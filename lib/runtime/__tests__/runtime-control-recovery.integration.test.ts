/**
 * R03 §6/§7：控制命令固定目标 + 暂停/子调用等待/Resume 统一（CONTROL-01..06）。
 *
 * 权威场景来自 `docs/topic02/nexharness-topic02-closure/acceptance/control.md`。
 * 全部走真实 MySQL / 真实 Broker / 真实 Ingress / 真实 Route Handler，无 mock 替身：
 *
 * - CONTROL-01 旧 Cancel 迟到（新 Owner 已在执行）→ **Hosted 与 External 两侧都必须核对
 *   targetAuthority**，都不取消新 generation。平台侧「命令派发不追随 current」由
 *   `command-target-authority.db.test.ts` TGT-01 覆盖；本用例验证的是**运行侧**同一义务。
 * - CONTROL-02 Resume HTTP ACK 返回而 `execution.started` 尚未到达 → Invocation/Turn
 *   不因 ACK 先 running；`running` 只由合法 `execution.started` 映射。
 * - CONTROL-03 request_user_input 真实 Loop → 用户输入 → Resume：只使用正式 Event 类型、
 *   持久暂停（Attempt=suspended/Owner 释放/Session 关闭）、新 generation、正确继续、无 schema 拒绝。
 * - CONTROL-04 Tool/Agent 耗时超过一轮 Heartbeat 周期且 Loop 处于 pending → 合法 Supervisor
 *   持续续租等待；只一次继续，不重复 launch。
 * - CONTROL-05 pending 期间 Hosted 进程死亡、子结果稍后返回 → 有效恢复的新 generation 读取
 *   子事实；不冒用过期 Owner 发结果。
 * - CONTROL-06 同 Attempt 多次正式 Resume → 每代 Session 唯一、StartKey 明确；重试必须找到
 *   正确那一代的 Session，而不是 `first by attempt`。
 */
import { randomUUID } from "node:crypto";
import { POST as resolveUserActionPOST } from "@/app/api/threads/[threadId]/user-actions/[requestId]/resolve/route";
import { POST as cancelRoutePOST } from "@/app/runtime/invocations/[invocationId]/cancel/route";
import { registerBuiltinTools } from "@/lib/capability/builtin-tools";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
import { ExecutionAuthorityError } from "@/lib/executions/domain/execution-authority";
import {
  createAttempt,
  getAttemptById,
  getLatestAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import {
  closeExecutionOwnership,
  getActiveExecutionOwnership,
} from "@/lib/executions/persistence/execution-ownership-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { issueWorkloadToken } from "@/lib/identity/workload-token";
import { turnTable } from "@/lib/persistence/schema/conversation";
import {
  executionOwnershipTable,
  invocationCommandTable,
  invocationTable,
  runtimeEventIngressTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { findStaleInvocations } from "@/lib/runtime/application/runtime-recovery";
import {
  createConfiguredHostedRuntimeApplicationService,
  resumeRuntimeInvocation,
} from "@/lib/runtime/application/runtime-resume";
import { startRuntimeInvocation } from "@/lib/runtime/application/runtime-start";
import { setCommandGatewayHostedApplicationServiceForTest } from "@/lib/runtime/command-dispatch-gateway";
import { dispatchCancelCommand, dispatchResumeCommand } from "@/lib/runtime/command-dispatcher";
import { claimInvocationCommandDispatch } from "@/lib/runtime/retry/dispatch-retry-queries";
import { RUNTIME_DISPATCH_RETRY_POLICY } from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { createMySqlHarnessLoopRecoveryPort } from "@/lib/runtime/harness-loop/mysql-recovery-port";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import {
  getRuntimeSessionBindingByAttempt,
  getRuntimeSessionBindingById,
  getRuntimeSessionBindingByOwnership,
  getRuntimeSessionBindingsByInvocation,
} from "@/lib/runtime/persistence/runtime-session-store";
import {
  type RuntimeStartTransportRequest,
  createMockRuntimeClient,
  defaultRuntimeCapabilities,
} from "@/lib/runtime/runtime-client";
import { type AuthorityIdentity, protocolDigest } from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RUNTIME_CAPABILITIES_JSON = ["event_stream"];
const DIGEST = `sha256:${"b".repeat(64)}`;

/** 新建并准备一个替换 Attempt（真实仓储写入，不伪造 prepared 证据）。 */
async function newPreparedAttempt(tenantId: string, invocationId: string) {
  const attempt = await createAttempt({ tenantId, invocationId });
  const evidence = { kind: "control-recovery-candidate", invocationId, attemptId: attempt.id };
  await db.transaction((tx) =>
    markAttemptPreparedInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: `sha256:${"c".repeat(64)}`,
    }),
  );
  return attempt;
}

async function readInvocation(tenantId: string, invocationId: string) {
  const [row] = await db
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .limit(1);
  return row ?? null;
}

async function readOwner(ownershipId: string) {
  const [row] = await db
    .select()
    .from(executionOwnershipTable)
    .where(eq(executionOwnershipTable.id, ownershipId))
    .limit(1);
  return row ?? null;
}

/**
 * 建出带**真实发布 RuntimeRevision**的可执行调用（能力摘要因此有唯一来源）。
 * 生产的 Resume 路径会读取 Revision 的冻结能力 JSON 写入新 Session，缺失即 fail-closed。
 */
async function seedInvocationWithPublishedRevision() {
  const tenant = await ensureDefaultTenant();
  const runtimeId = randomUUID();
  const runtimeRevisionId = randomUUID();
  const digest = protocolDigest({ runtimeId, runtimeRevisionId, fixture: "control-recovery" });
  const runtimeCapabilitiesJson = defaultRuntimeCapabilities();
  await db.insert(runtimeTable).values({
    id: runtimeId,
    tenantId: tenant.id,
    runtimeKey: `control-recovery-runtime-${runtimeId}`,
    displayName: "Control Recovery Runtime",
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
    runtimeCapabilitiesJson,
    identityMode: "none",
    networkZone: "external",
    configHash: digest,
    credentialRefId: null,
    revisionState: "published",
    createdBy: "test-service",
  });
  const fixture = await seedPreparedRuntimeAttempt({ tenantId: tenant.id, runtimeRevisionId });
  return {
    ...fixture,
    runtimeCapabilitiesJson,
    capabilitiesDigest: expectedCapabilityManifestDigest({
      runtimeRevisionId,
      runtimeCapabilitiesJson,
    }),
  };
}

