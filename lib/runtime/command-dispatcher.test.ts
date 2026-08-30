/**
 * S05-C04：命令调度器（cancel/resume/steer）集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - dispatchSteerCommand（6 例）：成功 ack + turn.steered / 网络不可达保持 dispatched /
 *   503 保持 dispatched / 409 IDEMPOTENCY_CONFLICT 幂等复用 / 400 HTTP 错误标记 failed /
 *   命令不存在 → CommandNotFoundError
 * - dispatchCancelCommand（5 例）：成功 ack / 网络不可达保持 dispatched /
 *   503 保持 dispatched / 409 幂等复用 / 命令已调度 → CommandAlreadyDispatchedError
 * - dispatchResumeCommand（8 例）：成功 ack + turn.resumed + invocation.resumed +
 *   Invocation waiting_user→running / 网络不可达保持 dispatched / 503 保持 dispatched /
 *   409 幂等复用 / 非 waiting_user → ResumeInvocationNotWaitingError / 跨租户隐藏 404 /
 *   requires_redispatch=true 触发重调度（创建新 Attempt + 调用 startInvocation） /
 *   requires_redispatch=true 但 gatewayEndpoints 缺失 → 命令 failed
 * - Runtime 路由（6 例）：POST :cancel 成功 / 缺少 Token 401 / 缺少 Idempotency-Key 400 /
 *   POST :resume 成功 / POST :steer 成功 / Token invocation 不匹配 401
 * - 端到端 + 投影器（3 例）：Steer 完整链路 + turn.steered 投影 / Cancel 完整链路 +
 *   命令状态机 / Resume 完整链路 + Turn/Invocation 状态推进 + 投影
 *
 * 真实 MySQL 8 Testcontainers + 真实 ed25519 签名，不使用 mock。
 */
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { createDraftRevisionWithContractSnapshot } from "@/lib/agents/test-support/create-draft-revision-with-contract";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type VerifyAttestationInput,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-writer";
import {
  buildDsseArtifactAttestationEnvelope,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { RequiredContextUnavailableError } from "@/lib/context/enrichment/build-invocation-context-bundle";
import { requestInterrupt } from "@/lib/conversations/interrupt-queries";
import { queueSteer } from "@/lib/conversations/steer-queries";
import { createThread } from "@/lib/conversations/thread-queries";
import { updateTurnState } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import type { AuditActor } from "@/lib/identity/audit";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  WORKLOAD_TOKEN_DEFAULT_TTL_MS,
  type WorkloadTokenClaims,
  issueWorkloadToken,
} from "@/lib/identity/workload-token";
import {
  type AgentRevision,
  agentContractSnapshotTable,
  agentTable,
} from "@/lib/persistence/schema/agents";
import type {
  InvocationCommand,
  ThreadEvent,
  TurnState,
} from "@/lib/persistence/schema/conversation";
import {
  invocationCommandTable,
  threadEventTable,
  threadItemTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import {
  type ExecutionBinding,
  invocationAttemptTable,
  invocationTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import { type RuntimeRevision, runtimeRevisionTable } from "@/lib/persistence/schema/runtimes";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import {
  type EventBatchSink,
  createHostedAdapter,
  setRouteHostedAdapter,
} from "@/lib/runtime/adapters/hosted-adapter";
import {
  dispatchInterruptCommandToRuntime,
  dispatchResumeCommandToRuntime,
} from "@/lib/runtime/command-dispatch-gateway";
import {
  type CommandDispatchResult,
  type CommandRuntimeEndpointResolution,
  dispatchCancelCommand,
  dispatchResumeCommand,
  dispatchSteerCommand,
  retryDispatchedInvocationCommand,
} from "@/lib/runtime/command-dispatcher";
import { DEFAULT_ROUTE_SCOPE_KEY, dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import {
  CommandAlreadyDispatchedError,
  CommandInvocationNotFoundError,
  CommandNotFoundError,
  ResumeInvocationNotWaitingError,
  RuntimeHttpClientError,
} from "@/lib/runtime/errors";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { claimDueInvocationCommands } from "@/lib/runtime/retry/dispatch-retry-queries";
import {
  type CancelInvocationResponse,
  type ResumeInvocationResponse,
  type StartInvocationResponse,
  type SteerInvocationResponse,
  createMockRuntimeClient,
} from "@/lib/runtime/runtime-client";
import { createSessionBinding } from "@/lib/runtime/session-binding-queries";
import { publishRuntimeRevisionForTest } from "@/lib/test-support/publish-runtime-revision-for-test";
import { publishTrustedAgentRevisionForTest } from "@/lib/test-support/publish-trusted-agent-revision";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：InMemoryManagedArtifactStore ────────────────────

class InMemoryManagedArtifactStore implements ManagedArtifactStore {
  private envelopes = new Map<string, Buffer>();
  private sboms = new Map<string, unknown>();
  private provenances = new Map<string, ProvenanceDocument>();

  writeDsseEnvelope(ref: string, envelope: Buffer): void {
    this.envelopes.set(ref, envelope);
  }
  writeSbom(ref: string, doc: unknown): void {
    this.sboms.set(ref, doc);
  }
  writeProvenance(ref: string, doc: ProvenanceDocument): void {
    this.provenances.set(ref, doc);
  }

  async readDsseEnvelope(ref: string): Promise<Buffer> {
    const envelope = this.envelopes.get(ref);
    if (!envelope) throw new Error(`DSSE envelope not found: ${ref}`);
    return envelope;
  }
  async readSbom(ref: string): Promise<unknown> {
    const doc = this.sboms.get(ref);
    if (!doc) throw new Error(`sbom not found: ${ref}`);
    return doc;
  }
  async readProvenance(ref: string): Promise<ProvenanceDocument> {
    const doc = this.provenances.get(ref);
    if (!doc) throw new Error(`provenance not found: ${ref}`);
    return doc;
  }
}

// ─── 辅助：DSSE Envelope 构造（来自 test-support） ─────────
// generateTestBuilderKey / buildDsseArtifactAttestationEnvelope 来自 test-support。

function buildCleanSbom(): unknown {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { type: "application", name: "test-app", version: "1.0.0" } },
    components: [
      {
        type: "library",
        name: "lodash",
        version: "4.17.21",
        licenses: [{ license: { id: "MIT" } }],
      },
    ],
  };
}

function buildValidProvenance(): ProvenanceDocument {
  return {
    buildPipeline: "ci-cd-pipeline-1",
    sourceRevision: "git_commit_1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  };
}

// ─── 辅助：seed 租户 + 用户 ────────────────────────────────

async function seedTenantAndOwner() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "cmd-dispatcher-owner-001",
    email: "cmd-dispatcher-owner@example.com",
    displayName: "Command Dispatcher Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "cmd-dispatcher-owner-001",
    displayName: "Command Dispatcher Owner",
    userIdentityId: identity.id,
  });
  return { tenantId: tenant.id, ownerId: identity.id };
}

function buildActor(tenantId: string, actorId: string): AuditActor {
  return { tenantId, actorType: "service", actorId };
}

// ─── 辅助：创建 verified attestation ───────────────────────

async function createVerifiedAttestation(
  tenantId: string,
  artifactType: string,
  artifactRevisionId: string,
  artifactContent: string,
) {
  const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
  const builderKeys: BuilderKeyRegistry = {
    "builder:company-agent-runtime": keyPair.publicKeyBase64,
  };
  const digest = computeArtifactDigest(artifactContent);
  const dsseEnvelopeRef = `attestation:signature:${digest.slice(7, 15)}`;
  const sbomRef = `attestation:sbom:${digest.slice(7, 15)}`;
  const provRef = `attestation:provenance:${digest.slice(7, 15)}`;

  const store = new InMemoryManagedArtifactStore();
  store.writeDsseEnvelope(
    dsseEnvelopeRef,
    buildDsseArtifactAttestationEnvelope(keyPair, digest, {
      sbomRef,
      sbomContent: buildCleanSbom(),
      provenanceRef: provRef,
      provenanceContent: buildValidProvenance(),
    }),
  );
  store.writeSbom(sbomRef, buildCleanSbom());
  store.writeProvenance(provRef, buildValidProvenance());

  const input: VerifyAttestationInput = {
    tenantId,
    artifactType,
    artifactRevisionId,
    artifactDigest: digest,
    dsseEnvelopeRef,
    builderIdentity: "builder:company-agent-runtime",
  };

  return verifyAndPersistAttestation(
    input,
    store,
    builderKeys,
    buildActor(tenantId, "ci-service-001"),
  );
}

// ─── 辅助：seed Agent + published AgentRevision + attestation ─

