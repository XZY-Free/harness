/**
 * R03 §6：控制命令必须固定目标，不在重试时追随 current。
 *
 * 三条不变量（全部用真实 DB 事实 + 真实命令行验证，不用 mock）：
 * 1. 命令目标在**正式接受时**冻结（targetOwnershipId/targetSessionId + payloadDigest）。
 * 2. 旧目标失效 → 返回 target superseded，命令收口为 failed（终态），**不重定向新 Owner**，
 *    也不产生任何网络调用；无论失效是在网关读冻结目标时判出，还是在 dispatcher 内判出，
 *    都走同一收口语义。
 * 3. Steer 携带的正式引用/摘要就是接受时持久化的 guidance ThreadItem 与 payloadDigest。
 * 4. 控制命令的持久交付必须**可排空**：失效目标收口后不再被维护 lane 重复领取；
 *    `queued`（首次交付从未发生的 Crash 残留）在安全窗口后也会被领取，不会永久不可见。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
import {
  acquireExecutionOwnership,
  closeExecutionOwnership,
  getActiveExecutionOwnership,
} from "@/lib/executions/persistence/execution-ownership-store";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import {
  executionOwnershipTable,
  invocationCommandTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import {
  dispatchInterruptCommandToRuntime,
  retryDispatchedCommandToRuntime,
} from "@/lib/runtime/command-dispatch-gateway";
import type { CommandRuntimeEndpointResolution } from "@/lib/runtime/command-dispatcher";
import { dispatchCancelCommand, dispatchSteerCommand } from "@/lib/runtime/command-dispatcher";
import {
  DISPATCH_STUCK_GRACE_MS,
  claimInvocationCommandDispatch,
  scanDueInvocationCommandDispatches,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import {
  type RuntimeCancelTransportRequest,
  type RuntimeHttpClient,
  type RuntimeSteerTransportRequest,
  defaultRuntimeCapabilities,
} from "@/lib/runtime/runtime-client";
import type { CancelResponse, SteerResponse } from "@/lib/runtime/runtime-protocol";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CALLBACK_ENDPOINTS = {
  events: "http://127.0.0.1/runtime/events",
  heartbeat: "http://127.0.0.1/runtime/heartbeat",
  context: "http://127.0.0.1/gateway/context",
  capabilityActions: "http://127.0.0.1/gateway/capability-actions",
  toolCalls: "http://127.0.0.1/gateway/tool-calls",
  userActions: "http://127.0.0.1/gateway/user-actions",
};

function endpointResolution(): CommandRuntimeEndpointResolution {
  return {
    runtimeEndpoint: "http://127.0.0.1:9/reference-runtime",
    auth: { mode: "none" },
    callbackEndpoints: CALLBACK_ENDPOINTS,
  };
}

/** 只记录请求的最小 transport；被调用即视为"真的发了网络请求"。 */
function recordingRuntimeClient() {
  const cancels: RuntimeCancelTransportRequest[] = [];
  const steers: RuntimeSteerTransportRequest[] = [];
  const client = {
    probeCapabilities: vi.fn(),
    startInvocation: vi.fn(),
    resumeInvocation: vi.fn(),
    postEventBatch: vi.fn(),
    heartbeat: vi.fn(),
    cancelInvocation: vi.fn(
      async (request: RuntimeCancelTransportRequest): Promise<CancelResponse> => {
        cancels.push(request);
        return {
          accepted: true,
          targetAuthority: request.request.targetAuthority,
          stopState: "requested",
        };
      },
    ),
    steerInvocation: vi.fn(
      async (request: RuntimeSteerTransportRequest): Promise<SteerResponse> => {
        steers.push(request);
        return {
          accepted: true,
          commandId: request.request.commandId,
          targetAuthority: request.request.targetAuthority,
          inputDigest: request.request.inputDigest,
        };
      },
    ),
    requestSafePoint: vi.fn(),
    releaseSafePoint: vi.fn(),
  } as unknown as RuntimeHttpClient;
  return { client, cancels, steers };
}

