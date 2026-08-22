import { randomUUID } from "node:crypto";
import {
  GET as conformanceGET,
  POST as conformancePOST,
} from "@/app/admin/api/v1/runtime-revisions/[revision_id]/conformance/route";
import { createRecordArtifactAttestation } from "@/lib/artifacts/application/record-artifact-attestation";
import { mysqlArtifactAttestationPersistenceStore } from "@/lib/artifacts/persistence/mysql-artifact-attestation-store";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
/**
 * Runtime Publication Conformance runner + 结果持久化 + Admin API 集成测试（真实 MySQL 8）。
 *
 * 覆盖 3 类：
 * 1. runtime-conformance-runner（Publication 套件）：clean adapter 可完整通过、
 *    每项真实 Adapter 调用、probe/ack 错误 fail-closed。
 * 2. publishRuntimeRevision 集成：持久化 conformance 结果 + 失败不持久化。
 * 3. Admin API 路由：GET 列表 / POST 持久化 / POST 发布 / 门禁失败 / 跨租户隔离。
 *
 * 测试环境：APP_ENV=test，auth mode=dev（resolvePrincipal 使用 DEFAULT_USER_ID）。
 * 真实 MySQL 8 Testcontainers，不使用 DB mock。
 */
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { db } from "@/lib/db/client";
import { assertCrossTenantHidden, buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { getIdempotencyRecordById } from "@/lib/identity/idempotency-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { getPublicationRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import type {
  CancelParams,
  CancelResult,
  ResumeParams,
  ResumeResult,
  RuntimeAdapter,
  StartInvocationParams,
  StartInvocationResult,
  SteerParams,
  SteerResult,
} from "@/lib/runtime/adapters/hosted-adapter";
import {
  type CreateHostedAdapterParams,
  type EventBatchSink,
  createHostedAdapter,
  hostedAdapterCapabilities,
} from "@/lib/runtime/adapters/hosted-adapter";
import {
  PUBLICATION_CONFORMANCE_CASES,
  type PublicationConformanceCaseId,
  type PublicationConformanceCaseResult,
  computeCaseEvidenceDigest,
  computeEvidenceManifestDigest,
  validatePublicationConformanceGate,
} from "@/lib/runtime/domain/runtime-conformance";
import { RuntimeConformanceRunInvalidError } from "@/lib/runtime/domain/runtime-revision-publication-policy";
import type { RuntimeCandidateEvent } from "@/lib/runtime/event-ingress-queries";
import {
  createRuntime,
  getRuntimeById,
  getRuntimeByKey,
} from "@/lib/runtime/persistence/runtime-queries";
import {
  RuntimePublicationVersionConflictError,
  RuntimeRevisionNotFoundError,
  createDraftRuntimeRevision,
  getRuntimeRevisionById,
} from "@/lib/runtime/persistence/runtime-revision-queries";
import type { RuntimeCapabilitiesResponse } from "@/lib/runtime/runtime-client";
import {
  ConformanceRunnerError,
  type RunPublicationConformanceSuiteParams,
  runPublicationConformanceSuite,
} from "@/lib/runtime/runtime-conformance-runner";
import { publishRuntimeRevision } from "@/lib/runtime/test-support/attempt-runtime-publication-without-trusted-run";
import {
  buildDsseConformanceEnvelope,
  generateTestRunnerKey,
} from "@/lib/runtime/test-support/build-dsse-conformance-envelope";
import { withdrawRuntimeRevision } from "@/lib/runtime/test-support/withdraw-runtime-revision";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 admin-api.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;
const ORIGINAL_RUNNER_SIGNING_IDENTITIES = process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON;
const TEST_RUNNER_KEY = generateTestRunnerKey("runner-api-test");
const RUNNER_IDENTITY = "ci/runtime-conformance";
const RUNNER_SIGNING_IDENTITIES_JSON = JSON.stringify([
  {
    keyId: TEST_RUNNER_KEY.keyid,
    publicKey: TEST_RUNNER_KEY.publicKeyBase64,
    runnerIdentity: RUNNER_IDENTITY,
    tenantScope: null,
    validFrom: "2020-01-01T00:00:00.000Z",
    validUntil: null,
    revokedAt: null,
  },
]);
const RUNTIME_DIGEST = `sha256:${"a".repeat(64)}`;
const CONFIG_DIGEST = `sha256:${"b".repeat(64)}`;
const RUNNER_DIGEST = `sha256:${"c".repeat(64)}`;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = RUNNER_SIGNING_IDENTITIES_JSON;
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
  process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = ORIGINAL_RUNNER_SIGNING_IDENTITIES;
});

