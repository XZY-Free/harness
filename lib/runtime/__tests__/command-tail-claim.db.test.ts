/**
 * A09：InvocationCommand 的 **ACK / 非重试失败尾部**必须校验当前领取权。
 *
 * 审查报告给出的失败条件（不是理论推演）：
 *
 * > 旧 Worker 发出请求后阻塞 → 领取权到期 → 新 Worker 接管 → 旧 Worker 回来，
 * > 仍可把新领取者的命令写为 acknowledged/failed，让新执行结果被忽略、
 * > 取消后续重试或留下不对应的回执。
 *
 * 此前只有"瞬态重试排定"与"superseded 专用收口"校验 claim，`markDispatched` /
 * `acknowledgeResumeCommand` / `acknowledge` / `reject` 只看 `commandState=dispatched`。
 * 本文件用**真实 MySQL + 真实两代 claim** 直接验证：尾部提交不再能覆盖新 claim 的结论。
 *
 * 交错手法：把"接管"放在 runtime client 的回调里——也就是旧 Worker 正在网络调用中
 * 被打断的那个窗口。这是确定性交错，不依赖调度运气。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
import { markAttemptPreparedInTransaction } from "@/lib/executions/persistence/attempt-store";
import { acquireTestRuntimeAuthority } from "@/lib/executions/test-support/seed-runtime-authority";
import {
  executionOwnershipTable,
  invocationCommandTable,
} from "@/lib/persistence/schema/executions";
import {
  dispatchCheckpointCommandToRuntime,
  dispatchInterruptCommandToRuntime,
  dispatchResumeCommandToRuntime,
  dispatchSteerCommandToRuntime,
  setCommandGatewayHostedApplicationServiceForTest,
} from "@/lib/runtime/command-dispatch-gateway";
import {
  CommandDispatchClaimSupersededError,
  retryDispatchedInvocationCommand,
} from "@/lib/runtime/command-dispatcher";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { claimInvocationCommandDispatch } from "@/lib/runtime/retry/dispatch-retry-queries";
import { createMockRuntimeClient } from "@/lib/runtime/runtime-client";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_VITEST_IDENTITY_FIXTURE;

async function readCommand(commandId: string) {
  const [row] = await db
    .select()
    .from(invocationCommandTable)
    .where(eq(invocationCommandTable.id, commandId))
    .limit(1);
  return row ?? null;
}

/** 把命令行的领取权交给 `claimToken`（模拟"接管"），模拟另一个 Worker 已领取该工作。 */
async function transferClaimTo(commandId: string, claimToken: string) {
  await db
    .update(invocationCommandTable)
    .set({ commandState: "dispatched", dispatchLeaseOwner: claimToken, updatedAt: new Date() })
    .where(eq(invocationCommandTable.id, commandId));
}

function endpointResolution() {
  return {
    runtimeEndpoint: "https://command-tail.invalid",
    auth: { mode: "none" as const },
    callbackEndpoints: {
      events: "https://command-tail.invalid/runtime/events",
      heartbeat: "https://command-tail.invalid/runtime/heartbeat",
      context: "https://command-tail.invalid/runtime/context",
      capabilityActions: "https://command-tail.invalid/gateway/capability-actions",
      toolCalls: "https://command-tail.invalid/gateway/tool-calls",
      userActions: "https://command-tail.invalid/gateway/user-actions",
    },
  };
}