async function seedPublishedAgentRevision(
  tenantId: string,
  ownerId: string,
  agentKey: string,
  requiredCaps: string[],
  contentSuffix: string,
) {
  const agent = await createAgent({
    tenantId,
    agentKey,
    displayName: `Agent ${agentKey}`,
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });

  const revision = await createDraftRevisionWithContractSnapshot({
    tenantId,
    agentId: agent.id,
    modelPolicyJson: { default: "doubao-pro", provider: "doubao" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: { allowed_agent_ids: [] },
    agentInterfaceRequirementsJson: { required: requiredCaps, optional: [] },
    createdBy: ownerId,
  });

  await publishTrustedAgentRevisionForTest({
    tenantId,
    revisionId: revision.id,
    agentExpectedVersionNo: 1,
    actorId: ownerId,
  });

  return { agent, revision };
}

// ─── 辅助：seed Runtime + published RuntimeRevision + attestation ─

async function seedPublishedRuntimeRevision(
  tenantId: string,
  ownerId: string,
  runtimeKey: string,
  capabilities: string[],
  contentSuffix: string,
  protocolType: "harness_runtime_protocol" = "harness_runtime_protocol",
) {
  const runtime = await createRuntime({
    tenantId,
    runtimeKey,
    displayName: `Runtime ${runtimeKey}`,
    runtimeKind: "hosted",
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });

  const revision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType,
    protocolContractRevision: "harness-runtime-protocol@1",
    runtimeEvidenceKind: "hosted_artifact",
    endpointRef: `https://runtime-${contentSuffix}.internal`,
    runtimeArtifactRef: `oci://registry/runtime@${computeArtifactDigest(`runtime-content-${contentSuffix}`)}`,
    runtimeCapabilitiesJson: capabilities,
    identityMode: "none",
    networkZone: "internal",
    configHash: computeArtifactDigest(`runtime-config-${contentSuffix}`),
    createdBy: ownerId,
  });

  const attestation = await createVerifiedAttestation(
    tenantId,
    "runtime_revision",
    revision.id,
    `runtime-content-${contentSuffix}`,
  );
  await publishRuntimeRevisionForTest({
    tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: 1,
    attestationId: attestation.id,
  });

  return { runtime, revision };
}

// ─── 辅助：seed 完整调度上下文 ─────────────────────────────

interface FullCommandContext {
  tenantId: string;
  ownerId: string;
  agentId: string;
  agentRevision: AgentRevision;
  runtimeRevision: RuntimeRevision;
  routeId: string;
  routeSetId: string;
  threadId: string;
  turnId: string;
  triggerItemId: string | null;
}

async function seedFullCommandContext(
  protocolType: "harness_runtime_protocol" = "harness_runtime_protocol",
): Promise<FullCommandContext> {
  const { tenantId, ownerId } = await seedTenantAndOwner();

  const { agent, revision: agentRevision } = await seedPublishedAgentRevision(
    tenantId,
    ownerId,
    "cmd-agent",
    ["event_stream"],
    "v1",
  );

  const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
    tenantId,
    ownerId,
    "cmd-runtime",
    ["event_stream"],
    "v1",
    protocolType,
  );

  // 顶层恒为 base harness route（target={kind:"runtime"}）。
  const routeSet = await createRouteSet({
    tenantId,
    target: { kind: "runtime" },
    routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
    routeScopeJson: { networkZone: "internal" },
  });

  const routeResult = await activateSingleRouteForTest({
    tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    target: { kind: "runtime", runtimeRevisionId: runtimeRevision.id },
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(tenantId, "deploy-bot-001"),
  });

  const { thread } = await createThread({
    tenantId,
    ownerUserId: ownerId,
    actorId: ownerId,
  });

  const { turn } = await acceptUserMessageTurnForCmd({
    tenantId,
    threadId: thread.id,
    ownerUserId: ownerId,
  });

  return {
    tenantId,
    ownerId,
    agentId: agent.id,
    agentRevision,
    runtimeRevision,
    routeId: routeResult.route.id,
    routeSetId: routeSet.id,
    threadId: thread.id,
    turnId: turn.id,
    triggerItemId: turn.triggerItemId ?? null,
  };
}

// ─── 辅助：acceptUserMessageTurn（简化封装） ───────────────

async function acceptUserMessageTurnForCmd(params: {
  tenantId: string;
  threadId: string;
  ownerUserId: string;
}) {
  const { acceptUserMessageTurn } = await import("@/lib/conversations/turn-queries");
  return acceptUserMessageTurn({
    tenantId: params.tenantId,
    threadId: params.threadId,
    ownerUserId: params.ownerUserId,
    content: { text: "请帮我执行命令调度测试" },
    actorId: params.ownerUserId,
  });
}

// ─── 辅助：调度 Invocation 并将 Turn 推进到 running ────────

interface RunningInvocationContext {
  invocationId: string;
  tenantId: string;
  threadId: string;
  turnId: string;
  turnVersionNo: number;
}

async function seedRunningInvocationWithRunningTurn(
  ctx: FullCommandContext,
): Promise<RunningInvocationContext> {
  // 调度（不传 runtimeClient，Invocation 保持 queued）；顶层 base harness route。
  const result = await dispatchInvocationForTurn({
    tenantId: ctx.tenantId,
    turnId: ctx.turnId,
  });

  const invocation = result.invocation;
  if (!invocation) {
    throw new Error("调度失败：未创建 Invocation");
  }

  // Invocation queued → running
  await db.transaction(async (tx) => {
    await updateInvocationState(tx, ctx.tenantId, invocation.id, "running");
  });

  // Turn queued → running（用于 Steer）
  const [turnRow] = await db.select().from(turnTable).where(eq(turnTable.id, ctx.turnId)).limit(1);
  if (!turnRow) throw new Error(`Turn 不存在: ${ctx.turnId}`);

  await updateTurnState(ctx.tenantId, ctx.turnId, "running", turnRow.versionNo);

  const [updatedTurn] = await db
    .select()
    .from(turnTable)
    .where(eq(turnTable.id, ctx.turnId))
    .limit(1);

  return {
    invocationId: invocation.id,
    tenantId: ctx.tenantId,
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    turnVersionNo: updatedTurn?.versionNo ?? 1,
  };
}

// ─── 辅助：将 Turn 推进到 waiting_user + Invocation waiting_user ──

async function transitionToWaitingUser(
  ctx: FullCommandContext,
  running: RunningInvocationContext,
): Promise<void> {
  // Turn running → waiting_user
  await updateTurnState(ctx.tenantId, ctx.turnId, "waiting_user", running.turnVersionNo);

  // Invocation running → waiting_user
  await db.transaction(async (tx) => {
    await updateInvocationState(tx, ctx.tenantId, running.invocationId, "waiting_user");
  });
}

// ─── 辅助：构造 CommandRuntimeEndpointResolution ──────────

function buildCommandRuntimeEndpointResolution(
  runtimeRevisionId: string,
): CommandRuntimeEndpointResolution {
  return {
    runtimeEndpoint: "https://runtime-hosted.internal",
    auth: {
      mode: "workload_token",
      token: issueWorkloadToken({
        type: "runtime",
        tenantId: "test-tenant",
        invocationId: "test-invocation",
        runtimeRevisionId,
        audience: "runtime",
        expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
      }),
    },
    gatewayEndpoints: {
      events: "https://gateway.internal/events",
      cancel: "https://gateway.internal/cancel",
      resume: "https://gateway.internal/resume",
      steer: "https://gateway.internal/steer",
      tools: "https://gateway.internal/tools",
      tool_calls: "https://gateway.internal/tool-calls",
      user_action_requests: "https://gateway.internal/user-action-requests",
    },
    governanceConfig: {
      revision_id: "gov-rev-1",
      config_digest: "sha256:test-governance-digest",
      config: {},
    },
    gatewayAccess: {
      access_token: issueWorkloadToken({
        type: "gateway",
        tenantId: "test-tenant",
        invocationId: "test-invocation",
        audience: "gateway",
        expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway,
      }),
      expires_at: new Date(Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway).toISOString(),
    },
  };
}

// ─── 辅助：构造 Workload Token（route 测试用） ─────────────

function makeWorkloadToken(
  tenantId: string,
  invocationId: string,
  runtimeRevisionId: string,
): string {
  const claims: Omit<WorkloadTokenClaims, "issuedAt"> = {
    type: "runtime",
    tenantId,
    jti: "jti-runtime-dispatcher-001",
    invocationId,
    runtimeRevisionId,
    audience: "runtime",
    expiresAt: Date.now() + 60_000,
  };
  return issueWorkloadToken(claims);
}

// ─── 辅助：构造 mock 命令响应 ──────────────────────────────

function buildCancelResponse(invocationId: string): CancelInvocationResponse {
  return {
    invocation_id: invocationId,
    cancelled: true,
    attempt_no: 1,
  };
}

function buildResumeResponse(invocationId: string): ResumeInvocationResponse {
  return {
    invocation_id: invocationId,
    resumed: true,
    attempt_no: 1,
  };
}

function buildSteerResponse(invocationId: string): SteerInvocationResponse {
  return {
    invocation_id: invocationId,
    steered: true,
    attempt_no: 1,
  };
}

// ─── 辅助：查询命令当前状态 ────────────────────────────────

async function getCommandRow(commandId: string): Promise<InvocationCommand | null> {
  const [row] = await db
    .select()
    .from(invocationCommandTable)
    .where(eq(invocationCommandTable.id, commandId))
    .limit(1);
  return row ?? null;
}

// ─── 辅助：将 Interrupt 命令绑定 invocationId ──────────────

async function bindInvocationIdToCommand(commandId: string, invocationId: string): Promise<void> {
  // requestInterrupt 创建的命令 invocationId=null（queued 状态可空），
  // 调度器首次加载 queued Command 时要求 invocationId 非空，
  // 此处模拟 Runtime 拉取后的 invocationId 绑定。
  await db
    .update(invocationCommandTable)
    .set({ invocationId, updatedAt: new Date() })
    .where(eq(invocationCommandTable.id, commandId));
}

// ─── 辅助：直接创建 Resume 命令（queueResume 尚未实现） ────

async function createResumeCommand(params: {
  threadId: string;
  turnId: string;
  invocationId: string;
  resumePayload: unknown;
  idempotencyKey: string;
}): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  const { computeInvocationCommandPayloadHash } = await import(
    "@/lib/conversations/regenerate-queries"
  );
  const commandId = randomUUID();
  const now = new Date();
  const commandPayload: Record<string, unknown> = {
    resume_payload: params.resumePayload,
    turn_id: params.turnId,
  };
  const commandPayloadHash = computeInvocationCommandPayloadHash(commandPayload);

  await db.insert(invocationCommandTable).values({
    id: commandId,
    invocationId: params.invocationId,
    threadId: params.threadId,
    turnId: params.turnId,
    commandType: "resume",
    commandPayloadJson: commandPayload,
    commandPayloadHash,
    commandState: "queued",
    runtimeExecutionRef: null,
    idempotencyKey: params.idempotencyKey,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    dispatchedAt: null,
    acknowledgedAt: null,
    failedAt: null,
    updatedAt: now,
  });

  return commandId;
}

