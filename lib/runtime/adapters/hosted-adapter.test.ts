/**
 * S05-C05：Hosted/VeADK 参考 Adapter 集成测试（真实 MySQL 8）。
 *
 * 覆盖（5 类，21+ 例）：
 * - HostedAdapter 基本能力（5 例）：probeCapabilities / startInvocation / session_ref 格式 /
 *   execution_ref 格式 / 不阻塞
 * - Agent Loop 事件回传：response.completed / execution.completed /
 *   producer_sequence 连续 / Loop 完成结果 / Item 内容（response.completed payload）
 * - 命令处理（4 例）：handleCancel / handleResume / handleSteer / handleCancel 异步事件回传
 * - VeADK Adapter（3 例）：session_ref 格式 / execution_ref 格式 / 能力声明
 * - 端到端 Turn 生命周期（3 例）：完整 Turn / Steer 中途 / Cancel 中途
 *
 * 真实 MySQL 8 Testcontainers（e2e 场景），mock sink（单元场景），不使用 DB mock。
 */
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { createDraftRevision } from "@/lib/agents/persistence/agent-revision-queries";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type VerifyAttestationInput,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-queries";
import {
  buildDsseArtifactAttestationEnvelope,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { listItemsByThread } from "@/lib/conversations/thread-item-queries";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/identity/audit";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { type WorkloadTokenClaims, issueWorkloadToken } from "@/lib/identity/workload-token";
import type { AgentRevision } from "@/lib/persistence/schema/agents";
import type { RuntimeRevision } from "@/lib/persistence/schema/runtimes";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import type { GatewayEndpoints } from "@/lib/runtime/adapters/hosted-adapter";
import {
  type CreateHostedAdapterParams,
  type EventBatchSink,
  createHostedAdapter,
  hostedAdapterCapabilities,
  setRouteHostedAdapter,
} from "@/lib/runtime/adapters/hosted-adapter";
import { createVeadkAdapter } from "@/lib/runtime/adapters/veadk-adapter";
import { DEFAULT_ROUTE_SCOPE_KEY, dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import type { RuntimeCandidateEvent } from "@/lib/runtime/event-ingress-queries";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { publishRuntimeRevisionForTest } from "@/lib/test-support/publish-runtime-revision-for-test";
import { publishTrustedAgentRevisionForTest } from "@/lib/test-support/publish-trusted-agent-revision";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ─── 全局 setup/teardown ──────────────────────────────────

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 清理路由层 Adapter 单例，避免泄漏到其他测试文件（如 command-dispatcher.test.ts）
  setRouteHostedAdapter(null);
});

// ─── 辅助：mock sink（捕获候选事件，不调用 DB） ───────────

interface MockSink {
  sink: EventBatchSink;
  events: RuntimeCandidateEvent[];
  calls: Array<{ invocationId: string; producerSequenceStart: number }>;
}

function createMockSink(): MockSink {
  const events: RuntimeCandidateEvent[] = [];
  const calls: Array<{ invocationId: string; producerSequenceStart: number }> = [];
  const sink: EventBatchSink = async ({ invocationId, events: batch, producerSequenceStart }) => {
    events.push(...batch);
    calls.push({ invocationId, producerSequenceStart });
  };
  return { sink, events, calls };
}

// ─── 辅助：构造 GatewayEndpoints ──────────────────────────

function mockGatewayEndpoints(): GatewayEndpoints {
  return {
    events: "https://platform.internal",
    cancel: "https://platform.internal/cancel",
    resume: "https://platform.internal/resume",
    steer: "https://platform.internal/steer",
  };
}

// ─── 辅助：构造 mock authToken（base64url 编码的 claims） ──

function mockAuthToken(tenantId = "test-tenant", invocationId = "test-invocation"): string {
  const claims: Omit<WorkloadTokenClaims, "issuedAt"> = {
    type: "runtime",
    tenantId,
    jti: "jti-runtime-hosted-mock-001",
    invocationId,
    runtimeRevisionId: "test-runtime-revision",
    audience: "runtime",
    expiresAt: Date.now() + 60_000,
  };
  return issueWorkloadToken(claims);
}