describe("A09：命令尾部提交必须校验当前领取权", () => {
  beforeEach(async () => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
    await resetDatabase(db);
  });

  afterEach(() => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = ORIGINAL_AUTH_MODE;
  });

  /** 建出可派发的 cancel 命令，并由 `worker-A` 正式领取。 */
  async function seedClaimedCommand() {
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
    const preparedEvidence = {
      kind: "command-tail-candidate",
      invocationId: invocation.id,
      attemptId: attempt.id,
    };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: attempt.id,
        evidence: preparedEvidence,
        digest: protocolDigest(preparedEvidence),
      }),
    );
    const gen1 = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: attempt.id,
      runtimeRevisionId: binding.runtimeRevisionId,
      phase: "dispatching",
    });
    const commandId = await db.transaction((tx) =>
      createInvocationCommandInTransaction(tx, {
        tenantId,
        invocationId: invocation.id,
        commandType: "cancel",
        idempotencyKey: `tail:${randomUUID()}`,
        payloadJson: { reason_code: "user_stop" },
        requestedByType: "user",
        requestedById: ctx.ownerId,
      }),
    );
    // 正式领取（`now` 取未来时间只为跨过 queued 的"静默安全窗口"，语义不变）。
    const claim = await claimInvocationCommandDispatch({
      commandId,
      leaseOwner: "worker-A",
      leaseDurationMs: 60_000,
      now: new Date(Date.now() + 60_000),
    });
    expect(claim?.claimToken).toBe("worker-A");
    return { ctx, tenantId, commandId, invocationId: invocation.id, gen1 };
  }

  it("COMMAND-CLAIM-01: 旧 Worker 的 ACK 到达时领取权已被接管，不得覆盖新 claim 的命令状态", async () => {
    const { tenantId, commandId, invocationId } = await seedClaimedCommand();

    // 旧 Worker 出站期间被接管：新 claim 是 worker-B。
    const client = createMockRuntimeClient({
      cancelInvocation: async (request) => {
        await transferClaimTo(commandId, "worker-B");
        return {
          accepted: true,
          targetAuthority: request.request.targetAuthority,
          stopState: "requested",
        };
      },
    });

    // 旧 Worker 带着**已失效的** claim 完成投递 → 尾部提交必须被拒。
    await expect(
      retryDispatchedInvocationCommand({
        tenantId,
        commandId,
        claimToken: "worker-A",
        runtimeClient: client,
        runtimeEndpointResolver: async () => endpointResolution(),
      }),
    ).rejects.toBeInstanceOf(CommandDispatchClaimSupersededError);

    // 新 claim 的命令状态与调度信息都没有被旧结论覆盖。
    const row = await readCommand(commandId);
    expect(row?.commandState).toBe("dispatched");
    expect(row?.dispatchLeaseOwner).toBe("worker-B");
    expect(row?.completedAt).toBeNull();
    expect(row?.receiptJson).toBeNull();
    const gen1Again = await db
      .select({ ownershipState: executionOwnershipTable.ownershipState })
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.invocationId, invocationId));
    expect(gen1Again[0]?.ownershipState).toBe("active");
  }, 30_000);

  it("COMMAND-CLAIM-02: 旧 Worker 的非重试失败到达时领取权已被接管，不得把命令写成 failed", async () => {
    const { tenantId, commandId } = await seedClaimedCommand();

    const client = createMockRuntimeClient({
      cancelInvocation: async () => {
        await transferClaimTo(commandId, "worker-B");
        // 非 RuntimeHttpClientError：走"不可重试失败"尾部（`reject`）。
        throw new Error("remote rejected: unrecoverable");
      },
    });

    await expect(
      retryDispatchedInvocationCommand({
        tenantId,
        commandId,
        claimToken: "worker-A",
        runtimeClient: client,
        runtimeEndpointResolver: async () => endpointResolution(),
      }),
    ).rejects.toBeInstanceOf(CommandDispatchClaimSupersededError);

    const row = await readCommand(commandId);
    expect(row?.commandState).toBe("dispatched");
    expect(row?.dispatchLeaseOwner).toBe("worker-B");
    expect(row?.lastErrorCode).toBeNull();
    expect(row?.completedAt).toBeNull();
  }, 30_000);

  it("COMMAND-CLAIM-03: 当前 claim 消失（行已离开 dispatched）时尾部提交是空操作，不报错也不改写", async () => {
    const { tenantId, commandId } = await seedClaimedCommand();

    // 新 claimer 已经收口为 acknowledged：旧 Worker 的迟到 ACK 只能是无副作用的空操作。
    await db
      .update(invocationCommandTable)
      .set({ commandState: "acknowledged", dispatchLeaseOwner: null, completedAt: new Date() })
      .where(eq(invocationCommandTable.id, commandId));

    const client = createMockRuntimeClient({
      cancelInvocation: async (request) => ({
        accepted: true,
        targetAuthority: request.request.targetAuthority,
        stopState: "requested",
      }),
    });

    // markDispatched 的状态前置就把这次旧投递拦住了（不进入网络阶段）。
    await expect(
      retryDispatchedInvocationCommand({
        tenantId,
        commandId,
        claimToken: "worker-A",
        runtimeClient: client,
        runtimeEndpointResolver: async () => endpointResolution(),
      }),
    ).rejects.toBeDefined();

    expect(client.calls.cancelInvocation).toHaveLength(0);
    const row = await readCommand(commandId);
    expect(row?.commandState).toBe("acknowledged");
  }, 30_000);
});