async function seedInvocationWithPublishedRevision() {
  const tenant = await ensureDefaultTenant();
  const runtimeId = randomUUID();
  const runtimeRevisionId = randomUUID();
  const digest = protocolDigest({ runtimeId, runtimeRevisionId, fixture: "command-target" });
  await db.insert(runtimeTable).values({
    id: runtimeId,
    tenantId: tenant.id,
    runtimeKey: `command-target-runtime-${runtimeId}`,
    displayName: "Command Target Runtime",
    runtimeKind: "external",
    ownerUserId: "test-user",
    lifecycleState: "enabled",
    currentRevisionId: runtimeRevisionId,
    versionNo: 1,
  });
  await db.insert(runtimeRevisionTable).values({
    id: runtimeRevisionId,
    tenantId: tenant.id,
    runtimeId,
    revisionNo: 1,
    protocolType: "harness_runtime_protocol",
    protocolVersion: 3,
    protocolContractDigest: digest,
    runtimeEvidenceKind: "external_endpoint",
    runtimeTargetDigest: digest,
    endpointRef: "http://127.0.0.1:9/reference-runtime",
    runtimeArtifactRef: null,
    artifactId: null,
    artifactDigest: null,
    runtimeCapabilitiesJson: defaultRuntimeCapabilities(),
    identityMode: "none",
    networkZone: "external",
    configHash: digest,
    credentialRefId: null,
    revisionState: "published",
    createdBy: "test-service",
  });
  return seedPreparedRuntimeAttempt({ tenantId: tenant.id, runtimeRevisionId });
}

async function createCommand(input: {
  tenantId: string;
  invocationId: string;
  commandType: "cancel" | "steer";
  payloadJson: unknown;
}): Promise<string> {
  return db.transaction((tx) =>
    createInvocationCommandInTransaction(tx, {
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      commandType: input.commandType,
      idempotencyKey: `idem:${randomUUID()}`,
      payloadJson: input.payloadJson,
      requestedByType: "user",
      requestedById: "test-user",
    }),
  );
}

async function readCommand(tenantId: string, commandId: string) {
  const [row] = await db
    .select()
    .from(invocationCommandTable)
    .where(
      and(eq(invocationCommandTable.tenantId, tenantId), eq(invocationCommandTable.id, commandId)),
    )
    .limit(1);
  if (!row) throw new Error("命令回读失败");
  return row;
}