/** 冻结一条针对**当前** active 代际的命令（接受时快照 targetOwnershipId/targetSessionId）。 */
async function freezeCommand(input: {
  tenantId: string;
  invocationId: string;
  commandType: "cancel" | "resume" | "steer" | "checkpoint";
  payloadJson: unknown;
}): Promise<string> {
  return db.transaction((tx) =>
    createInvocationCommandInTransaction(tx, {
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      commandType: input.commandType,
      idempotencyKey: `command:${randomUUID()}`,
      payloadJson: input.payloadJson,
      requestedByType: "user",
      requestedById: "control-recovery-fixture",
    }),
  );
}

const ORIGINAL_AUTH_MODE = process.env.SNOW_VITEST_IDENTITY_FIXTURE;

function endpointResolution() {
  return {
    runtimeEndpoint: "https://control-recovery.invalid",
    auth: { mode: "none" as const },
    callbackEndpoints: {
      events: "https://control-recovery.invalid/runtime/events",
      heartbeat: "https://control-recovery.invalid/runtime/heartbeat",
      context: "https://control-recovery.invalid/runtime/context",
      capabilityActions: "https://control-recovery.invalid/gateway/capability-actions",
      toolCalls: "https://control-recovery.invalid/gateway/tool-calls",
      userActions: "https://control-recovery.invalid/gateway/user-actions",
    },
  };
}

async function waitForInvocation(
  tenantId: string,
  invocationId: string,
  state: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  let row: Awaited<ReturnType<typeof getInvocationById>> | null =
    (await getInvocationById(tenantId, invocationId)) ?? null;
  while (row?.executionState !== state && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    row = (await getInvocationById(tenantId, invocationId)) ?? null;
  }
  return row;
}

/** 轮询直到条件成立（真实 setTimeout，不依赖任何假时钟）。 */
async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}

/** 读取当前代际的完整 Authority（真实 Current Owner + 该 Ownership 的唯一 Session）。 */
async function readCurrentAuthority(
  tenantId: string,
  invocationId: string,
  runtimeRevisionId: string,
) {
  const owner = await getActiveExecutionOwnership({ tenantId, invocationId });
  if (!owner) throw new Error("没有 active Owner");
  const session = await getRuntimeSessionBindingByOwnership(tenantId, owner.id);
  if (!session) throw new Error("Ownership 没有对应 Session");
  const authority: AuthorityIdentity = {
    invocationId,
    runtimeRevisionId,
    attemptId: owner.attemptId,
    ownershipId: owner.id,
    leaseEpoch: String(owner.leaseEpoch),
    sessionBindingId: session.id,
  };
  return { owner, session, authority };
}

/**
 * 让某代 Owner 的租约真正过期（同时满足 `leaseExpiresAt > acquiredAt` 的 CHECK）。
 *
 * 只改租约字段，不改 ownershipState —— 「进程死亡」在平台侧的唯一可见事实就是租约停止前移。
 */
async function expireOwner(tenantId: string, ownershipId: string): Promise<void> {
  const owner = await readOwner(ownershipId);
  if (!owner) throw new Error("Owner 不存在");
  const expiredAt = new Date(owner.acquiredAt.getTime() + 1);
  await db
    .update(executionOwnershipTable)
    .set({ leaseExpiresAt: expiredAt, updatedAt: new Date() })
    .where(
      and(
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.id, ownershipId),
      ),
    );
  // 库时钟必须真的越过这个时刻，扫描才会把它当成过期候选。
  await waitForCondition(() => Date.now() >= expiredAt.getTime(), "Owner 租约越过过期时刻");
}

/**
 * 只回接纳结果、不产生任何事件的 Runtime 替身（用于「实例不在本进程里」的场景）。
 * 摘要必须来自发布证据，否则 `startRuntimeInvocation` 会按 R02 §3 fail-closed。
 */
function cannedRuntimeClient(capabilitiesDigest: string) {
  const acknowledge = (request: RuntimeStartTransportRequest) => ({
    protocolVersion: 3 as const,
    authority: request.request.authority,
    semanticRequestDigest: request.request.semanticRequestDigest,
    accepted: true as const,
    remoteSessionRef: `mock-session:${request.request.authority.ownershipId}`,
    remoteExecutionRef: `mock-execution:${request.request.authority.ownershipId}`,
    capabilitiesDigest,
    acceptedAt: Date.now(),
  });
  return createMockRuntimeClient({
    startInvocation: async (request) => acknowledge(request),
    resumeInvocation: async (request) => acknowledge(request),
  });
}

/**
 * A09：真实投递必须先取得领取 nonce（内联路径同样走同一个原子领取服务）。
 */
async function claimCommandForDelivery(commandId: string, leaseOwner: string): Promise<string> {
  const claim = await claimInvocationCommandDispatch({
    commandId,
    leaseOwner,
    leaseDurationMs: RUNTIME_DISPATCH_RETRY_POLICY.leaseDurationMs,
    now: new Date(),
    allowImmediateQueued: true,
  });
  if (!claim) throw new Error(`无法领取命令 ${commandId}`);
  return claim.claimToken;
}

