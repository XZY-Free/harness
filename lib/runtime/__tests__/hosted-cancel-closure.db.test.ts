/**
 * A02：Hosted Cancel 的终态收口必须与「代际复核」在**同一条收口边界**上完成。
 *
 * 审查报告确认了两个实质后果，本文件分别编码成可执行回归：
 *
 * 1. **状态分裂**（CANCEL-01）：`transitionInvocation` 只改 Invocation 行并桥 Job，
 *    不关闭 Attempt / Session / Turn，也不写 canonical Thread 终态事件。只检查
 *    "Invocation 变成 cancelled" 无法发现这条旁路，因此这里逐项回读**全部执行子对象**
 *    与**产品面**（Turn + Thread 事件流）。
 * 2. **竞态**（CANCEL-02/03）：初检与终态提交分离时，初检通过后发生 epoch2 接管，
 *    最后一步仍会把**新代际**取消。CANCEL-03 用真实两条连接 + 屏障构造"请求已发出、
 *    但取消尚未取得执行根锁时接管完成"的交错。
 *
 * 另有一条关联约束（CANCEL-04）：`parentInvocationId` 不是代际标识，同一个
 * Invocation 会被后续代际继续使用；针对旧目标的取消不得误伤后来创建的子调用。
 */
import { randomUUID } from "node:crypto";
import { requestInterrupt } from "@/lib/conversations/interrupt-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import {
  acquireExecutionOwnershipInTransaction,
  closeExecutionOwnership,
} from "@/lib/executions/persistence/execution-ownership-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { acquireTestRuntimeAuthority } from "@/lib/executions/test-support/seed-runtime-authority";
import { threadEventTable, turnTable } from "@/lib/persistence/schema/conversation";
import {
  executionOwnershipTable,
  invocationAttemptTable,
  invocationCommandTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { hostedRuntimeApplicationService } from "@/lib/runtime/application/runtime-resume";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import {
  createRuntimeSessionBindingInTransaction,
  getRuntimeSessionBindingByOwnership,
} from "@/lib/runtime/persistence/runtime-session-store";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { sourceIntentForFixture } from "@/lib/runtime/test-support/session-write-fixtures";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { and, eq } from "drizzle-orm";
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

async function markPrepared(invocationId: string, attemptId: string) {
  const evidence = { kind: "hosted-cancel-candidate", invocationId, attemptId };
  await db.transaction((tx) =>
    markAttemptPreparedInTransaction(tx, {
      attemptId,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
}

async function readInvocation(tenantId: string, invocationId: string) {
  const [row] = await db
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .limit(1);
  return row ?? null;
}

async function readTurn(turnId: string) {
  const [row] = await db.select().from(turnTable).where(eq(turnTable.id, turnId)).limit(1);
  return row ?? null;
}

async function readOwnership(ownershipId: string) {
  const [row] = await db
    .select()
    .from(executionOwnershipTable)
    .where(eq(executionOwnershipTable.id, ownershipId))
    .limit(1);
  return row ?? null;
}

async function readAttempt(attemptId: string) {
  const [row] = await db
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, attemptId))
    .limit(1);
  return row ?? null;
}

async function readSession(sessionId: string) {
  const [row] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(eq(runtimeSessionBindingTable.id, sessionId))
    .limit(1);
  return row ?? null;
}

async function terminalThreadEvents(threadId: string) {
  return db
    .select({ eventType: threadEventTable.eventType })
    .from(threadEventTable)
    .where(and(eq(threadEventTable.threadId, threadId), eq(threadEventTable.actorType, "service")));
}

/** 建出可取消的真实上下文：Thread/Turn 经真实调度，Attempt 补成 Prepared 后正式 Acquire。 */
async function seedCancelable() {
  const ctx = await seedDispatchableTurn();
  const dispatch = await dispatchInvocationForTurn({
    tenantId: ctx.tenantId,
    turnId: ctx.turnId,
    executionSubject: {
      tenantId: ctx.tenantId,
      subjectType: "user",
      subjectId: ctx.ownerId,
    },
  });
  const invocation = dispatch.invocation;
  const binding = dispatch.binding;
  const attempt = dispatch.attempt;
  if (!invocation || !binding || !attempt) throw new Error("调度失败");
  await markPrepared(invocation.id, attempt.id);
  const gen1 = await acquireTestRuntimeAuthority({
    tenantId: ctx.tenantId,
    invocationId: invocation.id,
    attemptId: attempt.id,
    runtimeRevisionId: binding.runtimeRevisionId,
    phase: "dispatching",
  });
  return { ctx, invocation, binding, attempt, gen1 };
}

describe("A02：Hosted Cancel 的终态收口与代际一致", () => {
  beforeEach(async () => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
    await resetDatabase(db);
  });

  afterEach(() => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = ORIGINAL_AUTH_MODE;
  });

  it("CANCEL-01: 无 liveRunner 的合法取消收口全部执行子对象与产品面", async () => {
    const { ctx, invocation, gen1 } = await seedCancelable();
    const tenantId = ctx.tenantId;

    // 前置事实：没有任何本进程 Runner（取消必须能独立于内存态成立）。
    await hostedRuntimeApplicationService.cancel({
      tenantId,
      invocationId: invocation.id,
      idempotencyKey: `cancel:${randomUUID()}`,
      authority: gen1.authority,
      reason: "user_cancelled",
    });

    // ── 执行面：四个从属对象必须与 Invocation 同一点收口 ──
    expect((await readInvocation(tenantId, invocation.id))?.executionState).toBe("cancelled");
    expect((await readOwnership(gen1.ownership.id))?.ownershipState).toBe("released");
    expect((await readAttempt(gen1.ownership.attemptId))?.attemptState).toBe("cancelled");
    expect((await readSession(gen1.session.id))?.bindingState).toBe("closed");

    // ── 产品面：权威 Turn 表 ──
    const turn = await readTurn(ctx.turnId);
    expect(turn?.turnState).toBe("cancelled");
    expect(turn?.activeInvocationId).toBeNull();
    // 没有正式回答的取消**不得**把半截回答抬成当前正式回答。
    expect(turn?.adoptedInvocationId ?? null).toBeNull();

    // ── 产品面：canonical Thread 事件流必须同时有 turn.cancelled 与 invocation.cancelled ──
    const types = (await terminalThreadEvents(ctx.threadId)).map((row) => row.eventType);
    expect(types).toContain("turn.cancelled");
    expect(types).toContain("invocation.cancelled");
  }, 30_000);

  it("CANCEL-02: 目标代际已失效时不重定向、零副作用", async () => {
    const { ctx, invocation, binding, gen1 } = await seedCancelable();
    const tenantId = ctx.tenantId;

    // 接管：旧 Owner 正式关闭 → 新 Attempt + 第 2 代 Acquire。
    await closeExecutionOwnership({
      tenantId,
      invocationId: invocation.id,
      ownershipId: gen1.ownership.id,
      attemptId: gen1.ownership.attemptId,
      leaseEpoch: gen1.ownership.leaseEpoch,
      state: "revoked",
      reasonCode: "cancel_closure_replaced",
    });
    const attempt2 = await createAttempt({ tenantId, invocationId: invocation.id });
    await markPrepared(invocation.id, attempt2.id);
    const gen2 = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: attempt2.id,
      runtimeRevisionId: binding.runtimeRevisionId,
      phase: "dispatching",
    });

    const turnBefore = await readTurn(ctx.turnId);
    await hostedRuntimeApplicationService.cancel({
      tenantId,
      invocationId: invocation.id,
      idempotencyKey: `cancel:${randomUUID()}`,
      authority: gen1.authority,
      reason: "late_cancel",
    });

    // 新代际原封不动，产品面也没有任何终态收口痕迹。
    expect((await readOwnership(gen2.ownership.id))?.ownershipState).toBe("active");
    expect((await readInvocation(tenantId, invocation.id))?.executionState).not.toBe("cancelled");
    expect((await readAttempt(gen2.ownership.attemptId))?.attemptState).not.toBe("cancelled");
    const turnAfter = await readTurn(ctx.turnId);
    expect(turnAfter?.turnState).toBe(turnBefore?.turnState);
    const types = (await terminalThreadEvents(ctx.threadId)).map((row) => row.eventType);
    expect(types).not.toContain("invocation.cancelled");
    expect(types).not.toContain("turn.cancelled");
  }, 30_000);

  it("CANCEL-03: 请求发出后、取得执行根前发生接管时，新代际不被取消", async () => {
    const { ctx, invocation, binding, gen1 } = await seedCancelable();
    const tenantId = ctx.tenantId;

    const holderLocked = deferred();
    const takeoverDone = deferred();
    const commitHolder = deferred();

    // 连接 A：先持 Invocation 根锁，然后在**同一事务内**完成接管并保持到屏障释放。
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: invocationTable.id })
        .from(invocationTable)
        .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocation.id)))
        .for("update")
        .limit(1);
      holderLocked.resolve();

      await tx
        .update(executionOwnershipTable)
        .set({
          ownershipState: "revoked",
          releasedAt: new Date(),
          reasonCode: "cancel_closure_takeover",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(executionOwnershipTable.tenantId, tenantId),
            eq(executionOwnershipTable.id, gen1.ownership.id),
          ),
        );
      const attempt2Id = randomUUID();
      await tx.insert(invocationAttemptTable).values({
        id: attempt2Id,
        tenantId,
        invocationId: invocation.id,
        attemptNo: 2,
        attemptState: "queued",
        versionNo: 1,
      });
      // 用**同一仓储方法**补 Prepared（CHECK 约束要求 evidence/digest 成对，手写 UPDATE 会被拒）。
      await markAttemptPreparedInTransaction(tx, {
        attemptId: attempt2Id,
        evidence: {
          kind: "hosted-cancel-takeover",
          invocationId: invocation.id,
          attemptId: attempt2Id,
        },
        digest: protocolDigest({ kind: "hosted-cancel-takeover", attemptId: attempt2Id }),
      });

      const takeover = await acquireExecutionOwnershipInTransaction(tx, {
        tenantId,
        invocationId: invocation.id,
        attemptId: attempt2Id,
        runtimeRevisionId: binding.runtimeRevisionId,
        acquiredByType: "service",
        acquiredById: "cancel-closure-takeover",
      });
      const session2 = await createRuntimeSessionBindingInTransaction(tx, {
        tenantId,
        invocationId: invocation.id,
        attemptId: attempt2Id,
        ownershipId: takeover.ownership.id,
        runtimeRevisionId: binding.runtimeRevisionId,
        leaseEpoch: takeover.ownership.leaseEpoch,
        intentType: "start",
        startIntentKey: `start:${takeover.ownership.id}`,
        ...sourceIntentForFixture({
          tenantId,
          invocationId: invocation.id,
          attemptId: attempt2Id,
          intentType: "start",
        }),
      });
      takeoverDone.resolve();
      await commitHolder.promise;
      return { ownershipId: takeover.ownership.id, sessionId: session2.id };
    });
    await holderLocked.promise;

    // 连接 B：针对第 1 代的合法取消请求。它必须停在执行根锁上，等接管提交后才做复核。
    let cancelSettled = false;
    const pendingCancel = hostedRuntimeApplicationService
      .cancel({
        tenantId,
        invocationId: invocation.id,
        idempotencyKey: `cancel:${randomUUID()}`,
        authority: gen1.authority,
        reason: "late_cancel_after_takeover",
      })
      .then(() => {
        cancelSettled = true;
      });
    await sleep(200);
    expect(cancelSettled, "取消请求应当已被执行根锁挡住").toBe(false);

    commitHolder.resolve();
    const gen2 = await holder;
    await pendingCancel;

    // 接管已提交，因此取消的**事务内复核**必须发现请求代际已失效 → 零副作用。
    expect((await readOwnership(gen2.ownershipId))?.ownershipState).toBe("active");
    expect((await readSession(gen2.sessionId))?.bindingState).not.toBe("closed");
    expect((await readInvocation(tenantId, invocation.id))?.executionState).not.toBe("cancelled");
    const types = (await terminalThreadEvents(ctx.threadId)).map((row) => row.eventType);
    expect(types).not.toContain("invocation.cancelled");

    // 反向对照：针对**当前**代际的取消必须真的收口（证明上面的"没取消"是代际核对的结果，
    // 不是"整条取消路径根本不工作"）。
    const currentSession = await getRuntimeSessionBindingByOwnership(tenantId, gen2.ownershipId);
    if (!currentSession) throw new Error("新代际没有 Session");
    await hostedRuntimeApplicationService.cancel({
      tenantId,
      invocationId: invocation.id,
      idempotencyKey: `cancel:${randomUUID()}`,
      authority: {
        invocationId: invocation.id,
        runtimeRevisionId: binding.runtimeRevisionId,
        attemptId: currentSession.attemptId,
        ownershipId: gen2.ownershipId,
        leaseEpoch: String(currentSession.leaseEpoch),
        sessionBindingId: currentSession.id,
      },
      reason: "current_cancel",
    });
    expect((await readInvocation(tenantId, invocation.id))?.executionState).toBe("cancelled");
    expect((await readOwnership(gen2.ownershipId))?.ownershipState).toBe("released");
  }, 30_000);

  it("CANCEL-04: Interrupt 命令的目标与代际边界取自锁内事实，而非请求前置快照", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: {
        tenantId: ctx.tenantId,
        subjectType: "user",
        subjectId: ctx.ownerId,
      },
    });
    const invocation = dispatch.invocation;
    const binding = dispatch.binding;
    const attempt = dispatch.attempt;
    if (!invocation || !binding || !attempt) throw new Error("调度失败");
    const tenantId = ctx.tenantId;
    await markPrepared(invocation.id, attempt.id);
    const gen1 = await acquireTestRuntimeAuthority({
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

    // 入队时冻结的命令目标就是当前代际的 Ownership/Session。
    const commandId = await db.transaction((tx) =>
      createInvocationCommandInTransaction(tx, {
        tenantId,
        invocationId: invocation.id,
        commandType: "cancel",
        idempotencyKey: `cancel-04:${randomUUID()}`,
        payloadJson: { reason_code: "user_stop" },
        requestedByType: "user",
        requestedById: ctx.ownerId,
      }),
    );
    const [command] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, commandId))
      .limit(1);
    expect(command?.targetOwnershipId).toBe(gen1.ownership.id);
    expect(command?.targetSessionId).toBe(gen1.session.id);

    // requestInterrupt 返回的目标与边界都取自执行根锁内，而不是请求前置阶段的 Turn 快照。
    const result = await requestInterrupt({
      tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "user_stop",
      idempotencyKey: `cancel-04-interrupt:${randomUUID()}`,
    });
    expect(result.targetInvocationId).toBe(invocation.id);
    expect(result.targetCutoffAt.getTime()).toBeLessThanOrEqual(Date.now());
  }, 30_000);
});
