/**
 * A11：Hosted transient（response.delta 等）必须绑定**当前执行代际**，旧执行者
 * 失权后的迟到增量不得进入新代际的展示流。
 *
 * 审查报告指出的缺口：`ingressTransientBatch` 只验证 Invocation 存在、非终态、
 * 批内序列连续，不验证 Attempt/Ownership/leaseEpoch；发布给客户端的数据里也没有
 * 任何可用于区分旧代际的身份。接管之后 Invocation 仍在运行，旧 Hosted 执行者在
 * 发现租约丢失/abort 生效之前发出的 delta 就会混进当前页面。
 *
 * 报告明确的边界：
 * - **不**把 transient 变成持久账本（它本来就不该进永久账本）。
 * - 要求的是"代际标记 + 发送/消费侧隔离"。
 *
 * 本文件在**真实 MySQL**上验证这三件事：
 * 1. TRANSIENT-GEN-01：当前代际的批次被接纳，投递项携带完整代际标记。
 * 2. TRANSIENT-GEN-02：接管后旧代际的迟到 delta 被**拒绝**，且总线里一个事件都没有
 *    ——即"旧执行者污染当前展示"被堵在发送侧，而不是交给客户端去猜。同一测试用
 *    新代际的反向对照证明通道本身仍然工作。
 * 3. TRANSIENT-GEN-03：代际是**逐项**复核的 —— 只带对 ownershipId 不够，
 *    leaseEpoch / Session / RuntimeRevision 任一不符都必须 fail closed。
 *
 * 消费侧隔离的证据在 `lib/conversations/sse-api.test.ts`：SSE 投递项必须携带
 * `generation`（attempt_id/ownership_id/lease_epoch）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { closeExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { acquireTestRuntimeAuthority } from "@/lib/executions/test-support/seed-runtime-authority";
import { IngressAuthorityMismatchError } from "@/lib/runtime/application/ingress-runtime-events";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { type AuthorityIdentity, protocolDigest } from "@/lib/runtime/runtime-protocol";
import {
  type ThreadTransientEvent,
  subscribeThreadTransientEvents,
} from "@/lib/runtime/transient-event-bus";
import { ingressTransientBatch } from "@/lib/runtime/transient-events";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_VITEST_IDENTITY_FIXTURE;

async function markPrepared(invocationId: string, attemptId: string) {
  const evidence = { kind: "transient-generation-candidate", invocationId, attemptId };
  await db.transaction((tx) =>
    markAttemptPreparedInTransaction(tx, {
      attemptId,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
}

/** 建出"当前有一代 Hosted 执行者正在跑"的真实上下文（Thread/Turn 走真实调度）。 */
async function seedExecuting() {
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
  const gen = await acquireTestRuntimeAuthority({
    tenantId: ctx.tenantId,
    invocationId: invocation.id,
    attemptId: attempt.id,
    runtimeRevisionId: binding.runtimeRevisionId,
    phase: "dispatching",
  });
  return { ctx, invocation, binding, attempt, gen };
}

/** 单事件批次的构造（transient 序号独立于持久 producerSequence）。 */
function batchOf(seq: number, delta: string, type = "response.delta") {
  return {
    transientSequenceStart: seq,
    events: [
      {
        transient_id: `transient-${seq}`,
        type,
        transient_sequence: seq,
        payload: { delta },
      },
    ],
  };
}