// ═══════════════════════════════════════════════════════════
// 1. dispatchSteerCommand
// ═══════════════════════════════════════════════════════════

describe("S05-C04 dispatchSteerCommand", () => {
  let ctx: FullCommandContext;

  beforeEach(async () => {
    ctx = await seedFullCommandContext();
  });

  it("成功 ack：CAS queued→dispatched→acknowledged + 写 turn.steered Event", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);

    // 入队 Steer 命令
    const steerResult = await queueSteer({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      guidanceText: "请使用更正式的语气",
      idempotencyKey: "steer-key-1",
    });

    const mockClient = createMockRuntimeClient({
      steerInvocation: async (req) => buildSteerResponse(req.invocationId),
    });

    const result = await dispatchSteerCommand({
      tenantId: ctx.tenantId,
      commandId: steerResult.command.id,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
      correlationId: "steer-test-1",
    });

    expect(result.commandState).toBe("acknowledged");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventType).toBe("turn.steered");

    // 命令状态已 acknowledged
    const cmdRow = await getCommandRow(steerResult.command.id);
    expect(cmdRow?.commandState).toBe("acknowledged");
    expect(cmdRow?.acknowledgedAt).toBeTruthy();
    expect(cmdRow?.dispatchedAt).toBeTruthy();

    // mock client 被调用一次
    expect(mockClient.calls.steerInvocation).toHaveLength(1);
    expect(mockClient.calls.steerInvocation[0]?.invocationId).toBe(running.invocationId);
  });

  it("网络不可达：保持 dispatched（skipped=true，等待重试）", async () => {
    await seedRunningInvocationWithRunningTurn(ctx);

    const steerResult = await queueSteer({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      guidanceText: "网络测试",
      idempotencyKey: "steer-key-2",
    });

    const mockClient = createMockRuntimeClient({
      steerInvocation: async () => {
        throw new RuntimeHttpClientError("network", "网络不可达");
      },
    });

    const result = await dispatchSteerCommand({
      tenantId: ctx.tenantId,
      commandId: steerResult.command.id,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("dispatched");
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("runtime_network_unavailable");

    // 命令保持 dispatched（未 acknowledged，未 failed）
    const cmdRow = await getCommandRow(steerResult.command.id);
    expect(cmdRow?.commandState).toBe("dispatched");
    expect(cmdRow?.acknowledgedAt).toBeNull();
    expect(cmdRow?.failedAt).toBeNull();
  });

  it("Runtime 503：保持 dispatched（skipped=true，等待重试）", async () => {
    await seedRunningInvocationWithRunningTurn(ctx);

    const steerResult = await queueSteer({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      guidanceText: "503 测试",
      idempotencyKey: "steer-key-3",
    });

    const mockClient = createMockRuntimeClient({
      steerInvocation: async () => {
        throw new RuntimeHttpClientError("http", "Runtime 不可用", 503, "RUNTIME_UNAVAILABLE");
      },
    });

    const result = await dispatchSteerCommand({
      tenantId: ctx.tenantId,
      commandId: steerResult.command.id,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("dispatched");
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("runtime_unavailable");

    const cmdRow = await getCommandRow(steerResult.command.id);
    expect(cmdRow?.commandState).toBe("dispatched");
  });

  it("409 IDEMPOTENCY_CONFLICT：幂等复用，标记 acknowledged", async () => {
    await seedRunningInvocationWithRunningTurn(ctx);

    const steerResult = await queueSteer({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      guidanceText: "幂等测试",
      idempotencyKey: "steer-key-4",
    });

    const mockClient = createMockRuntimeClient({
      steerInvocation: async () => {
        throw new RuntimeHttpClientError("http", "幂等冲突", 409, "IDEMPOTENCY_CONFLICT");
      },
    });

    const result = await dispatchSteerCommand({
      tenantId: ctx.tenantId,
      commandId: steerResult.command.id,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("acknowledged");
    // 幂等复用不写新事件
    expect(result.events).toHaveLength(0);

    const cmdRow = await getCommandRow(steerResult.command.id);
    expect(cmdRow?.commandState).toBe("acknowledged");
  });

  it("Runtime 拒绝（400 错误）：标记 failed（不伪造成功）", async () => {
    await seedRunningInvocationWithRunningTurn(ctx);

    const steerResult = await queueSteer({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      guidanceText: "失败测试",
      idempotencyKey: "steer-key-5",
    });

    const mockClient = createMockRuntimeClient({
      steerInvocation: async () => {
        throw new RuntimeHttpClientError("http", "请求非法", 400, "REQUEST_SCHEMA_INVALID");
      },
    });

    const result = await dispatchSteerCommand({
      tenantId: ctx.tenantId,
      commandId: steerResult.command.id,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("failed");
    expect(result.errorCode).toBe("REQUEST_SCHEMA_INVALID");
    expect(result.errorMessage).toBeTruthy();

    const cmdRow = await getCommandRow(steerResult.command.id);
    expect(cmdRow?.commandState).toBe("failed");
    expect(cmdRow?.errorCode).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("命令不存在 → CommandNotFoundError（跨租户隐藏 404）", async () => {
    const mockClient = createMockRuntimeClient({
      steerInvocation: async (req) => buildSteerResponse(req.invocationId),
    });

    await expect(
      dispatchSteerCommand({
        tenantId: ctx.tenantId,
        commandId: "nonexistent-command-id",
        runtimeClient: mockClient,
        runtimeEndpointResolver: async () =>
          buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
      }),
    ).rejects.toThrow(CommandNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. dispatchCancelCommand
// ═══════════════════════════════════════════════════════════

describe("S05-C04 dispatchCancelCommand", () => {
  let ctx: FullCommandContext;

  beforeEach(async () => {
    ctx = await seedFullCommandContext();
  });

  it("成功 ack：CAS queued→dispatched→acknowledged（Turn 终态由 ingress 推进）", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);

    // 入队 Interrupt 命令（requestInterrupt 创建 invocationId=null）
    const interruptResult = await requestInterrupt({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "user_cancel",
      idempotencyKey: "cancel-key-1",
    });

    // 绑定 invocationId（模拟 Runtime 拉取后绑定）
    await bindInvocationIdToCommand(interruptResult.command.id, running.invocationId);

    const mockClient = createMockRuntimeClient({
      cancelInvocation: async (req) => buildCancelResponse(req.invocationId),
    });

    const result = await dispatchCancelCommand({
      tenantId: ctx.tenantId,
      commandId: interruptResult.command.id,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
      correlationId: "cancel-test-1",
    });

    expect(result.commandState).toBe("acknowledged");
    // Cancel 不写新事件（Turn 终态由 ingress execution.cancelled 推进）
    expect(result.events).toHaveLength(0);

    const cmdRow = await getCommandRow(interruptResult.command.id);
    expect(cmdRow?.commandState).toBe("acknowledged");

    expect(mockClient.calls.cancelInvocation).toHaveLength(1);
    expect(mockClient.calls.cancelInvocation[0]?.invocationId).toBe(running.invocationId);
  });

  it("网络不可达：保持 dispatched（skipped=true）", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);

    const interruptResult = await requestInterrupt({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "user_cancel",
      idempotencyKey: "cancel-key-2",
    });

    await bindInvocationIdToCommand(interruptResult.command.id, running.invocationId);

    const mockClient = createMockRuntimeClient({
      cancelInvocation: async () => {
        throw new RuntimeHttpClientError("network", "网络不可达");
      },
    });

    const result = await dispatchCancelCommand({
      tenantId: ctx.tenantId,
      commandId: interruptResult.command.id,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("dispatched");
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("runtime_network_unavailable");

    const cmdRow = await getCommandRow(interruptResult.command.id);
    expect(cmdRow?.commandState).toBe("dispatched");
  });

  it("Runtime 503：保持 dispatched（skipped=true）", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);

    const interruptResult = await requestInterrupt({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "user_cancel",
      idempotencyKey: "cancel-key-3",
    });

    await bindInvocationIdToCommand(interruptResult.command.id, running.invocationId);

    const mockClient = createMockRuntimeClient({
      cancelInvocation: async () => {
        throw new RuntimeHttpClientError("http", "不可用", 503, "RUNTIME_UNAVAILABLE");
      },
    });

    const result = await dispatchCancelCommand({
      tenantId: ctx.tenantId,
      commandId: interruptResult.command.id,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("dispatched");
    expect(result.skipReason).toBe("runtime_unavailable");
  });

  it("409 IDEMPOTENCY_CONFLICT：幂等复用，标记 acknowledged", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);

    const interruptResult = await requestInterrupt({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "user_cancel",
      idempotencyKey: "cancel-key-4",
    });

    await bindInvocationIdToCommand(interruptResult.command.id, running.invocationId);

    const mockClient = createMockRuntimeClient({
      cancelInvocation: async () => {
        throw new RuntimeHttpClientError("http", "幂等冲突", 409, "IDEMPOTENCY_CONFLICT");
      },
    });

    const result = await dispatchCancelCommand({
      tenantId: ctx.tenantId,
      commandId: interruptResult.command.id,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("acknowledged");

    const cmdRow = await getCommandRow(interruptResult.command.id);
    expect(cmdRow?.commandState).toBe("acknowledged");
  });

  it("命令已调度 → CommandAlreadyDispatchedError（不可重复调度）", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);

    const interruptResult = await requestInterrupt({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "user_cancel",
      idempotencyKey: "cancel-key-5",
    });

    await bindInvocationIdToCommand(interruptResult.command.id, running.invocationId);

    const mockClient = createMockRuntimeClient({
      cancelInvocation: async (req) => buildCancelResponse(req.invocationId),
    });

    // 第一次调度成功
    await dispatchCancelCommand({
      tenantId: ctx.tenantId,
      commandId: interruptResult.command.id,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    // 第二次调度应抛 CommandAlreadyDispatchedError
    await expect(
      dispatchCancelCommand({
        tenantId: ctx.tenantId,
        commandId: interruptResult.command.id,
        runtimeClient: mockClient,
        runtimeEndpointResolver: async () =>
          buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
      }),
    ).rejects.toThrow(CommandAlreadyDispatchedError);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. dispatchResumeCommand
// ═══════════════════════════════════════════════════════════

describe("S05-C04 dispatchResumeCommand", () => {
  let ctx: FullCommandContext;

  beforeEach(async () => {
    ctx = await seedFullCommandContext();
  });

  it("成功 ack：Invocation waiting_user→running + Turn waiting_user→running + 写 turn.resumed/invocation.resumed", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);

    // 将 Turn + Invocation 推进到 waiting_user
    await transitionToWaitingUser(ctx, running);

    // 创建 Resume 命令
    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm", value: "yes" },
      idempotencyKey: "resume-key-1",
    });

    const mockClient = createMockRuntimeClient({
      resumeInvocation: async (req) => buildResumeResponse(req.invocationId),
    });

    const result = await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
      correlationId: "resume-test-1",
    });

    expect(result.commandState).toBe("acknowledged");
    // 写入 2 个事件：turn.resumed + invocation.resumed
    expect(result.events).toHaveLength(2);
    const eventTypes = result.events.map((e) => e.eventType).sort();
    expect(eventTypes).toEqual(["invocation.resumed", "turn.resumed"]);

    // 命令状态 acknowledged
    const cmdRow = await getCommandRow(resumeCommandId);
    expect(cmdRow?.commandState).toBe("acknowledged");

    // Invocation 已转为 running
    const invocation = await getInvocationById(ctx.tenantId, running.invocationId);
    expect(invocation?.executionState).toBe("running");

    // Turn 已转为 running
    const [turnRow] = await db
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, ctx.turnId))
      .limit(1);
    expect(turnRow?.turnState).toBe("running");

    expect(mockClient.calls.resumeInvocation).toHaveLength(1);
  });

  it("04 专项：resolveInvocationContext 的 supplied entries 进入 resume wire（每次 dispatch 重建）", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);
    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { text: "明天一天" },
      idempotencyKey: "resume-ctx-key-1",
    });
    const mockClient = createMockRuntimeClient({
      resumeInvocation: async (req) => buildResumeResponse(req.invocationId),
    });
    const contextEntries = [
      {
        context_kind: "execution_subject",
        value: { subject_id: "user-1", subject_kind: "platform_user" },
      },
      { context_kind: "current_datetime", value: "2026-08-27T00:00:00.000Z" },
    ];
    const result = await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
      resolveInvocationContext: async () => contextEntries,
    });
    expect(result.commandState).toBe("acknowledged");
    expect(mockClient.calls.resumeInvocation).toHaveLength(1);
    expect(mockClient.calls.resumeInvocation[0]?.requestBody.invocation_context).toEqual(
      contextEntries,
    );
  });

  it("04 专项：required context 缺失 → 命令 failed（fail closed，零网络）", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);
    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { text: "明天一天" },
      idempotencyKey: "resume-ctx-key-2",
    });
    const mockClient = createMockRuntimeClient({
      resumeInvocation: async (req) => buildResumeResponse(req.invocationId),
    });
    const result = await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
      resolveInvocationContext: async () => {
        throw new RequiredContextUnavailableError("execution_subject");
      },
    });
    expect(result.commandState).toBe("failed");
    expect(result.errorCode).toBe("RESUME_CONTEXT_UNAVAILABLE");
    expect(mockClient.calls.resumeInvocation).toHaveLength(0);
    const cmdRow = await getCommandRow(resumeCommandId);
    expect(cmdRow?.commandState).toBe("failed");
  });

  it("网络不可达：保持 dispatched（skipped=true，等待重试）", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);

    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-key-2",
    });

    const mockClient = createMockRuntimeClient({
      resumeInvocation: async () => {
        throw new RuntimeHttpClientError("network", "网络不可达");
      },
    });

    const result = await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("dispatched");
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("runtime_network_unavailable");

    // Invocation 仍为 waiting_user（未推进）
    const invocation = await getInvocationById(ctx.tenantId, running.invocationId);
    expect(invocation?.executionState).toBe("waiting_user");
  });

  it("Runtime 503：保持 dispatched（skipped=true）", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);

    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-key-3",
    });

    const mockClient = createMockRuntimeClient({
      resumeInvocation: async () => {
        throw new RuntimeHttpClientError("http", "不可用", 503, "RUNTIME_UNAVAILABLE");
      },
    });

    const result = await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("dispatched");
    expect(result.skipReason).toBe("runtime_unavailable");
  });

  it("409 IDEMPOTENCY_CONFLICT：幂等复用，标记 acknowledged", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);

    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-key-4",
    });

    const mockClient = createMockRuntimeClient({
      resumeInvocation: async () => {
        throw new RuntimeHttpClientError("http", "幂等冲突", 409, "IDEMPOTENCY_CONFLICT");
      },
    });

    const result = await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("acknowledged");
    // 幂等复用不写新事件，也不推进 Invocation/Turn 状态
    expect(result.events).toHaveLength(0);

    const cmdRow = await getCommandRow(resumeCommandId);
    expect(cmdRow?.commandState).toBe("acknowledged");
  });

  it("非 waiting_user Invocation → ResumeInvocationNotWaitingError", async () => {
    // Invocation 保持 running 状态（未推进到 waiting_user）
    const running = await seedRunningInvocationWithRunningTurn(ctx);

    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-key-5",
    });

    const mockClient = createMockRuntimeClient({
      resumeInvocation: async (req) => buildResumeResponse(req.invocationId),
    });

    await expect(
      dispatchResumeCommand({
        tenantId: ctx.tenantId,
        commandId: resumeCommandId,
        runtimeClient: mockClient,
        runtimeEndpointResolver: async () =>
          buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
      }),
    ).rejects.toThrow(ResumeInvocationNotWaitingError);

    // 命令保持 queued（未调度）
    const cmdRow = await getCommandRow(resumeCommandId);
    expect(cmdRow?.commandState).toBe("queued");
  });

  it("跨租户：不同 tenantId → CommandNotFoundError（隐藏式 404）", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);

    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-key-6",
    });

    const mockClient = createMockRuntimeClient({
      resumeInvocation: async (req) => buildResumeResponse(req.invocationId),
    });

    await expect(
      dispatchResumeCommand({
        tenantId: "11111111-1111-4111-8111-111111111111", // 不同租户
        commandId: resumeCommandId,
        runtimeClient: mockClient,
        runtimeEndpointResolver: async () =>
          buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
      }),
    ).rejects.toThrow(CommandNotFoundError);
  });

  it("requires_redispatch=true：触发重调度（创建新 Attempt + 调用 startInvocation + 写 turn.resumed + invocation.started）", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);

    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-key-redispatch",
    });

    // Runtime resumeInvocation 返回 requires_redispatch=true，触发重调度流程
    // Runtime startInvocation 返回成功响应（attempt_no=2）
    const startInvocationResponse: StartInvocationResponse = {
      invocation_id: running.invocationId,
      accepted: true,
      attempt_no: 2,
      runtime_session_ref: `runtime-session-${running.invocationId}-2`,
      runtime_execution_ref: `runtime-exec-${running.invocationId}-2`,
      capabilities: {
        protocol_versions: ["2"],
        features: {
          event_stream: true,
          cancel: true,
          resume: true,
          steer: true,
          dynamic_tools: true,
          user_action: true,
          workspace_types: ["none"],
          filesystem_checkpoint: true,
        },
        limits: { max_invocation_seconds: 600, max_event_bytes: 1_048_576 },
      },
    };
    const mockClient = createMockRuntimeClient({
      resumeInvocation: async (req) => ({
        invocation_id: req.invocationId,
        resumed: false,
        attempt_no: 1,
        requires_redispatch: true,
      }),
      startInvocation: async () => startInvocationResponse,
    });

    // runtimeEndpointResolver 必须包含 gatewayEndpoints（redispatch 需要）
    const result = await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () => ({
        ...buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
        gatewayEndpoints: {
          events: "https://gateway.internal/events",
          cancel: "https://gateway.internal/cancel",
          resume: "https://gateway.internal/resume",
          steer: "https://gateway.internal/steer",
          tools: "https://gateway.internal/tools",
          tool_calls: "https://gateway.internal/tool-calls",
          user_action_requests: "https://gateway.internal/user-action-requests",
        },
      }),
      correlationId: "resume-redispatch-test-1",
    });

    // 命令 acknowledged
    expect(result.commandState).toBe("acknowledged");
    expect(result.redispatched).toBe(true);

    // 写入 2 个事件：turn.resumed (带 redispatched=true) + invocation.started (带 redispatched=true)
    expect(result.events).toHaveLength(2);
    const eventTypes = result.events.map((e) => e.eventType).sort();
    expect(eventTypes).toEqual(["invocation.started", "turn.resumed"]);

    const turnResumed = result.events.find((e) => e.eventType === "turn.resumed");
    const turnResumedPayload = turnResumed?.payloadJson as Record<string, unknown>;
    expect(turnResumedPayload.redispatched).toBe(true);
    expect(turnResumedPayload.requires_redispatch).toBe(true);

    const invocationStarted = result.events.find((e) => e.eventType === "invocation.started");
    const invocationStartedPayload = invocationStarted?.payloadJson as Record<string, unknown>;
    expect(invocationStartedPayload.redispatched).toBe(true);
    expect(invocationStartedPayload.attempt_no).toBe(2);
    expect(invocationStartedPayload.retry_reason).toBe("requires_redispatch");

    // 命令行状态
    const cmdRow = await getCommandRow(resumeCommandId);
    expect(cmdRow?.commandState).toBe("acknowledged");

    // Invocation 已转为 running（由 redispatchInvocation 推进）
    const invocation = await getInvocationById(ctx.tenantId, running.invocationId);
    expect(invocation?.executionState).toBe("running");
    expect(invocation?.runtimeExecutionRef).toBeTruthy();

    // Turn 已转为 running（由 handleResumeRequiresRedispatch 推进）
    const [turnRow] = await db
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, ctx.turnId))
      .limit(1);
    expect(turnRow?.turnState).toBe("running");

    // Runtime 被调用：resumeInvocation 1 次 + startInvocation 1 次
    expect(mockClient.calls.resumeInvocation).toHaveLength(1);
    expect(mockClient.calls.startInvocation).toHaveLength(1);

    // 新 Attempt 已创建（attempt_no=2，running）
    const attempts = await db
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.invocationId, running.invocationId));
    expect(attempts.length).toBe(2);
    const newAttempt = attempts.find((a) => a.attemptNo === 2);
    expect(newAttempt?.attemptState).toBe("running");
    expect(newAttempt?.retryReasonCode).toBe("requires_redispatch");
  });

  it("requires_redispatch=true 但 gatewayEndpoints 缺失：标记命令 failed", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);

    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-key-redispatch-no-gateway",
    });

    const mockClient = createMockRuntimeClient({
      resumeInvocation: async (req) => ({
        invocation_id: req.invocationId,
        resumed: false,
        attempt_no: 1,
        requires_redispatch: true,
      }),
    });

    // runtimeEndpointResolver 不包含 gatewayEndpoints（gatewayAccess 仍提供，以先过 resume 校验）
    const result = await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () => ({
        ...buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
        gatewayEndpoints: undefined,
      }),
    });

    // 命令 failed
    expect(result.commandState).toBe("failed");
    expect(result.errorCode).toBe("REDISPATCH_GATEWAY_ENDPOINTS_MISSING");
    expect(result.events).toHaveLength(0);

    const cmdRow = await getCommandRow(resumeCommandId);
    expect(cmdRow?.commandState).toBe("failed");
    expect(cmdRow?.errorCode).toBe("REDISPATCH_GATEWAY_ENDPOINTS_MISSING");

    // Invocation 仍为 waiting_user（未推进）
    const invocation = await getInvocationById(ctx.tenantId, running.invocationId);
    expect(invocation?.executionState).toBe("waiting_user");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Runtime 路由（cancel/resume/steer）
