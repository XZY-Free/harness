/** Serialized ExecutionOwnership operations. Every operation locks Invocation first. */
import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { scheduleEnvironmentLeaseCleanupInTransaction } from "@/lib/environment/environment-lease-store";
import { assertLeasePreparedEvidence } from "@/lib/environment/environment-prepared-evidence";
import {
  ExecutionAuthorityError,
  OWNERSHIP_DISPATCH_DEADLINE_MS,
  OWNERSHIP_LEASE_MS,
  authorityIdentity,
} from "@/lib/executions/domain/execution-authority";
import { environmentLeaseTable } from "@/lib/persistence/schema/environment";
import { environmentDefinitionRevisionTable } from "@/lib/persistence/schema/environment-definition-revision";
import {
  type ExecutionOwnership,
  INVOCATION_ATTEMPT_TERMINAL_STATES,
  INVOCATION_TERMINAL_STATES,
  type InvocationAttempt,
  type RuntimeSessionBinding,
  executionBindingTable,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import type { RuntimeEvidenceKind } from "@/lib/persistence/schema/runtimes";
import {
  getRuntimeSessionBindingByOwnership,
  lockRuntimeSessionBindingInTransaction,
  markRuntimeSessionLostByOwnershipInTransaction,
  renewSupervisorClaimInTransaction,
} from "@/lib/runtime/persistence/runtime-session-store";
import { and, eq, isNull, sql } from "drizzle-orm";

export type OwnershipTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function getAuthorityDatabaseTime(executor: DbOrTx): Promise<Date> {
  // 时间事实来自**数据库服务器本身**，不是某一行业务数据。因此这里用不带 FROM 的
  // `SELECT`：旧实现从 `Invocation` 表取一行来计算时间，一旦该表为空（全新库、
  // 或只跑了迁移还没建业务事实的集成环境）就会静默变成 `NaN` 并抛错——那是把
  // "读时钟"错误地绑在"库里有数据"上。
  const [rows] = (await executor.execute(
    sql`SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(6)) * 1000) AS epochMilliseconds`,
  )) as unknown as [Array<{ epochMilliseconds: number | string }>];
  const epochMilliseconds = Number(Array.isArray(rows) ? rows[0]?.epochMilliseconds : undefined);
  if (!Number.isFinite(epochMilliseconds)) {
    throw new ExecutionAuthorityError("NotCurrentExecutor", "无法读取数据库 Authority 时间");
  }
  return new Date(epochMilliseconds);
}

export interface AcquireExecutionOwnershipInput {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  runtimeRevisionId: string;
  environmentLeaseId?: string | null;
  acquiredByType: "system" | "service";
  acquiredById: string;
  workspaceWriterGeneration?: number | null;
  activationEvidence?: unknown;
  activationDigest?: string | null;
  /**
   * A05：**本次取得执行权时**的恢复水位摘要（`start` 为 `null`，`resume` 为当次 Anchor）。
   *
   * `prepareChecks` 会用它与 Lease 上冻结的 Prepared 证据逐字比对（R07 §4「恢复水位变化
   * 必须在这里被拒绝」）。此前它写死 `null`，等价于"只承认 Start 时准备的证据"：
   * 正式 Resume 携带新 Anchor、证据也按新 Anchor 重写过，却仍会被判成
   * "恢复 Anchor 已变化" —— 同一份恢复事实在两处用两套判据。
   */
  recoveryAnchorDigest?: string | null;
}

export interface OwnershipResult {
  ownership: ExecutionOwnership;
  authority: null;
  takeover: boolean;
}

/**
 * 锁定执行根 `Invocation`；行不存在时返回 `null`，由调用方决定是否 fail closed。
 *
 * R04 §2「固定锁图」把 Invocation 定为所有执行事实的根：
 * `Invocation → Attempt → Ownership → Session → EnvironmentLease → 必需子执行事实 → Thread/Turn/Item 映射`。
 * 凡是可能触达 Ownership/Session/Lease 的入口都必须先经过这里，否则会与
 * `acquire`/`renew`/`close`/守卫形成相反的持锁顺序（真实死锁环，不是理论担忧）。
 */
export async function lockInvocationRootIfExists(
  executor: OwnershipTx,
  tenantId: string,
  invocationId: string,
) {
  const [invocation] = await executor
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .for("update")
    .limit(1);
  return invocation ?? null;
}

/**
 * 在写产品根（Thread/Turn/Item 映射）之前**预先锁定执行根**：`Invocation → 活跃 Ownership`。
 *
 * R04 §2 固定锁图的顺序是
 * `Invocation → Attempt → Ownership → Session → EnvironmentLease → 必需子执行事实 → Thread/Turn/Item`。
 * 产品侧入口（Steer / Pause-Resume / 子线程取消 / UAR 解析 / Interrupt）在语义上都需要
 * 「先改执行侧、再改产品侧」，但它们往往先锁 Turn/Thread 才能定位执行根，于是形成了
 * **产品根 → 执行根** 的反向序：Runtime 路径「锁 I/O → 写 Thread 事件流」与之互等即是死锁环。
 *
 * 用法：先用非锁定读定位出 `invocationId`，调用本函数，然后再去 `FOR UPDATE` Turn/Thread。
 * 之后任何下游 helper（如 `createInvocationCommandInTransaction`）再对同一行取锁都不会等待。
 *
 * 行不存在时返回 `null`（调用方沿用自身的错误语义），不做 fail-closed 判定。
 */
export async function lockExecutionRootForProductWrite(
  executor: OwnershipTx,
  tenantId: string,
  invocationId: string | null | undefined,
): Promise<{ invocationId: string | null; ownershipId: string | null }> {
  if (!invocationId) return { invocationId: null, ownershipId: null };
  await lockInvocationRootIfExists(executor, tenantId, invocationId);
  const [owner] = await executor
    .select({ id: executionOwnershipTable.id })
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.invocationId, invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .for("update")
    .limit(1);
  return { invocationId, ownershipId: owner?.id ?? null };
}

async function lockInvocation(executor: OwnershipTx, tenantId: string, invocationId: string) {
  const invocation = await lockInvocationRootIfExists(executor, tenantId, invocationId);
  if (!invocation)
    throw new ExecutionAuthorityError("NotCurrentExecutor", "Invocation 不存在或不可见");
  return invocation;
}

/**
 * A03-05「新推进者必须换代际」：InvocationAttempt 承载执行代际，终态 Attempt 的物理执行
 * 事实已经收口，任何新执行权都不能再挂在它上面 —— 否则一个已结算的代际会被复活。
 *
 * 这是**唯一实现**：`prepareChecks`（Acquire 前置）与 `startRuntimeInvocation`（写任何
 * 准备槽/Workspace 候选之前）都调用它，避免同一不变量在两处各写一份判定而漂移。
 */
export function assertAttemptAcceptsNewGeneration(
  attempt: Pick<InvocationAttempt, "attemptState">,
): void {
  if (INVOCATION_ATTEMPT_TERMINAL_STATES.includes(attempt.attemptState)) {
    throw new ExecutionAuthorityError(
      "AttemptMismatch",
      `Attempt 已终态（${attempt.attemptState}），不可取得执行权`,
    );
  }
}

async function prepareChecks(executor: OwnershipTx, input: AcquireExecutionOwnershipInput) {
  const [attempt] = await executor
    .select()
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, input.tenantId),
        eq(invocationAttemptTable.id, input.attemptId),
        eq(invocationAttemptTable.invocationId, input.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!attempt || attempt.preparationState !== "prepared") {
    throw new ExecutionAuthorityError("AttemptMismatch", "Attempt 不存在或尚未 Prepared");
  }
  // R02 §4「Attempt 属于 Invocation 并处于允许阶段」：属于关系已由上面的 invocationId
  // 过滤保证；阶段上只接受非终态 Attempt——终态 Attempt 不可再承载任何执行权，换个实例
  // 必须新建 Attempt（§7），不能靠 Acquire 复活一个已收口的代际。
  assertAttemptAcceptsNewGeneration(attempt);
  if (input.environmentLeaseId) {
    const [lease] = await executor
      .select()
      .from(environmentLeaseTable)
      .where(
        and(
          eq(environmentLeaseTable.tenantId, input.tenantId),
          eq(environmentLeaseTable.id, input.environmentLeaseId),
          eq(environmentLeaseTable.invocationId, input.invocationId),
          eq(environmentLeaseTable.attemptId, input.attemptId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !lease ||
      !["prepared", "ready"].includes(lease.readinessState) ||
      !["allocated", "active"].includes(lease.leaseState)
    ) {
      throw new ExecutionAuthorityError("WorkspaceNotReady", "EnvironmentLease 尚未达到 ready");
    }
    // R07 §4：Acquire 也必须复验准备证据本身，而不是只信 Lease 的状态字段。
    // 换 Revision / 换 WorkspaceBinding / 恢复水位变化 / 已过 Prepared 有效期
    // 都必须在这里被拒绝，否则旧准备证据会随状态字段一起"漂"进执行。
    const [binding] = await executor
      .select({
        workspaceBindingId: executionBindingTable.workspaceBindingId,
        environmentDefinitionRevisionId: executionBindingTable.environmentDefinitionRevisionId,
      })
      .from(executionBindingTable)
      .where(
        and(
          eq(executionBindingTable.tenantId, input.tenantId),
          eq(executionBindingTable.invocationId, input.invocationId),
        ),
      )
      .limit(1);
    if (!binding?.environmentDefinitionRevisionId) {
      throw new Error("EnvironmentRevisionMismatch");
    }
    if (binding.environmentDefinitionRevisionId !== lease.environmentDefinitionRevisionId) {
      throw new Error("EnvironmentRevisionMismatch");
    }
    const [revision] = await executor
      .select({
        semanticDigest: environmentDefinitionRevisionTable.semanticDigest,
      })
      .from(environmentDefinitionRevisionTable)
      .where(
        and(
          eq(environmentDefinitionRevisionTable.tenantId, input.tenantId),
          eq(environmentDefinitionRevisionTable.id, binding.environmentDefinitionRevisionId),
        ),
      )
      .limit(1);
    if (!revision) throw new Error("EnvironmentRevisionMismatch");
    assertLeasePreparedEvidence({
      preparedEvidence: lease.preparedEvidence,
      preparedDigest: lease.preparedDigest,
      revisionId: binding.environmentDefinitionRevisionId,
      semanticDigest: revision.semanticDigest,
      attemptId: input.attemptId,
      workspaceBindingId: binding.workspaceBindingId,
      // 判据必须与"本次取得执行权所依据的恢复水位"一致，不能写死 null。
      recoveryAnchorDigest: input.recoveryAnchorDigest ?? null,
      // Acquire 在事务内，用 DB Authority 时间判定有效期（不受调用方时钟影响）。
      now: await getAuthorityDatabaseTime(executor),
    });
  }
}

export async function acquireExecutionOwnership(
  input: AcquireExecutionOwnershipInput,
): Promise<OwnershipResult> {
  return db.transaction(async (tx) => acquireExecutionOwnershipInTransaction(tx, input));
}

export async function acquireExecutionOwnershipInTransaction(
  tx: OwnershipTx,
  input: AcquireExecutionOwnershipInput,
): Promise<OwnershipResult> {
  const invocation = await lockInvocation(tx, input.tenantId, input.invocationId);
  // R02 §4「Invocation 非 terminal」：终态 Invocation 不再接受新执行权，Acquire 必须在此
  // fail closed——否则终态 Invocation 会被新 Ownership 复活（还会顺带推进 lastOwnershipEpoch）。
  if (INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) {
    throw new ExecutionAuthorityError(
      "NotCurrentExecutor",
      `Invocation 已终态（${invocation.executionState}），不可取得执行权`,
    );
  }
  await prepareChecks(tx, input);
  const now = await getAuthorityDatabaseTime(tx);
  const [active] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.invocationId, input.invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .for("update")
    .limit(1);
  if (active && active.leaseExpiresAt > now) {
    throw new ExecutionAuthorityError(
      "HealthyOwnerExists",
      "Invocation 已存在未过期 Current Owner",
    );
  }
  let takeover = false;
  if (active) {
    // A03-05：接管会**收口**旧 Attempt（见下方 `lost` 写入），因此新代际绝不能建立在同一行上。
    // 旧实现只在 `prepareChecks` 里判"终态 Attempt 不可 Acquire"，而那是在**收口之前**求值的：
    // 这里看到的是 `running`，随后同一事务把它写成 `lost`，守卫被自己所在的事务推翻 ——
    // 新 Ownership 于是指向一个已收口的 Attempt，下游 `execution.started` 再写 `running`
    // 必然违反 `InvocationAttempt_terminal_shape`。
    // 基础设施替换（进程被杀 / 租约过期）一律新建 Attempt（`dispatcher`、
    // `redispatchRuntimeInvocation`、`dispatch-queued-invocation-attempt` 都是此形态）。
    if (active.attemptId === input.attemptId) {
      throw new ExecutionAuthorityError(
        "AttemptMismatch",
        "接管必须新建 Attempt：不可在即将收口的旧 Attempt 上建立新执行权",
      );
    }
    takeover = true;
    await tx
      .update(executionOwnershipTable)
      .set({
        ownershipState: "lost",
        releasedAt: now,
        reasonCode: "OwnershipExpired",
        versionNo: active.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(executionOwnershipTable.id, active.id));
    // R02 §8：接管旧代际时 Session 状态写入收敛到仓储方法（行锁 + 单向转换表）。
    await markRuntimeSessionLostByOwnershipInTransaction(tx, input.tenantId, active.id);
    const [staleAttempt] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, input.tenantId),
          eq(invocationAttemptTable.id, active.attemptId),
          eq(invocationAttemptTable.invocationId, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (staleAttempt && ["queued", "running", "suspended"].includes(staleAttempt.attemptState)) {
      await tx
        .update(invocationAttemptTable)
        .set({
          attemptState: "lost",
          finishedAt: now,
          errorCode: "OwnershipExpired",
          errorSummary: "ExecutionOwnership lease expired before takeover",
          versionNo: staleAttempt.versionNo + 1,
          updatedAt: now,
        })
        .where(eq(invocationAttemptTable.id, staleAttempt.id));
    }
    // A08 8.1：旧代际失权 = **Authority** 事实，不是**资源**事实。
    //
    // 此前这里直接把 `active.environmentLeaseId` 写成 `lost`（终态），而清理 Worker 只扫
    // `releasing`：旧 Owner 的真实容器因此永远进不了清理扫描、也永远不会消失。
    // 现在出口只登记持久清理工作（`releasing` + 立即可重试），`releasedAt` 保持为空，
    // 真实释放回执由清理 Worker 写；`released` 才是"物理已释放"。
    //
    // 只有**另一个** Lease 才登记：接管偶尔在同一 Attempt 上重建执行权（Lease id 相同），
    // 此时新代际正要继续用它，绝不能把它的真实资源排进释放队列。
    if (active.environmentLeaseId && active.environmentLeaseId !== input.environmentLeaseId) {
      await scheduleEnvironmentLeaseCleanupInTransaction(tx, {
        tenantId: input.tenantId,
        leaseId: active.environmentLeaseId,
        errorCode: "OwnershipExpired",
        now,
        immediate: true,
      });
    }
    // R04 §3：**不**在已持有 I 根锁时撤销/释放 WorkspaceWriteLock。
    // 旧 Owner 被置为 lost 之后，其 Writer 的物理 stop/drain 与 W 行收口由持久
    // Workspace Writer 释放 lane 按 W→I 顺序完成（`workspace-writer-release.ts`）；
    // 新 Writer 的接管由 `reserveWorkspaceWriter` 在 W 路径中复核"父 Owner 已失权"。
  }
  const leaseEpoch = invocation.lastOwnershipEpoch + 1;
  const ownershipId = randomUUID();
  const expiredCheckpointGate = active && invocation.checkpointOwnerId === active.id;
  await tx
    .update(invocationTable)
    .set({
      lastOwnershipEpoch: leaseEpoch,
      ...(expiredCheckpointGate
        ? {
            // Owner 失权不等于物理屏障已释放。保留原 intent/owner 与既有 freeze/Checkpoint
            // 证据，转交 checkpoint maintenance lane 关闭两条 release 腿。
            checkpointGate: "releasing",
            checkpointDeadline: null,
            checkpointPreparedEvidence: {
              ...((invocation.checkpointPreparedEvidence as Record<string, unknown> | null) ?? {}),
              failureCode: "OwnershipExpired",
              release: {
                runtime: "pending",
                backend: "pending",
                ...(((invocation.checkpointPreparedEvidence as { release?: object } | null)
                  ?.release ?? {}) as object),
              },
            },
          }
        : {}),
      versionNo: invocation.versionNo + 1,
      updatedAt: now,
    })
    .where(eq(invocationTable.id, input.invocationId));
  await tx.insert(executionOwnershipTable).values({
    id: ownershipId,
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    environmentLeaseId: input.environmentLeaseId ?? null,
    leaseEpoch,
    ownershipState: "active",
    executionPhase: "activating",
    acquiredAt: now,
    lastHeartbeatAt: now,
    leaseExpiresAt: new Date(now.getTime() + OWNERSHIP_LEASE_MS),
    dispatchDeadline: new Date(now.getTime() + OWNERSHIP_DISPATCH_DEADLINE_MS),
    releasedAt: null,
    reasonCode: null,
    reasonDetail: null,
    acquiredByType: input.acquiredByType,
    acquiredById: input.acquiredById,
    closedByType: null,
    closedById: null,
    workspaceWriterGeneration: input.workspaceWriterGeneration ?? null,
    activationEvidence: input.activationEvidence ?? null,
    activationDigest: input.activationDigest ?? null,
    activatedAt: null,
    versionNo: 1,
  });
  const [ownership] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(eq(executionOwnershipTable.id, ownershipId))
    .limit(1);
  if (!ownership) throw new ExecutionAuthorityError("NotCurrentExecutor", "Owner 创建后回查失败");
  return {
    ownership,
    authority: null,
    takeover,
  };
}

export async function renewExecutionOwnership(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  attemptId: string;
  leaseEpoch: number;
}): Promise<ExecutionOwnership> {
  return db.transaction(async (tx) => renewExecutionOwnershipInTransaction(tx, input));
}

export async function getActiveExecutionOwnership(input: {
  tenantId: string;
  invocationId: string;
  executor?: DbOrTx;
}): Promise<ExecutionOwnership | null> {
  const executor = input.executor ?? db;
  const [row] = await executor
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.invocationId, input.invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .orderBy(sql`${executionOwnershipTable.leaseEpoch} DESC`)
    .limit(1);
  return row ?? null;
}

export async function renewExecutionOwnershipInTransaction(
  tx: OwnershipTx,
  input: {
    tenantId: string;
    invocationId: string;
    ownershipId: string;
    attemptId: string;
    leaseEpoch: number;
  },
): Promise<ExecutionOwnership> {
  // 锁序不变量：任何 Owner 操作先锁 Invocation 根。
  const invocation = await lockInvocation(tx, input.tenantId, input.invocationId);
  // R02 §4「Renew：完整 tuple 匹配、**Invocation 非 terminal**、Owner active 且未过期」。
  // 这一条不是装饰性的：Cancel 路径先 `closeExecutionOwnership`（Owner 立刻失去 active）
  // 再 `transitionInvocation`（写终态），两步之间另一个实例可以合法 Acquire 成为新的
  // Current Owner。若 Renew 只看 Owner 字段不看 Invocation 状态，这个"终态上的活跃
  // Owner"就能靠平台端点可达无限续租，把一个已收口的逻辑执行一直吊着。
  if (INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) {
    throw new ExecutionAuthorityError(
      "NotCurrentExecutor",
      `Invocation 已终态（${invocation.executionState}），不可续租执行权`,
    );
  }
  const [owner] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.id, input.ownershipId),
        eq(executionOwnershipTable.invocationId, input.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const now = await getAuthorityDatabaseTime(tx);
  if (!owner || owner.attemptId !== input.attemptId || owner.leaseEpoch !== input.leaseEpoch)
    throw new ExecutionAuthorityError("NotCurrentExecutor", "Owner tuple 不匹配");
  if (owner.ownershipState !== "active")
    throw new ExecutionAuthorityError("NotCurrentExecutor", "Owner 已关闭");
  if (owner.leaseExpiresAt <= now)
    throw new ExecutionAuthorityError("OwnershipExpired", "Owner lease 已过期");
  // R02 §4：dispatch deadline 按 **owner.executionPhase** 判定，不看 Invocation 是否 running。
  // `activating`/`dispatching`（尚未 Start）受固定 dispatchDeadline 封顶——平台无法通过
  // 反复续租无限占用 Start 阶段；`executing`/`suspending` 只受任务 Lease 与暂停安全点
  // deadline 约束（后者由 Checkpoint Gate 自己的 safePointDeadline 表达）。
  const withinDispatchWindow =
    owner.executionPhase === "activating" || owner.executionPhase === "dispatching";
  if (withinDispatchWindow && owner.dispatchDeadline <= now) {
    throw new ExecutionAuthorityError("OwnershipExpired", "Dispatch deadline 已过且执行尚未启动");
  }
  // A03-06（Hosted 准入）：来源由**服务端事实**（RuntimeRevision → ExecutionBinding
  // 投影的 `runtimeEvidenceKind`）判定，不接受请求体选择。本代际一旦已经分配过实际的
  // Supervisor claim，续租这条 Hosted 执行就**只能**携带该 claim —— 省略 claim 直接续
  // Owner 正是"Hosted 冒充 External Runtime"的入口。
  //
  // 未领取的代际不受此围栏影响：`execution.started` 之前平台仍可按既有 dispatchDeadline
  // 续合法的派发阶段（见下面 `withinDispatchWindow` 的封顶），因此"还没有 Supervisor 的
  // Start 阶段"不会被锁死。
  const sourceKind = await loadExecutionSourceKind(tx, input.tenantId, input.invocationId);
  if (sourceKind === "hosted_artifact") {
    const session = await getRuntimeSessionBindingByOwnership(input.tenantId, owner.id, tx);
    if (session?.supervisorClaimId) {
      throw new ExecutionAuthorityError(
        "NotCurrentExecutor",
        "Hosted 执行已分配 Supervisor claim，续租必须携带该 claim（renewHostedExecutionLease），不得省略 claim 冒充 External Runtime",
      );
    }
  }
  const desiredLeaseExpiresAt = new Date(now.getTime() + OWNERSHIP_LEASE_MS);
  const leaseExpiresAt =
    withinDispatchWindow && desiredLeaseExpiresAt > owner.dispatchDeadline
      ? owner.dispatchDeadline
      : desiredLeaseExpiresAt;
  await tx
    .update(executionOwnershipTable)
    .set({ lastHeartbeatAt: now, leaseExpiresAt, versionNo: owner.versionNo + 1, updatedAt: now })
    .where(eq(executionOwnershipTable.id, owner.id));
  const [updated] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(eq(executionOwnershipTable.id, owner.id))
    .limit(1);
  if (!updated) throw new ExecutionAuthorityError("NotCurrentExecutor", "Owner 续租后回查失败");
  return updated;
}

/**
 * A03：按**服务端事实**判定这条执行的来源种类（Hosted 还是 External Runtime）。
 *
 * `ExecutionBinding` 已经把 RuntimeRevision 的证据种类投影成 `runtimeEvidenceKind`，
 * 因此这里不需要额外 join。来源**不接受**请求体声明 —— 那正是"Hosted 省略 claim 冒充
 * External"的入口。返回 `null` 表示投影缺失，调用方按 fail-closed 处理。
 */
async function loadExecutionSourceKind(
  executor: OwnershipTx,
  tenantId: string,
  invocationId: string,
): Promise<RuntimeEvidenceKind | null> {
  const [row] = await executor
    .select({ runtimeEvidenceKind: executionBindingTable.runtimeEvidenceKind })
    .from(executionBindingTable)
    .where(
      and(
        eq(executionBindingTable.tenantId, tenantId),
        eq(executionBindingTable.invocationId, invocationId),
      ),
    )
    .limit(1);
  return row?.runtimeEvidenceKind ?? null;
}

/** Hosted 联合续租被拒绝的原因。每一种都表示"本进程不再是该代际的合法执行者"。 */
export type HostedLeaseRenewalReason =
  | "renewed"
  | "not_current_executor"
  | "not_hosted_execution"
  | "invocation_terminal"
  | "ownership_expired"
  | "claim_superseded"
  | "claim_released"
  | "claim_expired"
  | "session_terminal"
  | "execution_deadline_reached";

export interface HostedLeaseRenewalInput {
  tenantId: string;
  /** 本次请求携带的**完整**执行身份（Hosted 不接受"按 invocationId 跟随 current"）。 */
  authority: {
    invocationId: string;
    attemptId: string;
    ownershipId: string;
    leaseEpoch: number;
    sessionBindingId: string;
    runtimeRevisionId: string;
  };
  /** 本代际实际领取的 Supervisor claim nonce。 */
  claimId: string;
  /** 领取者进程启动 id（`workerInstanceId()`），仅诊断归属。 */
  instanceId: string;
  /** Supervisor 工作租约 TTL（毫秒）。 */
  leaseTtlMs: number;
  /**
   * 调用方已知的**执行绝对上限**；`null` = 本层没有这项事实。
   *
   * 契约的 `deadline = min(DB now + TTL, invocation absolute deadline, dispatch deadline
   * when still dispatching)` 里，第二项在物理模型中没有对应列：`Invocation` 只有
   * `checkpointDeadline`，执行权侧的 `dispatchDeadline` 则挂在 **Owner 行**上、由本函数
   * 按阶段独立取小（见下）。因此 Hosted 路径传 `null`，截止时间由 TTL 与 Owner 的
   * `dispatchDeadline` 共同决定。
   *
   * 曾经这里传的是本次 Loop 的窗口，于是两个租约被**同一个常量**夹住：心跳每轮都算出
   * 相同的 deadline，`S.supervisorLeaseExpiresAt` 永不推进 —— 那不是"租到期限为止"，
   * 而是"租到一个与执行期限没有实质关系的固定时刻"。
   */
  absoluteDeadlineAt: Date | null;
}

export interface HostedLeaseRenewalResult {
  renewed: boolean;
  reason: HostedLeaseRenewalReason;
  /** 两个租约**共同**的截止时间；未续租时为 null。 */
  leaseExpiresAt: Date | null;
  ownership: ExecutionOwnership | null;
  session: RuntimeSessionBinding | null;
}

/**
 * Hosted 执行权的**唯一**合法续租路径（A03-03）。
 *
 * 契约（`contracts/shared-contracts.md` §3）要求 Owner 与 Supervisor claim 必须同步失效：
 * 不能让 Supervisor 过期而 Owner 被另一路继续续活，也不能"先无条件续 Owner，再发现
 * Session claim 已失效"。因此这里把它们放进**同一个** `I → Attempt → O → S` 事务：
 *
 * ```text
 * BEGIN
 *   lock I → Attempt → O → exact S
 *   validate RuntimeRevision is Hosted
 *   validate exact authority + exact claim + process instance
 *   require O lease 与 S supervisor lease 在 DB now 均为活
 *   require S 未 released/终态
 *   deadline = min(DB now + TTL, 冻结的绝对期限, 仍在派发阶段的 dispatchDeadline)
 *   write O.leaseExpiresAt 与 S.supervisorLeaseExpiresAt = deadline
 * COMMIT
 * ```
 *
 * 判定全部在**锁定当前行**之后、且**先校验后写入**：Session 侧校验失败时调用方返回
 * 拒绝，Owner 行一个字都没写，因此不存在"续租只完成一半"的中间状态。
 *
 * 拒绝以返回值表达（而不是抛异常）：失权是正常控制流，调用方要按原因决定停心跳、
 * 释放 claim 还是把代际交回恢复流程；`NotCurrentExecutor` 只在真正需要中断流程时才抛。
 */
export async function renewHostedExecutionLeaseInTransaction(
  tx: OwnershipTx,
  input: HostedLeaseRenewalInput,
): Promise<HostedLeaseRenewalResult> {
  const denied = (reason: HostedLeaseRenewalReason): HostedLeaseRenewalResult => ({
    renewed: false,
    reason,
    leaseExpiresAt: null,
    ownership: null,
    session: null,
  });
  const authority = input.authority;
  // 固定锁图前缀：Invocation → Attempt → Ownership → Session。
  const invocation = await lockInvocation(tx, input.tenantId, authority.invocationId);
  const [attempt] = await tx
    .select({ id: invocationAttemptTable.id })
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, input.tenantId),
        eq(invocationAttemptTable.invocationId, authority.invocationId),
        eq(invocationAttemptTable.id, authority.attemptId),
      ),
    )
    .for("update")
    .limit(1);
  if (!attempt) return denied("not_current_executor");
  const [owner] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.id, authority.ownershipId),
        eq(executionOwnershipTable.invocationId, authority.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !owner ||
    owner.attemptId !== authority.attemptId ||
    owner.leaseEpoch !== authority.leaseEpoch ||
    owner.ownershipState !== "active"
  ) {
    return denied("not_current_executor");
  }
  const session = await lockRuntimeSessionBindingInTransaction(
    tx,
    input.tenantId,
    authority.sessionBindingId,
  );
  if (
    session.invocationId !== authority.invocationId ||
    session.attemptId !== authority.attemptId ||
    session.ownershipId !== owner.id ||
    session.leaseEpoch !== authority.leaseEpoch ||
    session.runtimeRevisionId !== authority.runtimeRevisionId
  ) {
    return denied("not_current_executor");
  }
  // 终态判定必须**先于**租约过期判定。`leaseExpiresAt` 是派生的 TTL，而 Session 的
  // `closed`/`lost` 是本代际**永久性**的生命周期事实（A03：claim 一经退休不可复活）：
  // 对一个已经收口的代际回答"租约过期"，会把"这个代际永远不会再推进"降级成
  // "等一下也许还能续"，等于把本包要消除的"过期即换手"从诊断口径上又引回来。
  if (session.bindingState === "closed" || session.bindingState === "lost") {
    return denied("session_terminal");
  }
  if (INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) {
    return denied("invocation_terminal");
  }
  // 来源必须是 Hosted：External Runtime 有它自己经认证的 heartbeat 契约，不走本路径。
  if (
    (await loadExecutionSourceKind(tx, input.tenantId, authority.invocationId)) !==
    "hosted_artifact"
  ) {
    return denied("not_hosted_execution");
  }
  const now = await getAuthorityDatabaseTime(tx);
  // "两份租约均未过期"是**前置条件**而不是结果：过期不复活——唯一延长路径是过期前的续租。
  if (owner.leaseExpiresAt <= now) return denied("ownership_expired");
  let deadline = new Date(now.getTime() + input.leaseTtlMs);
  if (
    input.absoluteDeadlineAt !== null &&
    input.absoluteDeadlineAt.getTime() < deadline.getTime()
  ) {
    deadline = input.absoluteDeadlineAt;
  }
  const withinDispatchWindow =
    owner.executionPhase === "activating" || owner.executionPhase === "dispatching";
  if (withinDispatchWindow && owner.dispatchDeadline.getTime() < deadline.getTime()) {
    deadline = owner.dispatchDeadline;
  }
  if (deadline.getTime() <= now.getTime()) {
    // 绝对期限已到：不再写出任何"合法租约"。期满正式收口，不继续写合法结果。
    return denied("execution_deadline_reached");
  }
  const renewal = await renewSupervisorClaimInTransaction(tx, {
    tenantId: input.tenantId,
    id: session.id,
    claimId: input.claimId,
    instanceId: input.instanceId,
    leaseExpiresAt: deadline,
    now,
  });
  if (!renewal.renewed) return denied(renewal.reason);
  await tx
    .update(executionOwnershipTable)
    .set({
      lastHeartbeatAt: now,
      leaseExpiresAt: deadline,
      versionNo: owner.versionNo + 1,
      updatedAt: now,
    })
    .where(eq(executionOwnershipTable.id, owner.id));
  const [updatedOwner] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(eq(executionOwnershipTable.id, owner.id))
    .limit(1);
  if (!updatedOwner) return denied("not_current_executor");
  return {
    renewed: true,
    reason: "renewed",
    leaseExpiresAt: deadline,
    ownership: updatedOwner,
    session: renewal.session,
  };
}