// ─── 辅助：seed 租户 + 用户 + Runtime + draft Revision ──

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

async function seedRuntimeAndRevision(
  tenantId: string,
  ownerId: string,
  runtimeKey = "doubao-hosted",
) {
  const runtime = await createRuntime({
    tenantId,
    runtimeKey,
    displayName: `Runtime ${runtimeKey}`,
    runtimeKind: "hosted",
    ownerUserId: ownerId,
  });
  const revision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "agent_runtime_protocol",
    endpointRef: "connection://doubao-prod",
    runtimeArtifactRef: `oci://registry/runtime@${RUNTIME_DIGEST}`,
    runtimeCapabilitiesJson: { steer: true, cancel: true, event_stream: true, tool_call: true },
    identityMode: "workload_token",
    networkZone: "internal",
    configHash: CONFIG_DIGEST,
    createdBy: ownerId,
  });
  return { runtime, revision };
}

/** 构造全部 Publication case 通过的 conformance 结果。 */
function passingConformanceResults(): PublicationConformanceCaseResult[] {
  return PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({
    caseId,
    passed: true,
    evidence: { caseId, passed: true },
    evidenceDigest: `sha256:${computeCanonicalDigest({ caseId, passed: true }).replace("sha256:", "")}`,
  }));
}

/** 构造全部 Publication case 通过的 conformance 结果。 */
function passingAllConformanceResults(): PublicationConformanceCaseResult[] {
  return PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({
    caseId,
    passed: true,
    evidence: { caseId, passed: true },
    evidenceDigest: `sha256:${computeCanonicalDigest({ caseId, passed: true }).replace("sha256:", "")}`,
  }));
}

function trustedRunnerBody(runtimeRevisionId: string, passed = true) {
  const caseResults = PUBLICATION_CONFORMANCE_CASES.map((caseId, index) => {
    const casePassed = passed || index !== 0;
    const evidence = {
      caseId,
      passed: casePassed,
      reason: casePassed ? null : "publication test failure",
    };
    return {
      caseId,
      passed: casePassed,
      reason: casePassed ? null : "publication test failure",
      evidenceDigest: computeCaseEvidenceDigest(evidence),
      evidence,
    };
  });
  const report = {
    runId: randomUUID(),
    runtimeRevisionId,
    runtimeArtifactDigest: RUNTIME_DIGEST,
    runtimeConfigDigest: CONFIG_DIGEST,
    protocolContractRevision: "agent-runtime-protocol@2",
    suiteRevision: "runtime-conformance@1",
    runnerArtifactDigest: RUNNER_DIGEST,
    runnerIdentity: RUNNER_IDENTITY,
    testEnvironmentRevision: "isolated-mysql8@1",
    startedAt: "2026-08-02T01:00:00.000Z",
    completedAt: "2026-08-02T01:00:01.000Z",
    overallResult: passed ? ("passed" as const) : ("failed" as const),
    evidenceManifestDigest: computeEvidenceManifestDigest({
      suiteRevision: "runtime-conformance@1",
      testEnvironmentRevision: "isolated-mysql8@1",
      runtimeRevisionId,
      runtimeArtifactDigest: RUNTIME_DIGEST,
      runtimeConfigDigest: CONFIG_DIGEST,
      protocolContractRevision: "agent-runtime-protocol@2",
      runnerArtifactDigest: RUNNER_DIGEST,
      cases: caseResults.map((result) => ({
        caseId: result.caseId,
        passed: result.passed,
        evidenceDigest: result.evidenceDigest,
      })),
    }),
    caseResults,
  };
  return {
    dsse_envelope: buildDsseConformanceEnvelope(
      report as Parameters<typeof buildDsseConformanceEnvelope>[0],
      TEST_RUNNER_KEY,
    ),
  };
}

