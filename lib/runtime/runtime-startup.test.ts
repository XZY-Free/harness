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
import { GET as capabilitiesGET } from "@/app/runtime/v1/capabilities/route";
import { POST as invocationsPOST } from "@/app/runtime/v1/invocations/route";
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
import { resolveContextHandle } from "@/lib/context/context-handle";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/identity/audit";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import type { RuntimeRevision } from "@/lib/persistence/schema/runtimes";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { createHostedAdapter, setRouteHostedAdapter } from "@/lib/runtime/adapters/hosted-adapter";
import {
  DEFAULT_ROUTE_SCOPE_KEY,
  type RuntimeDispatchResult,
  type RuntimeEndpointResolution,
  dispatchInvocationForTurn,
} from "@/lib/runtime/dispatcher";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import { buildCapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCapabilitiesResponse,
  type StartInvocationResponse,
  createHttpRuntimeClient,
  createMockRuntimeClient,
  defaultRuntimeCapabilities,
} from "@/lib/runtime/runtime-client";
import {
  closeSessionBinding,
  createSessionBinding,
  getSessionBindingByExternalRef,
  getSessionBindingById,
  getSessionBindingsByThread,
  updateLastUsedAt,
} from "@/lib/runtime/session-binding-queries";
import { publishRuntimeRevisionForTest } from "@/lib/test-support/publish-runtime-revision-for-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  setRouteHostedAdapter(null);
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