/** 公开入口：Hosted 联合续租在独立事务中执行（内部事务函数必须显式传 tx）。 */
export async function renewHostedExecutionLease(
  input: HostedLeaseRenewalInput,
): Promise<HostedLeaseRenewalResult> {
  return db.transaction(async (tx) => renewHostedExecutionLeaseInTransaction(tx, input));
}

export async function requireCurrentExecutionOwnership(input: {
  tenantId: string;
  authority: { invocationId: string; attemptId: string; ownershipId: string; leaseEpoch: number };
  /**
   * A01-03：本函数是多语句操作（`SELECT … FOR UPDATE` + 数据库时间 + 复核），
   * **必须**在调用方已开启的事务里执行。参数类型就是真实事务类型，不存在
   * "省略即落回全局 db" 的隐式 autocommit 路径，也不允许用 `as Tx` 把全局 db 强转进来。
   */
  executor: OwnershipTx;
  /** 可接受一个或多个执行阶段（R04 §6：已接纳重放可同时接受 dispatching/executing）。 */
  requiredPhase?:
    | "activating"
    | "dispatching"
    | "executing"
    | "suspending"
    | readonly ("activating" | "dispatching" | "executing" | "suspending")[];
}): Promise<ExecutionOwnership> {
  const executor = input.executor;
  // R04 §2「固定锁图」：`Invocation → Attempt → Ownership → Session → EnvironmentLease → …`
  // —— **任何 Owner 操作先锁 Invocation 根**，与 `acquire`/`renew`/`close` 保持同一顺序。
  //
  // 这里必须先锁 I 再读 O。此前本函数只对 `ExecutionOwnership` 加 `FOR UPDATE`，于是唯一
  // 调用方 `requireCurrentExecutionAuthority` 的实际顺序是 **O → I**，而 `renew`/`acquire`/
  // `close` 是 **I → O**：两条真实路径互等即构成死锁环（Tool 接纳持 O 等 I，Heartbeat
  // 持 I 等 O），且 `applyToolCall` 的重试只处理 `ToolCallSequenceConflictError`，不会兜住
  // 数据库死锁。锁序只能靠顺序本身保证，不能靠注释声明。
  await lockInvocation(executor, input.tenantId, input.authority.invocationId);
  const [owner] = await executor
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.id, input.authority.ownershipId),
        eq(executionOwnershipTable.invocationId, input.authority.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const now = await getAuthorityDatabaseTime(executor);
  if (
    !owner ||
    owner.attemptId !== input.authority.attemptId ||
    owner.leaseEpoch !== input.authority.leaseEpoch ||
    owner.ownershipState !== "active"
  )
    throw new ExecutionAuthorityError("NotCurrentExecutor", "不是 Current ExecutionOwnership");
  if (input.requiredPhase) {
    const allowed =
      typeof input.requiredPhase === "string" ? [input.requiredPhase] : input.requiredPhase;
    if (!allowed.includes(owner.executionPhase))
      throw new ExecutionAuthorityError(
        "NotCurrentExecutor",
        "Current ExecutionOwnership 阶段不允许该操作",
      );
  }
  if (owner.leaseExpiresAt <= now)
    throw new ExecutionAuthorityError("OwnershipExpired", "Current ExecutionOwnership 已过期");
  return owner;
}