// ═══════════════════════════════════════════════════════════

describe("S05-C04 Runtime 路由 cancel/resume/steer", () => {
  let ctx: FullCommandContext;
  let running: RunningInvocationContext;

  beforeEach(async () => {
    ctx = await seedFullCommandContext();
    running = await seedRunningInvocationWithRunningTurn(ctx);
    // : HTTP 路由 handler 通过 getRouteHostedAdapter() 获取 Adapter 单例；
    // 未注入 mock 时返回 null → 503 RUNTIME_UNAVAILABLE。这里注入带 mock sink 的
    // Hosted 参考 Adapter，使 cancel/resume/steer 返回 ack（不调用真实平台）。
    const sink: EventBatchSink = async () => {};
    setRouteHostedAdapter(
      createHostedAdapter({
        platformEndpoint: "https://platform.internal",
        platformAuthToken: "test-token",
        eventBatchSink: sink,
      }),
    );
  });

  afterEach(() => {
    setRouteHostedAdapter(null);
  });

  it("POST :cancel 成功：返回 200 + cancelled=true", async () => {
    const { POST } = await import("@/app/runtime/v1/invocations/[invocation_id]/cancel/route");

    const token = makeWorkloadToken(ctx.tenantId, running.invocationId, ctx.runtimeRevision.id);
    const request = new Request(
      `https://example.com/runtime/v1/invocations/${running.invocationId}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "idempotency-key": "route-cancel-1",
          "x-request-id": "route-req-cancel-1",
        },
        body: JSON.stringify({ reason: "user requested cancel" }),
      },
    );

    const context = {
      params: Promise.resolve({ invocation_id: running.invocationId }),
    };

    const response = await POST(request, context);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.invocation_id).toBe(running.invocationId);
    expect(json.cancelled).toBe(true);
    expect(json.attempt_no).toBe(1);
  });

  it("POST :cancel 缺少 Authorization Token → 401 AUTHENTICATION_REQUIRED", async () => {
    const { POST } = await import("@/app/runtime/v1/invocations/[invocation_id]/cancel/route");

    const request = new Request(
      `https://example.com/runtime/v1/invocations/${running.invocationId}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "route-cancel-2",
          "x-request-id": "route-req-cancel-2",
        },
        body: JSON.stringify({ reason: "no token" }),
      },
    );

    const context = {
      params: Promise.resolve({ invocation_id: running.invocationId }),
    };

    const response = await POST(request, context);
    expect(response.status).toBe(401);

    const json = await response.json();
    expect(json.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("POST :cancel 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { POST } = await import("@/app/runtime/v1/invocations/[invocation_id]/cancel/route");

    const token = makeWorkloadToken(ctx.tenantId, running.invocationId, ctx.runtimeRevision.id);
    const request = new Request(
      `https://example.com/runtime/v1/invocations/${running.invocationId}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-request-id": "route-req-cancel-3",
          // 故意不传 idempotency-key
        },
        body: JSON.stringify({ reason: "no idempotency key" }),
      },
    );

    const context = {
      params: Promise.resolve({ invocation_id: running.invocationId }),
    };

    const response = await POST(request, context);
    expect(response.status).toBe(400);

    const json = await response.json();
    expect(json.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("POST :resume 成功：返回 200 + resumed=true", async () => {
    const { POST } = await import("@/app/runtime/v1/invocations/[invocation_id]/resume/route");

    const token = makeWorkloadToken(ctx.tenantId, running.invocationId, ctx.runtimeRevision.id);
    const request = new Request(
      `https://example.com/runtime/v1/invocations/${running.invocationId}/resume`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "idempotency-key": "route-resume-1",
          "x-request-id": "route-req-resume-1",
        },
        body: JSON.stringify({ resume_payload: { action: "confirm", value: "yes" } }),
      },
    );

    const context = {
      params: Promise.resolve({ invocation_id: running.invocationId }),
    };

    const response = await POST(request, context);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.invocation_id).toBe(running.invocationId);
    expect(json.resumed).toBe(true);
    expect(json.attempt_no).toBe(1);
  });

  it("POST :steer 成功：返回 200 + steered=true", async () => {
    const { POST } = await import("@/app/runtime/v1/invocations/[invocation_id]/steer/route");

    const token = makeWorkloadToken(ctx.tenantId, running.invocationId, ctx.runtimeRevision.id);
    const request = new Request(
      `https://example.com/runtime/v1/invocations/${running.invocationId}/steer`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "idempotency-key": "route-steer-1",
          "x-request-id": "route-req-steer-1",
        },
        body: JSON.stringify({ steer_payload: { guidance: "请使用简洁语气" } }),
      },
    );

    const context = {
      params: Promise.resolve({ invocation_id: running.invocationId }),
    };

    const response = await POST(request, context);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.invocation_id).toBe(running.invocationId);
    expect(json.steered).toBe(true);
    expect(json.attempt_no).toBe(1);
  });

  it("Token invocationId 与 path 不匹配 → 401 AUTHENTICATION_REQUIRED", async () => {
    const { POST } = await import("@/app/runtime/v1/invocations/[invocation_id]/steer/route");

    // Token 绑定不同 invocationId
    const token = makeWorkloadToken(
      ctx.tenantId,
      "different-invocation-id",
      ctx.runtimeRevision.id,
    );
    const request = new Request(
      `https://example.com/runtime/v1/invocations/${running.invocationId}/steer`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "idempotency-key": "route-steer-2",
          "x-request-id": "route-req-steer-2",
        },
        body: JSON.stringify({ steer_payload: { guidance: "test" } }),
      },
    );

    const context = {
      params: Promise.resolve({ invocation_id: running.invocationId }),
    };

    const response = await POST(request, context);
    expect(response.status).toBe(401);

    const json = await response.json();
    expect(json.error.code).toBe("AUTHENTICATION_REQUIRED");
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 端到端 + 投影器
// ═══════════════════════════════════════════════════════════