/**
 * A09 残留（审查报告 §8）：**内联投递**此前传 `claimToken=null`，整条 claim 校验被跳过，
 * 于是后台 Worker 领取同一行之后，旧内联请求仍能覆盖它的结论。
 *
 * 这一组用例全部从**真实内联入口**（命令网关）出发：先由网关自己走正式领取服务取得
 * nonce，再在"网络等待"这个真实窗口里让后台 Worker 接管。断言的是持久事实，
 * 不是"某个函数被调用了几次"。
 */
describe("A09：内联投递必须持真实领取身份（null 旁路已消除）", () => {
  beforeEach(async () => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
    await resetDatabase(db);
  });

  afterEach(() => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = ORIGINAL_AUTH_MODE;
    setCommandGatewayHostedApplicationServiceForTest(null);
  });

  /** 建出**未领取**（queued）的命令，交给真实内联入口去领取。 */
  async function seedQueuedCommand(
    commandType: "cancel" | "resume" | "steer" | "checkpoint" = "cancel",
  ) {
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
    const preparedEvidence = { kind: "command-tail-candidate", invocationId: invocation.id };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: attempt.id,
        evidence: preparedEvidence,
        digest: protocolDigest(preparedEvidence),
      }),
    );
    await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: attempt.id,
      runtimeRevisionId: binding.runtimeRevisionId,
      phase: "dispatching",
    });
    const commandId = await db.transaction((tx) =>
      createInvocationCommandInTransaction(tx, {
        tenantId,
        invocationId: invocation.id,
        commandType,
        idempotencyKey: `inline:${randomUUID()}`,
        payloadJson:
          commandType === "steer"
            ? { guidance_item_id: randomUUID(), turn_id: ctx.turnId }
            : { reason_code: "user_stop" },
        requestedByType: "user",
        requestedById: ctx.ownerId,
      }),
    );
    return { ctx, tenantId, commandId, invocationId: invocation.id };
  }

  /** 后台 Worker 用正式领取服务接管（先让当前领取过期）。 */
  async function expireAndTakeOverByWorkerB(commandId: string) {
    await db
      .update(invocationCommandTable)
      .set({ dispatchLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(invocationCommandTable.id, commandId));
    return claimInvocationCommandDispatch({
      commandId,
      leaseOwner: "worker-B",
      leaseDurationMs: 60_000,
      now: new Date(),
    });
  }

  function hostedService(overrides: {
    cancel?: () => Promise<void>;
    steer?: () => Promise<void>;
    invocationId: string;
  }) {
    return {
      start: async () => ({ status: "resumed" as const, invocationId: overrides.invocationId }),
      resume: async () => ({ status: "resumed" as const, invocationId: overrides.invocationId }),
      cancel: async () => {
        if (overrides.cancel) await overrides.cancel();
      },
      steer: async () => {
        if (overrides.steer) await overrides.steer();
      },
    };
  }

  it("COMMAND-CLAIM-04（A09-T01）：内联请求在网络上被 Worker 接管后，旧 ACK 不得覆盖新 claim", async () => {
    const { tenantId, commandId, invocationId } = await seedQueuedCommand("cancel");
    let inlineClaim: string | null = null;
    setCommandGatewayHostedApplicationServiceForTest(
      hostedService({
        invocationId,
        cancel: async () => {
          // 内联请求此刻**已经**持有领取身份：这本身就是"无 null 旁路"的直接证据。
          const held = await readCommand(commandId);
          inlineClaim = held?.dispatchLeaseOwner ?? null;
          expect(inlineClaim).toMatch(/^inline-dispatch:/);
          const taken = await expireAndTakeOverByWorkerB(commandId);
          expect(taken?.claimToken).toBe("worker-B");
        },
      }),
    );

    const result = await dispatchInterruptCommandToRuntime({ tenantId, commandId });
    // 旧内联结论被拒绝：网关把它收敛成一个稳定的"无交付"结果，而不是把失权当成
    // 一次投递失败（那会生成与新持有者不相应的失败事实）。
    expect(result.dispatched).toBe(false);
    if (result.dispatched) throw new Error("unreachable");
    expect(result.reason).toBe("claim_superseded");
    const row = await readCommand(commandId);
    expect(row?.commandState).toBe("dispatched");
    expect(row?.dispatchLeaseOwner).toBe("worker-B");
    expect(row?.completedAt).toBeNull();
    expect(row?.receiptJson).toBeNull();
  }, 30_000);

  it("COMMAND-CLAIM-05（A09-T02）：旧内联非重试失败迟到时不得把命令写成 failed", async () => {
    const { tenantId, commandId, invocationId } = await seedQueuedCommand("cancel");
    setCommandGatewayHostedApplicationServiceForTest(
      hostedService({
        invocationId,
        cancel: async () => {
          const taken = await expireAndTakeOverByWorkerB(commandId);
          expect(taken?.claimToken).toBe("worker-B");
          throw new Error("remote rejected: unrecoverable");
        },
      }),
    );

    const result = await dispatchInterruptCommandToRuntime({ tenantId, commandId });
    expect(result.dispatched).toBe(false);
    if (result.dispatched) throw new Error("unreachable");
    expect(result.reason).toBe("claim_superseded");
    const row = await readCommand(commandId);
    expect(row?.commandState).toBe("dispatched");
    expect(row?.dispatchLeaseOwner).toBe("worker-B");
    // 旧内联请求的永久失败不得把命令写成 failed，也不得清空新持有者的领取。
    expect(row?.lastErrorCode).toBeNull();
    expect(row?.completedAt).toBeNull();
  }, 30_000);

  it("COMMAND-CLAIM-06（A09-T05）：领取已过期（尚未被接管）的旧 nonce 也不能提交结论", async () => {
    const { tenantId, commandId, invocationId } = await seedQueuedCommand("cancel");
    setCommandGatewayHostedApplicationServiceForTest(
      hostedService({
        invocationId,
        cancel: async () => {
          // 只让期限过期，**不**让别人接管：尾部的期限校验必须独立成立。
          await db
            .update(invocationCommandTable)
            .set({ dispatchLeaseExpiresAt: new Date(Date.now() - 1_000) })
            .where(eq(invocationCommandTable.id, commandId));
        },
      }),
    );

    const result = await dispatchInterruptCommandToRuntime({ tenantId, commandId });
    expect(result.dispatched).toBe(false);
    if (result.dispatched) throw new Error("unreachable");
    expect(result.reason).toBe("claim_superseded");
    const row = await readCommand(commandId);
    expect(row?.commandState).toBe("dispatched");
    expect(row?.completedAt).toBeNull();
    expect(row?.receiptJson).toBeNull();
    expect(row?.lastErrorCode).toBeNull();
  }, 30_000);

  it("COMMAND-CLAIM-07（A09-T06）：健康内联领取不被后台扫描抢占，且只计一次真实发送", async () => {
    const { tenantId, commandId, invocationId } = await seedQueuedCommand("cancel");
    let workerClaimDuringInline: string | null = null;
    setCommandGatewayHostedApplicationServiceForTest(
      hostedService({
        invocationId,
        cancel: async () => {
          const taken = await claimInvocationCommandDispatch({
            commandId,
            leaseOwner: "worker-B",
            leaseDurationMs: 60_000,
            now: new Date(),
          });
          workerClaimDuringInline = taken?.claimToken ?? null;
        },
      }),
    );

    const result = await dispatchInterruptCommandToRuntime({ tenantId, commandId });
    expect(result.dispatched).toBe(true);
    if (!result.dispatched) throw new Error("unreachable");
    expect(workerClaimDuringInline).toBeNull();
    expect(result.command.commandState).toBe("acknowledged");
    const row = await readCommand(commandId);
    expect(row?.commandState).toBe("acknowledged");
    expect(row?.dispatchCount).toBe(1);
  }, 30_000);

  it("COMMAND-CLAIM-08（A09-T08）：重复终态回执保持原结果，不重开命令", async () => {
    const { tenantId, commandId, invocationId } = await seedQueuedCommand("cancel");
    setCommandGatewayHostedApplicationServiceForTest(hostedService({ invocationId }));
    const first = await dispatchInterruptCommandToRuntime({ tenantId, commandId });
    expect(first.dispatched).toBe(true);
    if (!first.dispatched) throw new Error("unreachable");
    expect(first.command.commandState).toBe("acknowledged");
    const receiptAfterFirst = (await readCommand(commandId))?.receiptJson ?? null;
    const versionAfterFirst = (await readCommand(commandId))?.versionNo;

    // 重复投递：命令已被合法领取者终结 → 不可再领取，原 receipt 不被替换。
    const second = await dispatchInterruptCommandToRuntime({ tenantId, commandId });
    expect(second.dispatched).toBe(false);
    if (second.dispatched) throw new Error("unreachable");
    expect(second.reason).toBe("not_claimable");
    const row = await readCommand(commandId);
    expect(row?.commandState).toBe("acknowledged");
    expect(row?.receiptJson).toEqual(receiptAfterFirst);
    expect(row?.versionNo).toBe(versionAfterFirst);
  }, 30_000);

  /**
   * A09-T09 的**表**：每一种命令类型的真实内联默认入口。
   *
   * 这张表存在的意义就是"文本搜索不可替代表驱动执行"（`test-matrix.json` A09-T09
   * 的 negative_control）：旧实现里内联投递**根本不领取**，`claimToken=null` 让整条
   * claim 校验被跳过 —— 这是**每一类**命令都能走的路径，只能逐个驱动真实入口来证伪。
   */
  const INLINE_ENTRIES = [
    {
      type: "cancel" as const,
      run: (p: { tenantId: string; commandId: string }) => dispatchInterruptCommandToRuntime(p),
    },
    {
      type: "resume" as const,
      run: (p: { tenantId: string; commandId: string }) => dispatchResumeCommandToRuntime(p),
    },
    {
      type: "steer" as const,
      run: (p: { tenantId: string; commandId: string }) => dispatchSteerCommandToRuntime(p),
    },
    {
      type: "checkpoint" as const,
      run: (p: { tenantId: string; commandId: string }) => dispatchCheckpointCommandToRuntime(p),
    },
  ];

  /** 造出"另一路投递正持有有效领取"的行（`dispatched` + 未过期），并给出取景基线。 */
  async function seedHeldByOtherDelivery(
    commandType: "cancel" | "resume" | "steer" | "checkpoint",
  ) {
    const seeded = await seedQueuedCommand(commandType);
    const heldUntil = new Date(Date.now() + 60_000);
    await db
      .update(invocationCommandTable)
      .set({
        commandState: "dispatched",
        dispatchLeaseOwner: "worker-A",
        dispatchLeaseExpiresAt: heldUntil,
        updatedAt: new Date(),
      })
      .where(eq(invocationCommandTable.id, seeded.commandId));
    const before = await readCommand(seeded.commandId);
    return { ...seeded, before, heldUntil };
  }

  it.each(INLINE_ENTRIES)(
    "COMMAND-CLAIM-09（A09-T09/$type）：$type 内联入口无领取身份时不得投递、不得写尾部结论",
    async ({ type, run }) => {
      const seeded = await seedHeldByOtherDelivery(type);
      const result = await run({ tenantId: seeded.tenantId, commandId: seeded.commandId });
      // "不可领取"这个结果在旧实现里**不存在**：旧内联路径没有领取步骤，会直接进入
      // dispatcher 并在 `claimToken=null` 下写出结论。因此它是"无 null fallback"的
      // 排他性证据，且对四种类型都成立。
      expect(result.dispatched).toBe(false);
      if (result.dispatched) throw new Error("unreachable");
      expect(result.reason).toBe("not_claimable");
      const after = await readCommand(seeded.commandId);
      expect(after?.commandState).toBe("dispatched");
      expect(after?.dispatchLeaseOwner).toBe("worker-A");
      // 与行内取景基线比（同为 DB 往返值），避免依赖列精度。
      expect(after?.dispatchLeaseExpiresAt).toEqual(seeded.before?.dispatchLeaseExpiresAt);
      expect(after?.dispatchCount).toBe(seeded.before?.dispatchCount);
      expect(after?.versionNo).toBe(seeded.before?.versionNo);
      expect(after?.completedAt).toBeNull();
      expect(after?.receiptJson).toBeNull();
      expect(after?.lastErrorCode).toBeNull();
    },
    30_000,
  );

  it("COMMAND-CLAIM-10（A09-T09 负向控制）：没有领取持有者的行不能被尾部驱动为终态", async () => {
    const { tenantId, commandId } = await seedQueuedCommand("cancel");
    // 造出"行已 dispatched、却没有任何领取持有者"的形状 —— 这正是旧实现内联投递留下的
    // 行：状态被推进，却没有领取身份。尾部必须靠自己的持有者/期限校验拦住它，而不是
    // 靠"行还在 queued"这种状态前置兜底；否则"等租约自然过期"就是绕过校验的路径。
    await db
      .update(invocationCommandTable)
      .set({ commandState: "dispatched", dispatchLeaseOwner: null, dispatchLeaseExpiresAt: null })
      .where(eq(invocationCommandTable.id, commandId));
    const client = createMockRuntimeClient({});
    await expect(
      retryDispatchedInvocationCommand({
        tenantId,
        commandId,
        claimToken: "never-claimed",
        runtimeClient: client,
        runtimeEndpointResolver: async () => endpointResolution(),
      }),
    ).rejects.toBeInstanceOf(CommandDispatchClaimSupersededError);
    expect(client.calls.cancelInvocation).toHaveLength(0);
    const row = await readCommand(commandId);
    expect(row?.commandState).toBe("dispatched");
    expect(row?.completedAt).toBeNull();
    expect(row?.receiptJson).toBeNull();
  }, 30_000);

  /**
   * A09-T09 的第二张表：**领取成功之后**的落点。
   *
   * 与 `COMMAND-CLAIM-09` 互补：那张表证明"没有领取就不投递"，这张表证明"投递时握着的
   * 就是本请求自己的领取"。四种类型必须逐个真实驱动，不能只覆盖 cancel（A09-T09 的
   * negative_control 明确禁止用文本搜索替代）。
   */
  const CLAIM_TRACE_ENTRIES = [
    { type: "cancel" as const, probe: "cancel" as const },
    { type: "resume" as const, probe: null },
    { type: "steer" as const, probe: "steer" as const },
    { type: "checkpoint" as const, probe: null },
  ];

  function runInlineEntry(type: "cancel" | "resume" | "steer" | "checkpoint") {
    return (p: { tenantId: string; commandId: string }): ReturnType<
      typeof dispatchInterruptCommandToRuntime
    > =>
      type === "cancel"
        ? dispatchInterruptCommandToRuntime(p)
        : type === "resume"
          ? dispatchResumeCommandToRuntime(p)
          : type === "steer"
            ? dispatchSteerCommandToRuntime(p)
            : dispatchCheckpointCommandToRuntime(p);
  }

  it.each(CLAIM_TRACE_ENTRIES)(
    "COMMAND-CLAIM-11（A09-T09/$type）：$type 内联入口的落点证明领取来自本请求",
    async ({ type, probe }) => {
      const { tenantId, commandId, invocationId } = await seedQueuedCommand(type);
      const run = runInlineEntry(type);

      // 出站前窗口可观察的两类：在网络等待里直接读行，看到的就是本次内联请求自己的 nonce。
      if (probe) {
        let observed: string | null = null;
        const read = async () => {
          observed = (await readCommand(commandId))?.dispatchLeaseOwner ?? null;
        };
        setCommandGatewayHostedApplicationServiceForTest(
          hostedService({
            invocationId,
            ...(probe === "cancel" ? { cancel: read } : { steer: read }),
          }),
        );
        const result = await run({ tenantId, commandId });
        expect(result.dispatched).toBe(true);
        if (!result.dispatched) throw new Error("unreachable");
        expect(observed).toMatch(/^inline-dispatch:/);
        expect(result.command.commandState).toBe("acknowledged");
        return;
      }

      // resume：capability 门控严格在**领取之后**执行。被门控拒绝时，行上留下的必须是
      // 本次内联请求自己的 nonce —— 旧实现的这条路径会让领取字段保持 null。
      if (type === "resume") {
        const result = await dispatchResumeCommandToRuntime({ tenantId, commandId });
        expect(result.dispatched).toBe(false);
        if (result.dispatched) throw new Error("unreachable");
        expect(result.reason).toBe("unsupported_capability");
        const row = await readCommand(commandId);
        expect(row?.commandState).toBe("dispatched");
        expect(row?.dispatchLeaseOwner).toMatch(/^inline-dispatch:/);
        expect(row?.dispatchLeaseExpiresAt).not.toBeNull();
        return;
      }

      // checkpoint：受管 Workspace 根未就绪 → 进入 dispatcher 后以终态失败收口。这条收口
      // 本身要求尾部持有真实领取（`reject` 的 claim 校验），且 dispatcher 只能按
      // `expectedState="dispatched"` 进入 —— 而该状态只能由网关的领取事务造出。
      const result = await dispatchCheckpointCommandToRuntime({ tenantId, commandId });
      expect(result.dispatched).toBe(true);
      if (!result.dispatched) throw new Error("unreachable");
      expect(result.command.commandState).toBe("failed");
      const row = await readCommand(commandId);
      expect(row?.commandState).toBe("failed");
      expect(row?.lastErrorCode).toBe("RUNTIME_COMMAND_FAILED");
    },
    30_000,
  );
});
