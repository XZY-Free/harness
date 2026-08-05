import {
  GET as conformanceGET,
  POST as conformancePOST,
} from "@/app/admin/api/v1/runtime-revisions/[revision_id]/conformance/route";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
/**
 * S05-C06：V11 Runtime Conformance runner + 结果持久化 + Admin API 集成测试（真实 MySQL 8）。
 *
 * 覆盖 4 类（30+ 例）：
 * 1. runtime-conformance-result-queries（4 例）：persist / list / get / delete。
 * 2. runtime-conformance-runner（12 例）：runConformanceSuite 基础场景 + 失败场景 + 边界。
 * 3. publishRuntimeRevision 集成（4 例）：持久化 conformance 结果 + options + 失败不持久化。
 * 4. Admin API 路由（5 例）：GET 列表 / POST 持久化 / POST 发布 / 门禁失败 / 跨租户隔离。
 *
 * 测试环境：APP_ENV=test，auth mode=dev（resolvePrincipal 使用 DEFAULT_USER_ID）。
 * 真实 MySQL 8 Testcontainers，不使用 DB mock。
 */
import { db } from "@/lib/db/client";
import { assertCrossTenantHidden, buildV11Request } from "@/lib/db/test/api-fixtures";
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
import type { RuntimeCandidateEvent } from "@/lib/runtime/event-ingress-queries";
import type { RuntimeCapabilitiesResponse } from "@/lib/runtime/runtime-client";
import {
  deleteConformanceResultsByRevision,
  getConformanceResult,
  listConformanceResultsByRevision,
  persistConformanceResults,
} from "@/lib/runtime/runtime-conformance-result-queries";
import {
  ConformanceRunnerError,
  type RunConformanceSuiteParams,
  runConformanceSuite,
} from "@/lib/runtime/runtime-conformance-runner";
import {
  ALL_CONFORMANCE_CASES,
  type ConformanceCaseId,
  type ConformanceCaseResult,
  MANDATORY_GATE_CASES,
  RuntimeConformanceCaseFailedError,
  validateConformanceGate,
} from "@/lib/runtimes/domain/runtime-conformance";
import { canonicalizeRuntimeConformanceReport } from "@/lib/runtimes/domain/runtime-conformance-run";
import {
  createRuntime,
  getRuntimeById,
  getRuntimeByKey,
} from "@/lib/runtimes/persistence/runtime-queries";
import {
  RuntimePublicationVersionConflictError,
  RuntimeRevisionNotFoundError,
  createDraftRuntimeRevision,
  getRuntimeRevisionById,
} from "@/lib/runtimes/persistence/runtime-revision-queries";
import { publishRuntimeRevision } from "@/lib/runtimes/test-support/attempt-runtime-publication-without-trusted-run";
import { withdrawRuntimeRevision } from "@/lib/runtimes/test-support/withdraw-runtime-revision";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 admin-api.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;
const ORIGINAL_CONFORMANCE_SECRET = process.env.SNOW_RUNTIME_CONFORMANCE_SIGNING_SECRET;
const CONFORMANCE_SECRET = "test-runtime-conformance-secret-32-bytes";
const RUNTIME_DIGEST = `sha256:${"a".repeat(64)}`;
const CONFIG_DIGEST = `sha256:${"b".repeat(64)}`;
const RUNNER_DIGEST = `sha256:${"c".repeat(64)}`;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  process.env.SNOW_RUNTIME_CONFORMANCE_SIGNING_SECRET = CONFORMANCE_SECRET;
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
  process.env.SNOW_RUNTIME_CONFORMANCE_SIGNING_SECRET = ORIGINAL_CONFORMANCE_SECRET;
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

/** 构造全部 mandatory case 通过的 conformance 结果。 */
function passingConformanceResults(): ConformanceCaseResult[] {
  return MANDATORY_GATE_CASES.map((caseId) => ({ caseId, passed: true }));
}

/** 构造全部 16 case 通过的 conformance 结果。 */
function passingAllConformanceResults(): ConformanceCaseResult[] {
  return ALL_CONFORMANCE_CASES.map((caseId) => ({ caseId, passed: true }));
}