describe("S05-C04 端到端 + 投影器", () => {
  let ctx: FullCommandContext;

  beforeEach(async () => {
    ctx = await seedFullCommandContext();
  });

  it("Steer 完整链路：queue → dispatch → ack + turn.steered 投影", async () => {
    const { rebuildProjectionsForThread } = await import("@/lib/conversations/projector");
    const running = await seedRunningInvocationWithRunningTurn(ctx);

    // 入队 Steer
    const steerResult = await queueSteer({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      guidanceText: "端到端测试",
      idempotencyKey: "e2e-steer-1",
    });

    // 调度
    const mockClient = createMockRuntimeClient({
      steerInvocation: async (req) => buildSteerResponse(req.invocationId),
    });

    const result = await dispatchSteerCommand({
      tenantId: ctx.tenantId,
      commandId: steerResult.command.id,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("acknowledged");
    expect(result.events).toHaveLength(1);

    // 重建投影（处理从 thread.created 到 turn.steered 的所有事件）
    await rebuildProjectionsForThread(ctx.tenantId, ctx.threadId);

    // 验证事件已写入数据库
    const steeredEvent = result.events[0];
    if (!steeredEvent) throw new Error("turn.steered 事件未写入");
    const [dbEvent] = await db
      .select()
      .from(threadEventTable)
      .where(eq(threadEventTable.id, steeredEvent.id))
      .limit(1);
    expect(dbEvent).toBeTruthy();
    expect(dbEvent?.eventType).toBe("turn.steered");
  });

  it("Cancel 完整链路：queue → dispatch → ack + 命令状态机不可逆", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);

    // 入队 Interrupt
    const interruptResult = await requestInterrupt({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "e2e_cancel",
      idempotencyKey: "e2e-cancel-1",
    });

    await bindInvocationIdToCommand(interruptResult.command.id, running.invocationId);

    const mockClient = createMockRuntimeClient({
      cancelInvocation: async (req) => buildCancelResponse(req.invocationId),
    });

    // 第一次调度：queued → dispatched → acknowledged
    const result1 = await dispatchCancelCommand({
      tenantId: ctx.tenantId,
      commandId: interruptResult.command.id,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });
    expect(result1.commandState).toBe("acknowledged");

    // 第二次调度：应抛 CommandAlreadyDispatchedError（状态机不可逆）
    await expect(
      dispatchCancelCommand({
        tenantId: ctx.tenantId,
        commandId: interruptResult.command.id,
        runtimeClient: mockClient,
        runtimeEndpointResolver: async () =>
          buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
      }),
    ).rejects.toThrow(CommandAlreadyDispatchedError);

    // 命令保持 acknowledged（不受第二次调度影响）
    const cmdRow = await getCommandRow(interruptResult.command.id);
    expect(cmdRow?.commandState).toBe("acknowledged");
  });

  it("Resume 完整链路：queue → dispatch → ack + Turn/Invocation 状态推进 + 投影", async () => {
    const { rebuildProjectionsForThread } = await import("@/lib/conversations/projector");
    const { threadListProjectionTable, turnTimelineProjectionTable } = await import(
      "@/lib/persistence/schema/projection"
    );

    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);

    // 入队 Resume
    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm", value: "yes" },
      idempotencyKey: "e2e-resume-1",
    });

    const mockClient = createMockRuntimeClient({
      resumeInvocation: async (req) => buildResumeResponse(req.invocationId),
    });

    const result = await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("acknowledged");
    expect(result.events).toHaveLength(2);

    // 重建投影（处理从 thread.created 到 turn.resumed/invocation.resumed 的所有事件）
    await rebuildProjectionsForThread(ctx.tenantId, ctx.threadId);

    // 验证 Invocation 已转为 running
    const invocation = await getInvocationById(ctx.tenantId, running.invocationId);
    expect(invocation?.executionState).toBe("running");

    // 验证 Turn 已转为 running
    const [turnRow] = await db
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, ctx.turnId))
      .limit(1);
    expect(turnRow?.turnState).toBe("running");

    // 验证 thread_list_projection 已被前移（latestEventSequence > 0）
    const [listProj] = await db
      .select()
      .from(threadListProjectionTable)
      .where(eq(threadListProjectionTable.threadId, ctx.threadId))
      .limit(1);
    expect(listProj).toBeTruthy();
    expect(listProj?.currentTurnState).toBe("running");
    expect(listProj?.latestEventSequence).toBeGreaterThan(0);

    // 验证 turn_timeline_projection 已被前移
    const [turnProj] = await db
      .select()
      .from(turnTimelineProjectionTable)
      .where(eq(turnTimelineProjectionTable.turnId, ctx.turnId))
      .limit(1);
    expect(turnProj).toBeTruthy();
    expect(turnProj?.turnState).toBe("running");
    expect(turnProj?.startedAt).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 基础 Harness Route redispatch 不依赖 Agent（§8.3）