// ─── 辅助：构造 mock inputItems ───────────────────────────

function mockInputItems(text: string): unknown[] {
  return [{ type: "user_message", content: { text } }];
}

// ─── 辅助：构造 createHostedAdapter 参数 ──────────────────

function mockAdapterParams(sink: EventBatchSink): CreateHostedAdapterParams {
  return {
    platformEndpoint: "https://platform.internal",
    platformAuthToken: "test-token",
    eventBatchSink: sink,
    modelFn: (userMessage) => `测试执行器回复：${userMessage}`,
    modelRef: "test-model",
  };
}

// ═══════════════════════════════════════════════════════════
// 1. HostedAdapter 基本能力
// ═══════════════════════════════════════════════════════════

describe("S05-C05 HostedAdapter 基本能力", () => {
  it("未配置模型执行器时回传 execution.failed，不生成回复", async () => {
    const { sink, events } = createMockSink();
    const adapter = createHostedAdapter({
      platformEndpoint: "https://platform.internal",
      platformAuthToken: "test-token",
      eventBatchSink: sink,
    });

    await adapter.startInvocation({
      invocationId: "inv-no-executor-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa-bbbb",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("不得伪造回复"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const result = await adapter.getLastLoopPromise?.();
    expect(result?.completed).toBe(false);
    expect(result?.failureReason).toContain("未配置模型执行器");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "execution.failed",
      payload: { error_code: "MODEL_EXECUTOR_UNAVAILABLE" },
    });
  });

  it("probeCapabilities 返回 Hosted 能力声明", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const caps = await adapter.probeCapabilities();

    expect(caps.protocol_versions).toEqual(["2"]);
    expect(caps.features.event_stream).toBe(true);
    expect(caps.features.cancel).toBe(true);
    expect(caps.features.resume).toBe(true);
    expect(caps.features.steer).toBe(true);
    expect(caps.features.dynamic_tools).toBe(false);
    expect(caps.features.user_action).toBe(false);
    expect(caps.features.workspace_types).toEqual(["cloud"]);
    expect(caps.features.filesystem_checkpoint).toBe(false);
  });

  it("startInvocation 返回 accepted + runtime_session_ref + runtime_execution_ref + capabilities", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const result = await adapter.startInvocation({
      invocationId: "inv-basic-001",
      threadId: "thread-aaaa-bbbb-cccc",
      turnId: "turn-aaaa-bbbb-cccc",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("你好"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    expect(result.accepted).toBe(true);
    expect(result.runtime_session_ref).toBeTruthy();
    expect(result.runtime_execution_ref).toBeTruthy();
    expect(result.capabilities.protocol_versions).toEqual(["2"]);
  });

  it("runtime_session_ref 以 'hosted-' 开头", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const result = await adapter.startInvocation({
      invocationId: "inv-ref-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("测试"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    expect(result.runtime_session_ref).toMatch(/^hosted-/);
  });

  it("runtime_execution_ref 以 'hosted-exec-' 开头", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const result = await adapter.startInvocation({
      invocationId: "inv-ref-002",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("测试"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    expect(result.runtime_execution_ref).toMatch(/^hosted-exec-/);
  });

  it("startInvocation 不阻塞（loop.run() 异步执行，可后续 await）", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    // startInvocation 返回时 loop 尚未完成
    const result = await adapter.startInvocation({
      invocationId: "inv-noblock-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("不阻塞测试"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    // startInvocation 已返回，loop 异步执行中
    expect(result.accepted).toBe(true);

    // getLastLoopPromise 返回未完成的 Promise
    const loopPromise = adapter.getLastLoopPromise?.();
    expect(loopPromise).not.toBeNull();

    // await loop 完成
    const loopResult = await loopPromise;
    expect(loopResult).not.toBeNull();
    expect(loopResult?.completed).toBe(true);
    expect(loopResult?.responseText).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Agent Loop 事件回传
// ═══════════════════════════════════════════════════════════

describe("S05-C05 HostedAdapter Agent Loop 事件回传", () => {
  it("不再用 progress.snapshot 制造用户引导 Item", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-loop-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("分析数据"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    await loopPromise;

    expect(mock.events.some((event) => event.type === "progress.snapshot")).toBe(false);
  });

  it("response.completed 事件（seq=1，包含 text + model_ref + finish_reason）", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-loop-002",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("生成回答"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    const loopResult = await loopPromise;

    const responseEvent = mock.events.find((e) => e.type === "response.completed");
    expect(responseEvent).toBeDefined();
    expect(responseEvent?.producer_sequence).toBe(1);
    expect(responseEvent?.payload.text).toBe(loopResult?.responseText);
    expect(responseEvent?.payload.model_ref).toBe("test-model");
    expect(responseEvent?.payload.finish_reason).toBe("stop");
  });

  it("execution.completed 事件（seq=2，终态）", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-loop-003",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("完成执行"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    await loopPromise;

    const execEvent = mock.events.find((e) => e.type === "execution.completed");
    expect(execEvent).toBeDefined();
    expect(execEvent?.producer_sequence).toBe(2);
    expect(execEvent?.payload.finish_reason).toBe("execution.completed");
  });

  it("producer_sequence 在整个 Invocation 内连续递增（1→2）", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-seq-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("连续序号"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    await loopPromise;

    // 2 个持久事件，序号连续 1, 2
    expect(mock.events).toHaveLength(2);
    expect(mock.events[0]?.producer_sequence).toBe(1);
    expect(mock.events[1]?.producer_sequence).toBe(2);
  });

  it("Loop 完成后返回 completed=true + responseText + sentEvents", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-complete-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("完成测试"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    const result = await loopPromise;

    expect(result?.completed).toBe(true);
    expect(result?.failureReason).toBeUndefined();
    expect(result?.responseText).toContain("完成测试");
    expect(result?.sentEvents).toHaveLength(2);
  });

  it("response.completed payload.text 包含用户消息内容（Item 内容）", async () => {
    const mock = createMockSink();
    const userMessage = "请帮我分析这组数据";
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    await adapter.startInvocation({
      invocationId: "inv-content-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems(userMessage),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    const loopPromise = adapter.getLastLoopPromise?.();
    await loopPromise;

    const responseEvent = mock.events.find((e) => e.type === "response.completed");
    expect(responseEvent?.payload.text).toContain(userMessage);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 命令处理
// ═══════════════════════════════════════════════════════════

describe("S05-C05 HostedAdapter 命令处理", () => {
  it("handleCancel 返回 cancel_state=accepted + already_completed_effects_preserved=true", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    const result = await adapter.handleCancel({
      invocationId: "inv-cancel-001",
      reason: "user_cancel",
      cancelledBy: "test-user",
      authToken: mockAuthToken(),
    });

    expect(result.cancel_state).toBe("accepted");
    expect(result.already_completed_effects_preserved).toBe(true);
  });

  it("handleResume 返回 resume_state=accepted + runtime_execution_ref + requires_redispatch=false", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    const result = await adapter.handleResume({
      invocationId: "inv-resume-001",
      resumePayload: { action: "confirm" },
      authToken: mockAuthToken(),
    });

    expect(result.resume_state).toBe("accepted");
    expect(result.runtime_execution_ref).toMatch(/^hosted-exec-resume-/);
    expect(result.requires_redispatch).toBe(false);
  });

  it("handleSteer 返回 steer_state=accepted + applies_at=next_safe_point + generation_interrupted=false", async () => {
    const mock = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(mock.sink));

    const result = await adapter.handleSteer({
      invocationId: "inv-steer-001",
      steerPayload: { guidance: "请简洁" },
      authToken: mockAuthToken(),
    });

    expect(result.steer_state).toBe("accepted");
    expect(result.applies_at).toBe("next_safe_point");
    expect(result.generation_interrupted).toBe(false);
  });

  it("handleCancel 异步回传 execution.cancelled 事件（fire-and-forget）", async () => {
    // 使用 deferred promise 等待异步事件回传
    let resolveCancel: (() => void) | undefined;
    const cancelSent = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });

    const events: RuntimeCandidateEvent[] = [];
    const sink: EventBatchSink = async ({ events: batch }) => {
      events.push(...batch);
      if (batch.some((e) => e.type === "execution.cancelled")) {
        resolveCancel?.();
      }
    };

    const adapter = createHostedAdapter(mockAdapterParams(sink));

    // handleCancel 立即返回，execution.cancelled 异步发送
    const result = await adapter.handleCancel({
      invocationId: "inv-cancel-async-001",
      reason: "user_cancel",
      cancelledBy: "test-user",
      authToken: mockAuthToken(),
    });

    expect(result.cancel_state).toBe("accepted");

    // 等待异步事件回传
    await cancelSent;

    const cancelEvent = events.find((e) => e.type === "execution.cancelled");
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent?.payload.cancelled_by).toBe("test-user");
    expect(cancelEvent?.payload.reason).toBe("user_cancel");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. VeADK Adapter
// ═══════════════════════════════════════════════════════════

describe("S05-C05 VeADK Adapter", () => {
  const veadkAppId = "crm-assistant";

  it("runtime_session_ref 以 'veadk-${appId}-' 开头", async () => {
    const mock = createMockSink();
    const adapter = createVeadkAdapter({
      ...mockAdapterParams(mock.sink),
      appId: veadkAppId,
    });

    const result = await adapter.startInvocation({
      invocationId: "inv-veadk-001",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("VeADK 测试"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    expect(result.runtime_session_ref).toMatch(new RegExp(`^veadk-${veadkAppId}-`));
  });

  it("runtime_execution_ref 以 'veadk-${appId}-exec-' 开头", async () => {
    const mock = createMockSink();
    const adapter = createVeadkAdapter({
      ...mockAdapterParams(mock.sink),
      appId: veadkAppId,
    });

    const result = await adapter.startInvocation({
      invocationId: "inv-veadk-002",
      threadId: "thread-aaaa-bbbb",
      turnId: "turn-aaaa",
      agentRevisionId: "agent-rev-001",
      inputItems: mockInputItems("VeADK exec ref"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: mockAuthToken(),
    });

    expect(result.runtime_execution_ref).toMatch(new RegExp(`^veadk-${veadkAppId}-exec-`));
  });

  it("probeCapabilities 与 HostedAdapter 能力声明相同", async () => {
    const mock = createMockSink();
    const adapter = createVeadkAdapter({
      ...mockAdapterParams(mock.sink),
      appId: veadkAppId,
    });

    const caps = await adapter.probeCapabilities();
    const hostedCaps = hostedAdapterCapabilities();

    expect(caps).toEqual(hostedCaps);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 端到端 Turn 生命周期（真实 MySQL 8 + 直接 ingress sink）
// ═══════════════════════════════════════════════════════════

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
    sourceRevision: "git:abc123def456",
    buildPipeline: "ci-cd-pipeline-1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-16T01:00:00.000Z",
  };
}

// ─── 辅助：seed 租户 + 用户 ────────────────────────────────

async function seedTenantAndOwner() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "adapter-owner-001",
    email: "adapter-owner@example.com",
    displayName: "Adapter Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "adapter-owner-001",
    displayName: "Adapter Owner",
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

  const revision = await createDraftRevision({
    tenantId,
    agentId: agent.id,
    sourceType: "agent_yaml",
    sourceRevision: `git:${contentSuffix}`,
    instructionHash: `sha256:instruction_${contentSuffix}`,
    agentArtifactRef: `oci://registry/agent@sha256:${contentSuffix}`,
    modelPolicyJson: { default: "doubao-pro", provider: "doubao" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: { allowed_agent_ids: [] },
    agentInterfaceRequirementsJson: { required: requiredCaps, optional: [] },
    createdBy: ownerId,
  });

  const attestation = await createVerifiedAttestation(
    tenantId,
    "agent_revision",
    revision.id,
    `agent-content-${contentSuffix}`,
  );
  await publishTrustedAgentRevisionForTest({
    tenantId,
    revisionId: revision.id,
    agentExpectedVersionNo: 1,
    attestationId: attestation.id,
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
    protocolType: "a2a",
    endpointRef: `https://runtime-${contentSuffix}.internal`,
    runtimeArtifactRef: `oci://registry/runtime@sha256:${contentSuffix}`,
    runtimeCapabilitiesJson: capabilities,
    identityMode: "managed",
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

interface FullE2EContext {
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

async function seedFullE2EContext(): Promise<FullE2EContext> {
  const { tenantId, ownerId } = await seedTenantAndOwner();

  const { agent, revision: agentRevision } = await seedPublishedAgentRevision(
    tenantId,
    ownerId,
    "adapter-agent",
    ["event_stream"],
    "v1",
  );

  const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
    tenantId,
    ownerId,
    "adapter-runtime",
    ["event_stream"],
    "v1",
  );

  const routeSet = await createRouteSet({
    tenantId,
    agentId: agent.id,
    routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
    routeScopeJson: { networkZone: "internal" },
  });

  const routeResult = await activateSingleRouteForTest({
    tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    agentRevisionId: agentRevision.id,
    runtimeRevisionId: runtimeRevision.id,
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(tenantId, "deploy-bot-001"),
  });

  const { thread } = await createThread({
    tenantId,
    ownerUserId: ownerId,
    actorId: ownerId,
  });

  const { turn } = await acceptUserMessageTurn({
    tenantId,
    threadId: thread.id,
    ownerUserId: ownerId,
    content: { text: "请帮我分析数据" },
    actorId: ownerId,
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

// ─── 辅助：调度 Invocation 并转为 running ─────────────────

async function seedRunningInvocation(ctx: FullE2EContext): Promise<string> {
  const result = await dispatchInvocationForTurn({
    tenantId: ctx.tenantId,
    turnId: ctx.turnId,
    agentConstraint: ctx.agentId,
  });

  const invocation = result.invocation;
  if (!invocation) {
    throw new Error("调度失败：未创建 Invocation");
  }

  await db.transaction(async (tx) => {
    await updateInvocationState(tx, ctx.tenantId, invocation.id, "running");
  });

  return invocation.id;
}

// ─── 辅助：构造直接调用 ingressEventBatch 的 sink ─────────

function createDirectIngressSink(tenantId: string): EventBatchSink {
  return async ({ invocationId, events, producerSequenceStart }) => {
    await ingressEventBatch({
      tenantId,
      invocationId,
      events,
      producerSequenceStart,
    });
  };
}

// ─── 辅助：构造 Workload Token ────────────────────────────

function makeWorkloadToken(
  tenantId: string,
  invocationId: string,
  runtimeRevisionId: string,
): string {
  const claims: Omit<WorkloadTokenClaims, "issuedAt"> = {
    type: "runtime",
    tenantId,
    jti: "jti-runtime-hosted-001",
    invocationId,
    runtimeRevisionId,
    audience: "runtime",
    expiresAt: Date.now() + 60_000,
  };
  return issueWorkloadToken(claims);
}

// ─── e2e 测试 ─────────────────────────────────────────────

describe("S05-C05 端到端 Turn 生命周期", () => {
  let ctx: FullE2EContext;

  beforeEach(async () => {
    ctx = await seedFullE2EContext();
  });

  it("完整 Turn：startInvocation → Loop → response.completed + execution.completed → Invocation completed + Turn completed + agent_message Item", async () => {
    const invocationId = await seedRunningInvocation(ctx);
    const token = makeWorkloadToken(ctx.tenantId, invocationId, ctx.runtimeRevision.id);

    const adapter = createHostedAdapter({
      platformEndpoint: "https://platform.internal",
      platformAuthToken: token,
      eventBatchSink: createDirectIngressSink(ctx.tenantId),
      modelFn: (userMessage) => `测试执行器回复：${userMessage}`,
      modelRef: "test-model",
    });

    const startResult = await adapter.startInvocation({
      invocationId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      agentRevisionId: ctx.agentRevision.id,
      inputItems: mockInputItems("请帮我分析数据"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: token,
    });

    expect(startResult.accepted).toBe(true);

    // 等待 Loop 完成
    const loopPromise = adapter.getLastLoopPromise?.();
    expect(loopPromise).not.toBeNull();
    const loopResult = await loopPromise;
    expect(loopResult?.completed).toBe(true);

    // Invocation → completed
    const invocation = await getInvocationById(ctx.tenantId, invocationId);
    expect(invocation?.executionState).toBe("completed");
    expect(invocation?.outputItemId).toBeTruthy();

    // Thread 应有 agent_message Item
    const items = await listItemsByThread(ctx.tenantId, ctx.threadId);
    const agentMessage = items.find((i) => i.itemType === "agent_message");
    expect(agentMessage).toBeDefined();
    expect(agentMessage?.contentJson).toBeTruthy();
  });

  it("Steer 中途：startInvocation → handleSteer → Loop 继续完成 → Invocation completed", async () => {
    const invocationId = await seedRunningInvocation(ctx);
    const token = makeWorkloadToken(ctx.tenantId, invocationId, ctx.runtimeRevision.id);

    const adapter = createHostedAdapter({
      platformEndpoint: "https://platform.internal",
      platformAuthToken: token,
      eventBatchSink: createDirectIngressSink(ctx.tenantId),
      modelFn: (userMessage) => `测试执行器回复：${userMessage}`,
      modelRef: "test-model",
    });

    // 启动 Loop（异步）
    const startResult = await adapter.startInvocation({
      invocationId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      agentRevisionId: ctx.agentRevision.id,
      inputItems: mockInputItems("处理请求"),
      gatewayEndpoints: mockGatewayEndpoints(),
      authToken: token,
    });
    expect(startResult.accepted).toBe(true);

    // Loop 已异步启动；立即调用 handleSteer（不打断 Loop，在 next_safe_point 应用）
    const steerResult = await adapter.handleSteer({
      invocationId,
      steerPayload: { guidance: "请使用简洁语气" },
      authToken: token,
    });
    expect(steerResult.steer_state).toBe("accepted");
    expect(steerResult.generation_interrupted).toBe(false);

    // 等待 Loop 完成（Steer 不阻止 Loop 完成）
    const loopPromise = adapter.getLastLoopPromise?.();
    expect(loopPromise).not.toBeNull();
    const loopResult = await loopPromise;
    expect(loopResult?.completed).toBe(true);

    // Invocation → completed（Steer 不改变终态）
    const invocation = await getInvocationById(ctx.tenantId, invocationId);
    expect(invocation?.executionState).toBe("completed");
  });

  it("Cancel 中途：handleCancel → execution.cancelled → Invocation cancelled + Turn interrupted", async () => {
    const invocationId = await seedRunningInvocation(ctx);
    const token = makeWorkloadToken(ctx.tenantId, invocationId, ctx.runtimeRevision.id);

    // 使用 deferred promise 等待 execution.cancelled 事件回传完成
    let resolveCancelled: (() => void) | undefined;
    const cancelledSent = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });

    const sink: EventBatchSink = async ({ invocationId, events, producerSequenceStart }) => {
      await ingressEventBatch({
        tenantId: ctx.tenantId,
        invocationId,
        events,
        producerSequenceStart,
      });
      if (events.some((e) => e.type === "execution.cancelled")) {
        resolveCancelled?.();
      }
    };

    const adapter = createHostedAdapter({
      platformEndpoint: "https://platform.internal",
      platformAuthToken: token,
      eventBatchSink: sink,
      modelFn: (userMessage) => `测试执行器回复：${userMessage}`,
      modelRef: "test-model",
    });

    // 直接调用 handleCancel（不启动 Loop，避免序号冲突）
    // adapter 的 nextSequence 从 1 开始，execution.cancelled 使用 seq=1
    const cancelResult = await adapter.handleCancel({
      invocationId,
      reason: "user_cancel",
      cancelledBy: "test-user",
      authToken: token,
    });
    expect(cancelResult.cancel_state).toBe("accepted");

    // 等待 execution.cancelled 事件回传
    await cancelledSent;

    // Invocation → cancelled
    const invocation = await getInvocationById(ctx.tenantId, invocationId);
    expect(invocation?.executionState).toBe("cancelled");
  });
});
