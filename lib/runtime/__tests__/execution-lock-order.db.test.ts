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
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { requireCurrentExecutionAuthority } from "@/lib/executions/application/require-current-execution-authority";
import { markAttemptPreparedInTransaction } from "@/lib/executions/persistence/attempt-store";
import { acquireTestRuntimeAuthority } from "@/lib/executions/test-support/seed-runtime-authority";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
import { turnTable } from "@/lib/persistence/schema/conversation";
import {
  executionOwnershipTable,
  invocationCommandTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
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
});
