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
  executionBindingTable,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { markRuntimeSessionLostByOwnershipInTransaction } from "@/lib/runtime/persistence/runtime-session-store";
import { and, eq, isNull, sql } from "drizzle-orm";

export type OwnershipTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function getAuthorityDatabaseTime(executor: DbOrTx): Promise<Date> {
  const [row] = await executor
    .select({ epochMilliseconds: sql<number>`FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(6)) * 1000)` })
    .from(invocationTable)
    .limit(1);
  const epochMilliseconds = Number(row?.epochMilliseconds);
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
  if (INVOCATION_ATTEMPT_TERMINAL_STATES.includes(attempt.attemptState)) {
    throw new ExecutionAuthorityError(
      "AttemptMismatch",
      `Attempt 已终态（${attempt.attemptState}），不可取得执行权`,
    );
  }
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
            checkpointGate: "open",
            checkpointIntentId: null,
            checkpointOwnerId: null,
            checkpointDeadline: null,
            checkpointPreparedEvidence: { failureCode: "OwnershipExpired" },
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
export async function closeExecutionOwnership(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  /** 调用方持有的 Owner 代际 tuple（缺一不可）。 */
  attemptId?: string;
  leaseEpoch?: number;
  state: "released" | "lost" | "revoked";
  reasonCode: string;
}): Promise<ExecutionOwnership> {
  return db.transaction(async (tx) => {
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
  });
}