/**
 * 关闭 Current Owner（R02 §4 Release/Revoke/Lost）。
 *
 * **必须**复核 `tenantId + invocationId + ownershipId + attemptId + leaseEpoch` 的完整所属关系：
 * 「关闭输入 Owner ID」绝不允许锁错 Invocation，也不允许把某个同租户但属于另一代际的
 * ownershipId 当成当前代际关闭。
 */
export interface CloseExecutionOwnershipInput {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  /** 调用方持有的 Owner 代际 tuple（缺一不可）。 */
  attemptId?: string;
  leaseEpoch?: number;
  state: "released" | "lost" | "revoked";
  reasonCode: string;
}

export async function closeExecutionOwnership(
  input: CloseExecutionOwnershipInput,
): Promise<ExecutionOwnership> {
  return db.transaction(async (tx) => closeExecutionOwnershipInTransaction(tx, input));
}

/**
 * 事务内版本：供**同一条收口边界**里既要关 Owner 又要动 Session 的调用方使用
 * （A03 的 Supervisor 交接、A02 的终态收口）。
 *
 * 它自己会先锁 Invocation 根（`lockInvocation`），因此调用方若已在本事务里锁过 I，
 * 这次取锁是同一事务内的重入，不引入反向序；但调用方若还持有产品根（Turn/Thread），
 * 必须先释放或按 `lockExecutionRootForProductWrite` 的既定策略处理。
 */
