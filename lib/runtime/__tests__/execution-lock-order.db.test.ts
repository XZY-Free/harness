/**
 * R04 §2「固定锁图」在**真实两条数据库连接 + 屏障**下的行为回归（A01）。
 *
 * `repairs/03-transactions.md` §2 的锁图要求「执行根先于产品根」。静态门禁
 * （`scripts/execution-lock-order.contract.test.ts`）只能证明**源码里的调用顺序**；
 * 审查报告要求的是另一件事：**入口在相反顺序下不得持锁**——这必须用真实连接观察。
 *
 * 观察方式（确定性，不依赖概率性死锁）：让连接 A 持住 Invocation 根锁，再在被审入口
 * 运行时从**连接 C** 去锁它本不该持有的那张行。
 *
 * - 若入口确实先取执行根：它会**停在** Invocation 根锁上，Ownership / Turn 行保持空闲，
 *   连接 C 立即取到。
 * - 若入口仍按旧序（先 O 后 I、或先 Turn/Thread 后 I）：它会在阻塞前先握住那张行，
 *   连接 C 只能等到 `innodb_lock_wait_timeout` 超时抛错。
 *
 * 因此本文件的断言直接编码了审查报告的一句原话：「确保入口不再通过相反顺序持锁」。
 */
import { randomUUID } from "node:crypto";
import { selectActiveAgentCallsForCancellation } from "@/lib/agents/calls/application/cancel-active-agent-calls";
import { requestInterrupt } from "@/lib/conversations/interrupt-queries";
import { type DbOrTx, db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createEnvironmentDefinition } from "@/lib/environment/environment-definition-store";
import {
  createEnvironmentLease,
  createEnvironmentLeaseInTransaction,
} from "@/lib/environment/environment-lease-store";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
import {
  type OwnershipTx,
  requireCurrentExecutionAuthority,
} from "@/lib/executions/application/require-current-execution-authority";
import { markAttemptPreparedInTransaction } from "@/lib/executions/persistence/attempt-store";
import { createInvocation } from "@/lib/executions/persistence/invocation-store";
import {
  acquireTestRuntimeAuthority,
  createPreparedTakeoverAttempt,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
import { threadEventTable, turnTable } from "@/lib/persistence/schema/conversation";
import { environmentLeaseTable } from "@/lib/persistence/schema/environment";
import {
  executionOwnershipTable,
  invocationCommandTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { authorizeRuntimeAction } from "@/lib/runtime/application/authorize-runtime-action";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { handleRuntimeHeartbeat } from "@/lib/runtime/application/runtime-heartbeat";
import { resumeRuntimeInvocation } from "@/lib/runtime/application/runtime-resume";
import { startRuntimeInvocation } from "@/lib/runtime/application/runtime-start";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { type AuthorityIdentity, protocolDigest } from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_VITEST_IDENTITY_FIXTURE;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把调度夹具建出的候选 Attempt 补成 Prepared。
 *
 * Acquire 的前置事实是"该 Attempt 已准备"（R02 §4）；生产由候选准备阶段写入，
 * 夹具必须用同一仓储方法补齐，而不是直接改状态列。
 */
async function markPrepared(tenantId: string, invocationId: string, attemptId: string) {
  const evidence = { kind: "lock-order-candidate", invocationId, attemptId };
  await db.transaction((tx) =>
    markAttemptPreparedInTransaction(tx, {
      attemptId,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
}

/**
 * 在**独立连接**上尝试给某一行加 `FOR UPDATE`，超时 1 秒。
 *
 * 返回 `true` = 该行此刻空闲（没有人持有它的排他锁）；返回 `false` = 被别的连接握着。
 */
async function rowIsFree(
  lock: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>,
): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET innodb_lock_wait_timeout = 1`);
      await lock(tx);
    });
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ER_LOCK_WAIT_TIMEOUT" || code === "ER_LOCK_DEADLOCK") return false;
    throw error;
  }
}

describe("R04 §2 固定锁图：真实双连接下的持锁顺序（A01）", () => {
  beforeEach(async () => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
    await resetDatabase(db);
  });

  afterEach(() => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = ORIGINAL_AUTH_MODE;
  });

  it("LOCKORDER-01: 守卫在取得执行根之前不预先占住 Ownership 行", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
    });
    const invocation = dispatch.invocation;
    const binding = dispatch.binding;
    const attempt = dispatch.attempt;
    if (!invocation || !binding || !attempt) throw new Error("调度失败");
    const tenantId = ctx.tenantId;
    await markPrepared(tenantId, invocation.id, attempt.id);
    const gen1 = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: attempt.id,
      runtimeRevisionId: binding.runtimeRevisionId,
      phase: "dispatching",
    });

    const guard = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<unknown> =>
      requireCurrentExecutionAuthority({
        tenantId,
        authority: gen1.authority,
        executor: tx,
        requiredPhase: "dispatching",
        operationKind: "progress",
      });

    // 基线：无争用时守卫必须成立——否则"它被阻塞"这件事就没有解释力。
    await db.transaction(async (tx) => {
      await guard(tx);
    });

    // 连接 A：持住 Invocation 根锁。
    const holderLocked = deferred();
    const releaseHolder = deferred();
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: invocationTable.id })
        .from(invocationTable)
        .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocation.id)))
        .for("update")
        .limit(1);
      holderLocked.resolve();
      await releaseHolder.promise;
    });
    await holderLocked.promise;

    // 连接 B：真实守卫。它必须停在 Invocation 根锁上。
    let guardSettled = false;
    const pendingGuard = db.transaction(async (tx) => {
      const owner = await guard(tx);
      guardSettled = true;
      return owner;
    });
    await sleep(200);

    // 连接 C：Ownership 行此刻必须是空闲的。
    // 旧实现（守卫先锁 Ownership 再锁 Invocation）会让 B 在等待 I 期间握着这一行，
    // 这里就会等到 innodb_lock_wait_timeout 并抛错。
    const ownershipFree = await rowIsFree((tx) =>
      tx
        .select({ id: executionOwnershipTable.id })
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, tenantId),
            eq(executionOwnershipTable.id, gen1.ownership.id),
          ),
        )
        .for("update")
        .limit(1),
    );
    expect(ownershipFree, "守卫在等待 Invocation 根锁期间不得持有 Ownership 行").toBe(true);
    expect(guardSettled, "守卫应当仍被 Invocation 根锁挡住").toBe(false);

    releaseHolder.resolve();
    await holder;
    await pendingGuard;
    expect(guardSettled).toBe(true);
  }, 30_000);

  it("LOCKORDER-02: Interrupt 入口在取得执行根之前不预先占住 Turn 行", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
    });
    const invocation = dispatch.invocation;
    const binding = dispatch.binding;
    const attempt = dispatch.attempt;
    if (!invocation || !binding || !attempt) throw new Error("调度失败");
    const tenantId = ctx.tenantId;
    await markPrepared(tenantId, invocation.id, attempt.id);
    await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: attempt.id,
      runtimeRevisionId: binding.runtimeRevisionId,
      phase: "dispatching",
    });

    // 生产 Interrupt 的准入前提：Turn 处于可中断状态且绑定当前 Invocation。
    await db
      .update(turnTable)
      .set({
        turnState: "running",
        activeInvocationId: invocation.id,
        latestInvocationId: invocation.id,
        startedAt: new Date(),
      })
      .where(eq(turnTable.id, ctx.turnId));

    // 基线：无争用时 Interrupt 必须真正入队（含代际边界返回值）。
    const baselineKey = `lockorder-baseline:${randomUUID()}`;
    const baseline = await requestInterrupt({
      tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "user_stop",
      idempotencyKey: baselineKey,
    });
    expect(baseline.targetInvocationId).toBe(invocation.id);
    expect(baseline.targetCutoffAt).toBeInstanceOf(Date);

    // 连接 A：持住 Invocation 根锁。
    const holderLocked = deferred();
    const releaseHolder = deferred();
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: invocationTable.id })
        .from(invocationTable)
        .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocation.id)))
        .for("update")
        .limit(1);
      holderLocked.resolve();
      await releaseHolder.promise;
    });
    await holderLocked.promise;

    // 连接 B：真实 Interrupt 入口。它必须停在 Invocation 根锁上。
    const contendedKey = `lockorder-contended:${randomUUID()}`;
    let interruptSettled = false;
    const pendingInterrupt = requestInterrupt({
      tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "user_stop",
      idempotencyKey: contendedKey,
    }).then((result) => {
      interruptSettled = true;
      return result;
    });
    await sleep(200);

    // 连接 C：Turn 行此刻必须是空闲的。
    // 旧实现（先锁 Turn → Thread，再在命令创建里锁 Ownership）会让 B 先握住 Turn，
    // 这里就会超时。修正后产品根只在执行根之后才被触碰。
    const turnFree = await rowIsFree((tx) =>
      tx
        .select({ id: turnTable.id })
        .from(turnTable)
        .where(eq(turnTable.id, ctx.turnId))
        .for("update")
        .limit(1),
    );
    expect(turnFree, "Interrupt 在等待 Invocation 根锁期间不得持有 Turn 行").toBe(true);
    expect(interruptSettled).toBe(false);

    releaseHolder.resolve();
    await holder;
    const settled = await pendingInterrupt;
    expect(interruptSettled).toBe(true);
    expect(settled.targetInvocationId).toBe(invocation.id);

    // 争用期的这次 Interrupt 也必须真正入队（不是"没报错但什么也没做"）。
    const commands = await db
      .select({ id: invocationCommandTable.id })
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, tenantId),
          eq(invocationCommandTable.invocationId, invocation.id),
          eq(invocationCommandTable.idempotencyKey, contendedKey),
        ),
      );
    expect(commands).toHaveLength(1);
  }, 30_000);

  it("LOCKORDER-03: 旧代际的子调用取消以入队时刻为界，不误伤新代际创建的子调用", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
    });
    const invocation = dispatch.invocation;
    const binding = dispatch.binding;
    const attempt = dispatch.attempt;
    if (!invocation || !binding || !attempt) throw new Error("调度失败");
    const tenantId = ctx.tenantId;
    await markPrepared(tenantId, invocation.id, attempt.id);
    await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: attempt.id,
      runtimeRevisionId: binding.runtimeRevisionId,
      phase: "dispatching",
    });
    await db
      .update(turnTable)
      .set({
        turnState: "running",
        activeInvocationId: invocation.id,
        latestInvocationId: invocation.id,
        startedAt: new Date(),
      })
      .where(eq(turnTable.id, ctx.turnId));

    // 同一个 parentInvocationId 会被后续代际继续使用：子调用本身不带 Ownership/Epoch。
    const insertCall = async (createdAt: Date) => {
      const id = randomUUID();
      await db.insert(agentCallTable).values({
        id,
        tenantId,
        parentInvocationId: invocation.id,
        agentId: randomUUID(),
        sourceType: "harness_planned",
        sourceRef: `lockorder:${id}`,
        state: "running",
        logicalCallKey: `lockorder:${id}`,
        creationRequestDigest: `sha256:${"a".repeat(64)}`,
        createdAt,
      });
      return id;
    };

    const staleCallId = await insertCall(new Date(Date.now() - 60_000));
    const interrupt = await requestInterrupt({
      tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "user_stop",
      idempotencyKey: `lockorder-cutoff:${randomUUID()}`,
    });
    // 入队之后才出现的子调用 —— 它属于后续代际，不属于本次取消的目标。
    const freshCallId = await insertCall(new Date());

    const selected = await selectActiveAgentCallsForCancellation({
      tenantId,
      parentInvocationId: interrupt.targetInvocationId,
      createdBefore: interrupt.targetCutoffAt,
    });
    expect(selected).toContain(staleCallId);
    expect(selected).not.toContain(freshCallId);

    // 不传边界 = 整条 Invocation 正在收口时的语义：两代子调用都在范围内。
    const all = await selectActiveAgentCallsForCancellation({
      tenantId,
      parentInvocationId: interrupt.targetInvocationId,
    });
    expect(new Set(all)).toEqual(new Set([staleCallId, freshCallId]));
  }, 30_000);

  // ─────────────────────── A01：真实入口的换代/竞争 ───────────────────────

  const CALLBACK_ENDPOINTS = {
    events: "https://lock-order.invalid/runtime/events",
    heartbeat: "https://lock-order.invalid/runtime/heartbeat",
    context: "https://lock-order.invalid/runtime/context",
    capabilityActions: "https://lock-order.invalid/gateway/capability-actions",
    toolCalls: "https://lock-order.invalid/gateway/tool-calls",
    userActions: "https://lock-order.invalid/gateway/user-actions",
  };

  /**
   * Hosted 应用边界的**空实现**：本组用例只观察锁与持久事实，不需要真实 Harness Loop。
   * 仍走真实 in-process client，因此 start 响应形状来自生产代码而不是手拼协议对象。
   */
  function idleHostedService(invocationId: string): HostedRuntimeApplicationService {
    return {
      start: async () => ({ status: "resumed", invocationId }),
      resume: async () => ({ status: "resumed", invocationId }),
      cancel: async () => undefined,
      steer: async () => undefined,
    };
  }

  async function activeOwnerships(tenantId: string, invocationId: string) {
    return db
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, tenantId),
          eq(executionOwnershipTable.invocationId, invocationId),
          eq(executionOwnershipTable.ownershipState, "active"),
        ),
      );
  }

  it("A01-T01：真实 Start 换代与 heartbeat 并发——Start 等待 I 根时不得持有旧 O，换代后只有一个当前 O", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
    });
    const invocation = dispatch.invocation;
    const binding = dispatch.binding;
    const attempt = dispatch.attempt;
    if (!invocation || !binding || !attempt) throw new Error("调度失败");
    const tenantId = ctx.tenantId;
    await markPrepared(tenantId, invocation.id, attempt.id);
    const gen1 = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: attempt.id,
      runtimeRevisionId: binding.runtimeRevisionId,
      phase: "dispatching",
    });
    // 显式构造"待替换的旧 O"：租约已过期，真实 Start 必须走换代分支（否则它会复用它）。
    // `ExecutionOwnership_lease_expiry_shape` 要求 `leaseExpiresAt > acquiredAt`，
    // 因此到期时间取 `acquiredAt + 1ms` —— 仍在 acquiredAt 之后，但早已早于 now。
    const gen1Row = (await activeOwnerships(tenantId, invocation.id))[0];
    if (!gen1Row) throw new Error("gen1 Ownership 不存在");
    await db
      .update(executionOwnershipTable)
      .set({
        leaseExpiresAt: new Date(gen1Row.acquiredAt.getTime() + 1),
        lastHeartbeatAt: gen1Row.acquiredAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(executionOwnershipTable.tenantId, tenantId),
          eq(executionOwnershipTable.id, gen1.ownership.id),
        ),
      );

    const client = createInProcessHostedRuntimeClient({
      tenantId,
      publishedCapabilityEvidence: {
        runtimeRevisionId: binding.runtimeRevisionId,
        runtimeCapabilitiesJson: ctx.runtimeRevision.runtimeCapabilitiesJson,
      },
      applicationService: idleHostedService(invocation.id),
    });
    // 换代必须自带新 Attempt（基础设施替换规则）：接管事务会收口旧 Attempt，
    // 沿用同一行会让新代际挂在一个已终态的 Attempt 上。
    const takeoverAttempt = await createPreparedTakeoverAttempt({
      tenantId,
      invocationId: invocation.id,
    });
    const startInput = {
      tenantId,
      sourceOperationKey: `invocation:${invocation.id}`,
      invocation,
      binding,
      attempt: takeoverAttempt,
      runtimeClient: client,
      runtimeEndpoint: "in-process://hosted",
      auth: { mode: "workload_token" as const, token: "lock-order-token" },
      callbackEndpoints: CALLBACK_ENDPOINTS,
    };

    // 连接 A：持住 Invocation 根锁（屏障）。
    const holderLocked = deferred();
    const releaseHolder = deferred();
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: invocationTable.id })
        .from(invocationTable)
        .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocation.id)))
        .for("update")
        .limit(1);
      holderLocked.resolve();
      await releaseHolder.promise;
    });
    await holderLocked.promise;

    // 连接 B：**真实 Start**。它必须停在 Invocation 根锁上。
    let startSettled = false;
    const pendingStart = startRuntimeInvocation(startInput).then(
      (result) => {
        startSettled = true;
        return result;
      },
      (error: unknown) => {
        startSettled = true;
        throw error;
      },
    );
    await sleep(200);

    // 断言（1）：Start 在等待 I 根期间**不得**持有旧 O 行。
    // 旧实现（先 `SELECT ExecutionOwnership … FOR UPDATE` 再进 Acquire 去锁 I）会让它
    // 握着这一行等 I，这里就会等到 innodb_lock_wait_timeout 并抛错 —— 即真实等待环。
    const ownershipFree = await rowIsFree((tx) =>
      tx
        .select({ id: executionOwnershipTable.id })
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, tenantId),
            eq(executionOwnershipTable.id, gen1.ownership.id),
          ),
        )
        .for("update")
        .limit(1),
    );
    expect(ownershipFree, "Start 在等待 Invocation 根锁期间不得持有 Ownership 行").toBe(true);
    expect(startSettled, "Start 应当仍被 Invocation 根锁挡住").toBe(false);

    // 连接 C：**真实 heartbeat**（与 Start 并发）。它只续租当前未过期 Owner。
    // 处理函数必须**立即**挂上：本代际租约已过期，它很可能在屏障释放前就拒绝。
    const pendingHeartbeat = handleRuntimeHeartbeat({
      tenantId,
      invocationId: invocation.id,
      request: {
        protocolVersion: 3,
        authority: gen1.authority,
        heartbeatId: randomUUID(),
        runtimeState: "running",
        lastObservedProducerSequence: "0",
        requestCredentialRefresh: false,
      },
    }).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    releaseHolder.resolve();
    await holder;

    const startOutcome = await pendingStart.then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const heartbeatOutcome = await pendingHeartbeat;
    expect(startSettled).toBe(true);
    expect(startOutcome.ok, `Start 未完成：${JSON.stringify(startOutcome)}`).toBe(true);

    // 断言（2）：换代后**只有一个**合法当前 O，且它不是被替换的旧代际。
    const actives = await activeOwnerships(tenantId, invocation.id);
    expect(actives).toHaveLength(1);
    expect(actives[0]?.id).not.toBe(gen1.ownership.id);
    expect(actives[0]?.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());

    // 断言（3）：失败方不会吞掉新事实。
    // 旧代际要么被 Start 换代（heartbeat 失败），要么在 Start 之前先合法续租成功
    // （此时 Start 会复用它）—— 两种线性化都不允许出现"旧代际仍 active 且新代际也 active"。
    if (!heartbeatOutcome.ok) {
      const stillActive = actives.some((row) => row.id === gen1.ownership.id);
      expect(stillActive, "旧代际被替换后不得再是当前 O").toBe(false);
    }

    // 连接 D：换代之后再对旧代际发一次真实 heartbeat —— 它必须被拒，且不得复活旧 O。
    const gen1Revived = await handleRuntimeHeartbeat({
      tenantId,
      invocationId: invocation.id,
      request: {
        protocolVersion: 3,
        authority: gen1.authority,
        heartbeatId: randomUUID(),
        runtimeState: "running",
        lastObservedProducerSequence: "0",
        requestCredentialRefresh: false,
      },
    }).then(
      () => true,
      () => false,
    );
    const activesAfter = await activeOwnerships(tenantId, invocation.id);
    expect(activesAfter).toHaveLength(1);
    expect(activesAfter[0]?.id).not.toBe(gen1.ownership.id);
    if (!heartbeatOutcome.ok) expect(gen1Revived, "旧代际不得被心跳复活").toBe(false);
  }, 30_000);

  it("A01-T06：根为空时并发首次创建 Owner——不得出现两条当前 O，也不得以不存在的 O 行替代 I 根", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
    });
    const invocation = dispatch.invocation;
    const binding = dispatch.binding;
    const attempt = dispatch.attempt;
    if (!invocation || !binding || !attempt) throw new Error("调度失败");
    const tenantId = ctx.tenantId;
    await markPrepared(tenantId, invocation.id, attempt.id);
    // 根为空：此前没有任何 Owner（也不存在"用一行不存在的 O 当根锁"的空间）。
    expect(await activeOwnerships(tenantId, invocation.id)).toHaveLength(0);

    const makeInput = () => ({
      tenantId,
      sourceOperationKey: `invocation:${invocation.id}`,
      invocation,
      binding,
      attempt,
      runtimeClient: createInProcessHostedRuntimeClient({
        tenantId,
        publishedCapabilityEvidence: {
          runtimeRevisionId: binding.runtimeRevisionId,
          runtimeCapabilitiesJson: ctx.runtimeRevision.runtimeCapabilitiesJson,
        },
        applicationService: idleHostedService(invocation.id),
      }),
      runtimeEndpoint: "in-process://hosted",
      auth: { mode: "workload_token" as const, token: "lock-order-token" },
      callbackEndpoints: CALLBACK_ENDPOINTS,
    });

    const [first, second] = await Promise.all([
      startRuntimeInvocation(makeInput()).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      startRuntimeInvocation(makeInput()).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);

    // 只有一个合法当前 O —— 并发首次创建不允许产生两个代际。
    const actives = await activeOwnerships(tenantId, invocation.id);
    expect(actives).toHaveLength(1);

    // 两个并发 Start 都不允许把"不存在的 Owner 行"当成执行根：它们必须都在真实 I 根上
    // 线性化。至少一方成功；失败方必须是稳定的执行权错误，而不是死锁/超时。
    expect([first.ok, second.ok].some(Boolean)).toBe(true);
    for (const outcome of [first, second]) {
      if (outcome.ok) continue;
      const name = (outcome.error as { name?: string }).name ?? "";
      expect(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]).not.toContain(name);
    }
  }, 30_000);
  /**
   * A01-T05：内部多语句函数不能接全局 `db`。
   *
   * 两段观察缺一不可：
   * - **静态**：多语句入口只接受真实事务类型，"省略即落回全局 db" 的默认值与"把全局 db
   *   断言成事务"的写法都必须不存在。下面的类型断言是编译期判定：签名一旦退回接受全局
   *   `db`，`DbIsNotTransaction` 会解析成 `never`，`pnpm typecheck` 立刻失败。
   * - **运行期**：在调用方事务里执行同一多语句函数后抛错 —— 整组写入必须回滚。若函数内部
   *   有任何一条语句落回全局 `db`，它就不受本事务约束，回滚后泄漏会被下面的计数观察到。
   *
   * 负向控制就是第二段：把任一内部语句改回全局 `db`，回滚后行数会是 1 而不是 0。
   */
  it("A01-T05：多语句内部函数必须参与调用方事务——中间失败整组回滚，签名不得接受全局 db", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
    });
    const invocation = dispatch.invocation;
    const attempt = dispatch.attempt;
    if (!invocation || !attempt) throw new Error("调度失败");
    const tenantId = ctx.tenantId;
    // 供"从不执行"的静态形状断言使用：显式取出，避免闭包内丢失收窄。
    const invocationId: string = invocation.id;
    const attemptId: string = attempt.id;

    // ── 静态形状（编译期）───────────────────────────────────────────────
    // `db` 不是事务类型：若它可赋值给 OwnershipTx，下面的类型会解析成 never 而无法赋值。
    type DbIsNotTransaction = [typeof db] extends [OwnershipTx] ? never : true;
    const dbIsNotTransaction: DbIsNotTransaction = true;
    expect(dbIsNotTransaction).toBe(true);
    // 反向确认收紧是"更窄"而不是"换了个名字"：真实事务类型仍可赋值给宽松的 DbOrTx，
    // 因此上面的 DbIsNotTransaction 失败只可能因为"全局 db 被排除"这一件事。
    type TxIsNarrowerThanDbOrTx = [OwnershipTx] extends [DbOrTx] ? true : never;
    const txIsNarrowerThanDbOrTx: TxIsNarrowerThanDbOrTx = true;
    expect(txIsNarrowerThanDbOrTx).toBe(true);
    // 全局 db 不能作为多语句入口的事务参数（每个 @ts-expect-error 都是编译期断言）。
    // 这些调用**从不执行**（函数只被引用、不被调用），因此它们只影响 `pnpm typecheck`：
    // 一旦签名退回"接受全局 db"，指令会变成未使用，typecheck 立即失败。
    function assertGlobalDbIsNotAcceptedAsTransaction() {
      // @ts-expect-error 全局 db 不得作为 InvocationCommand 创建的事务
      void createInvocationCommandInTransaction(db, {
        tenantId,
        invocationId,
        commandType: "cancel",
        idempotencyKey: "a01-t05-static",
        payloadJson: {},
        requestedByType: "user",
        requestedById: ctx.ownerId,
      });
      // @ts-expect-error 全局 db 不得作为 EnvironmentLease 创建的事务
      void createEnvironmentLeaseInTransaction(db, {
        tenantId,
        invocationId,
        attemptId,
        environmentDefinitionRevisionId: "static-shape-only",
      });
    }
    expect(typeof assertGlobalDbIsNotAcceptedAsTransaction).toBe("function");

    // ── 运行期：真实事务整体回滚 ────────────────────────────────────────
    await expect(
      db.transaction(async (tx) => {
        await createInvocationCommandInTransaction(tx, {
          tenantId,
          invocationId: invocation.id,
          commandType: "cancel",
          idempotencyKey: `a01-t05:${randomUUID()}`,
          payloadJson: { probe: "rollback" },
          requestedByType: "user",
          requestedById: ctx.ownerId,
        });
        throw new Error("a01-t05-rollback");
      }),
    ).rejects.toThrow("a01-t05-rollback");
    const commandsAfterRollback = await db
      .select({ id: invocationCommandTable.id })
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, tenantId),
          eq(invocationCommandTable.invocationId, invocation.id),
        ),
      );
    expect(commandsAfterRollback).toHaveLength(0);

    // 环境租赁模块：Revision 校验 + INSERT + 回读三步同属一个事务。
    const definition = await createEnvironmentDefinition({
      tenantId,
      environmentKey: `a01t05-${randomUUID().slice(0, 8)}`,
      displayName: "A01-T05 事务边界",
      revision: {
        environmentType: "sandbox",
        filesystemPolicyJson: { writeRoots: ["workspace"] },
        networkPolicyJson: { egress: "deny_all" },
        resourceLimitsJson: { cpu: 2, memoryMb: 2048 },
        secretPolicyJson: { inject: "none" },
        executionTarget: { kind: "container", image: "snowharness/test:latest" },
        requiredCapabilities: { isolation: true },
        createdByType: "service",
        createdById: "a01-t05",
      },
    });
    const revisionId = definition.currentRevisionId;
    if (!revisionId) throw new Error("EnvironmentRevision 未创建");
    const leaseInput = {
      tenantId,
      invocationId: invocation.id,
      attemptId: attempt.id,
      environmentDefinitionRevisionId: revisionId,
    };
    await expect(
      db.transaction(async (tx) => {
        await createEnvironmentLeaseInTransaction(tx, leaseInput);
        throw new Error("a01-t05-lease-rollback");
      }),
    ).rejects.toThrow("a01-t05-lease-rollback");
    const leasesAfterRollback = await db
      .select({ id: environmentLeaseTable.id })
      .from(environmentLeaseTable)
      .where(
        and(
          eq(environmentLeaseTable.tenantId, tenantId),
          eq(environmentLeaseTable.attemptId, attempt.id),
        ),
      );
    expect(leasesAfterRollback).toHaveLength(0);

    // 正向对照：公共包装自开事务并提交 —— 证明上面的 0 行来自回滚，而不是写入从未发生。
    const committed = await createEnvironmentLease(leaseInput);
    const leasesCommitted = await db
      .select({ id: environmentLeaseTable.id })
      .from(environmentLeaseTable)
      .where(eq(environmentLeaseTable.id, committed.id));
    expect(leasesCommitted).toHaveLength(1);
  }, 30_000);

  // ──────────────── A01-T02/T03/T04：真实入口的换代、终态并发与目标冻结 ────────────────

  type ResumeInput = Parameters<typeof resumeRuntimeInvocation>[0];

  /**
   * A01-T02/T03/T04 共用的「活 Owner」夹具。
   *
   * 走真实调度（Route/Revision/Binding/Attempt）→ 真实候选准备 → 真实代际；
   * 不为任何用例伪造 Ownership 或 Session 行。
   */
  async function seedActiveOwner(input: { phase: "dispatching" | "executing" }) {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
    });
    const invocation = dispatch.invocation;
    const binding = dispatch.binding;
    const attempt = dispatch.attempt;
    if (!invocation || !binding || !attempt) throw new Error("调度失败");
    await markPrepared(ctx.tenantId, invocation.id, attempt.id);
    const gen = await acquireTestRuntimeAuthority({
      tenantId: ctx.tenantId,
      invocationId: invocation.id,
      attemptId: attempt.id,
      runtimeRevisionId: binding.runtimeRevisionId,
      runtimeCapabilitiesJson: ctx.runtimeRevision.runtimeCapabilitiesJson,
      phase: input.phase,
      // `dispatching` 阶段就必须带真实激活证据：接纳 `execution.started` 时 applyLifecycle
      // 会把 executionPhase 推到 `executing`，而 canonical
      // `ExecutionOwnership_executing_activation_shape` 要求那一刻已有
      // activatedAt + activationEvidence/Digest（与生产 startRuntimeInvocation 同形）。
      ...(input.phase === "dispatching"
        ? {
            activationEvidence: {
              kind: "lock-order-active-runtime",
              invocationId: invocation.id,
              attemptId: attempt.id,
            },
          }
        : {}),
    });
    return { ctx, invocation, binding, attempt, gen };
  }

  /**
   * 复用**已有租户与 RuntimeRevision**的活 Owner 夹具。
   *
   * `DeploymentRouteSet` 的唯一键是 `(tenant, targetKind, targetIdentity, routeScopeKey)`，
   * 因此同一个测试里不能再建第二个 RouteSet（ER_DUP_ENTRY）。候选准备仍走同一正式夹具。
   */
  async function seedReusableActiveOwner(input: {
    tenantId: string;
    runtimeRevisionId: string;
    runtimeCapabilitiesJson?: unknown;
    phase: "dispatching" | "executing";
  }) {
    const fixture = await seedPreparedRuntimeAttempt({
      tenantId: input.tenantId,
      runtimeRevisionId: input.runtimeRevisionId,
    });
    const gen = await acquireTestRuntimeAuthority({
      tenantId: input.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      ...(input.runtimeCapabilitiesJson === undefined
        ? {}
        : { runtimeCapabilitiesJson: input.runtimeCapabilitiesJson }),
      phase: input.phase,
      ...(input.phase === "dispatching"
        ? {
            activationEvidence: {
              kind: "lock-order-active-runtime",
              invocationId: fixture.invocation.id,
              attemptId: fixture.attempt.id,
            },
          }
        : {}),
    });
    return { fixture, gen };
  }

  /**
   * 真实 Resume 的默认入口输入（Hosted in-process transport）。
   *
   * A01 的关闭证据明确要求「A01-T02 必须走实际 Resume，而不是仅调用 Guard」，
   * 因此这里装配的是生产入口 `resumeRuntimeInvocation` 的完整输入。
   */
  function resumeInputFor(input: {
    tenantId: string;
    invocation: ResumeInput["invocation"];
    binding: ResumeInput["binding"];
    attempt: ResumeInput["attempt"];
    runtimeCapabilitiesJson: unknown;
  }): ResumeInput {
    const anchor = `resume:${input.invocation.id}`;
    return {
      tenantId: input.tenantId,
      sourceOperationKey: `invocation:${input.invocation.id}`,
      invocation: input.invocation,
      binding: input.binding,
      attempt: input.attempt,
      runtimeClient: createInProcessHostedRuntimeClient({
        tenantId: input.tenantId,
        publishedCapabilityEvidence: {
          runtimeRevisionId: input.binding.runtimeRevisionId,
          runtimeCapabilitiesJson: input.runtimeCapabilitiesJson,
        },
        applicationService: idleHostedService(input.invocation.id),
      }),
      runtimeEndpoint: "in-process://hosted",
      auth: { mode: "workload_token", token: "lock-order-token" },
      callbackEndpoints: CALLBACK_ENDPOINTS,
      anchor,
      anchorDigest: protocolDigest(anchor),
    };
  }

  /** 稳定错误身份：`ExecutionAuthorityError` 的 `name == code`，其余类只取一个可用标识。 */
  function errorIdentity(error: unknown): { code: string; name: string } {
    const candidate = error as { code?: string; name?: string } | null;
    return { code: candidate?.code ?? "", name: candidate?.name ?? "" };
  }

  /** 真实 Action admission（生产守卫的正式入口，不是"只测 Guard 自身"）。 */
  async function runActionGuard(input: {
    tenantId: string;
    authority: AuthorityIdentity;
    requiredPhase?: "dispatching" | "executing";
  }) {
    return db
      .transaction(async (tx) =>
        authorizeRuntimeAction({
          tenantId: input.tenantId,
          authority: input.authority,
          executor: tx,
          requiredPhase: input.requiredPhase ?? "dispatching",
          // `progress`：本用例观察代际与锁序，不让 Checkpoint Gate 参与判定。
          operationKind: "progress",
        }),
      )
      .then(
        () => ({ ok: true as const, error: null }),
        (error: unknown) => ({ ok: false as const, error }),
      );
  }

  /** 由当前 active Owner + 它的唯一 Session 重建准确 authority tuple。 */
  async function currentAuthorityOf(
    tenantId: string,
    invocationId: string,
  ): Promise<AuthorityIdentity> {
    const [owner] = await activeOwnerships(tenantId, invocationId);
    if (!owner) throw new Error("换代后没有 active Owner");
    const [session] = await db
      .select()
      .from(runtimeSessionBindingTable)
      .where(
        and(
          eq(runtimeSessionBindingTable.tenantId, tenantId),
          eq(runtimeSessionBindingTable.invocationId, invocationId),
          eq(runtimeSessionBindingTable.ownershipId, owner.id),
        ),
      )
      .limit(1);
    if (!session) throw new Error("active Owner 没有自洽的唯一 Session");
    return {
      invocationId,
      runtimeRevisionId: session.runtimeRevisionId,
      attemptId: owner.attemptId,
      ownershipId: owner.id,
      leaseEpoch: String(owner.leaseEpoch),
      sessionBindingId: session.id,
    };
  }

  /**
   * 把代际推到「可接纳执行事件」的形状：冻结语义请求与发布能力证据（生产同一仓储方法），
   * 再用**真实** `execution.started` 走正式 ingress 把它推到 active/executing。
   */
  async function activateForIngress(input: {
    tenantId: string;
    invocationId: string;
    binding: { runtimeRevisionId: string };
    gen: Awaited<ReturnType<typeof acquireTestRuntimeAuthority>>;
    runtimeCapabilitiesJson: unknown;
  }): Promise<void> {
    const semanticRequest = { invocationId: input.invocationId, fixture: "lock-order-ingress" };
    const semanticRequestDigest = protocolDigest(semanticRequest);
    const remoteSessionRef = `runtime-session:${input.gen.session.id}`;
    const remoteExecutionRef = `runtime-execution:${input.invocationId}`;
    const capabilitiesDigest = expectedCapabilityManifestDigest({
      runtimeRevisionId: input.binding.runtimeRevisionId,
      runtimeCapabilitiesJson: input.runtimeCapabilitiesJson,
    });
    await applyRuntimeSessionDispatchForTest(input.tenantId, input.gen.session.id, {
      bindingState: "dispatching",
      semanticRequestJson: semanticRequest,
      semanticRequestDigest,
      remoteSessionRef,
      remoteExecutionRef,
      transportAcknowledgement: { capabilitiesDigest },
    });
    await ingressRuntimeEvents({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      batch: {
        protocolVersion: 3,
        authority: input.gen.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "1",
            type: "execution.started",
            schemaVersion: 1,
            payload: {
              intentKey: input.gen.session.startIntentKey,
              semanticRequestDigest,
              remoteSessionRef,
              remoteExecutionRef,
              capabilitiesDigest,
            },
          },
        ],
      },
    });
  }

  /** 在产品根上开一个「持锁屏障」：持住 Invocation 根锁直到被显式放行。 */
  function holdInvocationRoot(tenantId: string, invocationId: string) {
    const locked = deferred();
    const release = deferred();
    const transaction = db.transaction(async (tx) => {
      await tx
        .select({ id: invocationTable.id })
        .from(invocationTable)
        .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
        .for("update")
        .limit(1);
      locked.resolve();
      await release.promise;
    });
    return { locked, release, transaction };
  }

  it("A01-T02：真实 Resume 换代与 Action Guard 并发——两种线性化都符合当前代际规则", async () => {
    const first = await seedActiveOwner({ phase: "executing" });
    const tenantId = first.ctx.tenantId;
    const invocationId = first.invocation.id;
    const resumeInput = resumeInputFor({
      tenantId,
      invocation: first.invocation,
      binding: first.binding,
      attempt: first.attempt,
      runtimeCapabilitiesJson: first.ctx.runtimeRevision.runtimeCapabilitiesJson,
    });

    // ── 阶段 1：并发屏障。Resume 停在执行根锁上时不得已经握住 Ownership ──
    const holder = holdInvocationRoot(tenantId, invocationId);
    await holder.locked.promise;

    let resumeSettled = false;
    const pendingResume = resumeRuntimeInvocation(resumeInput).then(
      (result) => {
        resumeSettled = true;
        return result;
      },
      (error: unknown) => {
        resumeSettled = true;
        throw error;
      },
    );
    await sleep(200);

    // 旧实现（先 `SELECT ExecutionOwnership … FOR UPDATE` 再进 Acquire 去锁 I）会让 Resume
    // 握着这一行等 I；这里就会等到 innodb_lock_wait_timeout —— 即真实等待环的一半。
    const ownershipFreeWhileResumeWaits = await rowIsFree((tx) =>
      tx
        .select({ id: executionOwnershipTable.id })
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, tenantId),
            eq(executionOwnershipTable.id, first.gen.ownership.id),
          ),
        )
        .for("update")
        .limit(1),
    );
    expect(
      ownershipFreeWhileResumeWaits,
      "Resume 在等待 Invocation 根锁期间不得持有 Ownership 行",
    ).toBe(true);
    expect(resumeSettled, "Resume 应当仍被 Invocation 根锁挡住").toBe(false);

    holder.release.resolve();
    await holder.transaction;
    const resumeOutcome = await pendingResume.then(
      (result) => ({ ok: true as const, error: null, result }),
      (error: unknown) => ({ ok: false as const, error, result: null }),
    );
    expect(resumeOutcome.ok, "真实 Resume 必须完成换代").toBe(true);
    expect(resumeSettled).toBe(true);
    const activesAfterResume = await activeOwnerships(tenantId, invocationId);
    expect(activesAfterResume).toHaveLength(1);
    expect(activesAfterResume[0]?.id).not.toBe(first.gen.ownership.id);

    // ── 阶段 2：线性化之一 —— Resume 先换代，Guard 后到 ──
    const staleGuard = await runActionGuard({ tenantId, authority: first.gen.authority });
    expect(staleGuard.ok, "换代之后旧 tuple 不得再通过 Action Guard").toBe(false);
    expect(errorIdentity(staleGuard.error).code).toBe("NotCurrentExecutor");
    expect(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]).not.toContain(
      errorIdentity(staleGuard.error).code,
    );
    const activesAfterStaleGuard = await activeOwnerships(tenantId, invocationId);
    expect(activesAfterStaleGuard).toHaveLength(1);
    expect(activesAfterStaleGuard[0]?.id, "失败的 Guard 不得复活旧代际").toBe(
      activesAfterResume[0]?.id,
    );
    // 换代后的代际本身必须能通过同一守卫：拒绝不是"守卫坏了"。
    const freshGuard = await runActionGuard({
      tenantId,
      authority: await currentAuthorityOf(tenantId, invocationId),
    });
    expect(freshGuard.ok, "换代后的当前代际必须通过 Action Guard").toBe(true);

    // ── 阶段 3：线性化之二 —— Guard 先（旧代际仍健康）通过，Resume 随后换代 ──
    // 复用同一租户与 RuntimeRevision（RouteSet 唯一键不允许同测试内重复建）。
    const runtimeCapabilitiesJson = first.ctx.runtimeRevision.runtimeCapabilitiesJson;
    const second = await seedReusableActiveOwner({
      tenantId,
      runtimeRevisionId: first.binding.runtimeRevisionId,
      runtimeCapabilitiesJson,
      phase: "dispatching",
    });
    // 让第二个代际同样是「已激活、正在执行」的活 Owner：真实 `execution.started` 接纳。
    await activateForIngress({
      tenantId,
      invocationId: second.fixture.invocation.id,
      binding: second.fixture.binding,
      gen: second.gen,
      runtimeCapabilitiesJson,
    });
    const guardFirst = await runActionGuard({
      tenantId,
      authority: second.gen.authority,
      requiredPhase: "executing",
    });
    expect(guardFirst.ok, "旧代际仍健康时 Guard 必须通过").toBe(true);
    await expect(
      resumeRuntimeInvocation(
        resumeInputFor({
          tenantId,
          invocation: second.fixture.invocation,
          binding: second.fixture.binding,
          attempt: second.fixture.attempt,
          runtimeCapabilitiesJson,
        }),
      ),
    ).resolves.toBeTruthy();
    const secondActives = await activeOwnerships(tenantId, second.fixture.invocation.id);
    expect(secondActives).toHaveLength(1);
    expect(secondActives[0]?.id).not.toBe(second.gen.ownership.id);
  }, 60_000);

  it("A01-T03：Interrupt 与终态 Ingress 并发——产品/执行事实收敛，且无产品根→执行根反向等待", async () => {
    const fixture = await seedActiveOwner({ phase: "dispatching" });
    const tenantId = fixture.ctx.tenantId;
    const invocationId = fixture.invocation.id;
    await activateForIngress({
      tenantId,
      invocationId,
      binding: fixture.binding,
      gen: fixture.gen,
      runtimeCapabilitiesJson: fixture.ctx.runtimeRevision.runtimeCapabilitiesJson,
    });
    // 真实 Thread/Turn + 活 Owner：Turn 处于可中断状态且绑定当前 Invocation。
    await db
      .update(turnTable)
      .set({
        turnState: "running",
        activeInvocationId: invocationId,
        latestInvocationId: invocationId,
        startedAt: new Date(),
      })
      .where(eq(turnTable.id, fixture.ctx.turnId));

    const holder = holdInvocationRoot(tenantId, invocationId);
    await holder.locked.promise;

    const interruptKey = `a01t03:${randomUUID()}`;
    // 连接 B：真实终态 Ingress（另一条真实入口）。
    const pendingIngress = ingressRuntimeEvents({
      tenantId,
      invocationId,
      batch: {
        protocolVersion: 3,
        authority: fixture.gen.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "2",
            type: "execution.completed",
            schemaVersion: 1,
            payload: { finish_reason: "execution.completed" },
          },
        ],
      },
    }).then(
      (result) => ({ ok: true as const, error: null, result }),
      (error: unknown) => ({ ok: false as const, error, result: null }),
    );
    // 连接 C：真实产品控制命令接纳（不 mock `createInvocationCommand` / 终态 helper）。
    const pendingInterrupt = requestInterrupt({
      tenantId,
      ownerUserId: fixture.ctx.ownerId,
      turnId: fixture.ctx.turnId,
      reasonCode: "user_stop",
      idempotencyKey: interruptKey,
    }).then(
      (result) => ({ ok: true as const, error: null, result }),
      (error: unknown) => ({ ok: false as const, error, result: null }),
    );
    await sleep(200);

    // 两条真实入口在等待执行根期间都**不得**握住产品根（Turn）——这正是
    // 「产品根 → 执行根」反向等待的可观察判据。
    const turnFreeWhileWaiting = await rowIsFree((tx) =>
      tx
        .select({ id: turnTable.id })
        .from(turnTable)
        .where(eq(turnTable.id, fixture.ctx.turnId))
        .for("update")
        .limit(1),
    );
    expect(turnFreeWhileWaiting, "等待执行根期间不得持有 Turn 行").toBe(true);
    const commandsWhileWaiting = await db
      .select({ id: invocationCommandTable.id })
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, tenantId),
          eq(invocationCommandTable.idempotencyKey, interruptKey),
        ),
      );
    expect(commandsWhileWaiting, "取得执行根之前不得有任何产品事实").toHaveLength(0);

    holder.release.resolve();
    await holder.transaction;
    const ingressOutcome = await pendingIngress;
    const interruptOutcome = await pendingInterrupt;

    // 执行事实必须收敛。
    expect(ingressOutcome.ok, "终态 Ingress 必须成功收口").toBe(true);
    const [invocationAfter] = await db
      .select()
      .from(invocationTable)
      .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
      .limit(1);
    expect(invocationAfter?.executionState).toBe("completed");
    const [turnAfter] = await db
      .select({ turnState: turnTable.turnState })
      .from(turnTable)
      .where(eq(turnTable.id, fixture.ctx.turnId))
      .limit(1);
    expect(["completed", "failed", "cancelled", "interrupted"]).toContain(turnAfter?.turnState);

    const [command] = await db
      .select({ id: invocationCommandTable.id, invocationId: invocationCommandTable.invocationId })
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, tenantId),
          eq(invocationCommandTable.idempotencyKey, interruptKey),
        ),
      );
    const [interruptEvent] = await db
      .select({ id: threadEventTable.id })
      .from(threadEventTable)
      .where(
        and(
          eq(threadEventTable.threadId, fixture.ctx.threadId),
          eq(threadEventTable.idempotencyKey, interruptKey),
        ),
      );

    if (interruptOutcome.ok) {
      // 线性化之一：Interrupt 先入队，随后执行事实收口 —— 命令与产品事件都必须在。
      expect(interruptOutcome.result?.targetInvocationId).toBe(invocationId);
      expect(command?.invocationId, "入队的 Interrupt 必须指向本 Invocation").toBe(invocationId);
      expect(interruptEvent, "入队的 Interrupt 必须留下 turn.interrupt_requested").toBeTruthy();
    } else {
      // 线性化之二：终态先到，产品命令必须被**明确**拒绝且零副作用
      // ——不是死锁、不是超时，也不是"没报错但什么也没做"。
      const identity = errorIdentity(interruptOutcome.error);
      expect(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]).not.toContain(identity.code);
      expect(
        identity.name,
        `失败方必须是稳定的产品/执行态冲突：${identity.name}/${identity.code}`,
      ).toMatch(/Conflict(Error)?$/);
      expect(command, "被拒绝的 Interrupt 不得留下命令").toBeUndefined();
      expect(interruptEvent, "被拒绝的 Interrupt 不得留下产品事件").toBeUndefined();
    }
  }, 60_000);

  it("A01-T04：非锁定定位之后活动执行被切走——按原冻结目标拒绝，绝不写新目标的执行事实", async () => {
    const fixture = await seedActiveOwner({ phase: "dispatching" });
    const tenantId = fixture.ctx.tenantId;
    const invocationId = fixture.invocation.id;
    await db
      .update(turnTable)
      .set({
        turnState: "running",
        activeInvocationId: invocationId,
        latestInvocationId: invocationId,
        startedAt: new Date(),
      })
      .where(eq(turnTable.id, fixture.ctx.turnId));

    // 正向对照：活动执行未被切走时，同一入口必须真正入队 ——
    // 否则后面那句"被拒绝"就没有解释力（无法排除入口本身不可用）。
    const controlKey = `a01t04-control:${randomUUID()}`;
    const control = await requestInterrupt({
      tenantId,
      ownerUserId: fixture.ctx.ownerId,
      turnId: fixture.ctx.turnId,
      reasonCode: "user_stop",
      idempotencyKey: controlKey,
    });
    expect(control.targetInvocationId).toBe(invocationId);
    expect(control.command.commandState).toBe("queued");

    // 屏障：真实 Interrupt 的非锁定定位已完成，随后停在 I1 执行根锁上。
    const holder = holdInvocationRoot(tenantId, invocationId);
    await holder.locked.promise;
    const subjectKey = `a01t04-subject:${randomUUID()}`;
    let subjectSettled = false;
    const pendingInterrupt = requestInterrupt({
      tenantId,
      ownerUserId: fixture.ctx.ownerId,
      turnId: fixture.ctx.turnId,
      reasonCode: "user_stop",
      idempotencyKey: subjectKey,
    }).then(
      (result) => {
        subjectSettled = true;
        return { ok: true as const, error: null, result };
      },
      (error: unknown) => {
        subjectSettled = true;
        return { ok: false as const, error, result: null };
      },
    );
    await sleep(200);
    expect(subjectSettled, "旧请求应当停在执行根锁上").toBe(false);

    // 另事务：真实新代际 Invocation I2 + 把 Turn 的活动执行切到 I2。
    // 只改活动指针、保持 `running`：这样"被拒绝"只能归因于**冻结目标失效**，
    // 而不是 Turn 恰好变成了终态。
    const second = await createInvocation({
      tenantId,
      threadId: fixture.ctx.threadId,
      turnId: fixture.ctx.turnId,
      triggerItemId: fixture.ctx.triggerItemId,
      invocationKind: "regenerate",
    });
    await db.transaction(async (tx) => {
      await tx
        .update(turnTable)
        .set({
          activeInvocationId: second.invocation.id,
          latestInvocationId: second.invocation.id,
          versionNo: sql`${turnTable.versionNo} + 1`,
        })
        .where(eq(turnTable.id, fixture.ctx.turnId));
    });
    const [secondBefore] = await db
      .select({
        executionState: invocationTable.executionState,
        lastProducerSequence: invocationTable.lastProducerSequence,
        versionNo: invocationTable.versionNo,
      })
      .from(invocationTable)
      .where(
        and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, second.invocation.id)),
      )
      .limit(1);

    holder.release.resolve();
    await holder.transaction;
    const outcome = await pendingInterrupt;

    expect(outcome.ok, "活动执行已被切走时，旧请求必须按原冻结目标拒绝").toBe(false);
    const identity = errorIdentity(outcome.error);
    expect(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]).not.toContain(identity.code);
    expect(
      identity.name,
      `失败方必须是稳定的产品态冲突：${identity.name}/${identity.code}`,
    ).toMatch(/Conflict(Error)?$/);

    // 零副作用：既没有为原目标建命令，也没有写任何产品事件。
    const [subjectCommand] = await db
      .select({ id: invocationCommandTable.id })
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, tenantId),
          eq(invocationCommandTable.idempotencyKey, subjectKey),
        ),
      );
    expect(subjectCommand, "被拒绝的请求不得留下 InvocationCommand").toBeUndefined();
    const [subjectEvent] = await db
      .select({ id: threadEventTable.id })
      .from(threadEventTable)
      .where(
        and(
          eq(threadEventTable.threadId, fixture.ctx.threadId),
          eq(threadEventTable.idempotencyKey, subjectKey),
        ),
      );
    expect(subjectEvent, "被拒绝的请求不得留下产品事件").toBeUndefined();

    // 活动执行仍是 I2：旧请求不得把它改回原目标。
    const [turnAfter] = await db
      .select({ activeInvocationId: turnTable.activeInvocationId })
      .from(turnTable)
      .where(eq(turnTable.id, fixture.ctx.turnId))
      .limit(1);
    expect(turnAfter?.activeInvocationId).toBe(second.invocation.id);

    // 未持 I2 锁就绝不写 I2 的执行事实：I2 的行逐项未变。
    const [secondAfter] = await db
      .select({
        executionState: invocationTable.executionState,
        lastProducerSequence: invocationTable.lastProducerSequence,
        versionNo: invocationTable.versionNo,
      })
      .from(invocationTable)
      .where(
        and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, second.invocation.id)),
      )
      .limit(1);
    expect(secondAfter).toEqual(secondBefore);
  }, 60_000);
});
