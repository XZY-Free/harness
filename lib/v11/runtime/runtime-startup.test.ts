/**
 * S05-C02：Runtime 启动、能力探测和 Session Binding 集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - probeRuntimeCapabilities：mock + HTTP 客户端能力探测
 * - startInvocation HTTP 客户端：mock 调用 + 网络错误 + HTTP 错误
 * - dispatchInvocationForTurn 集成：Runtime 调用 → Invocation running + invocation.started Event
 * - RuntimeSessionBinding 仓储：create/get/close 操作
 * - GET /runtime/v1/capabilities：Hosted Runtime 参考路由
 * - POST /runtime/v1/invocations：Hosted Runtime 参考路由
 *
 * 真实 MySQL 8 Testcontainers + 真实 ed25519 签名，不使用 DB mock。
 */
import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import { GET as capabilitiesGET } from "@/app/runtime/v1/capabilities/route";
import { POST as invocationsPOST } from "@/app/runtime/v1/invocations/route";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { resolveContextHandle } from "@/lib/v11/context/context-handle";
import { createAgent } from "@/lib/v11/control-plane/agent-queries";
import { createDraftRevision } from "@/lib/v11/control-plane/agent-revision-queries";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type SbomDocument,
  type SignatureBundle,
  type VerifyAttestationInput,
  computeArtifactDigest,
} from "@/lib/v11/control-plane/artifact-attestation";
import { verifyAndPersistAttestation } from "@/lib/v11/control-plane/artifact-attestation-queries";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
  upsertDeploymentRoute,
} from "@/lib/v11/control-plane/deployment-route-queries";
import { createRuntime } from "@/lib/v11/control-plane/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/v11/control-plane/runtime-revision-queries";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { acceptUserMessageTurn } from "@/lib/v11/conversation/turn-queries";
import type { AuditActor } from "@/lib/v11/identity/audit";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import {
  WORKLOAD_TOKEN_DEFAULT_TTL_MS,
  issueWorkloadToken,
} from "@/lib/v11/identity/workload-token";
import {
  createHostedAdapter,
  setRouteHostedAdapter,
} from "@/lib/v11/runtime/adapters/hosted-adapter";
import {
  DEFAULT_ROUTE_SCOPE_KEY,
  type RuntimeDispatchResult,
  type RuntimeEndpointResolution,
  dispatchInvocationForTurn,
} from "@/lib/v11/runtime/dispatcher";
import { RuntimeHttpClientError } from "@/lib/v11/runtime/errors";
import {
  type RuntimeCapabilitiesResponse,
  type StartInvocationResponse,
  createHttpRuntimeClient,
  createMockRuntimeClient,
  defaultRuntimeCapabilities,
} from "@/lib/v11/runtime/runtime-client";
import {
  closeSessionBinding,
  createSessionBinding,
  getSessionBindingByExternalRef,
  getSessionBindingById,
  getSessionBindingsByThread,
  updateLastUsedAt,
} from "@/lib/v11/runtime/session-binding-queries";
import type { V11AgentRevision } from "@/lib/v11/schema/agent";
import type { V11RuntimeRevision } from "@/lib/v11/schema/runtime";
import { publishTrustedAgentRevisionForTest } from "@/lib/v11/test-support/publish-trusted-agent-revision";
import { publishTrustedRuntimeRevisionForTest } from "@/lib/v11/test-support/publish-trusted-runtime-revision";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  setRouteHostedAdapter(null);
});

// ─── 辅助：InMemoryManagedArtifactStore ────────────────────

class InMemoryManagedArtifactStore implements ManagedArtifactStore {
  private signatures = new Map<string, SignatureBundle>();
  private sboms = new Map<string, SbomDocument>();
  private provenances = new Map<string, ProvenanceDocument>();

  writeSignatureBundle(ref: string, bundle: SignatureBundle): void {
    this.signatures.set(ref, bundle);
  }
  writeSbom(ref: string, doc: SbomDocument): void {
    this.sboms.set(ref, doc);
  }
  writeProvenance(ref: string, doc: ProvenanceDocument): void {
    this.provenances.set(ref, doc);
  }