describe("R03 §6 控制命令固定目标", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("TGT-01：代际被替换后旧 Cancel 返回 target superseded，不重定向新 Owner", async () => {
    const fixture = await seedInvocationWithPublishedRevision();
    const { tenantId, invocation } = fixture;
    const first = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const staleCommandId = await createCommand({
      tenantId,
      invocationId: invocation.id,
      commandType: "cancel",
      payloadJson: { reason_code: "user_cancel" },
    });
    const staleCommand = await readCommand(tenantId, staleCommandId);
    expect(staleCommand.targetOwnershipId).toBe(first.ownership.id);

    // 代际被替换：旧 Owner 失权，新 Owner 接管。
    await closeExecutionOwnership({
      tenantId,
      invocationId: invocation.id,
      ownershipId: first.ownership.id,
      attemptId: first.ownership.attemptId,
      leaseEpoch: first.ownership.leaseEpoch,
      state: "lost",
      reasonCode: "OwnershipExpired",
    });
    const second = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    expect(second.ownership.id).not.toBe(first.ownership.id);
    const invocationBefore = await db
      .select({ executionState: invocationTable.executionState })
      .from(invocationTable)
      .where(eq(invocationTable.id, invocation.id))
      .limit(1);

    const transport = recordingRuntimeClient();
    const result = await dispatchCancelCommand({
      tenantId,
      commandId: staleCommandId,
      runtimeClient: transport.client,
      runtimeEndpointResolver: async () => endpointResolution(),
    });

    expect(result).toMatchObject({
      commandState: "failed",
      targetSuperseded: true,
      errorCode: "CommandTargetSuperseded",
    });
    expect(transport.cancels).toHaveLength(0);
    expect((await readCommand(tenantId, staleCommandId)).lastErrorCode).toBe(
      "CommandTargetSuperseded",
    );
    // 新 Owner 与新代际完全未被触碰。
    const stillActive = await getActiveExecutionOwnership({
      tenantId,
      invocationId: invocation.id,
    });
    expect(stillActive?.id).toBe(second.ownership.id);
    expect(stillActive?.ownershipState).toBe("active");
    const invocationAfter = await db
      .select({ executionState: invocationTable.executionState })
      .from(invocationTable)
      .where(eq(invocationTable.id, invocation.id))
      .limit(1);
    expect(invocationAfter).toEqual(invocationBefore);
  });

  it("TGT-02：目标仍有效时 Cancel 精确送达冻结代际", async () => {
    const fixture = await seedInvocationWithPublishedRevision();
    const { tenantId, invocation } = fixture;
    const acquired = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const commandId = await createCommand({
      tenantId,
      invocationId: invocation.id,
      commandType: "cancel",
      payloadJson: { reason_code: "user_cancel" },
    });

    const transport = recordingRuntimeClient();
    const result = await dispatchCancelCommand({
      tenantId,
      commandId,
      runtimeClient: transport.client,
      runtimeEndpointResolver: async () => endpointResolution(),
    });

    expect(result.commandState).toBe("acknowledged");
    expect(transport.cancels).toHaveLength(1);
    expect(transport.cancels[0]?.request.targetAuthority).toEqual(acquired.authority);
    expect((await readCommand(tenantId, commandId)).commandState).toBe("acknowledged");
  });

  it("TGT-03：Steer 引用与摘要取接受时冻结的正式事实，不退化为空操作引用", async () => {
    const fixture = await seedInvocationWithPublishedRevision();
    const { tenantId, invocation } = fixture;
    await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    // 产品入口（steer-queries）持久化的命令 payload 用的是 guidance_item_id。
    const guidanceItemId = randomUUID();
    const commandId = await createCommand({
      tenantId,
      invocationId: invocation.id,
      commandType: "steer",
      payloadJson: { guidance_item_id: guidanceItemId, turn_id: randomUUID() },
    });
    const frozen = await readCommand(tenantId, commandId);

    const transport = recordingRuntimeClient();
    const result = await dispatchSteerCommand({
      tenantId,
      commandId,
      runtimeClient: transport.client,
      runtimeEndpointResolver: async () => endpointResolution(),
    });

    expect(result.commandState).toBe("acknowledged");
    expect(transport.steers).toHaveLength(1);
    expect(transport.steers[0]?.request.inputRef).toBe(guidanceItemId);
    expect(transport.steers[0]?.request.inputDigest).toBe(frozen.payloadDigest);
  });

  it("TGT-04：未固定目标的命令不追随 current，网关返回 target_superseded", async () => {
    const fixture = await seedInvocationWithPublishedRevision();
    const { tenantId, invocation } = fixture;
    // 接受时没有任何执行权 → 命令没有目标代际；此后即使出现新 Owner 也不得被追随。
    const commandId = await createCommand({
      tenantId,
      invocationId: invocation.id,
      commandType: "cancel",
      payloadJson: { reason_code: "user_cancel" },
    });
    expect((await readCommand(tenantId, commandId)).targetOwnershipId).toBeNull();
    const late = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });

    const gateway = await dispatchInterruptCommandToRuntime({ tenantId, commandId });

    expect(gateway).toEqual({ dispatched: false, reason: "target_superseded" });
    const stillActive = await getActiveExecutionOwnership({
      tenantId,
      invocationId: invocation.id,
    });
    expect(stillActive?.id).toBe(late.ownership.id);
    // 目标失效是**稳定可判定结果**：命令必须落终态，不能停在无人扫描的 queued
    // （否则用户的停止/引导命令会被静默丢弃）。
    const settled = await readCommand(tenantId, commandId);
    expect(settled.commandState).toBe("failed");
    expect(settled.lastErrorCode).toBe("CommandTargetSuperseded");
    expect(settled.completedAt).not.toBeNull();
    const [owner] = await db
      .select({ ownershipState: executionOwnershipTable.ownershipState })
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.id, late.ownership.id))
      .limit(1);
    expect(owner?.ownershipState).toBe("active");
  });

  it("TGT-05：维护 lane 领取失效目标后收口终态，命令不再被重复领取（不永不排空）", async () => {
    const fixture = await seedInvocationWithPublishedRevision();
    const { tenantId, invocation } = fixture;
    const first = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const commandId = await createCommand({
      tenantId,
      invocationId: invocation.id,
      commandType: "cancel",
      payloadJson: { reason_code: "user_cancel" },
    });
    // 代际被替换：冻结目标失去执行权。
    await closeExecutionOwnership({
      tenantId,
      invocationId: invocation.id,
      ownershipId: first.ownership.id,
      attemptId: first.ownership.attemptId,
      leaseEpoch: first.ownership.leaseEpoch,
      state: "lost",
      reasonCode: "OwnershipExpired",
    });
    await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });

    const claimNow = new Date(Date.now() + DISPATCH_STUCK_GRACE_MS + 1_000);
    const claim = await claimInvocationCommandDispatch({
      commandId,
      leaseOwner: "worker-1",
      leaseDurationMs: 30_000,
      now: claimNow,
    });
    expect(claim?.claimToken).toBe("worker-1");

    const gateway = await retryDispatchedCommandToRuntime({
      tenantId,
      commandId,
      claimToken: "worker-1",
    });
    expect(gateway).toEqual({ dispatched: false, reason: "target_superseded" });

    const settled = await readCommand(tenantId, commandId);
    expect(settled.commandState).toBe("failed");
    expect(settled.lastErrorCode).toBe("CommandTargetSuperseded");
    expect(settled.dispatchLeaseOwner).toBeNull();
    expect(settled.dispatchLeaseExpiresAt).toBeNull();

    // 时间推远一整天（远超租约与退避）：本 lane 不再把它当作待交付工作。
    const due = await scanDueInvocationCommandDispatches({
      now: new Date(claimNow.getTime() + 86_400_000),
      limit: 50,
    });
    expect(due).not.toContain(commandId);
  });

  it("TGT-06：首次交付从未发生的 queued 命令在安全窗口后被领取（不再永久不可见）", async () => {
    const fixture = await seedInvocationWithPublishedRevision();
    const { tenantId, invocation } = fixture;
    const commandId = await createCommand({
      tenantId,
      invocationId: invocation.id,
      commandType: "steer",
      payloadJson: { guidance_item_id: "guidance-item-1" },
    });
    const createdAt = (await readCommand(tenantId, commandId)).updatedAt;

    // 安全窗口内不抢走请求内联调度的工作。
    const early = new Date(createdAt.getTime() + 1_000);
    expect(await scanDueInvocationCommandDispatches({ now: early, limit: 50 })).not.toContain(
      commandId,
    );
    expect(
      await claimInvocationCommandDispatch({
        commandId,
        leaseOwner: "worker-1",
        leaseDurationMs: 30_000,
        now: early,
      }),
    ).toBeNull();

    // 静默超过安全窗口：视为到期，领取即进入 dispatched。
    const late = new Date(createdAt.getTime() + DISPATCH_STUCK_GRACE_MS + 1);
    expect(await scanDueInvocationCommandDispatches({ now: late, limit: 50 })).toContain(commandId);
    const claim = await claimInvocationCommandDispatch({
      commandId,
      leaseOwner: "worker-1",
      leaseDurationMs: 30_000,
      now: late,
    });
    expect(claim?.claimToken).toBe("worker-1");
    expect((await readCommand(tenantId, commandId)).commandState).toBe("dispatched");
  });
});