function emptyCapabilityCatalog(invocationId: string) {
  return buildCapabilityCatalogSnapshot({
    invocationId,
    preferredAgentId: null,
    agentCandidate: null,
    tools: [],
    knowledgeSources: [],
    sourceRefs: ["runtime-startup-test:empty-capability-catalog"],
    now: new Date("2026-09-04T00:00:00.000Z"),
  }).snapshot;
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
    protocolType: "harness_runtime_protocol",
    protocolContractRevision: "harness-runtime-protocol@1",
    runtimeEvidenceKind: "hosted_artifact",
    endpointRef: `https://runtime-${contentSuffix}.internal`,
    runtimeArtifactRef: `oci://registry/runtime@${computeArtifactDigest(`runtime-content-${contentSuffix}`)}`,
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

interface FullDispatchContext {
  tenantId: string;
  ownerId: string;
  runtimeRevision: RuntimeRevision;
  routeId: string;
  routeSetId: string;
  threadId: string;
  turnId: string;
  triggerItemId: string | null;
}

async function seedFullDispatchContext(preferredAgentId?: string): Promise<FullDispatchContext> {
  const { tenantId, ownerId } = await seedTenantAndOwner();

  const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
    tenantId,
    ownerId,
    "doubao-hosted",
    ["event_stream"],
    "v1",
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

  const { turn } = await acceptUserMessageTurn({
    tenantId,
    threadId: thread.id,
    ownerUserId: ownerId,
    content: { text: "请帮我分析财务数据" },
    agentUse: preferredAgentId ? { mode: "preferred", agentId: preferredAgentId } : null,
    actorId: ownerId,
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

// ─── 辅助：构造 RuntimeEndpointResolution ──────────────────

function buildRuntimeEndpointResolution(runtimeRevisionId: string): RuntimeEndpointResolution {
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
      events: "https://platform.internal/gateway/v1/events",
      cancel: "https://platform.internal/gateway/v1/cancel",
      resume: "https://platform.internal/gateway/v1/resume",
      steer: "https://platform.internal/gateway/v1/steer",
      tools: "https://platform.internal/gateway/v1/tools",
      tool_calls: "https://platform.internal/gateway/v1/tool-calls",
      user_action_requests: "https://platform.internal/gateway/v1/user-action-requests",
      capability_actions: "https://platform.internal/gateway/v1/capability-actions",
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

    const caps = await mockClient.probeCapabilities("https://rt.internal", {
      mode: "workload_token",
      token: "test-token",
    });

    expect(caps.protocol_versions).toEqual(["2"]);
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
    expect(caps.protocol_versions).toContain("2");
  });

  it("http client probeCapabilities 网络不可达 → RuntimeHttpClientError(kind=network)", async () => {
    const client = createHttpRuntimeClient({ timeoutMs: 1000 });
    await expect(
      client.probeCapabilities("http://127.0.0.1:1", { mode: "workload_token", token: "token" }),
    ).rejects.toThrow(RuntimeHttpClientError);
    try {
      await client.probeCapabilities("http://127.0.0.1:1", {
        mode: "workload_token",
        token: "token",
      });
    } catch (err) {
      const e = err as RuntimeHttpClientError;
      expect(e.kind).toBe("network");
    }
  });

  it("mock probeCapabilities 未实现 handler → RuntimeHttpClientError(kind=protocol)", async () => {
    const mockClient = createMockRuntimeClient({});
    await expect(
      mockClient.probeCapabilities("https://rt.internal", {
        mode: "workload_token",
        token: "token",
      }),
    ).rejects.toThrow(RuntimeHttpClientError);
    try {
      await mockClient.probeCapabilities("https://rt.internal", {
        mode: "workload_token",
        token: "token",
      });
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
      auth: { mode: "workload_token", token: "test-token" },
      idempotencyKey: "invoke-test-1",
      requestBody: {
        protocol_version: RUNTIME_PROTOCOL_VERSION,
        invocation_id: "inv-test-001",
        turn_context: null,
        job_context: null,
        input_items: [{ type: "user_message", content: { text: "test" } }],
        context_handle: "ctx_test",
        gateway_endpoints: {
          events: "https://gw/events",
          cancel: "https://gw/cancel",
          resume: "https://gw/resume",
          steer: "https://gw/steer",
          tools: "https://gw/tools",
          tool_calls: "https://gw/tool-calls",
          user_action_requests: "https://gw/user-action-requests",
          capability_actions: "https://gw/capability-actions",
        },
        workspace: { workspace_binding_id: null, workspace_type: "none" },
        governance_config: { revision_id: "gov-rev-1", config_digest: "sha256:test", config: {} },
        gateway_access: {
          access_token: "gw-token",
          expires_at: new Date(Date.now() + 60000).toISOString(),
        },
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
        auth: { mode: "workload_token", token: "token" },
        idempotencyKey: "key-1",
        requestBody: {
          protocol_version: RUNTIME_PROTOCOL_VERSION,
          invocation_id: "inv-1",
          turn_context: null,
          job_context: null,
          input_items: [{ type: "user_message", content: { text: "test" } }],
          context_handle: "ctx_test",
          gateway_endpoints: {
            events: "https://gw/events",
            cancel: "https://gw/cancel",
            resume: "https://gw/resume",
            steer: "https://gw/steer",
            tools: "https://gw/tools",
            tool_calls: "https://gw/tool-calls",
            user_action_requests: "https://gw/user-action-requests",
            capability_actions: "https://gw/capability-actions",
          },
          workspace: { workspace_binding_id: null, workspace_type: "none" },
          governance_config: { revision_id: "gov-rev-1", config_digest: "sha256:test", config: {} },
          gateway_access: {
            access_token: "gw-token",
            expires_at: new Date(Date.now() + 60000).toISOString(),
          },
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
        auth: { mode: "workload_token", token: "token" },
        idempotencyKey: "key-1",
        requestBody: {
          protocol_version: RUNTIME_PROTOCOL_VERSION,
          invocation_id: "inv-1",
          turn_context: null,
          job_context: null,
          input_items: [{ type: "user_message", content: { text: "test" } }],
          context_handle: "ctx_test",
          gateway_endpoints: {
            events: "https://gw/events",
            cancel: "https://gw/cancel",
            resume: "https://gw/resume",
            steer: "https://gw/steer",
            tools: "https://gw/tools",
            tool_calls: "https://gw/tool-calls",
            user_action_requests: "https://gw/user-action-requests",
            capability_actions: "https://gw/capability-actions",
          },
          workspace: { workspace_binding_id: null, workspace_type: "none" },
          governance_config: { revision_id: "gov-rev-1", config_digest: "sha256:test", config: {} },
          gateway_access: {
            access_token: "gw-token",
            expires_at: new Date(Date.now() + 60000).toISOString(),
          },
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
        auth: { mode: "workload_token", token: "token" },
        idempotencyKey: "key-1",
        requestBody: {
          protocol_version: RUNTIME_PROTOCOL_VERSION,
          invocation_id: "inv-1",
          turn_context: null,
          job_context: null,
          input_items: [{ type: "user_message", content: { text: "test" } }],
          context_handle: "ctx_test",
          gateway_endpoints: {
            events: "https://gw/events",
            cancel: "https://gw/cancel",
            resume: "https://gw/resume",
            steer: "https://gw/steer",
            tools: "https://gw/tools",
            tool_calls: "https://gw/tool-calls",
            user_action_requests: "https://gw/user-action-requests",
            capability_actions: "https://gw/capability-actions",
          },
          workspace: { workspace_binding_id: null, workspace_type: "none" },
          governance_config: { revision_id: "gov-rev-1", config_digest: "sha256:test", config: {} },
          gateway_access: {
            access_token: "gw-token",
            expires_at: new Date(Date.now() + 60000).toISOString(),
          },
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
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
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

  it("preferred Agent 只作为 capability_directives 下发，不进入顶层 Binding", async () => {
    const { turn } = await acceptUserMessageTurn({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      ownerUserId: ctx.ownerId,
      content: { text: "优先使用指定 Agent" },
      agentUse: { mode: "preferred", agentId: "agent-preferred-1" },
      actorId: ctx.ownerId,
    });
    const mockClient = createMockRuntimeClient({
      startInvocation: async (req) => buildAcceptedResponse(req.requestBody.invocation_id),
    });

    const result = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: turn.id,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
      runtimeClient: mockClient,
      runtimeEndpointResolver: async () => buildRuntimeEndpointResolution(ctx.runtimeRevision.id),
    });

    expect(mockClient.calls.startInvocation[0]?.requestBody.capability_directives).toEqual([
      { capability_type: "agent", capability_id: "agent-preferred-1", mode: "preferred" },
    ]);
    expect(result.binding).not.toHaveProperty("agentRevisionId");
    expect(result.binding).not.toHaveProperty("preferredAgentId");
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
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
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
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
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
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
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
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
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
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
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
      invocationId: "inv-test-001",
      runtimeRevisionId: "test-rr",
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    });

    const request = new Request(
      "https://platform.internal/runtime/v1/capabilities?protocol_version=2",
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
    expect(body.protocol_versions).toEqual(["2"]);
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
          input_items: [],
          context_handle: null,
          gateway_endpoints: {
            events: "https://gw/events",
            cancel: "https://gw/cancel",
            resume: "https://gw/resume",
            steer: "https://gw/steer",
            tools: "https://gw/tools",
            tool_calls: "https://gw/tool-calls",
            user_action_requests: "https://gw/user-action-requests",
            capability_actions: "https://gw/capability-actions",
          },
          governance_config: { revision_id: "gov-rev-1", config_digest: "sha256:test", config: {} },
          gateway_access: {
            access_token: "gw-token",
            expires_at: new Date(Date.now() + 60000).toISOString(),
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
      invocationId: "inv-test-001",
      runtimeRevisionId: "test-rr",
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    });

    const body = {
      protocol_version: RUNTIME_PROTOCOL_VERSION,
      invocation_id: "inv-test-001",
      capability_catalog: emptyCapabilityCatalog("inv-test-001"),
      turn_context: null,
      job_context: null,
      input_items: [{ type: "user_message", content: { text: "test" } }],
      context_handle: "ctx_test",
      gateway_endpoints: {
        events: "https://gw/events",
        cancel: "https://gw/cancel",
        resume: "https://gw/resume",
        steer: "https://gw/steer",
        tools: "https://gw/tools",
        tool_calls: "https://gw/tool-calls",
        user_action_requests: "https://gw/user-action-requests",
        capability_actions: "https://gw/capability-actions",
      },
      governance_config: { revision_id: "gov-rev-1", config_digest: "sha256:test", config: {} },
      gateway_access: {
        access_token: "gw-token",
        expires_at: new Date(Date.now() + 60000).toISOString(),
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
    expect(respBody.capabilities.protocol_versions).toEqual(["2"]);
  });

  it("preferred capability_directives 的 capability_id 为空 → 400", async () => {
    const token = issueWorkloadToken({
      type: "runtime",
      tenantId: "test-tenant",
      invocationId: "inv-empty-preferred-agent",
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
          "idempotency-key": "empty-preferred-agent",
        },
        body: JSON.stringify({
          protocol_version: RUNTIME_PROTOCOL_VERSION,
          invocation_id: "inv-empty-preferred-agent",
          turn_context: null,
          job_context: null,
          capability_directives: [
            { capability_type: "agent", capability_id: "   ", mode: "preferred" },
          ],
          input_items: [{ type: "user_message", content: { text: "test" } }],
          context_handle: "ctx_test",
          gateway_endpoints: {
            events: "https://gw/events",
            cancel: "https://gw/cancel",
            resume: "https://gw/resume",
            steer: "https://gw/steer",
            tools: "https://gw/tools",
            tool_calls: "https://gw/tool-calls",
            user_action_requests: "https://gw/user-action-requests",
            capability_actions: "https://gw/capability-actions",
          },
          governance_config: { revision_id: "gov-rev-1", config_digest: "sha256:test", config: {} },
          gateway_access: {
            access_token: "gw-token",
            expires_at: new Date(Date.now() + 60000).toISOString(),
          },
          execution_limits: {
            max_invocation_seconds: 600,
            max_event_bytes: 1_048_576,
          },
          workspace: null,
          trace_context: { trace_id: "trace-empty-preferred", span_id: "span-1" },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("capability_directives 超过一个或携带额外字段 → 400", async () => {
    const token = issueWorkloadToken({
      type: "runtime",
      tenantId: "test-tenant",
      invocationId: "inv-invalid-directives",
      runtimeRevisionId: "test-rr",
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    });
    const baseBody = {
      protocol_version: RUNTIME_PROTOCOL_VERSION,
      invocation_id: "inv-invalid-directives",
      turn_context: null,
      job_context: null,
      input_items: [{ type: "user_message", content: { text: "test" } }],
      context_handle: "ctx_test",
      gateway_endpoints: {
        events: "https://gw/events",
        cancel: "https://gw/cancel",
        resume: "https://gw/resume",
        steer: "https://gw/steer",
        tools: "https://gw/tools",
        tool_calls: "https://gw/tool-calls",
        user_action_requests: "https://gw/user-action-requests",
        capability_actions: "https://gw/capability-actions",
      },
      governance_config: { revision_id: "gov-rev-1", config_digest: "sha256:test", config: {} },
      gateway_access: {
        access_token: "gw-token",
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
      execution_limits: { max_invocation_seconds: 600, max_event_bytes: 1_048_576 },
      workspace: null,
      trace_context: { trace_id: "trace-invalid-directives", span_id: "span-1" },
    };
    for (const [idempotencyKey, capabilityDirectives] of [
      [
        "multiple-directives",
        [
          { capability_type: "agent", capability_id: "agent-1", mode: "preferred" },
          { capability_type: "agent", capability_id: "agent-2", mode: "preferred" },
        ],
      ],
      [
        "extra-directive-key",
        [
          {
            capability_type: "agent",
            capability_id: "agent-1",
            mode: "preferred",
            required: true,
          },
        ],
      ],
    ] as const) {
      const response = await invocationsPOST(
        new Request("https://platform.internal/runtime/v1/invocations", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
            ...baseBody,
            capability_directives: capabilityDirectives,
          }),
        }),
      );
      expect(response.status).toBe(400);
    }
  });

  it("Runtime route 把当前输入、handle、workspace、limits、trace 传入实际 HostedHarnessLoop", async () => {
    let decisionView: unknown = null;
    const adapter = createHostedAdapter({
      platformEndpoint: "https://platform.internal",
      platformAuthToken: "unused",
      eventBatchSink: async () => {},
      decisionPort: {
        async decideNextAction(view) {
          decisionView = view;
          return {
            actionId: "respond-1",
            stepNo: 1,
            actionType: "respond",
            purposeCode: "answer_ready",
            shortPurpose: "测试回答",
            payload: { evidenceRefs: [] },
          };
        },
      },
      finalResponsePort: {
        async generateFinalResponse() {
          return "ok";
        },
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
          protocol_version: RUNTIME_PROTOCOL_VERSION,
          invocation_id: "inv-actual-adapter",
          capability_catalog: emptyCapabilityCatalog("inv-actual-adapter"),
          turn_context: { thread_id: "thread-1", turn_id: "turn-1" },
          job_context: null,
          input_items: [{ type: "user_message", content: { text: "真实当前输入" } }],
          context_handle: "ctx_actual",
          gateway_endpoints: {
            events: "https://gw/events",
            cancel: "https://gw/cancel",
            resume: "https://gw/resume",
            steer: "https://gw/steer",
            tools: "https://gw/tools",
            tool_calls: "https://gw/tool-calls",
            user_action_requests: "https://gw/user-action-requests",
            capability_actions: "https://gw/capability-actions",
          },
          workspace: { workspace_binding_id: "wbind-1", workspace_type: "managed" },
          governance_config: { revision_id: "gov-rev-1", config_digest: "sha256:test", config: {} },
          gateway_access: {
            access_token: "gw-token",
            expires_at: new Date(Date.now() + 60000).toISOString(),
          },
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
    expect(decisionView).toMatchObject({
      objective: "真实当前输入",
      context: {
        contextHandle: "ctx_actual",
        workspace: { workspace_binding_id: "wbind-1", workspace_type: "managed" },
        executionLimits: { max_invocation_seconds: 321, max_event_bytes: 654 },
        traceContext: { trace_id: "trace-1", span_id: "span-1" },
      },
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