// ═══════════════════════════════════════════════════════════
//
// 冻结边界：Agent 表 0 行合法；基础 Harness Route/Binding 的 agentRevisionId=null；
// 任何实际执行仍完整绑定 Runtime/Route；resume redispatch 不能额外要求 Agent。
// 零 Agent 是基础 Harness 的长期合法形态，重调度不得额外引入 Agent 前置条件。

interface BaseHarnessContext {
  tenantId: string;
  ownerId: string;
  runtimeRevision: RuntimeRevision;
  routeId: string;
  routeSetId: string;
  threadId: string;
  turnId: string;
  triggerItemId: string | null;
}

interface BaseHarnessRunningContext {
  invocationId: string;
  tenantId: string;
  threadId: string;
  turnId: string;
  turnVersionNo: number;
  binding: ExecutionBinding;
}

async function seedBaseHarnessContext(): Promise<BaseHarnessContext> {
  const { tenantId, ownerId } = await seedTenantAndOwner();

  // 只发布可信 RuntimeRevision；不创建 Agent/AgentRevision。
  const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
    tenantId,
    ownerId,
    "base-cmd-runtime",
    ["event_stream"],
    "v1",
  );

  // 创建 target={kind:"runtime"} 的 RouteSet（基础 Harness）。
  const routeSet = await createRouteSet({
    tenantId,
    target: { kind: "runtime" },
    routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
    routeScopeJson: { networkZone: "internal" },
  });

  // 激活 runtime target 的基础 Route。
  const routeResult = await activateSingleRouteForTest({
    tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    target: { kind: "runtime", runtimeRevisionId: runtimeRevision.id },
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(tenantId, "deploy-bot-001"),
  });

  const { thread } = await createThread({
    tenantId,
    ownerUserId: ownerId,
    actorId: ownerId,
  });

  const { turn } = await acceptUserMessageTurnForCmd({
    tenantId,
    threadId: thread.id,
    ownerUserId: ownerId,
  });

  return {
    tenantId,
    ownerId,
    runtimeRevision,
    routeId: routeResult.route.id,
    routeSetId: routeSet.id,
    threadId: thread.id,
    turnId: turn.id,
    triggerItemId: turn.triggerItemId ?? null,
  };
}

async function seedBaseHarnessRunningInvocation(
  ctx: BaseHarnessContext,
): Promise<BaseHarnessRunningContext> {
  // 基础 Harness：顶层无 Agent 约束，得到真实 ExecutionBinding（专题01 冻结架构下不含 Agent 维度）。
  const result = await dispatchInvocationForTurn({
    tenantId: ctx.tenantId,
    turnId: ctx.turnId,
  });
  if (!result.dispatched) {
    throw new Error(`基础 Harness 调度失败：reason=${result.reason ?? "unknown"}`);
  }
  const invocation = result.invocation;
  const binding = result.binding;
  if (!invocation || !binding) {
    throw new Error("基础 Harness 调度失败：未创建 Invocation/ExecutionBinding");
  }

  // Invocation queued → running
  await db.transaction(async (tx) => {
    await updateInvocationState(tx, ctx.tenantId, invocation.id, "running");
  });

  // Turn queued → running
  const [turnRow] = await db.select().from(turnTable).where(eq(turnTable.id, ctx.turnId)).limit(1);
  if (!turnRow) throw new Error(`Turn 不存在: ${ctx.turnId}`);
  await updateTurnState(ctx.tenantId, ctx.turnId, "running", turnRow.versionNo);

  const [updatedTurn] = await db
    .select()
    .from(turnTable)
    .where(eq(turnTable.id, ctx.turnId))
    .limit(1);

  return {
    invocationId: invocation.id,
    tenantId: ctx.tenantId,
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    turnVersionNo: updatedTurn?.versionNo ?? 1,
    binding,
  };
}

