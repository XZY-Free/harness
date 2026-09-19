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