  async readSignatureBundle(ref: string): Promise<SignatureBundle> {
    const bundle = this.signatures.get(ref);
    if (!bundle) throw new Error(`signature bundle not found: ${ref}`);
    return bundle;
  }
  async readSbom(ref: string): Promise<SbomDocument> {
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

// ─── 辅助：ed25519 密钥对 + 签名 ───────────────────────────

interface BuilderKeyPair {
  builderIdentity: string;
  publicKeyBase64: string;
  privateKey: KeyObject;
}

function generateBuilderKeyPair(builderIdentity: string): BuilderKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const rawPublicKey = Buffer.from(der.subarray(der.length - 32));
  return {
    builderIdentity,
    publicKeyBase64: rawPublicKey.toString("base64"),
    privateKey,
  };
}

function signEd25519(privateKey: KeyObject, payload: string): string {
  const sig = sign(null, Buffer.from(payload, "utf-8"), privateKey);
  return sig.toString("base64");
}

function buildValidSignatureBundle(keyPair: BuilderKeyPair, digest: string): SignatureBundle {
  return {
    algorithm: "ed25519",
    publicKey: keyPair.publicKeyBase64,
    signature: signEd25519(keyPair.privateKey, digest),
  };
}

function buildCleanSbom(): SbomDocument {
  return {
    packages: [{ name: "lodash", version: "4.17.21", licenses: ["MIT"], vulnerabilities: [] }],
  };
}

function buildValidProvenance(): ProvenanceDocument {
  return {
    sourceRevision: "git:abc123def456",
    buildPipeline: "ci-cd-pipeline-1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  };
}

// ─── 辅助：seed 租户 + 用户 ────────────────────────────────

async function seedTenantAndOwner() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "runtime-owner-001",
    email: "runtime-owner@example.com",
    displayName: "Runtime Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "runtime-owner-001",
    displayName: "Runtime Owner",
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
  const keyPair = generateBuilderKeyPair("builder:company-agent-runtime");
  const builderKeys: BuilderKeyRegistry = {
    "builder:company-agent-runtime": keyPair.publicKeyBase64,
  };
  const digest = computeArtifactDigest(artifactContent);
  const sigRef = `attestation:signature:${digest.slice(7, 15)}`;
  const sbomRef = `attestation:sbom:${digest.slice(7, 15)}`;
  const provRef = `attestation:provenance:${digest.slice(7, 15)}`;

  const store = new InMemoryManagedArtifactStore();
  store.writeSignatureBundle(sigRef, buildValidSignatureBundle(keyPair, digest));
  store.writeSbom(sbomRef, buildCleanSbom());
  store.writeProvenance(provRef, buildValidProvenance());

  const input: VerifyAttestationInput = {
    tenantId,
    artifactType,
    artifactRevisionId,
    artifactDigest: digest,
    signatureBundleRef: sigRef,
    sbomRef,
    provenanceRef: provRef,
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
  modelPolicy?: Record<string, unknown>,
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
    modelPolicyJson: modelPolicy ?? { default: "doubao-pro", provider: "doubao" },
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
    configHash: `sha256:config_${contentSuffix}`,
    createdBy: ownerId,
  });

  const attestation = await createVerifiedAttestation(
    tenantId,
    "runtime_revision",
    revision.id,
    `runtime-content-${contentSuffix}`,
  );
  await publishTrustedRuntimeRevisionForTest({
    tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: 1,
    attestationId: attestation.id,
  });

  return { runtime, revision };
}

// ─── 辅助：seed 完整调度上下文 ─────────────────────────────

interface FullDispatchContext {
  tenantId: string;
  ownerId: string;
  agentId: string;
  agentRevision: V11AgentRevision;
  runtimeRevision: V11RuntimeRevision;
  routeId: string;
  routeSetId: string;
  threadId: string;
  turnId: string;
  triggerItemId: string | null;
}