describe("S05-C04 基础 Harness Route redispatch 不依赖 Agent（§8.3）", () => {
  let ctx: BaseHarnessContext;

  beforeEach(async () => {
    ctx = await seedBaseHarnessContext();
  });

  it("requires_redispatch=true 不额外要求 Agent：ack + redispatched + startInvocation.agent=null + 无 agent_instruction_ref + Agent 表 0 行", async () => {
    // 前置：Agent 表 0 行（不创建 Agent/AgentRevision）。
    const agentRowsBefore = await db.select().from(agentTable);
    expect(agentRowsBefore).toHaveLength(0);

    const running = await seedBaseHarnessRunningInvocation(ctx);

    // Invocation/Turn 推进到 waiting_user。
    await updateTurnState(ctx.tenantId, ctx.turnId, "waiting_user", running.turnVersionNo);
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, ctx.tenantId, running.invocationId, "waiting_user");
    });

    // 创建 Resume Command。
    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm", value: "yes" },
      idempotencyKey: "resume-key-base-harness-redispatch",
    });

    // mock Runtime 仅作协议对端：resume → requires_redispatch=true；start → accepted。
    const mockClient = createMockRuntimeClient({
      resumeInvocation: async (req) => ({
        invocation_id: req.invocationId,
        resumed: false,
        attempt_no: 1,
        requires_redispatch: true,
      }),
      startInvocation: async () => ({
        invocation_id: running.invocationId,
        accepted: true,
        attempt_no: 2,
        runtime_session_ref: `runtime-session-${running.invocationId}-2`,
        runtime_execution_ref: `runtime-exec-${running.invocationId}-2`,
        capabilities: {
          protocol_versions: ["2"],
          features: {
            event_stream: true,
            cancel: true,
            resume: true,
            steer: true,
            dynamic_tools: true,
            user_action: true,
            workspace_types: ["none"],
            filesystem_checkpoint: true,
          },
          limits: { max_invocation_seconds: 600, max_event_bytes: 1_048_576 },
        },
      }),
    });

    // 不传 AgentRevision，验证绑定中的 null 身份直接贯穿到 Runtime 请求。
    const result = await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () => ({
        ...buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
        gatewayEndpoints: {
          events: "https://gateway.internal/events",
          cancel: "https://gateway.internal/cancel",
          resume: "https://gateway.internal/resume",
          steer: "https://gateway.internal/steer",
          tools: "https://gateway.internal/tools",
          tool_calls: "https://gateway.internal/tool-calls",
          user_action_requests: "https://gateway.internal/user-action-requests",
        },
      }),
      correlationId: "resume-base-harness-redispatch",
    });

    // 目标断言（GREEN）：ack + redispatched。
    expect(result.commandState).toBe("acknowledged");
    expect(result.redispatched).toBe(true);

    // 同一 Invocation 创建 attemptNo=2 且 running。
    const attempts = await db
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.invocationId, running.invocationId));
    const newAttempt = attempts.find((a) => a.attemptNo === 2);
    expect(newAttempt?.attemptState).toBe("running");
    expect(newAttempt?.retryReasonCode).toBe("requires_redispatch");

    // 必须捕获真实 startInvocation request。
    expect(mockClient.calls.startInvocation).toHaveLength(1);
    const startReq = mockClient.calls.startInvocation[0];
    // 基础 Harness Route（无 Agent）：不携带 capability_requirements（专题01 冻结架构）。
    expect(startReq?.requestBody.capability_requirements).toBeUndefined();

    // input_items 中不存在 type="agent_instruction_ref"。
    const inputItems = startReq?.requestBody.input_items ?? [];
    const hasAgentInstructionRef = inputItems.some(
      (item) => (item as { type?: string }).type === "agent_instruction_ref",
    );
    expect(hasAgentInstructionRef).toBe(false);

    // Agent 表仍 0 行。
    const agentRowsAfter = await db.select().from(agentTable);
    expect(agentRowsAfter).toHaveLength(0);

    // Runtime/Route/Binding 冻结值保持不变。
    const bindingAfter = await getExecutionBindingByInvocation(ctx.tenantId, running.invocationId);
    expect(bindingAfter?.runtimeRevisionId).toBe(running.binding.runtimeRevisionId);
    expect(bindingAfter?.deploymentRouteId).toBe(running.binding.deploymentRouteId);
    expect(bindingAfter?.runtimeRevisionId).toBe(ctx.runtimeRevision.id);
  });
});

// ─── 辅助：把 Binding 冻结 Snapshot 的合同 cancel/resume 打开（05 专项）──

async function enableContractCancelOnSnapshot(ctx: FullCommandContext): Promise<void> {
  const snapshotId = ctx.agentRevision.agentContractSnapshotId;
  if (!snapshotId) throw new Error("seed 未生成 AgentContractSnapshot");
  await db
    .update(agentContractSnapshotTable)
    .set({ cancel: true, resume: true })
    .where(eq(agentContractSnapshotTable.id, snapshotId));
}

// ─── 辅助：为远端调用装配 runtimeExecutionRef + SessionBinding（Batch 10） ─

async function attachRemoteRefsToInvocation(
  ctx: FullCommandContext,
  invocationId: string,
  externalSessionRef: string,
): Promise<string> {
  // 模拟远端 startInvocation 已返回 taskId/contextId 并落 Binding。
  const binding = await createSessionBinding({
    tenantId: ctx.tenantId,
    runtimeRevisionId: ctx.runtimeRevision.id,
    threadId: ctx.threadId,
    externalSessionRef,
  });
  const taskId = `task-${binding.id.slice(0, 8)}`;
  await db
    .update(invocationTable)
    .set({ runtimeExecutionRef: taskId, runtimeSessionBindingId: binding.id })
    .where(and(eq(invocationTable.tenantId, ctx.tenantId), eq(invocationTable.id, invocationId)));
  return taskId;
}

// ═══════════════════════════════════════════════════════════
// Batch 10：命令调度生产网关（command-dispatch-gateway，08 §5/§6）
// ═══════════════════════════════════════════════════════════

describe("Batch 10 命令调度生产网关", () => {
  it("命令不存在：dispatched=false + command_not_found", async () => {
    const ctx = await seedFullCommandContext();
    const result = await dispatchInterruptCommandToRuntime({
      tenantId: ctx.tenantId,
      commandId: "00000000-0000-4000-8000-000000000000",
    });
    expect(result).toEqual({ dispatched: false, reason: "command_not_found" });
  });

  it("hosted 协议（harness_runtime_protocol）：protocol_not_remote，命令保持 queued 由既有状态机吸收", async () => {
    const ctx = await seedFullCommandContext("harness_runtime_protocol");
    // 05 §3：合同声明 cancel=true，使本用例聚焦协议分流（合同 cancel=false 的
    // unsupported_capability 分支由专项 05 用例覆盖）。
    await enableContractCancelOnSnapshot(ctx);
    const running = await seedRunningInvocationWithRunningTurn(ctx);

    const interruptResult = await requestInterrupt({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "user_cancel",
      idempotencyKey: "gw-protocol-1",
    });
    await bindInvocationIdToCommand(interruptResult.command.id, running.invocationId);

    const result = await dispatchInterruptCommandToRuntime({
      tenantId: ctx.tenantId,
      commandId: interruptResult.command.id,
    });
    expect(result).toEqual({ dispatched: false, reason: "protocol_not_remote" });
    // hosted in-process 协议无远端端点可调，命令保持 queued 等待状态机处理（04 §10）。
    expect((await getCommandRow(interruptResult.command.id))?.commandState).toBe("queued");
  });

  // 说明：原"05 §8 Binding effective cancel=false → unsupported_capability"用例的前提是
  // 顶层 ExecutionBinding 携带 Agent Contract（cancel=false）以门禁 deny。
  // 专题01 冻结架构下顶层恒为 base harness route（agentRevisionId=null，无 Agent Contract），
  // effective cancel 只由 Runtime measured 能力 + 协议实现决定，该 Agent-Route 门禁路径
  // 已从顶层移除（Agent Contract 门禁属于 AgentCall 层，不在顶层 Invocation Binding）。
  // 因此该用例无顶层等价物，删除。

  it("跨租户隐藏：他租户调用返回 command_not_found", async () => {
    const ctx = await seedFullCommandContext();
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    const interruptResult = await requestInterrupt({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "user_cancel",
      idempotencyKey: "gw-tenant-1",
    });
    await bindInvocationIdToCommand(interruptResult.command.id, running.invocationId);

    // 命令表无租户列，隔离由 Invocation 查询保证（loadCommandContext）。
    const result = await dispatchInterruptCommandToRuntime({
      tenantId: "tenant-not-exist",
      commandId: interruptResult.command.id,
    });
    expect(result).toEqual({ dispatched: false, reason: "command_not_found" });
  });
});

// ─── 辅助：authority 忠实的 post-authority resume 命令 ────

/**
 * 模拟 resolveGenericUserAction（input+submit）权威产物：pending input UAR（真实行）+
 * queued resume 命令携带完整来源标记 resume_source/request_id/精确 resume_payload。
 * 不得用普通 createResumeCommand 冒充 authority。
 */
async function createPostAuthorityResumeCommand(params: {
  tenantId: string;
  threadId: string;
  turnId: string;
  invocationId: string;
  responseRedactedJson: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ commandId: string; requestId: string }> {
  const { randomUUID } = await import("node:crypto");
  const { computeInvocationCommandPayloadHash } = await import(
    "@/lib/conversations/regenerate-queries"
  );
  const { userActionRequestTable } = await import("@/lib/persistence/schema/user-action-request");

  const requestId = randomUUID();
  await db.insert(userActionRequestTable).values({
    id: requestId,
    tenantId: params.tenantId,
    threadId: params.threadId,
    turnId: params.turnId,
    invocationId: params.invocationId,
    toolCallId: null,
    itemId: null,
    requestType: "input",
    purpose: "a2a_input_required",
    requestState: "pending",
    promptJson: { kind: "user_action.requested", prompt: "请提供请假事由" },
    inputSchemaJson: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 20_000 } },
    },
    expiresAt: null,
    versionNo: 1,
  });

  const commandId = randomUUID();
  const now = new Date();
  const commandPayload = {
    request_id: requestId,
    request_type: "input",
    purpose: "a2a_input_required",
    resolution: "submit",
    resumed_by: "user-1",
    has_response: true,
    resume_source: "user_action_resolution",
    resume_payload: params.responseRedactedJson,
  };
  const commandPayloadHash = computeInvocationCommandPayloadHash(commandPayload);

  await db.insert(invocationCommandTable).values({
    id: commandId,
    invocationId: params.invocationId,
    threadId: params.threadId,
    turnId: params.turnId,
    commandType: "resume",
    commandPayloadJson: commandPayload,
    commandPayloadHash,
    commandState: "queued",
    runtimeExecutionRef: null,
    idempotencyKey: params.idempotencyKey,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    dispatchedAt: null,
    acknowledgedAt: null,
    failedAt: null,
    updatedAt: now,
  });

  return { commandId, requestId };
}

// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// 01 专项：Durable Dispatch Retry（Command lane）
// ═══════════════════════════════════════════════════════════