describe("A11：Hosted transient 的当前代际隔离", () => {
  beforeEach(async () => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
    await resetDatabase(db);
  });

  afterEach(() => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = ORIGINAL_AUTH_MODE;
  });

  it("TRANSIENT-GEN-01: 当前代际的 delta 被接纳，投递项带同一代际标记", async () => {
    const { ctx, invocation, gen } = await seedExecuting();
    const received: ThreadTransientEvent[] = [];
    // 先建活跃 listener 并打开 barrier：publish 走实时投递，不会落进一次性 buffer 干扰断言。
    const subscription = subscribeThreadTransientEvents(ctx.threadId, (event) =>
      received.push(event),
    );
    subscription.release(() => true);

    const result = await ingressTransientBatch({
      tenantId: ctx.tenantId,
      invocationId: invocation.id,
      authority: gen.authority,
      transientSequenceStart: 1,
      events: [
        {
          transient_id: "t-1",
          type: "response.delta",
          transient_sequence: 1,
          payload: { delta: "你" },
        },
        {
          transient_id: "t-2",
          type: "response.delta",
          transient_sequence: 2,
          payload: { delta: "好" },
        },
      ],
    });
    subscription.unsubscribe();

    expect(result.persisted).toBe(false);
    expect(result.acceptedThroughTransientSequence).toBe(2);
    expect(received.map((event) => event.payload.delta)).toEqual(["你", "好"]);
    for (const event of received) {
      expect(event.generation).toEqual({
        invocationId: invocation.id,
        attemptId: gen.ownership.attemptId,
        ownershipId: gen.ownership.id,
        leaseEpoch: String(gen.ownership.leaseEpoch),
      });
    }
  }, 30_000);

  it("TRANSIENT-GEN-02: 接管后旧代际的迟到 delta 被拒绝且不进展示流；新代际仍可发布", async () => {
    const { ctx, invocation, binding, gen } = await seedExecuting();
    const tenantId = ctx.tenantId;
    const received: ThreadTransientEvent[] = [];
    const subscription = subscribeThreadTransientEvents(ctx.threadId, (event) =>
      received.push(event),
    );
    subscription.release(() => true);

    // 接管：旧 Owner 正式关闭 → 新 Attempt + 第 2 代 Acquire（与生产接管同一条路径）。
    await closeExecutionOwnership({
      tenantId,
      invocationId: invocation.id,
      ownershipId: gen.ownership.id,
      attemptId: gen.ownership.attemptId,
      leaseEpoch: gen.ownership.leaseEpoch,
      state: "revoked",
      reasonCode: "transient_generation_takeover",
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
    expect(gen2.ownership.id).not.toBe(gen.ownership.id);
    expect(gen2.authority.leaseEpoch).not.toBe(gen.authority.leaseEpoch);

    // 旧执行者失权后按老 authority 发 delta：必须被拒，且**一个字节都没进展示流**。
    await expect(
      ingressTransientBatch({
        tenantId,
        invocationId: invocation.id,
        authority: gen.authority,
        ...batchOf(5, "旧代际残留"),
      }),
    ).rejects.toBeInstanceOf(IngressAuthorityMismatchError);
    expect(received).toEqual([]);

    // 反向对照：同一条通道对新代际仍然工作 —— 上面的"没收到"是代际核对的结果，
    // 不是"整条 transient 路径根本不投递"。
    await ingressTransientBatch({
      tenantId,
      invocationId: invocation.id,
      authority: gen2.authority,
      ...batchOf(6, "新代际正文"),
    });
    subscription.unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]?.payload.delta).toBe("新代际正文");
    expect(received[0]?.generation.ownershipId).toBe(gen2.ownership.id);
    expect(received[0]?.generation.attemptId).toBe(attempt2.id);
    expect(received[0]?.generation.leaseEpoch).toBe(String(gen2.ownership.leaseEpoch));
  }, 30_000);

  it("TRANSIENT-GEN-03: 代际逐项复核——epoch / Session / RuntimeRevision 任一不符都拒绝", async () => {
    const { ctx, invocation, gen } = await seedExecuting();
    const received: ThreadTransientEvent[] = [];
    const subscription = subscribeThreadTransientEvents(ctx.threadId, (event) =>
      received.push(event),
    );
    subscription.release(() => true);

    const send = (authority: AuthorityIdentity, seq: number, delta: string) =>
      ingressTransientBatch({
        tenantId: ctx.tenantId,
        invocationId: invocation.id,
        authority,
        ...batchOf(seq, delta),
      });

    // 同一 Ownership 行，但租约代已被推进（旧 epoch 的迟到重放）。
    await expect(
      send(
        { ...gen.authority, leaseEpoch: String(Number(gen.authority.leaseEpoch) + 1) },
        1,
        "旧 epoch",
      ),
    ).rejects.toBeInstanceOf(IngressAuthorityMismatchError);

    // Session 不属于该 Ownership。
    await expect(
      send({ ...gen.authority, sessionBindingId: randomUUID() }, 2, "错 Session"),
    ).rejects.toBeInstanceOf(IngressAuthorityMismatchError);

    // RuntimeRevision 与该 Session 冻结的证据不符。
    await expect(
      send({ ...gen.authority, runtimeRevisionId: randomUUID() }, 3, "错 RuntimeRevision"),
    ).rejects.toBeInstanceOf(IngressAuthorityMismatchError);

    await expect(
      send({ ...gen.authority, attemptId: randomUUID() }, 4, "错 Attempt"),
    ).rejects.toBeInstanceOf(IngressAuthorityMismatchError);

    // 以上四次全部 fail closed：既不发布，也不留下任何展示残留。
    expect(received).toEqual([]);

    // 四项逐项都对时正常发布。
    await send(gen.authority, 5, "合法批次");
    subscription.unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]?.payload.delta).toBe("合法批次");
  }, 30_000);
});