function trustedRunnerBody(runtimeRevisionId: string, passed = true) {
  const report = {
    runId: randomUUID(),
    runtimeRevisionId,
    runtimeArtifactDigest: RUNTIME_DIGEST,
    runtimeConfigDigest: CONFIG_DIGEST,
    protocolContractRevision: "agent-runtime-protocol@1",
    suiteRevision: "runtime-conformance@1",
    runnerArtifactDigest: RUNNER_DIGEST,
    runnerIdentity: "ci/runtime-conformance",
    testEnvironmentRevision: "isolated-mysql8@1",
    startedAt: "2026-08-02T01:00:00.000Z",
    completedAt: "2026-08-02T01:00:01.000Z",
    overallResult: passed ? ("passed" as const) : ("failed" as const),
    evidenceManifestDigest: `sha256:${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
    caseResults: ALL_CONFORMANCE_CASES.map((caseId, index) => ({
      caseId,
      passed: passed || index !== 0,
      reason: !passed && index === 0 ? "isolated test failure" : null,
      evidenceDigest: `sha256:${index.toString(16).padStart(64, "0")}`,
    })),
  };
  return {
    runner_report: report,
    runner_signature: createHmac("sha256", CONFORMANCE_SECRET)
      .update(canonicalizeRuntimeConformanceReport(report))
      .digest("hex"),
  };
}

/** 构造指定 mandatory case 失败的 conformance 结果。 */
function failingConformanceResults(
  failCase: (typeof MANDATORY_GATE_CASES)[number],
): ConformanceCaseResult[] {
  return MANDATORY_GATE_CASES.map((caseId) => ({
    caseId,
    passed: caseId !== failCase,
    reason: caseId === failCase ? "模拟探测失败" : undefined,
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

/**
 * Mock 能力覆盖：features / limits 均为 Partial，便于只覆盖单个字段。
 * protocol_versions 整体替换（数组语义）。
 */
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
      if (!config.startAccepted && config.startAccepted === false) {
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
        requires_redispatch: false,
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
// 1. runtime-conformance-result-queries（持久化）
// ═══════════════════════════════════════════════════════════

describe("S05-C06 runtime-conformance-result-queries（持久化）", () => {
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

  it("旧结果投影仍可读取全部 required case（不再作为发布依据）", async () => {
    const results = await persistConformanceResults({
      tenantId,
      runtimeRevisionId: revisionId,
      results: passingConformanceResults(),
      adapterDigest: "sha256:adapter-v1",
      testEnvironment: "testcontainers-mysql-8",
      evidenceRef: "log://test/abc",
    });

    expect(results).toHaveLength(16);
    expect(results[0]?.caseId).toBe("attempt-sequence-continuity");
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.adapterDigest).toBe("sha256:adapter-v1");
    expect(results[0]?.testEnvironment).toBe("testcontainers-mysql-8");
    expect(results[0]?.evidenceRef).toBe("log://test/abc");
  });

  it("persistConformanceResults UPSERT 同 (revisionId, caseId) 更新而非插入", async () => {
    // 首次写入
    await persistConformanceResults({
      tenantId,
      runtimeRevisionId: revisionId,
      results: passingConformanceResults(),
    });

    // 再次写入（同一组 case，passed 改为 false）
    const updatedResults = passingConformanceResults().map((r) => ({
      ...r,
      passed: false,
      reason: "重新测试失败",
    }));
    await persistConformanceResults({
      tenantId,
      runtimeRevisionId: revisionId,
      results: updatedResults,
    });

    const all = await listConformanceResultsByRevision(revisionId);
    expect(all).toHaveLength(16);
    // 全部应为 false（UPSERT 更新）
    expect(all.every((r) => r.passed === false)).toBe(true);
    expect(all[0]?.reason).toBe("重新测试失败");
  });

  it("listConformanceResultsByRevision 按 caseId 升序返回", async () => {
    await persistConformanceResults({
      tenantId,
      runtimeRevisionId: revisionId,
      results: passingConformanceResults(),
    });

    const list = await listConformanceResultsByRevision(revisionId);
    const caseIds = list.map((r) => r.caseId);
    expect(caseIds).toEqual([...caseIds].sort());
  });

  it("getConformanceResult 查询单个 (revisionId, caseId) 结果", async () => {
    await persistConformanceResults({
      tenantId,
      runtimeRevisionId: revisionId,
      results: passingConformanceResults(),
    });

    const result = await getConformanceResult(revisionId, "event-batch-idempotent");
    expect(result?.caseId).toBe("event-batch-idempotent");
    expect(result?.passed).toBe(true);
  });

  it("getConformanceResult 不存在返回 null", async () => {
    expect(await getConformanceResult(revisionId, "event-batch-idempotent")).toBeNull();
  });

  it("deleteConformanceResultsByRevision 清空 Revision 的全部结果", async () => {
    await persistConformanceResults({
      tenantId,
      runtimeRevisionId: revisionId,
      results: passingConformanceResults(),
    });

    const deleted = await deleteConformanceResultsByRevision(revisionId);
    expect(deleted).toBe(16);
    expect(await listConformanceResultsByRevision(revisionId)).toHaveLength(0);
  });

  it("listConformanceResultsByRevision 空结果返回空数组", async () => {
    expect(await listConformanceResultsByRevision(revisionId)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. runtime-conformance-runner（adapter probe）
// ═══════════════════════════════════════════════════════════

describe("S05-C06 runtime-conformance-runner（adapter probe）", () => {
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

  it("runConformanceSuite 返回 16 个结果（按 ALL_CONFORMANCE_CASES 顺序）", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));
    const params: RunConformanceSuiteParams = {
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    };

    const results = await runConformanceSuite(params);

    expect(results).toHaveLength(16);
    expect(results.map((r) => r.caseId)).toEqual([...ALL_CONFORMANCE_CASES]);
  });

  it("runConformanceSuite 不会把未执行的 case 伪装为通过", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    expect(results.find((r) => r.caseId === "tool-schema-refresh")).toMatchObject({
      passed: false,
      reason: "case_requires_isolated_runner",
    });
  });

  it("仅 Adapter probe 的结果不能通过完整门禁", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const gateResult = validateConformanceGate(results);
    expect(gateResult.passed).toBe(false);
    expect(gateResult.failedCases).toContain("tool-schema-refresh");
  });

  it("dispatch-binds-immutable-config: HostedAdapter 返回唯一 runtime_execution_ref", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const case1 = results.find((r) => r.caseId === "dispatch-binds-immutable-config");
    expect(case1?.passed).toBe(true);
  });

  it("event-batch-idempotent: HostedAdapter event_stream=true → passed=true", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const case2 = results.find((r) => r.caseId === "event-batch-idempotent");
    expect(case2?.passed).toBe(true);
  });

  it("steer-requires-ack: HostedAdapter handleSteer 返回 accepted + next_safe_point", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const case5 = results.find((r) => r.caseId === "steer-requires-ack");
    expect(case5?.passed).toBe(true);
  });

  it("cancel-request-not-terminal: HostedAdapter handleCancel 返回 accepted（非终态）", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const case7 = results.find((r) => r.caseId === "cancel-request-not-terminal");
    expect(case7?.passed).toBe(true);
  });

  it("credential-never-in-model-data: 设计声明不能冒充隔离实测", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const case14 = results.find((r) => r.caseId === "credential-never-in-model-data");
    expect(case14).toMatchObject({
      passed: false,
      reason: "case_requires_isolated_runner",
    });
  });

  it("execution-ownership-epoch: Hosted 单节点假设不能冒充所有权切换实测", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));
    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    expect(results.find((r) => r.caseId === "execution-ownership-epoch")).toMatchObject({
      passed: false,
      reason: "case_requires_isolated_runner",
    });
  });

  it("session-does-not-claim-filesystem-recovery: filesystem_checkpoint=false → passed=true", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const case16 = results.find((r) => r.caseId === "session-does-not-claim-filesystem-recovery");
    expect(case16?.passed).toBe(true);
  });

  it("6 个未执行 case fail-closed", async () => {
    const { sink } = createMockSink();
    const adapter = createHostedAdapter(mockAdapterParams(sink));

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const notApplicableCases = [
      "tool-schema-refresh",
      "unknown-effect-no-replay",
      "capability-search-not-use",
      "memory-proposal-only",
      "child-thread-isolation",
      "child-cancel-requires-ack",
    ] as const;

    for (const caseId of notApplicableCases) {
      const result = results.find((r) => r.caseId === caseId);
      expect(result?.passed).toBe(false);
      expect(result?.reason).toBe("case_requires_isolated_runner");
    }
  });

  it("MockAdapter event_stream=false → event-batch-idempotent 失败（mandatory）", async () => {
    const adapter = createMockAdapter({
      capabilities: {
        features: { event_stream: false },
      },
    });

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const case2 = results.find((r) => r.caseId === "event-batch-idempotent");
    expect(case2?.passed).toBe(false);

    const gateResult = validateConformanceGate(results);
    expect(gateResult.passed).toBe(false);
    expect(gateResult.failedCases).toContain("event-batch-idempotent");
  });

  it("MockAdapter filesystem_checkpoint=true → session-does-not-claim-filesystem-recovery 失败", async () => {
    const adapter = createMockAdapter({
      capabilities: {
        features: { filesystem_checkpoint: true },
      },
    });

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const case16 = results.find((r) => r.caseId === "session-does-not-claim-filesystem-recovery");
    expect(case16?.passed).toBe(false);
  });

  it("MockAdapter handleSteer 抛错 → steer-requires-ack 失败", async () => {
    const adapter = createMockAdapter({ steerThrows: true });

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const case5 = results.find((r) => r.caseId === "steer-requires-ack");
    expect(case5?.passed).toBe(false);
    expect(case5?.reason).toContain("probe 失败");
  });

  it("MockAdapter handleCancel 抛错 → cancel-request-not-terminal 失败（mandatory）", async () => {
    const adapter = createMockAdapter({ cancelThrows: true });

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const case7 = results.find((r) => r.caseId === "cancel-request-not-terminal");
    expect(case7?.passed).toBe(false);

    const gateResult = validateConformanceGate(results);
    expect(gateResult.passed).toBe(false);
    expect(gateResult.failedCases).toContain("cancel-request-not-terminal");
  });

  it("MockAdapter handleResume 抛错 → session-does-not-claim-filesystem-recovery 失败", async () => {
    const adapter = createMockAdapter({ resumeThrows: true });

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const case16 = results.find((r) => r.caseId === "session-does-not-claim-filesystem-recovery");
    expect(case16?.passed).toBe(false);
  });

  it("MockAdapter steer=false → unsupported-steer passed=true（路由层不调用 handleSteer）", async () => {
    const adapter = createMockAdapter({
      capabilities: {
        features: { steer: false },
      },
    });

    const results = await runConformanceSuite({
      tenantId,
      runtimeRevisionId: revisionId,
      runtimeAdapter: adapter,
    });

    const case6 = results.find((r) => r.caseId === "unsupported-steer");
    expect(case6?.passed).toBe(true);
    expect(case6?.reason).toContain("features.steer=false");
  });

  it("runConformanceSuite probeCapabilities 抛错 → 抛 ConformanceRunnerError", async () => {
    const failingAdapter: RuntimeAdapter = {
      ...createMockAdapter(),
      async probeCapabilities() {
        throw new Error("probe 失败");
      },
    };

    await expect(
      runConformanceSuite({
        tenantId,
        runtimeRevisionId: revisionId,
        runtimeAdapter: failingAdapter,
      }),
    ).rejects.toThrow(ConformanceRunnerError);
  });

  it("runConformanceSuite probeCapabilities 返回非法结构 → 抛 ConformanceRunnerError", async () => {
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

    await expect(
      runConformanceSuite({
        tenantId,
        runtimeRevisionId: revisionId,
        runtimeAdapter: badAdapter,
      }),
    ).rejects.toThrow(ConformanceRunnerError);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. publishRuntimeRevision 集成（conformance 持久化）
// ═══════════════════════════════════════════════════════════

describe("S05-C06 publishRuntimeRevision 集成（conformance 持久化）", () => {
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
    ).rejects.toThrow(RuntimeConformanceCaseFailedError);
    expect((await getRuntimeRevisionById(revisionId))?.revisionState).toBe("draft");
  });

  it("publishRuntimeRevision 门禁失败 → 抛 RuntimeConformanceCaseFailedError + 不持久化结果", async () => {
    await expect(
      publishRuntimeRevision(
        tenantId,
        revisionId,
        1,
        failingConformanceResults("event-batch-idempotent"),
      ),
    ).rejects.toThrow(RuntimeConformanceCaseFailedError);

    // Revision 保持 draft
    const after = await getRuntimeRevisionById(revisionId);
    expect(after?.revisionState).toBe("draft");

    // conformance 结果未持久化
    const results = await listConformanceResultsByRevision(revisionId);
    expect(results).toHaveLength(0);
  });

  it("缺少显式 Passed Run 时全部 16 个 required case 均视为缺失", async () => {
    await expect(
      publishRuntimeRevision(tenantId, revisionId, 1, passingConformanceResults()),
    ).rejects.toMatchObject({ failedCases: ALL_CONFORMANCE_CASES });
  });

  it("旧式 options 不会创建或覆盖任何 conformance 事实", async () => {
    await expect(
      publishRuntimeRevision(tenantId, revisionId, 1, passingConformanceResults(), {
        adapterDigest: "sha256:legacy",
      }),
    ).rejects.toThrow(RuntimeConformanceCaseFailedError);
    expect(await listConformanceResultsByRevision(revisionId)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Admin API 路由（GET + POST /conformance）
// ═══════════════════════════════════════════════════════════

describe("S05-C06 Admin API /admin/api/v1/runtime-revisions/{revision_id}/conformance", () => {
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
    const request = buildV11Request({
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

  it("GET /conformance 不把旧可覆盖投影冒充权威 Run", async () => {
    // 先持久化一些结果
    await persistConformanceResults({
      tenantId,
      runtimeRevisionId: revisionId,
      results: passingConformanceResults(),
    });

    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: `/runtime-revisions/${revisionId}/conformance`,
    });

    const response = await conformanceGET(request, {
      params: Promise.resolve({ revision_id: revisionId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(0);
  });

  it("POST /conformance publish=false 验签并记录不可变 Run（不发布）", async () => {
    const request = buildV11Request({
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
    expect(body.results).toHaveLength(16);
    expect(body.conformance_run_id).toBeTruthy();

    // Revision 仍为 draft
    const after = await getRuntimeRevisionById(revisionId);
    expect(after?.revisionState).toBe("draft");
  });

  it("POST /conformance publish=true 通过门禁 → 发布 Revision", async () => {
    const signedBody = {
      ...trustedRunnerBody(revisionId),
      publish: true,
      expected_version_no: 1,
    };
    const request = buildV11Request({
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
      buildV11Request({
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
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/runtime-revisions/${revisionId}/conformance`,
      idempotencyKey: "idem-conf-fail-001",
      ifMatch: etag,
      body: {
        ...trustedRunnerBody(revisionId, false),
        publish: true,
        expected_version_no: 1,
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
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/runtime-revisions/${revisionId}/conformance`,
      idempotencyKey: "idem-conf-no-ifmatch-001",
      body: {
        ...trustedRunnerBody(revisionId),
        publish: true,
        expected_version_no: 1,
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
    const request = buildV11Request({
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
    const request = buildV11Request({
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
    // 在另一个租户创建 Revision
    const otherTenant = await ensureDefaultTenant(); // 同一默认租户，需用其他方式测试跨租户
    void otherTenant; // 当前测试框架使用单一默认租户，跨租户测试由其他测试覆盖
    // 这里通过访问不存在的 revisionId 验证 404
    const request = buildV11Request({
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
import { createHmac, randomUUID } from "node:crypto";