export async function closeExecutionOwnershipInTransaction(
  tx: OwnershipTx,
  input: CloseExecutionOwnershipInput,
): Promise<ExecutionOwnership> {
  await lockInvocation(tx, input.tenantId, input.invocationId);
  const [owner] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.id, input.ownershipId),
      ),
    )
    .for("update")
    .limit(1);
  if (!owner) throw new ExecutionAuthorityError("NotCurrentExecutor", "Owner 不存在");
  // 所属关系复核：ownershipId 必须真的属于本次要锁的 Invocation，且代际 tuple 一致。
  if (
    owner.invocationId !== input.invocationId ||
    (input.attemptId !== undefined && owner.attemptId !== input.attemptId) ||
    (input.leaseEpoch !== undefined && owner.leaseEpoch !== input.leaseEpoch)
  ) {
    throw new ExecutionAuthorityError(
      "NotCurrentExecutor",
      "Owner 不属于该 Invocation/代际（拒绝跨 Invocation 关闭）",
    );
  }
  if (owner.ownershipState !== "active") return owner;
  const now = await getAuthorityDatabaseTime(tx);
  await tx
    .update(executionOwnershipTable)
    .set({
      ownershipState: input.state,
      releasedAt: now,
      reasonCode: input.reasonCode,
      versionNo: owner.versionNo + 1,
      updatedAt: now,
    })
    .where(eq(executionOwnershipTable.id, owner.id));
  const [updated] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(eq(executionOwnershipTable.id, owner.id))
    .limit(1);
  if (!updated) throw new ExecutionAuthorityError("NotCurrentExecutor", "Owner 关闭后回查失败");
  return updated;
}