/** 构造指定 Publication case 失败的 conformance 结果。 */
function failingConformanceResults(
  failCase: PublicationConformanceCaseId,
): PublicationConformanceCaseResult[] {
  return PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({
    caseId,
    passed: caseId !== failCase,
    reason: caseId === failCase ? "模拟探测失败" : undefined,
    evidence: { caseId, passed: caseId !== failCase },
    evidenceDigest: `sha256:${computeCanonicalDigest({ caseId, passed: caseId !== failCase }).replace("sha256:", "")}`,
  }));
}

// ─── 辅助：mock sink（捕获候选事件，不调用 DB） ───────────

function createMockSink(): { sink: EventBatchSink; events: RuntimeCandidateEvent[] } {
  const events: RuntimeCandidateEvent[] = [];
  const sink: EventBatchSink = async ({ events: batch }) => {
    events.push(...batch);
  };
  return { sink, events };
}

/** 构造 createHostedAdapter 参数。 */
function mockAdapterParams(sink: EventBatchSink): CreateHostedAdapterParams {
  return {
    platformEndpoint: "https://platform.internal",
    platformAuthToken: "test-token",
    eventBatchSink: sink,
    modelFn: (userMessage) => `测试执行器回复：${userMessage}`,
    modelRef: "test-model",
  };
}

// ─── 辅助：MockRuntimeAdapter（可定制能力 + 命令响应） ─────

interface MockCapabilitiesOverride {
  protocol_versions?: string[];
  features?: Partial<RuntimeCapabilitiesResponse["features"]>;
  limits?: Partial<RuntimeCapabilitiesResponse["limits"]>;
}

interface MockAdapterConfig {
  capabilities?: MockCapabilitiesOverride;
  /** startInvocation 返回 accepted（默认 true）。 */
  startAccepted?: boolean;
  /** handleSteer 抛错（模拟不支持）。 */
  steerThrows?: boolean;
  /** handleCancel 抛错（模拟失败）。 */
  cancelThrows?: boolean;
  /** handleResume 抛错（模拟失败）。 */
  resumeThrows?: boolean;
  /** handleResume 返回 requires_redispatch（默认 false）。 */
  requiresRedispatch?: boolean;
}

/** 创建可定制的 mock RuntimeAdapter（用于测试失败场景）。 */
function createMockAdapter(config: MockAdapterConfig = {}): RuntimeAdapter {
  const baseCaps = hostedAdapterCapabilities();
  const caps: RuntimeCapabilitiesResponse = {
    protocol_versions: config.capabilities?.protocol_versions ?? baseCaps.protocol_versions,
    features: { ...baseCaps.features, ...config.capabilities?.features },
    limits: { ...baseCaps.limits, ...config.capabilities?.limits },
  };

  return {
    async probeCapabilities() {
      return caps;
    },
    async startInvocation(_params: StartInvocationParams): Promise<StartInvocationResult> {
      if (config.startAccepted === false) {
        throw new Error("mock startInvocation 失败");
      }
      return {
        accepted: true,
        runtime_session_ref: `mock-session-${Math.random().toString(36).slice(2)}`,
        runtime_execution_ref: `mock-exec-${Math.random().toString(36).slice(2)}`,
        capabilities: caps,
      };
    },
    async handleCancel(_params: CancelParams): Promise<CancelResult> {
      if (config.cancelThrows) throw new Error("mock handleCancel 失败");
      return {
        cancel_state: "accepted",
        already_completed_effects_preserved: true,
      };
    },
    async handleResume(_params: ResumeParams): Promise<ResumeResult> {
      if (config.resumeThrows) throw new Error("mock handleResume 失败");
      return {
        resume_state: "accepted",
        runtime_execution_ref: `mock-exec-resume-${Math.random().toString(36).slice(2)}`,
        requires_redispatch: config.requiresRedispatch ?? false,
      };
    },
    async handleSteer(_params: SteerParams): Promise<SteerResult> {
      if (config.steerThrows) throw new Error("mock handleSteer 失败");
      return {
        steer_state: "accepted",
        applies_at: "next_safe_point",
        generation_interrupted: false,
      };
    },
  };
}