describe("01 专项 Durable Dispatch Retry（Command lane）", () => {
  let ctx: FullCommandContext;

  beforeEach(async () => {
    ctx = await seedFullCommandContext();
  });

  it("Resume network → dispatched + nextDispatchAt（durable retry work），不误 failed", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);

    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-durable-1",
    });

    const mockClient = createMockRuntimeClient({
      resumeInvocation: async () => {
        throw new RuntimeHttpClientError("network", "网络不可达");
      },
    });

    const result = await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("dispatched");
    expect(result.skipped).toBe(true);
    expect(result.pendingRetry).toBeDefined();
    expect(result.pendingRetry?.dispatchAttemptCount).toBe(1);
    expect(result.pendingRetry?.nextDispatchAt.getTime()).toBeGreaterThan(Date.now());

    const [command] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, resumeCommandId))
      .limit(1);
    expect(command?.commandState).toBe("dispatched");
    expect(command?.nextDispatchAt).not.toBeNull();
    expect(command?.dispatchAttemptCount).toBe(1);
    expect(command?.lastTransientErrorCode).toBe("runtime_network_unavailable");
    expect(command?.dispatchLeaseOwner).toBeNull();
  });

  it("Worker retry 同一 Command（同 idempotency key）成功 → acknowledged", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);

    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-durable-2",
    });

    const failClient = createMockRuntimeClient({
      resumeInvocation: async () => {
        throw new RuntimeHttpClientError("network", "网络不可达");
      },
    });
    await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: failClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    // Worker 领取后 retry（同一 command idempotency key）
    const okClient = createMockRuntimeClient({
      resumeInvocation: async () => ({
        invocation_id: running.invocationId,
        resumed: true,
        attempt_no: 1,
      }),
    });
    const result = await retryDispatchedInvocationCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: okClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.commandState).toBe("acknowledged");
    const [command] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, resumeCommandId))
      .limit(1);
    expect(command?.commandState).toBe("acknowledged");
    expect(command?.nextDispatchAt).toBeNull();
    expect(command?.dispatchLeaseOwner).toBeNull();
    // 两次调用使用同一 idempotency key（稳定）
    const keys = [...failClient.calls.resumeInvocation, ...okClient.calls.resumeInvocation].map(
      (c) => c.idempotencyKey,
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("resume-durable-2");
  });

  it("5 次耗尽 → command failed(retry_exhausted) + Resume Invocation lost（Turn failed）", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);

    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-durable-3",
    });

    const mockClient = createMockRuntimeClient({
      resumeInvocation: async () => {
        throw new RuntimeHttpClientError("http", "不可用", 503, "RUNTIME_UNAVAILABLE");
      },
    });

    // 首次 dispatch + 4 次 worker retry = 5 次
    let result = await dispatchResumeCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });
    expect(result.commandState).toBe("dispatched");
    for (let i = 0; i < 3; i += 1) {
      result = await retryDispatchedInvocationCommand({
        tenantId: ctx.tenantId,
        commandId: resumeCommandId,
        runtimeClient: mockClient,
        runtimeEndpointResolver: async () =>
          buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
      });
      expect(result.commandState).toBe("dispatched");
    }
    // 第 5 次：耗尽
    result = await retryDispatchedInvocationCommand({
      tenantId: ctx.tenantId,
      commandId: resumeCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });
    expect(result.commandState).toBe("failed");
    expect(result.retryExhausted).toBe(true);
    expect(result.errorCode).toBe("retry_exhausted");

    const [command] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, resumeCommandId))
      .limit(1);
    expect(command?.commandState).toBe("failed");
    expect(command?.errorCode).toBe("retry_exhausted");
    expect(command?.dispatchAttemptCount).toBe(5);

    // Resume → 唯一 Recovery Authority 收口：Invocation lost + active Turn failed
    const invocation = await getInvocationById(ctx.tenantId, running.invocationId);
    expect(invocation?.executionState).toBe("lost");
    expect(invocation?.errorCode).toBe("resume_retry_exhausted");
    // 02 专项：active Turn 同事务收口为 failed（turn.failed Event 由 Recovery Authority 写入）
    const [turnRow] = await db
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, ctx.turnId))
      .limit(1);
    expect(turnRow?.turnState).toBe("failed");
    expect(turnRow?.errorCode).toBe("resume_retry_exhausted");
  });

  it("Cancel transient 5 次耗尽 → command failed，但不伪造 Invocation cancelled", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);

    const interruptResult = await requestInterrupt({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      turnId: ctx.turnId,
      reasonCode: "user_cancel",
      idempotencyKey: "cancel-durable-1",
    });
    await bindInvocationIdToCommand(interruptResult.command.id, running.invocationId);
    const cancelCommandId = interruptResult.command.id;

    const mockClient = createMockRuntimeClient({
      cancelInvocation: async () => {
        throw new RuntimeHttpClientError("network", "网络不可达");
      },
    });

    await dispatchCancelCommand({
      tenantId: ctx.tenantId,
      commandId: cancelCommandId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () =>
        buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });
    let result: Awaited<ReturnType<typeof retryDispatchedInvocationCommand>> | undefined;
    for (let i = 0; i < 4; i += 1) {
      result = await retryDispatchedInvocationCommand({
        tenantId: ctx.tenantId,
        commandId: cancelCommandId,
        runtimeClient: mockClient,
        runtimeEndpointResolver: async () =>
          buildCommandRuntimeEndpointResolution(ctx.runtimeRevision.id),
      });
    }
    expect(result?.commandState).toBe("failed");
    expect(result?.errorCode).toBe("retry_exhausted");

    // Cancel 耗尽：不把 Invocation 伪造成 cancelled（由现有 cancel 状态机决定）
    const invocation = await getInvocationById(ctx.tenantId, running.invocationId);
    expect(invocation?.executionState).not.toBe("cancelled");
  });

  it("claimDueInvocationCommands：活跃 lease 内（含 nextDispatchAt 已 due）不可被其他 worker 领取；过期后可接管", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);

    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-lease-active-1",
    });

    // 注入时钟：worker-a 已通过 transient retry lane 领取（nextDispatchAt 已 due + 30s 活跃 lease）
    const now = new Date("2026-08-27T10:00:00.000Z");
    await db
      .update(invocationCommandTable)
      .set({
        commandState: "dispatched",
        dispatchedAt: now,
        nextDispatchAt: new Date(now.getTime() - 1_000),
        dispatchAttemptCount: 1,
        lastDispatchAttemptAt: now,
        dispatchLeaseOwner: "worker-a",
        dispatchLeaseExpiresAt: new Date(now.getTime() + 30_000),
      })
      .where(eq(invocationCommandTable.id, resumeCommandId));

    // worker-b 在 lease 活跃期间（10:00:05 < 10:00:30）poll：nextDispatchAt 虽已 due，
    // 但活跃 lease 必须阻断领取（否则 due 的 nextDispatchAt 会绕过 lease 造成重复 HTTP dispatch）
    const claimedByB = await claimDueInvocationCommands({
      now: new Date(now.getTime() + 5_000),
      leaseOwner: "worker-b",
      leaseDurationMs: 30_000,
      limit: 10,
    });
    expect(claimedByB.filter((c) => c.id === resumeCommandId)).toHaveLength(0);

    // DB owner 仍是 worker-a
    const [leased] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, resumeCommandId))
      .limit(1);
    expect(leased?.dispatchLeaseOwner).toBe("worker-a");

    // lease 过期后（10:00:31 > 10:00:30）：worker-b 可接管（crash / lease recovery）
    const reclaimed = await claimDueInvocationCommands({
      now: new Date(now.getTime() + 31_000),
      leaseOwner: "worker-b",
      leaseDurationMs: 30_000,
      limit: 10,
    });
    expect(reclaimed.map((c) => c.id)).toContain(resumeCommandId);
    const [takenOver] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, resumeCommandId))
      .limit(1);
    expect(takenOver?.dispatchLeaseOwner).toBe("worker-b");
  });

  it("claimDueInvocationCommands：lease 过期可接管（crash recovery），非 due 不领取", async () => {
    const running = await seedRunningInvocationWithRunningTurn(ctx);
    await transitionToWaitingUser(ctx, running);

    const resumeCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-durable-4",
    });
    const futureCommandId = await createResumeCommand({
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: running.invocationId,
      resumePayload: { action: "confirm" },
      idempotencyKey: "resume-durable-5",
    });

    const now = new Date();
    // 命令 A：dispatcher CAS dispatched 后崩溃（lease 已过期，nextDispatchAt 未到）
    await db
      .update(invocationCommandTable)
      .set({
        commandState: "dispatched",
        dispatchedAt: now,
        dispatchAttemptCount: 1,
        lastDispatchAttemptAt: now,
        dispatchLeaseOwner: "worker-crashed",
        dispatchLeaseExpiresAt: new Date(now.getTime() - 1_000),
      })
      .where(eq(invocationCommandTable.id, resumeCommandId));
    // 命令 B：正常 transient retry 但时间未到
    await db
      .update(invocationCommandTable)
      .set({
        commandState: "dispatched",
        dispatchedAt: now,
        nextDispatchAt: new Date(now.getTime() + 60_000),
        dispatchAttemptCount: 1,
      })
      .where(eq(invocationCommandTable.id, futureCommandId));

    const claimed = await claimDueInvocationCommands({
      now,
      leaseOwner: "worker-b",
      leaseDurationMs: 30_000,
      limit: 10,
    });
    const claimedIds = claimed.map((c) => c.id);
    expect(claimedIds).toContain(resumeCommandId);
    expect(claimedIds).not.toContain(futureCommandId);
    expect(claimed.find((c) => c.id === resumeCommandId)?.dispatchLeaseOwner).toBe("worker-b");
  });
});