async function seedFullDispatchContext(): Promise<FullDispatchContext> {
  const { tenantId, ownerId } = await seedTenantAndOwner();

  const { agent, revision: agentRevision } = await seedPublishedAgentRevision(
    tenantId,
    ownerId,
    "finance",
    ["event_stream"],
    "v1",
  );

  const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
    tenantId,
    ownerId,
    "doubao-hosted",
    ["event_stream"],
    "v1",
  );

  const routeSet = await createRouteSet({
    tenantId,
    agentId: agent.id,
    routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
    routeScopeJson: { networkZone: "internal" },
  });

  const routeResult = await upsertDeploymentRoute({
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
    primaryAgentId: agent.id,
    actorId: ownerId,
  });

  const { turn } = await acceptUserMessageTurn({
    tenantId,
    threadId: thread.id,
    ownerUserId: ownerId,
    content: { text: "请帮我分析财务数据" },
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

// ─── 辅助：构造 RuntimeEndpointResolution ──────────────────

function buildRuntimeEndpointResolution(runtimeRevisionId: string): RuntimeEndpointResolution {
  return {
    runtimeEndpoint: "https://runtime-hosted.internal",
    authToken: issueWorkloadToken({
      type: "runtime",
      tenantId: "test-tenant",
      invocationId: "test-invocation",
      runtimeRevisionId,
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    }),
    gatewayEndpoints: {
      events: "https://platform.internal/gateway/v1/events",
      cancel: "https://platform.internal/gateway/v1/cancel",
      resume: "https://platform.internal/gateway/v1/resume",
      steer: "https://platform.internal/gateway/v1/steer",
    },
  };
}

// ─── 辅助：构造 mock startInvocation 成功响应 ──────────────

function buildAcceptedResponse(invocationId: string): StartInvocationResponse {
  return {
    invocation_id: invocationId,
    accepted: true,
    attempt_no: 1,
    runtime_session_ref: `rss_test_${invocationId.slice(0, 8)}`,
    runtime_execution_ref: `rex_test_${invocationId.slice(0, 8)}`,
    capabilities: defaultRuntimeCapabilities(),
  };
}

// ═══════════════════════════════════════════════════════════
// 1. probeRuntimeCapabilities
// ═══════════════════════════════════════════════════════════

describe("S05-C02 probeRuntimeCapabilities", () => {
  it("mock probeCapabilities 返回默认能力声明", async () => {
    const mockClient = createMockRuntimeClient({
      probeCapabilities: async () => defaultRuntimeCapabilities(),
    });

    const caps = await mockClient.probeCapabilities("https://rt.internal", "test-token");

    expect(caps.protocol_versions).toEqual(["1"]);
    expect(caps.features.event_stream).toBe(true);
    expect(caps.features.cancel).toBe(true);
    expect(caps.limits.max_invocation_seconds).toBe(600);
    expect(mockClient.calls.probeCapabilities).toHaveLength(1);
    expect(mockClient.calls.probeCapabilities[0]?.endpoint).toBe("https://rt.internal");
  });

  it("defaultRuntimeCapabilities 包含必需能力集", () => {
    const caps = defaultRuntimeCapabilities();
    expect(caps.features.event_stream).toBe(true);
    expect(caps.features.cancel).toBe(true);
    expect(caps.features.resume).toBe(true);
    expect(caps.features.steer).toBe(true);
    expect(caps.features.workspace_types).toContain("local");
    expect(caps.protocol_versions).toContain("1");
  });

  it("http client probeCapabilities 网络不可达 → RuntimeHttpClientError(kind=network)", async () => {
    const client = createHttpRuntimeClient({ timeoutMs: 1000 });
    await expect(client.probeCapabilities("http://127.0.0.1:1", "token")).rejects.toThrow(
      RuntimeHttpClientError,
    );
    try {
      await client.probeCapabilities("http://127.0.0.1:1", "token");
    } catch (err) {
      const e = err as RuntimeHttpClientError;
      expect(e.kind).toBe("network");
    }
  });

  it("mock probeCapabilities 未实现 handler → RuntimeHttpClientError(kind=protocol)", async () => {
    const mockClient = createMockRuntimeClient({});
    await expect(mockClient.probeCapabilities("https://rt.internal", "token")).rejects.toThrow(
      RuntimeHttpClientError,
    );
    try {
      await mockClient.probeCapabilities("https://rt.internal", "token");
    } catch (err) {
      const e = err as RuntimeHttpClientError;
      expect(e.kind).toBe("protocol");
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 2. startInvocation HTTP 客户端
// ═══════════════════════════════════════════════════════════

describe("S05-C02 startInvocation HTTP 客户端", () => {
  it("mock startInvocation 返回 accepted 响应", async () => {
    const mockClient = createMockRuntimeClient({
      startInvocation: async (req) => buildAcceptedResponse(req.requestBody.invocation_id),
    });

    const response = await mockClient.startInvocation({
      runtimeEndpoint: "https://rt.internal",
      authToken: "test-token",
      idempotencyKey: "invoke-test-1",
      requestBody: {
        invocation_id: "inv-test-001",
        turn_context: null,
        job_context: null,
        agent: {
          agent_revision_id: "ar-1",
          instruction_hash: "sha256:abc",
          artifact_ref: "oci://ref",
          model_policy: {},
          permission_requirements: {},
          interface_requirements: {},
        },
        input_items: [{ type: "user_message", content: { text: "test" } }],
        context_handle: "ctx_test",
        gateway_endpoints: {
          events: "https://gw/events",
          cancel: "https://gw/cancel",
          resume: "https://gw/resume",
          steer: "https://gw/steer",
        },
        workspace: { workspace_binding_id: null, workspace_type: "none" },
        execution_limits: {
          max_invocation_seconds: 600,
          max_event_bytes: 1_048_576,
        },
        trace_context: { trace_id: "trace-test", span_id: "span-test" },
      },
    });

    expect(response.accepted).toBe(true);
    expect(response.invocation_id).toBe("inv-test-001");
    expect(response.runtime_session_ref).toMatch(/^rss_test_/);
    expect(response.runtime_execution_ref).toMatch(/^rex_test_/);
    expect(mockClient.calls.startInvocation).toHaveLength(1);
  });

  it("http client startInvocation 网络不可达 → RuntimeHttpClientError(kind=network)", async () => {
    const client = createHttpRuntimeClient({ timeoutMs: 1000 });
    await expect(
      client.startInvocation({
        runtimeEndpoint: "http://127.0.0.1:1",
        authToken: "token",
        idempotencyKey: "key-1",
        requestBody: {
          invocation_id: "inv-1",
          turn_context: null,
          job_context: null,
          agent: {
            agent_revision_id: "ar-1",
            instruction_hash: "sha256:abc",
            artifact_ref: "oci://ref",
            model_policy: {},
            permission_requirements: {},
            interface_requirements: {},
          },
          input_items: [{ type: "user_message", content: { text: "test" } }],
          context_handle: "ctx_test",
          gateway_endpoints: {
            events: "https://gw/events",
            cancel: "https://gw/cancel",
            resume: "https://gw/resume",
            steer: "https://gw/steer",
          },
          workspace: { workspace_binding_id: null, workspace_type: "none" },
          execution_limits: {
            max_invocation_seconds: 600,
            max_event_bytes: 1_048_576,
          },
          trace_context: { trace_id: "trace-test", span_id: "span-test" },
        },
      }),
    ).rejects.toThrow(RuntimeHttpClientError);
  });

  it("mock startInvocation 模拟 HTTP 503 → 调用方处理 skip", async () => {
    const mockClient = createMockRuntimeClient({
      startInvocation: async () => {
        throw new RuntimeHttpClientError("http", "Runtime 暂不可用", 503, "RUNTIME_UNAVAILABLE");
      },
    });

    await expect(
      mockClient.startInvocation({
        runtimeEndpoint: "https://rt.internal",
        authToken: "token",
        idempotencyKey: "key-1",
        requestBody: {
          invocation_id: "inv-1",
          turn_context: null,
          job_context: null,
          agent: {
            agent_revision_id: "ar-1",
            instruction_hash: "sha256:abc",
            artifact_ref: "oci://ref",
            model_policy: {},
            permission_requirements: {},
            interface_requirements: {},
          },
          input_items: [{ type: "user_message", content: { text: "test" } }],
          context_handle: "ctx_test",
          gateway_endpoints: {
            events: "https://gw/events",
            cancel: "https://gw/cancel",
            resume: "https://gw/resume",
            steer: "https://gw/steer",
          },
          workspace: { workspace_binding_id: null, workspace_type: "none" },
          execution_limits: {
            max_invocation_seconds: 600,
            max_event_bytes: 1_048_576,
          },
          trace_context: { trace_id: "trace-test", span_id: "span-test" },
        },
      }),
    ).rejects.toThrow(RuntimeHttpClientError);
  });

  it("mock startInvocation 模拟 HTTP 409 IDEMPOTENCY_CONFLICT", async () => {
    const mockClient = createMockRuntimeClient({
      startInvocation: async () => {
        throw new RuntimeHttpClientError("http", "幂等冲突", 409, "IDEMPOTENCY_CONFLICT");
      },
    });

    try {
      await mockClient.startInvocation({
        runtimeEndpoint: "https://rt.internal",
        authToken: "token",
        idempotencyKey: "key-1",
        requestBody: {
          invocation_id: "inv-1",
          turn_context: null,
          job_context: null,
          agent: {
            agent_revision_id: "ar-1",
            instruction_hash: "sha256:abc",
            artifact_ref: "oci://ref",
            model_policy: {},
            permission_requirements: {},
            interface_requirements: {},
          },
          input_items: [{ type: "user_message", content: { text: "test" } }],
          context_handle: "ctx_test",
          gateway_endpoints: {
            events: "https://gw/events",
            cancel: "https://gw/cancel",
            resume: "https://gw/resume",
            steer: "https://gw/steer",
          },
          workspace: { workspace_binding_id: null, workspace_type: "none" },
          execution_limits: {
            max_invocation_seconds: 600,
            max_event_bytes: 1_048_576,
          },
          trace_context: { trace_id: "trace-test", span_id: "span-test" },
        },
      });
      expect.unreachable("应抛出 RuntimeHttpClientError");
    } catch (err) {
      const e = err as RuntimeHttpClientError;
      expect(e.kind).toBe("http");
      expect(e.httpStatus).toBe(409);
      expect(e.runtimeErrorCode).toBe("IDEMPOTENCY_CONFLICT");
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 3. dispatchInvocationForTurn 集成
// ═══════════════════════════════════════════════════════════

describe("S05-C02 dispatchInvocationForTurn Runtime 集成", () => {
  let ctx: FullDispatchContext;

  beforeEach(async () => {
    ctx = await seedFullDispatchContext();
  });

  it("dispatch 成功 → Invocation queued → running + invocation.started Event + SessionBinding", async () => {
    const mockClient = createMockRuntimeClient({
      startInvocation: async (req) => buildAcceptedResponse(req.requestBody.invocation_id),
    });

    const result = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () => buildRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.dispatched).toBe(true);
    expect(result.invocation).toBeDefined();
    expect(result.runtimeDispatch).toBeDefined();
    expect(result.runtimeDispatch?.skipped).toBeFalsy();
    expect(result.runtimeDispatch?.response?.accepted).toBe(true);
    expect(result.runtimeDispatch?.sessionBinding).toBeDefined();
    expect(result.runtimeDispatch?.sessionBindingCreated).toBe(true);
    expect(result.runtimeDispatch?.invocationStartedEvent).toBeDefined();
    expect(result.runtimeDispatch?.invocationStartedEvent?.eventType).toBe("invocation.started");

    // Invocation 应已转为 running
    expect(result.invocation?.executionState).toBe("running");
    // mock client 被调用一次
    expect(mockClient.calls.startInvocation).toHaveLength(1);
    const startup = mockClient.calls.startInvocation[0]?.requestBody;
    expect(startup?.input_items.length).toBeGreaterThan(0);
    expect(startup?.input_items).toContainEqual(expect.objectContaining({ type: "user_message" }));
    expect(startup?.context_handle).toEqual(expect.any(String));
    expect(startup?.workspace).toEqual({
      workspace_binding_id: null,
      workspace_type: "none",
    });
    const handleBinding = await resolveContextHandle(startup?.context_handle ?? "", {
      tenantId: ctx.tenantId,
      invocationId: result.invocation?.id ?? "",
    });
    expect(handleBinding.threadId).toBe(ctx.threadId);
  });

  it("dispatch Runtime 网络不可达 → Turn 保持 queued，skipped=true", async () => {
    const mockClient = createMockRuntimeClient({
      startInvocation: async () => {
        throw new RuntimeHttpClientError("network", "网络不可达");
      },
    });

    const result = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () => buildRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.dispatched).toBe(true);
    expect(result.runtimeDispatch?.skipped).toBe(true);
    expect(result.runtimeDispatch?.skipReason).toBe("runtime_network_unavailable");
    // Turn 仍为 queued（不是 accepted）
    expect(result.turn?.turnState).toBe("queued");
    // Invocation 仍为 queued（未转 running）
    expect(result.invocation?.executionState).toBe("queued");
  });

  it("dispatch Runtime 503 → Turn 保持 queued，skipped=true", async () => {
    const mockClient = createMockRuntimeClient({
      startInvocation: async () => {
        throw new RuntimeHttpClientError("http", "不可用", 503, "RUNTIME_UNAVAILABLE");
      },
    });

    const result = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () => buildRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(result.runtimeDispatch?.skipped).toBe(true);
    expect(result.runtimeDispatch?.skipReason).toBe("runtime_unavailable");
    expect(result.turn?.turnState).toBe("queued");
    expect(result.invocation?.executionState).toBe("queued");
  });

  it("dispatch 不传 runtimeClient → 沿用 S05-C01 行为（不调用 Runtime）", async () => {
    const result = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
    });

    expect(result.dispatched).toBe(true);
    expect(result.runtimeDispatch).toBeUndefined();
    expect(result.invocation?.executionState).toBe("queued");
    expect(result.turn?.turnState).toBe("queued");
  });

  it("dispatch 成功后 RuntimeSessionBinding 字段正确", async () => {
    const mockClient = createMockRuntimeClient({
      startInvocation: async (req) => buildAcceptedResponse(req.requestBody.invocation_id),
    });

    const result = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () => buildRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    const binding = result.runtimeDispatch?.sessionBinding;
    expect(binding).toBeDefined();
    expect(binding?.tenantId).toBe(ctx.tenantId);
    expect(binding?.runtimeRevisionId).toBe(ctx.runtimeRevision.id);
    expect(binding?.threadId).toBe(ctx.threadId);
    expect(binding?.jobId).toBeNull();
    expect(binding?.bindingState).toBe("active");
    expect(binding?.externalSessionRef).toMatch(/^rss_test_/);
  });

  it("dispatch 409 IDEMPOTENCY_CONFLICT 无已有 binding → 跳过", async () => {
    const mockClient = createMockRuntimeClient({
      startInvocation: async () => {
        throw new RuntimeHttpClientError("http", "幂等冲突", 409, "IDEMPOTENCY_CONFLICT");
      },
    });

    const result = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () => buildRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    // 无已有 SessionBinding → 跳过
    expect(result.runtimeDispatch?.skipped).toBe(true);
    expect(result.runtimeDispatch?.skipReason).toBe("runtime_unavailable");
    expect(result.turn?.turnState).toBe("queued");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. RuntimeSessionBinding 仓储
// ═══════════════════════════════════════════════════════════

describe("S05-C02 RuntimeSessionBinding 仓储", () => {
  let ctx: FullDispatchContext;

  beforeEach(async () => {
    ctx = await seedFullDispatchContext();
  });

  it("createSessionBinding 创建 active binding（threadId 模式）", async () => {
    const binding = await createSessionBinding({
      tenantId: ctx.tenantId,
      runtimeRevisionId: ctx.runtimeRevision.id,
      threadId: ctx.threadId,
      externalSessionRef: "rss-binding-001",
    });

    expect(binding.tenantId).toBe(ctx.tenantId);
    expect(binding.runtimeRevisionId).toBe(ctx.runtimeRevision.id);
    expect(binding.threadId).toBe(ctx.threadId);
    expect(binding.jobId).toBeNull();
    expect(binding.externalSessionRef).toBe("rss-binding-001");
    expect(binding.bindingState).toBe("active");
    expect(binding.createdAt).toBeDefined();
    expect(binding.lastUsedAt).toBeDefined();
    expect(binding.closedAt).toBeNull();
  });

  it("getSessionBindingByExternalRef 查找 binding", async () => {
    await createSessionBinding({
      tenantId: ctx.tenantId,
      runtimeRevisionId: ctx.runtimeRevision.id,
      threadId: ctx.threadId,
      externalSessionRef: "rss-find-001",
    });

    const found = await getSessionBindingByExternalRef(ctx.runtimeRevision.id, "rss-find-001");
    expect(found).toBeDefined();
    expect(found?.externalSessionRef).toBe("rss-find-001");

    const notFound = await getSessionBindingByExternalRef(ctx.runtimeRevision.id, "rss-not-exist");
    expect(notFound).toBeNull();
  });

  it("getSessionBindingsByThread 列出 Thread 下所有 binding", async () => {
    await createSessionBinding({
      tenantId: ctx.tenantId,
      runtimeRevisionId: ctx.runtimeRevision.id,
      threadId: ctx.threadId,
      externalSessionRef: "rss-list-001",
    });
    await createSessionBinding({
      tenantId: ctx.tenantId,
      runtimeRevisionId: ctx.runtimeRevision.id,
      threadId: ctx.threadId,
      externalSessionRef: "rss-list-002",
    });

    const list = await getSessionBindingsByThread(ctx.tenantId, ctx.threadId);
    expect(list).toHaveLength(2);
    const refs = list.map((b) => b.externalSessionRef);
    expect(refs).toContain("rss-list-001");
    expect(refs).toContain("rss-list-002");
  });

  it("closeSessionBinding active → closed（幂等）", async () => {
    const binding = await createSessionBinding({
      tenantId: ctx.tenantId,
      runtimeRevisionId: ctx.runtimeRevision.id,
      threadId: ctx.threadId,
      externalSessionRef: "rss-close-001",
    });

    const closed = await closeSessionBinding(binding.id);
    expect(closed.bindingState).toBe("closed");
    expect(closed.closedAt).toBeDefined();

    // 再次关闭（幂等）
    const reClosed = await closeSessionBinding(binding.id);
    expect(reClosed.bindingState).toBe("closed");
  });
});

// ═══════════════════════════════════════════════════════════
// 5. GET /runtime/v1/capabilities
// ═══════════════════════════════════════════════════════════

describe("S05-C02 GET /runtime/v1/capabilities", () => {
  it("有效 runtime Token → 200 + 能力声明", async () => {
    const token = issueWorkloadToken({
      type: "runtime",
      tenantId: "test-tenant",
      invocationId: "test-inv",
      runtimeRevisionId: "test-rr",
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    });

    const request = new Request(
      "https://platform.internal/runtime/v1/capabilities?protocol_version=1",
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-request-id": "req-test-caps-1",
        },
      },
    );

    const response = await capabilitiesGET(request);
    expect(response.status).toBe(200);

    const body = (await response.json()) as RuntimeCapabilitiesResponse;
    expect(body.protocol_versions).toEqual(["1"]);
    expect(body.features.event_stream).toBe(true);
  });

  it("缺少 Authorization → 401 AUTHENTICATION_REQUIRED", async () => {
    const request = new Request("https://platform.internal/runtime/v1/capabilities", {
      headers: { "x-request-id": "req-test-caps-2" },
    });

    const response = await capabilitiesGET(request);
    expect(response.status).toBe(401);

    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. POST /runtime/v1/invocations
// ═══════════════════════════════════════════════════════════

describe("S05-C02 POST /runtime/v1/invocations", () => {
  it("空 input_items/context_handle/workspace 按机器契约拒绝", async () => {
    const token = issueWorkloadToken({
      type: "runtime",
      tenantId: "test-tenant",
      invocationId: "test-inv",
      runtimeRevisionId: "test-rr",
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    });
    const response = await invocationsPOST(
      new Request("https://platform.internal/runtime/v1/invocations", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": "invalid-empty-context",
        },
        body: JSON.stringify({
          invocation_id: "test-inv",
          agent: {
            agent_revision_id: "ar-1",
            instruction_hash: "sha256:abc",
            artifact_ref: "oci://ref",
          },
          input_items: [],
          context_handle: null,
          gateway_endpoints: {
            events: "https://gw/events",
            cancel: "https://gw/cancel",
            resume: "https://gw/resume",
            steer: "https://gw/steer",
          },
          execution_limits: {
            max_invocation_seconds: 600,
            max_event_bytes: 1_048_576,
          },
          workspace: null,
          trace_context: null,
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("合法无 workspace 请求 → 202 + runtime_session_ref + runtime_execution_ref", async () => {
    const token = issueWorkloadToken({
      type: "runtime",
      tenantId: "test-tenant",
      invocationId: "test-inv",
      runtimeRevisionId: "test-rr",
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    });

    const body = {
      invocation_id: "inv-test-001",
      turn_context: null,
      job_context: null,
      agent: {
        agent_revision_id: "ar-1",
        instruction_hash: "sha256:abc",
        artifact_ref: "oci://ref",
        model_policy: {},
        permission_requirements: {},
        interface_requirements: {},
      },
      input_items: [{ type: "user_message", content: { text: "test" } }],
      context_handle: "ctx_test",
      gateway_endpoints: {
        events: "https://gw/events",
        cancel: "https://gw/cancel",
        resume: "https://gw/resume",
        steer: "https://gw/steer",
      },
      execution_limits: {
        max_invocation_seconds: 600,
        max_event_bytes: 1_048_576,
      },
      trace_context: { trace_id: "trace-test", span_id: "span-test" },
    };

    const request = new Request("https://platform.internal/runtime/v1/invocations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "invoke-test-1",
        "x-request-id": "req-test-inv-1",
      },
      body: JSON.stringify(body),
    });

    const response = await invocationsPOST(request);
    expect(response.status).toBe(202);

    const respBody = (await response.json()) as StartInvocationResponse;
    expect(respBody.invocation_id).toBe("inv-test-001");
    expect(respBody.accepted).toBe(true);
    expect(respBody.runtime_session_ref).toMatch(/^rss_/);
    expect(respBody.runtime_execution_ref).toMatch(/^rex_/);
    expect(respBody.capabilities.protocol_versions).toEqual(["1"]);
  });

  it("Runtime route 把当前输入、handle、workspace、limits、trace 传入实际 HostedAgentLoop", async () => {
    let modelArgs: unknown[] = [];
    const adapter = createHostedAdapter({
      platformEndpoint: "https://platform.internal",
      platformAuthToken: "unused",
      eventBatchSink: async () => {},
      modelFn: (...args: unknown[]) => {
        modelArgs = args;
        return "ok";
      },
      modelRef: "test-model",
    });
    setRouteHostedAdapter(adapter);
    const token = issueWorkloadToken({
      type: "runtime",
      tenantId: "test-tenant",
      invocationId: "inv-actual-adapter",
      runtimeRevisionId: "test-rr",
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    });
    const response = await invocationsPOST(
      new Request("https://platform.internal/runtime/v1/invocations", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": "actual-adapter-context",
        },
        body: JSON.stringify({
          invocation_id: "inv-actual-adapter",
          turn_context: { thread_id: "thread-1", turn_id: "turn-1" },
          job_context: null,
          agent: {
            agent_revision_id: "ar-1",
            instruction_hash: "sha256:abc",
            artifact_ref: "oci://ref",
            model_policy: {},
            permission_requirements: {},
            interface_requirements: {},
          },
          input_items: [{ type: "user_message", content: { text: "真实当前输入" } }],
          context_handle: "ctx_actual",
          gateway_endpoints: {
            events: "https://gw/events",
            cancel: "https://gw/cancel",
            resume: "https://gw/resume",
            steer: "https://gw/steer",
          },
          workspace: { workspace_binding_id: "wbind-1", workspace_type: "managed" },
          execution_limits: {
            max_invocation_seconds: 321,
            max_event_bytes: 654,
          },
          trace_context: { trace_id: "trace-1", span_id: "span-1" },
        }),
      }),
    );
    expect(response.status).toBe(202);
    await adapter.getLastLoopPromise?.();
    expect(modelArgs[0]).toBe("真实当前输入");
    expect(modelArgs[1]).toEqual({
      contextHandle: "ctx_actual",
      workspace: { workspace_binding_id: "wbind-1", workspace_type: "managed" },
      executionLimits: { max_invocation_seconds: 321, max_event_bytes: 654 },
      traceContext: { trace_id: "trace-1", span_id: "span-1" },
    });
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const token = issueWorkloadToken({
      type: "runtime",
      tenantId: "test-tenant",
      invocationId: "test-inv",
      runtimeRevisionId: "test-rr",
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    });

    const request = new Request("https://platform.internal/runtime/v1/invocations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-request-id": "req-test-inv-2",
      },
      body: JSON.stringify({ invocation_id: "inv-1" }),
    });

    const response = await invocationsPOST(request);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("请求体非法 → 400 REQUEST_SCHEMA_INVALID", async () => {
    const token = issueWorkloadToken({
      type: "runtime",
      tenantId: "test-tenant",
      invocationId: "test-inv",
      runtimeRevisionId: "test-rr",
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    });

    const request = new Request("https://platform.internal/runtime/v1/invocations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "invoke-test-3",
        "x-request-id": "req-test-inv-3",
      },
      body: JSON.stringify({ invocation_id: "" }),
    });

    const response = await invocationsPOST(request);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });
});