// ─── 辅助：seed admin 用户 + runtime.publish action binding ──

async function seedAdminWithRuntimePublish() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "runtime.publish",
    resourceScope: { type: "runtime", wildcard: true },
  });
  return { tenantId: tenant.id, userIdentityId: identity.id };
}

// ═══════════════════════════════════════════════════════════
// runtime-conformance-runner（Publication 套件，adapter probe）
// ═══════════════════════════════════════════════════════════

describe("runtime-conformance-runner（Runtime Publication 套件）", () => {
  let tenantId: string;
  let ownerId: string;
  let revisionId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    const { revision } = await seedRuntimeAndRevision(tenantId, ownerId);
    revisionId = revision.id;
  });

  it("runPublicationConformanceSuite 返回 6 个结果（clean/no-route/no-binding adapter 可完成）", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));
    const params: RunPublicationConformanceSuiteParams = {
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    };

    const results = await runPublicationConformanceSuite(params);

    expect(results).toHaveLength(PUBLICATION_CONFORMANCE_CASES.length);
    expect(results.map((r) => r.caseId)).toEqual([...PUBLICATION_CONFORMANCE_CASES]);
    // 全部真实通过 → Publication 门禁通过。
    const gate = validatePublicationConformanceGate(results);
    expect(gate.passed).toBe(true);
  });

  it("capability-manifest-contract: clean HostedAdapter 返回合法能力清单", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "capability-manifest-contract");
    expect(c?.passed).toBe(true);
  });

  it("dispatch-acknowledgement: HostedAdapter startInvocation 返回唯一 execution/session ref", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "dispatch-acknowledgement");
    expect(c?.passed).toBe(true);
  });

  it("cancel-acknowledgement: HostedAdapter handleCancel 返回 accepted（必须实际 ack）", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "cancel-acknowledgement");
    expect(c?.passed).toBe(true);
  });

  it("steer-capability-consistency: HostedAdapter steer=true → handleSteer accepted", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "steer-capability-consistency");
    expect(c?.passed).toBe(true);
  });

  it("resume-capability-consistency: HostedAdapter resume=true → handleResume accepted", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "resume-capability-consistency");
    expect(c?.passed).toBe(true);
  });

  it("session-recovery-declaration: HostedAdapter filesystem_checkpoint=false + resume requires_redispatch", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "session-recovery-declaration");
    expect(c?.passed).toBe(true);
  });

  it("MockAdapter filesystem_checkpoint=true + resume=true + requires_redispatch=false → session-recovery-declaration 通过", async () => {
    const adapter = createMockAdapter({
      capabilities: {
        features: { filesystem_checkpoint: true },
      },
    });
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "session-recovery-declaration");
    expect(c?.passed).toBe(true);
  });

  it("MockAdapter filesystem_checkpoint=true 但 requires_redispatch=true → session-recovery-declaration fail-closed", async () => {
    const adapter = createMockAdapter({
      capabilities: {
        features: { filesystem_checkpoint: true },
      },
      requiresRedispatch: true,
    });
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "session-recovery-declaration");
    expect(c?.passed).toBe(false);
  });

  it("MockAdapter handleSteer 抛错 → steer-capability-consistency 失败", async () => {
    const adapter = createMockAdapter({ steerThrows: true });
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "steer-capability-consistency");
    expect(c?.passed).toBe(false);
    expect(c?.reason).toContain("steer");
  });

  it("MockAdapter handleCancel 抛错 → cancel-acknowledgement 失败（cancel 必须实际 ack）", async () => {
    const adapter = createMockAdapter({ cancelThrows: true });
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "cancel-acknowledgement");
    expect(c?.passed).toBe(false);

    const gate = validatePublicationConformanceGate(results);
    expect(gate.passed).toBe(false);
    expect(gate.failedCases).toContain("cancel-acknowledgement");
  });

  it("MockAdapter handleResume 抛错 → resume-capability-consistency 失败", async () => {
    const adapter = createMockAdapter({ resumeThrows: true });
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "resume-capability-consistency");
    expect(c?.passed).toBe(false);
  });

  it("MockAdapter steer=false → steer-capability-consistency 只验证不宣称支持（不伪造成功）", async () => {
    const adapter = createMockAdapter({
      capabilities: {
        features: { steer: false },
      },
    });
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "steer-capability-consistency");
    expect(c?.passed).toBe(true);
    expect(c?.reason).toContain("steer");
  });

  it("MockAdapter resume=false → resume-capability-consistency 只验证不宣称支持（不伪造成功）", async () => {
    const adapter = createMockAdapter({
      capabilities: {
        features: { resume: false },
      },
    });
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });
    const c = results.find((r) => r.caseId === "resume-capability-consistency");
    expect(c?.passed).toBe(true);
    expect(c?.reason).toContain("resume");
  });

  it("probeCapabilities 抛错 → capability-manifest-contract fail-closed（不抛）", async () => {
    const failingAdapter: RuntimeAdapter = {
      ...createMockAdapter(),
      async probeCapabilities() {
        throw new Error("probe 失败");
      },
    };
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: failingAdapter,
    });
    const c = results.find((r) => r.caseId === "capability-manifest-contract");
    expect(c?.passed).toBe(false);
    expect(c?.reason).toContain("probe");
  });

  it("probeCapabilities 返回非法结构 → capability-manifest-contract fail-closed", async () => {
    const badAdapter: RuntimeAdapter = {
      ...createMockAdapter(),
      async probeCapabilities() {
        return {
          protocol_versions: "not-array",
          features: {},
          limits: {},
        } as unknown as RuntimeCapabilitiesResponse;
      },
    };
    const results = await runPublicationConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: badAdapter,
    });
    const c = results.find((r) => r.caseId === "capability-manifest-contract");
    expect(c?.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. publishRuntimeRevision 集成（conformance 持久化）
// ═══════════════════════════════════════════════════════════

describe("publishRuntimeRevision 集成（conformance 持久化）", () => {
  let tenantId: string;
  let ownerId: string;
  let runtimeId: string;
  let revisionId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    const { runtime, revision } = await seedRuntimeAndRevision(tenantId, ownerId);
    runtimeId = runtime.id;
    revisionId = revision.id;
  });

  it("旧发布入口不能再用调用方自报结果发布", async () => {
    await expect(
      publishRuntimeRevision(tenantId, revisionId, 1, passingAllConformanceResults()),
    ).rejects.toThrow(RuntimeConformanceRunInvalidError);
    expect((await getRuntimeRevisionById(revisionId))?.revisionState).toBe("draft");
  });

  it("publishRuntimeRevision 门禁失败 → 抛 RuntimeConformanceRunInvalidError + 不持久化结果", async () => {
    await expect(
      publishRuntimeRevision(
        tenantId,
        revisionId,
        1,
        failingConformanceResults("cancel-acknowledgement"),
      ),
    ).rejects.toThrow(RuntimeConformanceRunInvalidError);

    // Revision 保持 draft
    const after = await getRuntimeRevisionById(revisionId);
    expect(after?.revisionState).toBe("draft");
  });

  it("缺少显式 Passed Run 时全部 Publication required case 均视为缺失", async () => {
    await expect(
      publishRuntimeRevision(tenantId, revisionId, 1, passingConformanceResults()),
    ).rejects.toThrow(RuntimeConformanceRunInvalidError);
  });

  it("旧式 options 不会创建或覆盖任何 conformance 事实", async () => {
    await expect(
      publishRuntimeRevision(tenantId, revisionId, 1, passingConformanceResults(), {
        adapterDigest: "sha256:legacy",
      }),
    ).rejects.toThrow(RuntimeConformanceRunInvalidError);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Admin API 路由（GET + POST /conformance）
// ═══════════════════════════════════════════════════════════

describe("Admin API /admin/api/v1/runtime-revisions/{revision_id}/conformance", () => {
  let tenantId: string;
  let ownerId: string;
  let revisionId: string;
  let runtimeId: string;
  const etag = "runtime-revision-1";

  beforeEach(async () => {
    const seeded = await seedAdminWithRuntimePublish();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const { runtime, revision } = await seedRuntimeAndRevision(tenantId, ownerId);
    runtimeId = runtime.id;
    revisionId = revision.id;
  });

  it("GET /conformance 返回空结果列表（Revision 未测试）", async () => {
    const request = buildApiRequest({
      audience: "admin",
      method: "GET",
      path: `/runtime-revisions/${revisionId}/conformance`,
    });

    const response = await conformanceGET(request, {
      params: Promise.resolve({ revision_id: revisionId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.runtime_revision_id).toBe(revisionId);
    expect(body.revision_state).toBe("draft");
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toHaveLength(0);
  });

  it("POST /conformance publish=false 验签并记录不可变 Run（不发布）", async () => {
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: `/runtime-revisions/${revisionId}/conformance`,
      idempotencyKey: "idem-conf-001",
      body: { ...trustedRunnerBody(revisionId), publish: false },
    });

    const response = await conformancePOST(request, {
      params: Promise.resolve({ revision_id: revisionId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.published).toBe(false);
    expect(body.revision_state).toBe("draft");
    expect(body.results).toHaveLength(PUBLICATION_CONFORMANCE_CASES.length);
    expect(body.conformance_run_id).toBeTruthy();

    // Revision 仍为 draft
    const after = await getRuntimeRevisionById(revisionId);
    expect(after?.revisionState).toBe("draft");
  });

  it("POST /conformance publish=true 通过门禁 → 发布 Revision", async () => {
    const attestation = await createRecordArtifactAttestation({
      store: mysqlArtifactAttestationPersistenceStore,
    })({
      tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: revisionId,
      artifactDigest: RUNTIME_DIGEST,
      dsseEnvelopeRef: "attestation:signature:conformance-publish",
      sbomRef: "attestation:sbom:conformance-publish",
      provenanceRef: "attestation:provenance:conformance-publish",
      builderIdentity: "builder:conformance-test",
      verificationState: "verified",
      policyRevisionId: null,
      failureCode: null,
      verifiedAt: new Date(),
      sourceRevision: null,
      buildPipeline: null,
      dependencyLockFileHash: null,
      buildTime: null,
      scanSummaryJson: null,
      actor: { tenantId, actorType: "service", actorId: "test-builder" },
      requestId: `attestation-${revisionId}`,
    });
    const signedBody = {
      ...trustedRunnerBody(revisionId),
      publish: true,
      expected_version_no: 1,
      artifact_attestation_id: attestation.id,
    };
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: `/runtime-revisions/${revisionId}/conformance`,
      idempotencyKey: "idem-conf-publish-001",
      ifMatch: etag,
      body: signedBody,
    });

    const response = await conformancePOST(request, {
      params: Promise.resolve({ revision_id: revisionId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.published).toBe(true);
    expect(body.revision_state).toBe("published");
    expect(body.published_at).not.toBeNull();
    expect(body.etag).toBe(etag);

    // Runtime.currentRevisionId 已回填
    const runtime = await getRuntimeById(tenantId, runtimeId);
    expect(runtime?.currentRevisionId).toBe(revisionId);

    const publication = await getPublicationRecordBySubject({
      tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: revisionId,
    });
    expect(publication?.idempotencyRecordId).not.toBeNull();
    const idempotency = await getIdempotencyRecordById(publication?.idempotencyRecordId ?? "");
    expect(idempotency?.processingState).toBe("completed");
    expect(idempotency?.responseRedactedJson).toBe(JSON.stringify(body));

    const replayResponse = await conformancePOST(
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: `/runtime-revisions/${revisionId}/conformance`,
        idempotencyKey: "idem-conf-publish-001",
        ifMatch: etag,
        body: signedBody,
      }),
      { params: Promise.resolve({ revision_id: revisionId }) },
    );
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toEqual(body);
  });

  it("POST /conformance publish=true 的 Failed Run 被发布门禁阻断", async () => {
    const attestation = await createRecordArtifactAttestation({
      store: mysqlArtifactAttestationPersistenceStore,
    })({
      tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: revisionId,
      artifactDigest: RUNTIME_DIGEST,
      dsseEnvelopeRef: "attestation:signature:conformance-fail",
      sbomRef: "attestation:sbom:conformance-fail",
      provenanceRef: "attestation:provenance:conformance-fail",
      builderIdentity: "builder:conformance-test",
      verificationState: "verified",
      policyRevisionId: null,
      failureCode: null,
      verifiedAt: new Date(),
      sourceRevision: null,
      buildPipeline: null,
      dependencyLockFileHash: null,
      buildTime: null,
      scanSummaryJson: null,
      actor: { tenantId, actorType: "service", actorId: "test-builder" },
      requestId: `attestation-fail-${revisionId}`,
    });
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: `/runtime-revisions/${revisionId}/conformance`,
      idempotencyKey: "idem-conf-fail-001",
      ifMatch: etag,
      body: {
        ...trustedRunnerBody(revisionId, false),
        publish: true,
        expected_version_no: 1,
        artifact_attestation_id: attestation.id,
      },
    });

    const response = await conformancePOST(request, {
      params: Promise.resolve({ revision_id: revisionId }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUSINESS_CONSTRAINT_VIOLATION");
  });

  it("POST /conformance publish=true 缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const attestation = await createRecordArtifactAttestation({
      store: mysqlArtifactAttestationPersistenceStore,
    })({
      tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: revisionId,
      artifactDigest: RUNTIME_DIGEST,
      dsseEnvelopeRef: "attestation:signature:conformance-no-ifmatch",
      sbomRef: "attestation:sbom:conformance-no-ifmatch",
      provenanceRef: "attestation:provenance:conformance-no-ifmatch",
      builderIdentity: "builder:conformance-test",
      verificationState: "verified",
      policyRevisionId: null,
      failureCode: null,
      verifiedAt: new Date(),
      sourceRevision: null,
      buildPipeline: null,
      dependencyLockFileHash: null,
      buildTime: null,
      scanSummaryJson: null,
      actor: { tenantId, actorType: "service", actorId: "test-builder" },
      requestId: `attestation-no-ifmatch-${revisionId}`,
    });
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: `/runtime-revisions/${revisionId}/conformance`,
      idempotencyKey: "idem-conf-no-ifmatch-001",
      body: {
        ...trustedRunnerBody(revisionId),
        publish: true,
        expected_version_no: 1,
        artifact_attestation_id: attestation.id,
      },
    });

    const response = await conformancePOST(request, {
      params: Promise.resolve({ revision_id: revisionId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("POST /conformance 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: `/runtime-revisions/${revisionId}/conformance`,
      body: {
        conformance_results: passingConformanceResults().map((r) => ({
          case_id: r.caseId,
          passed: r.passed,
        })),
      },
    });

    const response = await conformancePOST(request, {
      params: Promise.resolve({ revision_id: revisionId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("POST /conformance 非法 case_id → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: `/runtime-revisions/${revisionId}/conformance`,
      idempotencyKey: "idem-conf-bad-case-001",
      body: {
        conformance_results: [
          { case_id: "unknown-case-id", passed: true },
          ...passingConformanceResults().map((r) => ({
            case_id: r.caseId,
            passed: r.passed,
          })),
        ],
      },
    });

    const response = await conformancePOST(request, {
      params: Promise.resolve({ revision_id: revisionId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("GET /conformance 跨租户隔离 → 404 RESOURCE_NOT_FOUND", async () => {
    const request = buildApiRequest({
      audience: "admin",
      method: "GET",
      path: "/runtime-revisions/nonexistent-revision-id/conformance",
    });

    const response = await conformanceGET(request, {
      params: Promise.resolve({ revision_id: "nonexistent-revision-id" }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });
});