describe("R03 §6/§7 控制命令固定目标与暂停/Resume 统一（CONTROL-01..06）", () => {
  beforeEach(async () => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  afterEach(() => {
    vi.useRealTimers();
    setCommandGatewayHostedApplicationServiceForTest(null);
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = ORIGINAL_AUTH_MODE;
  });

  it("CONTROL-01: 旧 Cancel 迟到且新 Owner 已执行时，Hosted 与 External 都核对 targetAuthority，不取消新 generation", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const tenantId = fixture.tenantId;
    const invocationId = fixture.invocation.id;
    // 第 1 代：真实 Acquire（active），并在此时冻结一条 cancel 命令。
    const gen1 = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
      phase: "dispatching",
    });
    const staleCancelId = await freezeCommand({
      tenantId,
      invocationId,
      commandType: "cancel",
      payloadJson: { reasonCode: "cancel_requested" },
    });
    const [staleCommand] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, staleCancelId))
      .limit(1);
    // 接受时冻结的目标就是第 1 代。
    expect(staleCommand?.targetOwnershipId).toBe(gen1.ownership.id);
    expect(staleCommand?.targetSessionId).toBe(gen1.session.id);

    // 代际被替换：旧 Owner 正式关闭 → 新 Attempt + 第 2 代 Acquire，Invocation 已在执行。
    await closeExecutionOwnership({
      tenantId,
      invocationId,
      ownershipId: gen1.ownership.id,
      attemptId: fixture.attempt.id,
      leaseEpoch: gen1.ownership.leaseEpoch,
      state: "revoked",
      reasonCode: "control_recovery_replaced",
    });
    const attempt2 = await newPreparedAttempt(tenantId, invocationId);
    await db
      .update(invocationTable)
      .set({ executionState: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(invocationTable.id, invocationId));
    const gen2 = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId,
      attemptId: attempt2.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
      phase: "executing",
    });

    // ── 平台侧：迟到的旧命令不重定向新 Owner（TGT-01 已覆盖的语义，此处作前置事实）──
    const staleTransport = createMockRuntimeClient({});
    const staleDispatch = await dispatchCancelCommand({
      tenantId,
      commandId: staleCancelId,
      claimToken: await claimCommandForDelivery(staleCancelId, `claim-${randomUUID()}`),
      runtimeClient: staleTransport,
      runtimeEndpointResolver: async () => ({
        runtimeEndpoint: "https://stale-target.invalid",
        auth: { mode: "none" },
        callbackEndpoints: {
          events: "https://stale-target.invalid/runtime/events",
          heartbeat: "https://stale-target.invalid/runtime/heartbeat",
          context: "https://stale-target.invalid/runtime/context",
          capabilityActions: "https://stale-target.invalid/gateway/capability-actions",
          toolCalls: "https://stale-target.invalid/gateway/tool-calls",
          userActions: "https://stale-target.invalid/gateway/user-actions",
        },
      }),
    });
    // 冻结目标已失效 → 返回 target superseded 并收口终态，且**零**远端投递（不重定向新 Owner）。
    expect(staleDispatch).toMatchObject({
      commandState: "failed",
      targetSuperseded: true,
      errorCode: "CommandTargetSuperseded",
    });
    expect(staleTransport.calls.cancelInvocation).toHaveLength(0);
    const [settledStale] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, staleCancelId))
      .limit(1);
    expect(settledStale?.lastErrorCode).toBe("CommandTargetSuperseded");

    // ── Hosted 运行侧：同一 body 直接投给 Hosted Runtime adapter，必须按 targetAuthority 关门 ──
    const hostedClient = createInProcessHostedRuntimeClient({
      tenantId,
      applicationService: createConfiguredHostedRuntimeApplicationService({}),
      publishedCapabilityEvidence: {
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
        runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
      },
    });
    await hostedClient.cancelInvocation({
      runtimeEndpoint: "in-process://hosted",
      auth: { mode: "workload_token", token: "hosted-control-token" },
      invocationId,
      idempotencyKey: `command:${staleCancelId}`,
      request: {
        protocolVersion: 3,
        commandId: staleCancelId,
        targetAuthority: gen1.authority,
        reasonCode: "cancel_requested",
      },
    });
    // 迟到的旧 Cancel 不得取消新 generation：Owner 仍 active、Invocation 仍 running。
    expect((await readOwner(gen2.ownership.id))?.ownershipState).toBe("active");
    expect((await readInvocation(tenantId, invocationId))?.executionState).toBe("running");

    // ── External 运行侧：真实 Route Handler 用 workload 凭据 tuple 复核 body.targetAuthority ──
    const externalToken = issueWorkloadToken({
      contractVersion: 3,
      type: "execution",
      audience: "runtime",
      tenantId,
      invocationId,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      attemptId: attempt2.id,
      ownershipId: gen2.ownership.id,
      leaseEpoch: String(gen2.ownership.leaseEpoch),
      sessionBindingId: gen2.session.id,
      expiresAt: Date.now() + 60_000,
    });
    const callExternalCancel = (authority: AuthorityIdentity, token = externalToken) =>
      cancelRoutePOST(
        buildApiRequest({
          audience: "runtime",
          method: "POST",
          path: `/invocations/${invocationId}/cancel`,
          idempotencyKey: randomUUID(),
          token,
          body: {
            protocolVersion: 3,
            commandId: randomUUID(),
            targetAuthority: authority,
            reasonCode: "cancel_requested",
          },
        }),
        { params: Promise.resolve({ invocationId }) },
      );

    // (a) 旧代际 targetAuthority + 新代际凭据 → 拒绝（不当作针对新代际的取消）。
    const late = await callExternalCancel(gen1.authority);
    expect(late.status).toBe(400);
    expect((await late.json()).error.code).toBe("REQUEST_SCHEMA_INVALID");
    expect((await readOwner(gen2.ownership.id))?.ownershipState).toBe("active");
    expect((await readInvocation(tenantId, invocationId))?.executionState).toBe("running");

    // (b) 目标与凭据一致 → 接纳（证明上面的拒绝是"核对 targetAuthority"，不是"一律拒绝"）。
    const current = await callExternalCancel(gen2.authority);
    expect(current.status).toBe(202);

    // ── Hosted 正向对照：针对当前代际的 Cancel 必须真的关门 ──
    await hostedClient.cancelInvocation({
      runtimeEndpoint: "in-process://hosted",
      auth: { mode: "workload_token", token: "hosted-control-token" },
      invocationId,
      idempotencyKey: `command:${randomUUID()}`,
      request: {
        protocolVersion: 3,
        commandId: randomUUID(),
        targetAuthority: gen2.authority,
        reasonCode: "cancel_requested",
      },
    });
    // A02 之后，Hosted Cancel 与 RuntimeEventIngress 走**同一**终态收口
    // （`closeInvocationTerminalInTransaction`），因此 Ownership 的终态写法与 Ingress
    // 完全一致：`released` + `reasonCode=execution_terminal`。
    // 旧期望 `revoked` 来自已删除的 Hosted 旁路（它只关 Owner、不关 Attempt/Turn/Session），
    // 保留它反而会把「收口边界已统一」这一事实断言成不成立。
    const owner = await readOwner(gen2.ownership.id);
    expect(owner?.ownershipState).toBe("released");
    expect(owner?.reasonCode).toBe("execution_terminal");
    expect((await readInvocation(tenantId, invocationId))?.executionState).toBe("cancelled");
  });

  it("CONTROL-02: Resume HTTP ACK 返回而 execution.started 尚未到达时，Invocation/Turn 不因 ACK 先 running", async () => {
    const fixture = await seedInvocationWithPublishedRevision();
    const tenantId = fixture.tenantId;
    const invocationId = fixture.invocation.id;
    const gen1 = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      runtimeCapabilitiesJson: fixture.runtimeCapabilitiesJson,
      // 生产在派发前就固定激活证据（`executionPhase` 仍是 dispatching）；缺它会让后续
      // 合法的 `execution.started` 把 phase 推成 executing 时撞
      // `ExecutionOwnership_executing_activation_shape`。
      activationEvidence: { kind: "control-recovery-activation", invocationId },
    });
    // 第 1 代已进入 dispatching：Session 必须冻结语义请求（`dispatch_freeze_shape`），
    // 这是生产 `startRuntimeInvocation` 在派发前写入的同一事实。
    const semanticRequestJson = {
      kind: "control-recovery-start",
      invocationId,
      attemptId: gen1.ownership.attemptId,
    };
    await applyRuntimeSessionDispatchForTest(tenantId, gen1.session.id, {
      bindingState: "dispatching",
      semanticRequestJson,
      semanticRequestDigest: protocolDigest(semanticRequestJson),
    });
    // 第 1 代真正执行过：由合法 `execution.started` 推进（Session active / Attempt running /
    // Owner executing / Invocation running）——暂停/终态类事件要求 Owner 已在 `executing`。
    await ingressRuntimeEvents({
      tenantId,
      invocationId,
      batch: {
        protocolVersion: 3,
        authority: gen1.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "1",
            type: "execution.started",
            schemaVersion: 1,
            payload: {
              intentKey: gen1.session.startIntentKey,
              semanticRequestDigest: protocolDigest(semanticRequestJson),
              remoteSessionRef: "control-gen1-session",
              remoteExecutionRef: "control-gen1-execution",
              capabilitiesDigest: fixture.capabilitiesDigest,
            },
          },
        ],
      },
    });
    expect((await readInvocation(tenantId, invocationId))?.executionState).toBe("running");

    // 正式暂停：走真实 ingress（Attempt=suspended、Owner 释放、Session 关闭）。
    await ingressRuntimeEvents({
      tenantId,
      invocationId,
      batch: {
        protocolVersion: 3,
        authority: gen1.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "2",
            type: "execution.suspended",
            schemaVersion: 1,
            payload: { reason: "waiting_user", resumeAnchorDigest: DIGEST },
          },
        ],
      },
    });
    const suspended = await readInvocation(tenantId, invocationId);
    expect(suspended?.executionState).toBe("waiting_user");
    expect((await readOwner(gen1.ownership.id))?.ownershipState).toBe("released");

    // Resume 命令：ACK 由 Runtime 返回，但**不发** execution.started。
    const resumeCommandId = await freezeCommand({
      tenantId,
      invocationId,
      commandType: "resume",
      payloadJson: { resume_source: "user_action_resolution" },
    });
    const capabilitiesDigest = fixture.capabilitiesDigest;
    let dispatchedAuthority: AuthorityIdentity | null = null;
    const ackOnlyRuntime = createMockRuntimeClient({
      resumeInvocation: async (request) => {
        dispatchedAuthority = request.request.authority;
        return {
          protocolVersion: 3,
          authority: request.request.authority,
          semanticRequestDigest: request.request.semanticRequestDigest,
          accepted: true,
          remoteSessionRef: "ack-only-session",
          remoteExecutionRef: "ack-only-execution",
          capabilitiesDigest,
          acceptedAt: Date.now(),
        };
      },
    });
    const result = await dispatchResumeCommand({
      tenantId,
      commandId: resumeCommandId,
      claimToken: await claimCommandForDelivery(resumeCommandId, `claim-${randomUUID()}`),
      runtimeClient: ackOnlyRuntime,
      runtimeEndpointResolver: async () => ({
        runtimeEndpoint: "https://ack-only.invalid",
        auth: { mode: "none" },
        callbackEndpoints: {
          events: "https://ack-only.invalid/runtime/events",
          heartbeat: "https://ack-only.invalid/runtime/heartbeat",
          context: "https://ack-only.invalid/runtime/context",
          capabilityActions: "https://ack-only.invalid/gateway/capability-actions",
          toolCalls: "https://ack-only.invalid/gateway/tool-calls",
          userActions: "https://ack-only.invalid/gateway/user-actions",
        },
      }),
    });
    expect(result.commandState).toBe("acknowledged");
    expect(dispatchedAuthority).not.toBeNull();

    // ACK 只表示 Transport 交付事实：Invocation / Turn 都不因 ACK 变 running。
    const afterAck = await readInvocation(tenantId, invocationId);
    expect(afterAck?.executionState).toBe("waiting_user");
    const [turn] = await db
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, fixture.turnId))
      .limit(1);
    expect(turn?.turnState).not.toBe("running");

    // 新代际的 Session 处于 dispatching（尚未被 execution.started 推成 active）。
    const sessions = await db
      .select()
      .from(runtimeSessionBindingTable)
      .where(eq(runtimeSessionBindingTable.invocationId, invocationId));
    const newSession = sessions.find((row) => row.ownershipId !== gen1.ownership.id);
    expect(newSession?.bindingState).toBe("dispatching");
    if (!newSession) throw new Error("Resume 未创建新代际 Session");

    // 只有合法 execution.started 才推进：waiting_user → running（控制命令 ACK 不推进）。
    const authority = dispatchedAuthority as unknown as AuthorityIdentity;
    await ingressRuntimeEvents({
      tenantId,
      invocationId,
      batch: {
        protocolVersion: 3,
        authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "3",
            type: "execution.started",
            schemaVersion: 1,
            payload: {
              intentKey: newSession.startIntentKey,
              semanticRequestDigest: newSession.semanticRequestDigest,
              remoteSessionRef: newSession.remoteSessionRef ?? "ack-only-session",
              remoteExecutionRef: newSession.remoteExecutionRef ?? "ack-only-execution",
              capabilitiesDigest,
            },
          },
        ],
      },
    });
    expect((await readInvocation(tenantId, invocationId))?.executionState).toBe("running");
    const [runningTurn] = await db
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, fixture.turnId))
      .limit(1);
    expect(runningTurn?.turnState).toBe("running");
    const [activatedSession] = await db
      .select()
      .from(runtimeSessionBindingTable)
      .where(eq(runtimeSessionBindingTable.id, newSession.id))
      .limit(1);
    expect(activatedSession?.bindingState).toBe("active");
  });

  it("CONTROL-03: request_user_input 真实 Loop → 用户输入 → Resume：只使用正式 Event 类型、持久暂停、新 generation、正确继续", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
    });
    const invocation = dispatch.invocation;
    const binding = dispatch.binding;
    const attempt = dispatch.attempt;
    if (!invocation || !binding || !attempt) {
      throw new Error("调度失败：未创建 Invocation/Binding/Attempt");
    }

    const decisionViews: Array<{ observations: unknown[] }> = [];
    const service = createConfiguredHostedRuntimeApplicationService({
      decisionPort: {
        async decideNextAction(view) {
          decisionViews.push(view);
          if (view.actionHistory.length === 0) {
            return {
              actionId: "ask-employee-id",
              stepNo: 1,
              actionType: "request_user_input",
              purposeCode: "missing_employee_id",
              shortPurpose: "缺少员工编号",
              payload: {
                purpose: "missing_employee_id",
                prompt: "请提供员工编号",
                inputSchema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["text"],
                  properties: { text: { type: "string", minLength: 1, maxLength: 20_000 } },
                },
              },
            };
          }
          return {
            actionId: "respond-after-input",
            stepNo: 2,
            actionType: "respond",
            purposeCode: "answer_ready",
            shortPurpose: "按补充信息回答",
            payload: { evidenceRefs: [] },
          };
        },
      },
      finalResponsePort: {
        async generateFinalResponse() {
          return "已根据补充信息完成";
        },
      },
      actionExecutors: {
        request_user_input: async (action) => ({
          authorityRef: `user-action:${action.actionId}`,
          observation: {
            observationType: "user_input",
            summary: "等待用户补充",
            sourceRefs: [],
            data: {},
          },
          waitingForUser: {
            requestType: "input" as const,
            purpose: action.payload.purpose,
            prompt: action.payload.prompt,
            inputSchema: action.payload.inputSchema,
          },
        }),
      },
      modelRef: "control-recovery-model",
    });
    setCommandGatewayHostedApplicationServiceForTest(service);

    const client = createInProcessHostedRuntimeClient({
      tenantId: ctx.tenantId,
      applicationService: service,
      publishedCapabilityEvidence: {
        runtimeRevisionId: ctx.runtimeRevision.id,
        runtimeCapabilitiesJson: ctx.runtimeRevision.runtimeCapabilitiesJson,
      },
    });
    const started = await startRuntimeInvocation({
      tenantId: ctx.tenantId,
      invocation,
      binding,
      attempt,
      runtimeClient: client,
      runtimeEndpoint: "in-process://hosted",
      auth: { mode: "workload_token", token: "hosted-control-token" },
      callbackEndpoints: endpointResolution().callbackEndpoints,
    });
    await client.getLastLaunchPromise();

    // ── 持久暂停：Invocation/Turn waiting_user、Attempt suspended、Owner 释放、Session 关闭 ──
    const paused = await waitForInvocation(ctx.tenantId, invocation.id, "waiting_user");
    expect(paused?.executionState).toBe("waiting_user");
    const [pausedTurn] = await db
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, ctx.turnId))
      .limit(1);
    expect(pausedTurn?.turnState).toBe("waiting_user");
    const pausedAttempt = await getLatestAttempt(invocation.id);
    expect(pausedAttempt?.attemptState).toBe("suspended");
    expect(
      await getActiveExecutionOwnership({ tenantId: ctx.tenantId, invocationId: invocation.id }),
    ).toBeNull();
    const sessionsAfterPause = await getRuntimeSessionBindingsByInvocation(
      ctx.tenantId,
      invocation.id,
    );
    expect(sessionsAfterPause).toHaveLength(1);
    expect(sessionsAfterPause[0]?.bindingState).toBe("closed");

    // ── 只使用正式 Event 类型：`user-action` / `execution.suspended` 都被生产 Ingress 接纳
    //    （旧实现发的是 ThreadEvent 名字 `user_action.requested`，会在此处被 schema 拒绝）。
    const ingressTypes = (
      await db
        .select({ candidateType: runtimeEventIngressTable.candidateType })
        .from(runtimeEventIngressTable)
        .where(eq(runtimeEventIngressTable.invocationId, invocation.id))
    ).map((row) => row.candidateType);
    expect(ingressTypes).toContain("user-action");
    expect(ingressTypes).toContain("execution.suspended");

    // 停等请求已持久为用户可见事实（pending UAR）。
    const [uar] = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.invocationId, invocation.id))
      .limit(1);
    expect(uar?.requestState).toBe("pending");
    expect(uar?.requestType).toBe("input");
    if (!uar) throw new Error("request_user_input 未持久化 UserActionRequest");

    // ── 用户输入 → Resume（真实员工路由 + 真实命令网关）──
    const resumeResponse = await resolveUserActionPOST(
      buildApiRequest({
        audience: "employee",
        method: "POST",
        path: `/threads/${ctx.threadId}/user-actions/${uar.id}/resolve`,
        idempotencyKey: `resolve:${randomUUID()}`,
        body: { resolution: "submit", response_redacted: { text: "E-1024" } },
      }),
      { params: Promise.resolve({ threadId: ctx.threadId, requestId: uar.id }) },
    );
    if (resumeResponse.status !== 200) {
      throw new Error(`resolve 返回 ${resumeResponse.status}: ${await resumeResponse.text()}`);
    }
    const completed = await waitForInvocation(ctx.tenantId, invocation.id, "completed");
    expect(completed?.executionState).toBe("completed");

    // ── 新 generation：同一 Invocation/Attempt，新 Ownership 与新 Session（intentType=resume）──
    const sessionsAfterResume = await getRuntimeSessionBindingsByInvocation(
      ctx.tenantId,
      invocation.id,
    );
    expect(sessionsAfterResume).toHaveLength(2);
    const resumedSession = sessionsAfterResume.find((row) => row.id !== sessionsAfterPause[0]?.id);
    expect(resumedSession?.intentType).toBe("resume");
    expect(resumedSession?.ownershipId).not.toBe(sessionsAfterPause[0]?.ownershipId);
    expect(resumedSession?.attemptId).toBe(attempt.id);
    expect(resumedSession?.startIntentKey).toBe(`start:${resumedSession?.ownershipId}`);

    // ── 正确继续：恢复后的 Loop 读到"已解决输入"这一子事实，接着同一行动往下走 ──
    expect(decisionViews).toHaveLength(2);
    expect(decisionViews[1]?.observations).toContainEqual(
      expect.objectContaining({
        observationType: "user_input",
        data: expect.objectContaining({
          harnessActionId: "ask-employee-id",
          response: { text: "E-1024" },
        }),
      }),
    );
    expect(started.response.accepted).toBe(true);
  });

  it("CONTROL-04: Tool/Agent 耗时超过一轮 Heartbeat 周期且 Loop 仍 pending 时，合法 Supervisor 持续续租等待，只唤醒一次且不重复 launch", async () => {
    const ctx = await seedDispatchableTurn();
    // R01 §5：Binding 冻结的能力目录是模型可见能力的唯一来源，也是执行时的**准入**事实。
    // 本用例要发起真实 Tool 子调用，因此租户必须先通过正式资产发布接口登记工具
    // （Connection/Provider/… 全部走生产链）——冻结一个空目录却请求工具，等于让用例
    // 依赖"目录根本没被交给 Loop"这个缺陷（`lib/runtime/application/runtime-resume.ts`
    // 的 `capabilityCatalog` 缺失）。这里显式登记基础工具，并从冻结目录里取用真实身份。
    await registerBuiltinTools({ tenantId: ctx.tenantId, ownerUserId: ctx.ownerId });
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
    });
    const invocation = dispatch.invocation;
    const binding = dispatch.binding;
    const attempt = dispatch.attempt;
    if (!invocation || !binding || !attempt) {
      throw new Error("调度失败：未创建 Invocation/Binding/Attempt");
    }
    const tenantId = ctx.tenantId;
    const invocationId = invocation.id;

    // 冻结目录必须真的声明了本用例将要请求的工具操作（否则 Loop 的目录准入会正确拒绝）。
    const frozenCatalog = binding.capabilityCatalogJson as {
      tools: Array<{ toolId: string; operationId: string; inputSchema: Record<string, unknown> }>;
    };
    const frozenTool = frozenCatalog.tools.find((tool) => tool.operationId === "web-search");
    if (!frozenTool) {
      throw new Error(
        `冻结能力目录未声明 web-search：${JSON.stringify(frozenCatalog.tools.map((t) => t.operationId))}`,
      );
    }

    // 子调用真实耗时超过一轮心跳周期：执行器阻塞到测试显式交付子结果。
    let releaseSubcall: () => void = () => {};
    const subcallGate = new Promise<void>((resolve) => {
      releaseSubcall = resolve;
    });
    let subcallExecutions = 0;
    const decisionViews: Array<{ actionHistory: unknown[]; observations: unknown[] }> = [];

    const service = createConfiguredHostedRuntimeApplicationService({
      decisionPort: {
        async decideNextAction(view) {
          decisionViews.push({
            actionHistory: view.actionHistory,
            observations: view.observations,
          });
          if (view.actionHistory.length === 0) {
            // 只请求冻结目录里**真实存在**的 Tool Operation（身份与参数都取自同一份冻结事实）。
            expect(view.capabilities.catalog?.tools.map((tool) => tool.operationId)).toContain(
              frozenTool.operationId,
            );
            return {
              actionId: "slow-child-tool",
              stepNo: 1,
              actionType: "tool.call",
              purposeCode: "slow_tool_call",
              shortPurpose: "调用耗时工具",
              payload: {
                toolId: frozenTool.toolId,
                operationId: frozenTool.operationId,
                arguments: { query: "control-04" },
              },
            };
          }
          return {
            actionId: "respond-after-slow-tool",
            stepNo: 2,
            actionType: "respond",
            purposeCode: "answer_ready",
            shortPurpose: "汇总工具结果",
            payload: { evidenceRefs: [] },
          };
        },
      },
      finalResponsePort: {
        async generateFinalResponse() {
          return "慢工具结果已并入";
        },
      },
      actionExecutors: {
        "tool.call": async () => {
          subcallExecutions += 1;
          await subcallGate;
          return {
            authorityRef: "tool-call:slow-child",
            observation: {
              observationType: "tool",
              summary: "慢工具执行完成",
              sourceRefs: ["tool-call:slow-child"],
              data: { state: "succeeded" },
            },
          };
        },
      },
      modelRef: "control-recovery-model",
    });
    setCommandGatewayHostedApplicationServiceForTest(service);

    const client = createInProcessHostedRuntimeClient({
      tenantId,
      applicationService: service,
      publishedCapabilityEvidence: {
        runtimeRevisionId: ctx.runtimeRevision.id,
        runtimeCapabilitiesJson: ctx.runtimeRevision.runtimeCapabilitiesJson,
      },
    });

    // Hosted Supervisor 的心跳间隔固定在 `runHostedInvocation` 内部（20s），必须先安装假时钟
    // 才能捕获它：只接管 setInterval/clearInterval，`Date` 与 `setTimeout` 保持真实，
    // 因此库时钟（`getAuthorityDatabaseTime`）与各轮询等待都不受假时钟影响。
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await startRuntimeInvocation({
        tenantId,
        invocation,
        binding,
        attempt,
        runtimeClient: client,
        runtimeEndpoint: "in-process://hosted",
        auth: { mode: "workload_token", token: "hosted-control-token" },
        callbackEndpoints: endpointResolution().callbackEndpoints,
      });
      await waitForCondition(() => subcallExecutions === 1, "Loop 进入 pending 子调用");

      const before = await readCurrentAuthority(tenantId, invocationId, binding.runtimeRevisionId);
      // 前提前置：代际已真正执行（Session active / Owner executing / Invocation running）。
      expect(before.session.bindingState).toBe("active");
      expect(before.owner.executionPhase).toBe("executing");
      expect((await readInvocation(tenantId, invocationId))?.executionState).toBe("running");
      const leaseBefore = before.owner.leaseExpiresAt.getTime();
      const heartbeatBefore = before.owner.lastHeartbeatAt.getTime();

      // 推进满一轮心跳周期：Supervisor 在等待子结果期间必须持续续租（而不是让租约到期）。
      vi.advanceTimersByTime(20_000);
      await waitForCondition(async () => {
        const owner = await readOwner(before.owner.id);
        return (
          (owner?.leaseExpiresAt.getTime() ?? 0) > leaseBefore &&
          (owner?.lastHeartbeatAt.getTime() ?? 0) > heartbeatBefore
        );
      }, "Hosted Supervisor 续租");
      const renewed = await readOwner(before.owner.id);
      expect(renewed?.ownershipState).toBe("active");
      expect(renewed?.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
      // 「子调用 pending」不是人工暂停：租约续上了，但 Loop 仍在同一个子调用里。
      expect(subcallExecutions).toBe(1);
      expect((await readInvocation(tenantId, invocationId))?.executionState).toBe("running");

      // 只一次继续：同代际的 continuation 唤醒只能唤醒既有 Supervisor，不得再起一个 Loop。
      const wake = await service.resume({
        tenantId,
        invocationId,
        idempotencyKey: "control-04:continuation-wake",
        authority: before.authority,
      });
      expect(wake).toMatchObject({ status: "resumed", completed: false, pending: true });
      expect(subcallExecutions).toBe(1);
      expect(decisionViews).toHaveLength(1);
      const startedEvents = await db
        .select()
        .from(runtimeEventIngressTable)
        .where(
          and(
            eq(runtimeEventIngressTable.tenantId, tenantId),
            eq(runtimeEventIngressTable.invocationId, invocationId),
            eq(runtimeEventIngressTable.candidateType, "execution.started"),
          ),
        );
      expect(startedEvents).toHaveLength(1);

      // 子结果到达：同一 Supervisor 继续往下走，不重复 launch、不重复执行子调用。
      releaseSubcall();
      const completed = await waitForInvocation(tenantId, invocationId, "completed");
      expect(completed?.executionState).toBe("completed");
    } finally {
      vi.useRealTimers();
    }

    expect(subcallExecutions).toBe(1);
    expect(decisionViews).toHaveLength(2);
    expect(decisionViews[1]?.observations).toContainEqual(
      expect.objectContaining({ observationType: "tool", summary: "慢工具执行完成" }),
    );
  }, 30_000);

  it("CONTROL-05: pending 期间 Hosted 进程死亡、子结果稍后返回时，有效恢复的新 generation 读取子事实，且不冒用过期 Owner 发结果", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
    });
    const invocation = dispatch.invocation;
    const binding = dispatch.binding;
    const attempt = dispatch.attempt;
    if (!invocation || !binding || !attempt) {
      throw new Error("调度失败：未创建 Invocation/Binding/Attempt");
    }
    const tenantId = ctx.tenantId;
    const invocationId = invocation.id;
    const capabilitiesDigest = expectedCapabilityManifestDigest({
      runtimeRevisionId: ctx.runtimeRevision.id,
      runtimeCapabilitiesJson: ctx.runtimeRevision.runtimeCapabilitiesJson,
    });

    // ── 第 1 代：真实 dispatch + 合法 `execution.started`，随后停在一个 pending 子调用上 ──
    // 调度夹具只建出候选 Attempt；Acquire 要求 Attempt 已 Prepared（R02 §4），
    // 这里补上同一份准备事实（生产由 `startRuntimeInvocation` 的候选准备阶段写入）。
    const attempt1Evidence = {
      kind: "control-recovery-pending-subcall",
      invocationId,
      attemptId: attempt.id,
    };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: attempt.id,
        evidence: attempt1Evidence,
        digest: `sha256:${"d".repeat(64)}`,
      }),
    );
    const gen1 = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId,
      attemptId: attempt.id,
      runtimeRevisionId: binding.runtimeRevisionId,
      runtimeCapabilitiesJson: ctx.runtimeRevision.runtimeCapabilitiesJson,
      activationEvidence: { kind: "control-recovery-activation", invocationId },
    });
    const semanticRequestJson = {
      kind: "control-recovery-pending-subcall",
      invocationId,
      attemptId: attempt.id,
    };
    await applyRuntimeSessionDispatchForTest(tenantId, gen1.session.id, {
      bindingState: "dispatching",
      semanticRequestJson,
      semanticRequestDigest: protocolDigest(semanticRequestJson),
    });
    await ingressRuntimeEvents({
      tenantId,
      invocationId,
      batch: {
        protocolVersion: 3,
        authority: gen1.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "1",
            type: "execution.started",
            schemaVersion: 1,
            payload: {
              intentKey: gen1.session.startIntentKey,
              semanticRequestDigest: protocolDigest(semanticRequestJson),
              remoteSessionRef: "control-gen1-session",
              remoteExecutionRef: "control-gen1-execution",
              capabilitiesDigest,
            },
          },
        ],
      },
    });
    expect((await readInvocation(tenantId, invocationId))?.executionState).toBe("running");

    // 子调用的**持久事实**：行动已接纳并开始执行（结果尚未产生）。
    const childActionId = "slow-child-tool";
    const childActionPayload = {
      toolId: "slow-tool",
      operationId: "run",
      arguments: { q: "control-05" },
    };
    const childActionDigest = computeCanonicalDigest({
      actionType: "tool.call",
      payload: childActionPayload,
    });
    const childActionEnvelope = {
      action_id: childActionId,
      step_no: 1,
      action_type: "tool.call",
      action_digest: childActionDigest,
      purpose_code: "slow_tool_call",
      short_purpose: "调用耗时工具",
      target_ref: "slow-tool:run",
      action_payload: childActionPayload,
      authority_ref: "tool-call:slow-child",
    };
    await ingressRuntimeEvents({
      tenantId,
      invocationId,
      batch: {
        protocolVersion: 3,
        authority: gen1.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "2",
            type: "harness.action.proposed",
            schemaVersion: 1,
            payload: { ...childActionEnvelope, state: "proposed" },
          },
          {
            eventId: randomUUID(),
            producerSequence: "3",
            type: "harness.action.started",
            schemaVersion: 1,
            payload: { ...childActionEnvelope, state: "started" },
          },
        ],
      },
    });

    // ── Hosted 进程死亡：租约停止前移并真正过期（平台侧唯一可见事实）──
    await expireOwner(tenantId, gen1.ownership.id);
    const stale = await findStaleInvocations({ tenantId });
    expect(stale.map((row) => row.invocationId)).toContain(invocationId);
    expect(stale.find((row) => row.invocationId === invocationId)?.observedOwner?.ownershipId).toBe(
      gen1.ownership.id,
    );

    // ── 有效恢复：替换执行实例 → 新 Attempt，经正式 Resume 进入同一 Start 服务 ──
    const attempt2 = await newPreparedAttempt(tenantId, invocationId);
    const reRead = await getInvocationById(tenantId, invocationId);
    if (!reRead) throw new Error("Invocation 回读失败");
    const resumed = await resumeRuntimeInvocation({
      tenantId,
      invocation: reRead,
      binding,
      attempt: attempt2,
      runtimeClient: cannedRuntimeClient(capabilitiesDigest),
      runtimeEndpoint: "https://control-recovery.invalid",
      auth: { mode: "none" },
      callbackEndpoints: endpointResolution().callbackEndpoints,
      anchor: `invocation:${invocationId}:recovery:1`,
      anchorDigest: protocolDigest({ kind: "control-recovery-anchor", invocationId }),
    });
    expect(resumed.accepted).toBe(true);

    // 旧代际被正式收口；Invocation **没有**因为一次代际死亡被误判为整个执行终态。
    expect((await readOwner(gen1.ownership.id))?.ownershipState).toBe("lost");
    expect((await readOwner(gen1.ownership.id))?.reasonCode).toBe("OwnershipExpired");
    expect((await getRuntimeSessionBindingById(tenantId, gen1.session.id))?.bindingState).toBe(
      "lost",
    );
    expect((await getAttemptById(attempt.id))?.attemptState).toBe("lost");
    expect((await readInvocation(tenantId, invocationId))?.executionState).toBe("running");

    const gen2 = await readCurrentAuthority(tenantId, invocationId, binding.runtimeRevisionId);
    expect(gen2.owner.id).not.toBe(gen1.ownership.id);
    expect(gen2.owner.attemptId).toBe(attempt2.id);
    expect(gen2.session.bindingState).toBe("dispatching");

    // ── 新 generation 读取子事实：从持久 Ingress 事实里读到那个尚未收口的子调用 ──
    const snapshot = await createMySqlHarnessLoopRecoveryPort(tenantId).load(invocationId);
    expect(snapshot.invocationState).toBe("running");
    expect(snapshot.actionHistory).toHaveLength(1);
    expect(snapshot.actionHistory[0]).toMatchObject({
      actionId: childActionId,
      actionType: "tool.call",
      state: "started",
      authorityRef: "tool-call:slow-child",
    });
    expect(snapshot.nextProducerSequence).toBe(4);

    // ── 子结果稍后从**已死亡的旧代际**返回：不得冒用过期 Owner 落库 ──
    const completedAt = Date.now();
    const lateSubResult = ingressRuntimeEvents({
      tenantId,
      invocationId,
      batch: {
        protocolVersion: 3,
        authority: gen1.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "4",
            type: "harness.action.completed",
            schemaVersion: 1,
            payload: {
              ...childActionEnvelope,
              state: "completed",
              observation: {
                observationType: "tool",
                summary: "慢工具执行完成",
                sourceRefs: ["tool-call:slow-child"],
                data: { state: "succeeded", completedAt },
              },
            },
          },
        ],
      },
    });
    // 过期代际的迟到结果被 Ingress 的 Current Authority 守卫拒绝（不是"接受后忽略"）。
    await expect(lateSubResult).rejects.toBeInstanceOf(ExecutionAuthorityError);
    await expect(lateSubResult).rejects.toMatchObject({ code: "NotCurrentExecutor" });

    // 拒绝是原子回滚：新 Owner 不被触碰，Invocation 水位与状态都没有被旧 Owner 推进。
    expect((await readOwner(gen2.owner.id))?.ownershipState).toBe("active");
    const afterLate = await readInvocation(tenantId, invocationId);
    expect(afterLate?.executionState).toBe("running");
    expect(afterLate?.lastProducerSequence).toBe(3);
    const completedRows = await db
      .select({ id: runtimeEventIngressTable.id })
      .from(runtimeEventIngressTable)
      .where(
        and(
          eq(runtimeEventIngressTable.tenantId, tenantId),
          eq(runtimeEventIngressTable.invocationId, invocationId),
          eq(runtimeEventIngressTable.candidateType, "harness.action.completed"),
        ),
      );
    expect(completedRows).toHaveLength(0);
  }, 30_000);

  it("CONTROL-06: 同一 Attempt 多次正式 Resume 时每代 Session 唯一、StartKey 明确，重试找到正确那一代的 Session", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
    });
    const invocation = dispatch.invocation;
    const binding = dispatch.binding;
    const attempt = dispatch.attempt;
    if (!invocation || !binding || !attempt) {
      throw new Error("调度失败：未创建 Invocation/Binding/Attempt");
    }
    const tenantId = ctx.tenantId;
    const invocationId = invocation.id;
    const capabilitiesDigest = expectedCapabilityManifestDigest({
      runtimeRevisionId: ctx.runtimeRevision.id,
      runtimeCapabilitiesJson: ctx.runtimeRevision.runtimeCapabilitiesJson,
    });
    const client = cannedRuntimeClient(capabilitiesDigest);

    // 第 1 代：正式 Start（intentType=start），Session 意图为 start。
    await startRuntimeInvocation({
      tenantId,
      invocation,
      binding,
      attempt,
      runtimeClient: client,
      runtimeEndpoint: "https://control-recovery.invalid",
      auth: { mode: "none" },
      callbackEndpoints: endpointResolution().callbackEndpoints,
      intentType: "start",
    });
    const gen1 = await readCurrentAuthority(tenantId, invocationId, binding.runtimeRevisionId);
    expect(gen1.session.intentType).toBe("start");
    expect(gen1.session.startIntentKey).toBe(`start:${gen1.owner.id}`);

    // 场景前提：Invocation 已在执行（正式 Resume 的前置状态；started→running 的映射由 CONTROL-02 覆盖）。
    await db
      .update(invocationTable)
      .set({ executionState: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)));

    const resumeOnce = async () => {
      const current = await getInvocationById(tenantId, invocationId);
      if (!current) throw new Error("Invocation 回读失败");
      return resumeRuntimeInvocation({
        tenantId,
        invocation: current,
        binding,
        attempt,
        runtimeClient: client,
        runtimeEndpoint: "https://control-recovery.invalid",
        auth: { mode: "none" },
        callbackEndpoints: endpointResolution().callbackEndpoints,
        anchor: `invocation:${invocationId}:recovery:1`,
        anchorDigest: protocolDigest({ kind: "control-recovery-anchor", invocationId }),
      });
    };

    // 正式 Resume #1：同实例恢复 → 复用同一 Attempt，但**新 Ownership + 新 Session**。
    const first = await resumeOnce();
    expect(first.accepted).toBe(true);
    const gen2 = await readCurrentAuthority(tenantId, invocationId, binding.runtimeRevisionId);
    expect(gen2.owner.id).not.toBe(gen1.owner.id);
    expect(gen2.owner.attemptId).toBe(attempt.id);
    expect(gen2.session.id).not.toBe(gen1.session.id);
    expect(gen2.session.intentType).toBe("resume");
    expect(gen2.session.startIntentKey).toBe(`start:${gen2.owner.id}`);
    // 旧代际被正式收口，而不是留着让重试误命中。
    expect((await readOwner(gen1.owner.id))?.ownershipState).toBe("released");
    expect((await readOwner(gen1.owner.id))?.reasonCode).toBe("resume_redispatch");
    expect((await getRuntimeSessionBindingById(tenantId, gen1.session.id))?.bindingState).toBe(
      "lost",
    );

    // 正式 Resume #2：同一次 Resume 的重试（丢 ACK 重发）必须命中**当前那一代**的 Session。
    const retry = await resumeOnce();
    expect(retry.accepted).toBe(true);
    expect(retry.authority.sessionBindingId).toBe(gen2.session.id);

    const sessions = await getRuntimeSessionBindingsByInvocation(tenantId, invocationId);
    expect(sessions).toHaveLength(2);
    // 每代 Session 唯一、StartKey 逐代明确（= start:<ownershipId>），没有复用旧 Key。
    expect(new Set(sessions.map((row) => row.startIntentKey)).size).toBe(2);
    for (const row of sessions) {
      expect(row.startIntentKey).toBe(`start:${row.ownershipId}`);
      expect(row.attemptId).toBe(attempt.id);
    }
    // retry 的查找语义：按 Attempt 也必须解析到**最新一代**，而不是 first by attempt。
    const byAttempt = await getRuntimeSessionBindingByAttempt(tenantId, attempt.id);
    expect(byAttempt?.id).toBe(gen2.session.id);
    expect(byAttempt?.bindingState).toBe("dispatching");
    expect(
      (await readCurrentAuthority(tenantId, invocationId, binding.runtimeRevisionId)).owner.id,
    ).toBe(gen2.owner.id);
  }, 30_000);
});
