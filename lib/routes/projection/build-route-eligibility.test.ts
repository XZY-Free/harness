/**
 * RouteEligibilityProjection 构建器 target-specific 收口测试（专题01，tests 阶段）。
 *
 * 冻结架构（01 §4.D）：
 * - 单一 RouteEligibilityProjection 必须显式携带 targetKind + targetIdentity。
 * - Agent target 与 Runtime target 证据组互斥：Agent projection 的 Runtime 字段全 NULL，
 *   Runtime projection 的 Agent 字段全 NULL；禁止 "not_applicable"/"hosted_artifact" placeholder。
 * - build-route-eligibility 只以 latest RouteActivation → RouteRevision 为 Authority；
 *   不得读 mutable activeRouteRevisionId。
 * - Builder 先按 RouteRevision target 判别，只读所选 target 的 authority/evidence；
 *   agent Route 不得为 Agent 构造 runtimeRevisionId 或读取 Runtime。
 *
 * 本文件用窄型 mock 验证 builder 的 query calls / reader input / 写入值（A–F），
 * 真实 MySQL schema 约束（G）由 route-eligibility-projection-target-schema.test.ts 覆盖。
 * 不允许用 mock DB 声称 schema 成立。
 */

import type { RevisionExecutionEvidenceReader } from "@/lib/control-plane/application/revision-execution-evidence-reader";
import type {
  AgentTargetEvidenceSnapshot,
  RevisionExecutionEvidenceSnapshot,
  RuntimeTargetEvidenceSnapshot,
} from "@/lib/control-plane/domain/revision-execution-eligibility";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/routes";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { computeSpecificity, normalizeEligibility } from "@/lib/routes/domain/route-selector";
import {
  computeNextVersion,
  computeProjectionContentDigest,
  createBuildRouteEligibility,
} from "@/lib/routes/projection/build-route-eligibility";
import type { RouteEligibilityStore } from "@/lib/routes/projection/route-eligibility-store";
import { PUBLICATION_CONFORMANCE_CASES } from "@/lib/runtime/domain/runtime-conformance-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── 窄型 Drizzle query mock ──────────────────────────────
// 仅 mock db.select() 的查询构建（query calls 序列 + 返回行）。
// 不 mock reader 的真实 input 判别（mock 只注入 evidence snapshot 值）。

const builderMocks = vi.hoisted(() => {
  const queryResults: unknown[][] = [];
  /** 每次 db.select() 实际调用 .from() 的表对象（用于断言不查询对侧 target）。 */
  const fromCalls: unknown[] = [];
  const select = vi.fn(() => {
    const result = queryResults.shift() ?? [];
    const query = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      // biome-ignore lint/suspicious/noThenProperty: 模拟 Drizzle QueryPromise 的 awaitable query。
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
    };
    query.from.mockImplementation((table: unknown) => {
      fromCalls.push(table);
      return query;
    });
    query.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.orderBy.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    return query;
  });
  return {
    queryResults,
    fromCalls,
    select,
    loadCurrentEvidence: vi.fn<RevisionExecutionEvidenceReader["loadCurrentEvidence"]>(),
  };
});

vi.mock("@/lib/db/client", () => ({
  db: { select: builderMocks.select },
}));

vi.mock("@/lib/control-plane/persistence/mysql-revision-execution-evidence-reader", () => ({
  createMySqlRevisionExecutionEvidenceReader: () => ({
    loadCurrentEvidence: builderMocks.loadCurrentEvidence,
  }),
}));

function createStoreMock(): RouteEligibilityStore {
  return {
    upsertProjection: vi.fn(async (input) => input as never),
    getProjectionByRoute: vi.fn(async () => null),
    listEligibleProjections: vi.fn(async () => []),
    markIneligible: vi.fn(async () => undefined),
    markPendingRebuild: vi.fn(async () => undefined),
    deleteProjection: vi.fn(async () => undefined),
    deleteProjectionsByRouteSet: vi.fn(async () => undefined),
    listAllProjectionRouteIds: vi.fn(async () => []),
    listProjectionRouteIdsByRouteSet: vi.fn(async () => []),
  };
}

// ─── 共享 Authority fixture（Route/RouteSet/Activation）────────────────

const NOW = new Date("2026-08-29T00:00:00.000Z");

const routeRow = {
  id: "route-1",
  routeSetId: "route-set-1",
  // 漂移的 activeRouteRevisionId 必须被忽略（Authority = latest activation）。
  activeRouteRevisionId: "drifted-revision",
  routeState: "enabled",
};

const activationRow = {
  id: "activation-2",
  routeId: "route-1",
  routeRevisionId: "revision-2",
  routeSetId: "route-set-1",
  routeSetVersionNo: 2,
  activationSequence: 2,
  activationState: "active",
};

const agentRouteSetRow = {
  id: "route-set-1",
  tenantId: "tenant-1",
  targetKind: "agent",
  agentId: "agent-1",
  routeScopeKey: "prod",
};

const runtimeRouteSetRow = {
  id: "route-set-1",
  tenantId: "tenant-1",
  targetKind: "runtime",
  agentId: null,
  routeScopeKey: "prod",
};

// ─── target-specific RouteRevision（互斥：agent 无 runtimeRevisionId，runtime 无 agent 事实）─

function agentRevisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "revision-2",
    tenantId: "tenant-1",
    routeId: "route-1",
    routeSetId: "route-set-1",
    agentRevisionId: "agent-revision-1",
    runtimeRevisionId: null,
    agentEndpointRef: "https://agent.example.com/a2a",
    agentIdentityMode: "bearer",
    agentCredentialRefId: "cred-1",
    agentNetworkZone: "private",
    policyRevisionId: null,
    revisionNo: 2,
    routeGroupId: "primary",
    trafficAllocationJson: null,
    selectorDigest: "sha256:selector",
    eligibilityConditionsJson: {},
    priorityNo: 10,
    trafficWeight: 100,
    effectiveFrom: null,
    effectiveUntil: null,
    contentDigest: "sha256:route-content",
    ...overrides,
  };
}

function runtimeRevisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "revision-2",
    tenantId: "tenant-1",
    routeId: "route-1",
    routeSetId: "route-set-1",
    agentRevisionId: null,
    runtimeRevisionId: "runtime-revision-1",
    agentEndpointRef: null,
    agentIdentityMode: null,
    agentCredentialRefId: null,
    agentNetworkZone: null,
    policyRevisionId: null,
    revisionNo: 2,
    routeGroupId: "primary",
    trafficAllocationJson: null,
    selectorDigest: "sha256:selector",
    eligibilityConditionsJson: {},
    priorityNo: 10,
    trafficWeight: 100,
    effectiveFrom: null,
    effectiveUntil: null,
    contentDigest: "sha256:route-content",
    ...overrides,
  };
}

const agentEntityRow = { id: "agent-1", lifecycleState: "enabled", deletedAt: null };
const agentRevisionEntityRow = {
  id: "agent-revision-1",
  agentId: "agent-1",
  revisionState: "published",
  artifactDigest: "sha256:agent",
};
const runtimeRevisionEntityRow = {
  id: "runtime-revision-1",
  runtimeId: "runtime-1",
  revisionState: "published",
  artifactDigest: "sha256:runtime",
  configHash: "sha256:config",
  runtimeTargetDigest: "sha256:target",
  protocolContractRevision: "agent-runtime-protocol@1",
  runtimeCapabilitiesJson: {},
  runtimeEvidenceKind: "hosted_artifact",
};
const runtimeEntityRow = { id: "runtime-1", lifecycleState: "enabled", deletedAt: null };

// ─── target-specific Evidence snapshot（领域类型，禁止 as any）──────────

function agentEvidence(
  overrides: Partial<AgentTargetEvidenceSnapshot> = {},
): AgentTargetEvidenceSnapshot {
  return {
    kind: "agent",
    tenantId: "tenant-1",
    agentRevisionId: "agent-revision-1",
    agentPublication: {
      publicationRecordId: "agent-pub-1",
      subjectType: "agent_revision",
      subjectRevisionId: "agent-revision-1",
      evidenceSetDigest: "sha256:ev",
      attestationIds: [],
      conformanceRunId: null,
      withdrawalRecordId: null,
      publishedAt: NOW,
      agentContractSnapshotId: "contract-1",
      agentContractDigest: "sha256:contract",
      agentCapabilityDigest: "sha256:cap",
      agentContextDigest: "sha256:ctx",
    },
    agentLifecycleState: "active",
    agentRevisionState: "published",
    policyRequirement: { kind: "none" },
    ...overrides,
  };
}

function runtimeEvidence(
  overrides: Partial<RuntimeTargetEvidenceSnapshot> = {},
): RuntimeTargetEvidenceSnapshot {
  return {
    kind: "runtime",
    tenantId: "tenant-1",
    runtimeRevisionId: "runtime-revision-1",
    runtimeArtifactEvidence: {
      tenantId: "tenant-1",
      artifactType: "runtime_revision",
      artifactRevisionId: "runtime-revision-1",
      artifactId: "rt-artifact-1",
      artifactDigest: "sha256:runtime",
      attestationId: "att-1",
      verificationState: "verified",
      attestationFormat: "in_toto_dsse",
      verifiedAt: NOW,
      revokedAt: null,
      revocationRecordId: null,
      verificationPolicyRevisionId: null,
      envelopeDigest: "sha256:env",
    },
    runtimePublication: {
      publicationRecordId: "rt-pub-1",
      subjectType: "runtime_revision",
      subjectRevisionId: "runtime-revision-1",
      evidenceSetDigest: "sha256:ev",
      attestationIds: ["att-1"],
      conformanceRunId: "conformance-1",
      withdrawalRecordId: null,
      publishedAt: NOW,
      agentContractSnapshotId: null,
      agentContractDigest: null,
      agentCapabilityDigest: null,
      agentContextDigest: null,
    },
    runtimeConformance: {
      run: {
        runId: "conformance-1",
        tenantId: "tenant-1",
        runtimeRevisionId: "runtime-revision-1",
        overallResult: "passed",
        runtimeTargetDigest: "sha256:target",
        runtimeConfigDigest: "sha256:config",
        protocolContractRevision: "agent-runtime-protocol@1",
        suiteRevision: "runtime-conformance@1",
        conformanceFormat: "standard_dsse",
      },
      caseResults: PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({ caseId, passed: true })),
      expected: {
        tenantId: "tenant-1",
        runtimeRevisionId: "runtime-revision-1",
        runtimeTargetDigest: "sha256:target",
        runtimeConfigDigest: "sha256:config",
        protocolContractRevision: "agent-runtime-protocol@1",
        allowedFormats: ["standard_dsse"],
      },
    },
    runtimeLifecycleState: "active",
    runtimeRevisionState: "published",
    runtimeEvidenceKind: "hosted_artifact",
    policyRequirement: { kind: "none" },
    ...overrides,
  };
}

// ─── 测试工具 ──────────────────────────────────────────────

const RUNTIME_GROUP_FIELDS = [
  "runtimeRevisionId",
  "runtimeRevisionState",
  "runtimeLifecycleState",
  "runtimePublicationActive",
  "runtimeEvidenceValid",
  "runtimeConformanceValid",
  "runtimeEvidenceKind",
  "runtimeArtifactDigest",
  "runtimeConfigDigest",
  "runtimeTargetDigest",
  "runtimePublicationRecordId",
  "runtimeAttestationIds",
  "conformanceRunId",
  "runtimeArtifactId",
] as const;

const AGENT_GROUP_FIELDS = [
  "agentRevisionId",
  "agentEndpointRef",
  "agentIdentityMode",
  "agentCredentialRefId",
  "agentNetworkZone",
  "agentRevisionState",
  "agentLifecycleState",
  "agentPublicationActive",
  "agentEvidenceValid",
  "agentPublicationRecordId",
  "agentContractSnapshotId",
  "agentContractDigest",
  "agentContextDigest",
] as const;

beforeEach(() => {
  builderMocks.queryResults.length = 0;
  builderMocks.fromCalls.length = 0;
  builderMocks.select.mockClear();
  builderMocks.loadCurrentEvidence.mockReset();
});

/** 断言给定 projection input 的 Runtime 证据组全为 NULL（冻结架构互斥）。 */
function expectRuntimeGroupNull(input: Record<string, unknown>): void {
  for (const field of RUNTIME_GROUP_FIELDS) {
    expect(input[field]).toBeNull();
  }
}

/** 断言给定 projection input 的 Agent 证据组全为 NULL（冻结架构互斥）。 */
function expectAgentGroupNull(input: Record<string, unknown>): void {
  for (const field of AGENT_GROUP_FIELDS) {
    expect(input[field]).toBeNull();
  }
}

/** 从 upsertProjection mock 调用参数中取出第一个 projection input。 */
function lastProjectionInput(store: RouteEligibilityStore): Record<string, unknown> {
  const mock = store.upsertProjection as ReturnType<typeof vi.fn>;
  const call = mock.mock.calls[0];
  if (!call) throw new Error("upsertProjection 未被调用");
  return call[0] as Record<string, unknown>;
}

/**
 * Agent target 构建所需 query 序列：
 * 1 deploymentRoute(+innerJoin routeSet) → 2 routeActivation → 3 routeRevision
 * → 4 routeSet → 5 agentTable → 6 agentRevisionTable。
 * 不包含 Runtime revision/entity 查询。
 */
function seedAgentQueries(
  overrides: {
    revision?: Record<string, unknown>;
    agent?: Record<string, unknown>;
    agentRevision?: Record<string, unknown>;
  } = {},
) {
  builderMocks.queryResults.push(
    [routeRow],
    [activationRow],
    [agentRevisionRow(overrides.revision)],
    [agentRouteSetRow],
    [overrides.agent ?? agentEntityRow],
    [overrides.agentRevision ?? agentRevisionEntityRow],
  );
}

/**
 * Runtime target 构建所需 query 序列：
 * 1 deploymentRoute → 2 routeActivation → 3 routeRevision → 4 routeSet
 * → 5 runtimeRevisionTable → 6 runtimeTable。
 * 不包含 Agent authority 查询。
 */
function seedRuntimeQueries(
  overrides: {
    revision?: Record<string, unknown>;
    runtimeRevision?: Record<string, unknown>;
    runtime?: Record<string, unknown>;
  } = {},
) {
  builderMocks.queryResults.push(
    [routeRow],
    [activationRow],
    [runtimeRevisionRow(overrides.revision)],
    [runtimeRouteSetRow],
    [overrides.runtimeRevision ?? runtimeRevisionEntityRow],
    [overrides.runtime ?? runtimeEntityRow],
  );
}

// ─── A. Agent target：只读 Agent authority/evidence，Runtime 组全 NULL ──

describe("Agent target projection（A）", () => {
  it("reader input 是 {kind:'agent',...}，不含 runtimeRevisionId", async () => {
    const store = createStoreMock();
    seedAgentQueries();
    builderMocks.loadCurrentEvidence.mockResolvedValue(agentEvidence());

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(builderMocks.loadCurrentEvidence).toHaveBeenCalledWith({
      kind: "agent",
      tenantId: "tenant-1",
      agentRevisionId: "agent-revision-1",
      policyRevisionId: null,
    });
  });

  it("query 序列包含 agent authority，且不包含任何 Runtime revision/entity 查询", async () => {
    const store = createStoreMock();
    seedAgentQueries();
    builderMocks.loadCurrentEvidence.mockResolvedValue(agentEvidence());

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(builderMocks.fromCalls).toContain(agentTable);
    expect(builderMocks.fromCalls).toContain(agentRevisionTable);
    expect(builderMocks.fromCalls).not.toContain(runtimeRevisionTable);
    expect(builderMocks.fromCalls).not.toContain(runtimeTable);
  });

  it("agent projection 的 Runtime 证据组必须全为 NULL（禁止 placeholder）", async () => {
    const store = createStoreMock();
    seedAgentQueries();
    builderMocks.loadCurrentEvidence.mockResolvedValue(agentEvidence());

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(store.upsertProjection).toHaveBeenCalled();
    const input = lastProjectionInput(store);
    expect(input.targetKind).toBe("agent");
    // 冻结架构：agent projection 不得携带任何 Runtime 字段值（RED——当前为 "missing"/"hosted_artifact"）。
    expectRuntimeGroupNull(input);
  });

  it("projectionVersionNo >= 1（成功写入投影）", async () => {
    const store = createStoreMock();
    seedAgentQueries();
    builderMocks.loadCurrentEvidence.mockResolvedValue(agentEvidence());

    const result = await createBuildRouteEligibility({ store })({
      tenantId: "tenant-1",
      routeId: "route-1",
    });

    expect(result.projectionVersionNo).toBeGreaterThanOrEqual(1);
    const input = lastProjectionInput(store);
    expect(input.projectionVersionNo).toBeGreaterThanOrEqual(1);
  });
});

// ─── B. Runtime target：只读 Runtime authority/evidence，Agent 组全 NULL ──

describe("Runtime target projection（B）", () => {
  it("reader input 是 {kind:'runtime',...}，不含 agentRevisionId", async () => {
    const store = createStoreMock();
    seedRuntimeQueries();
    builderMocks.loadCurrentEvidence.mockResolvedValue(runtimeEvidence());

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(builderMocks.loadCurrentEvidence).toHaveBeenCalledWith({
      kind: "runtime",
      tenantId: "tenant-1",
      runtimeRevisionId: "runtime-revision-1",
      policyRevisionId: null,
    });
  });

  it("query 序列包含 Runtime authority，且不包含任何 Agent authority 查询", async () => {
    const store = createStoreMock();
    seedRuntimeQueries();
    builderMocks.loadCurrentEvidence.mockResolvedValue(runtimeEvidence());

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(builderMocks.fromCalls).toContain(runtimeRevisionTable);
    expect(builderMocks.fromCalls).toContain(runtimeTable);
    expect(builderMocks.fromCalls).not.toContain(agentTable);
    expect(builderMocks.fromCalls).not.toContain(agentRevisionTable);
  });

  it("runtime projection 的 Agent 证据组必须全为 NULL（禁止 placeholder）", async () => {
    const store = createStoreMock();
    seedRuntimeQueries();
    builderMocks.loadCurrentEvidence.mockResolvedValue(runtimeEvidence());

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(store.upsertProjection).toHaveBeenCalled();
    const input = lastProjectionInput(store);
    expect(input.targetKind).toBe("runtime");
    // 冻结架构：runtime projection 不得携带任何 Agent 字段值（RED——当前为 "not_applicable"）。
    expectAgentGroupNull(input);
  });

  it("projectionVersionNo >= 1（成功写入投影）", async () => {
    const store = createStoreMock();
    seedRuntimeQueries();
    builderMocks.loadCurrentEvidence.mockResolvedValue(runtimeEvidence());

    const result = await createBuildRouteEligibility({ store })({
      tenantId: "tenant-1",
      routeId: "route-1",
    });

    expect(result.projectionVersionNo).toBeGreaterThanOrEqual(1);
    const input = lastProjectionInput(store);
    expect(input.projectionVersionNo).toBeGreaterThanOrEqual(1);
  });
});

// ─── C. 权威链断裂 / target 不一致 → fail-closed（不写 placeholder）─────

describe("Fail-closed authority（C）", () => {
  it("latest activation 缺失 → 删除既有投影且不写", async () => {
    const store = createStoreMock();
    builderMocks.queryResults.push([routeRow], []);

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(store.deleteProjection).toHaveBeenCalledWith("route-1");
    expect(store.upsertProjection).not.toHaveBeenCalled();
  });

  it("activation 指向的 revision 缺失 → 删除既有投影且不写", async () => {
    const store = createStoreMock();
    builderMocks.queryResults.push([routeRow], [activationRow], []);

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(store.deleteProjection).toHaveBeenCalledWith("route-1");
    expect(store.upsertProjection).not.toHaveBeenCalled();
  });

  it("authority RouteSet 缺失 → 删除既有投影且不写", async () => {
    const store = createStoreMock();
    builderMocks.queryResults.push([routeRow], [activationRow], [agentRevisionRow()], []);

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(store.deleteProjection).toHaveBeenCalledWith("route-1");
    expect(store.upsertProjection).not.toHaveBeenCalled();
  });

  it("routeGroupId 非法（null/空/纯空白）→ fail-closed 删除投影", async () => {
    const store = createStoreMock();
    builderMocks.queryResults.push(
      [routeRow],
      [activationRow],
      [agentRevisionRow({ routeGroupId: "   " })],
      [agentRouteSetRow],
    );

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(store.deleteProjection).toHaveBeenCalledWith("route-1");
    expect(store.upsertProjection).not.toHaveBeenCalled();
  });

  it("错误 tenantId 不得删除其他租户既有投影", async () => {
    const store = createStoreMock();
    builderMocks.queryResults.push([]);

    await createBuildRouteEligibility({ store })({
      tenantId: "foreign-tenant",
      routeId: "route-1",
    });

    expect(store.deleteProjection).not.toHaveBeenCalled();
    expect(store.upsertProjection).not.toHaveBeenCalled();
  });
});

// ─── D. withdrawn/unqualified publication → ineligible（对侧证据不影响）─

describe("Publication withdrawn/unqualified（D）", () => {
  it("Agent publication 缺失（unqualified）→ agent projection ineligible", async () => {
    const store = createStoreMock();
    seedAgentQueries();
    // 无 agentPublication = 未发布/unqualified。
    builderMocks.loadCurrentEvidence.mockResolvedValue(agentEvidence({ agentPublication: null }));

    const result = await createBuildRouteEligibility({ store })({
      tenantId: "tenant-1",
      routeId: "route-1",
    });

    expect(result.eligibilityState).toBe("ineligible");
    const input = lastProjectionInput(store);
    expect(input.eligibilityState).toBe("ineligible");
    expect(input.agentEvidenceValid).toBe(0);
  });

  it("Agent revision withdrawn（agentRevisionState=withdrawn）→ agent projection ineligible", async () => {
    const store = createStoreMock();
    seedAgentQueries();
    // reader 对已撤回/未发布的 revision 返回 revisionState='withdrawn'。
    builderMocks.loadCurrentEvidence.mockResolvedValue(
      agentEvidence({ agentRevisionState: "withdrawn" }),
    );

    const result = await createBuildRouteEligibility({ store })({
      tenantId: "tenant-1",
      routeId: "route-1",
    });

    expect(result.eligibilityState).toBe("ineligible");
  });

  it("Runtime publication 缺失 → runtime projection ineligible（Agent 侧无关）", async () => {
    const store = createStoreMock();
    seedRuntimeQueries();
    builderMocks.loadCurrentEvidence.mockResolvedValue(
      runtimeEvidence({ runtimePublication: null }),
    );

    const result = await createBuildRouteEligibility({ store })({
      tenantId: "tenant-1",
      routeId: "route-1",
    });

    expect(result.eligibilityState).toBe("ineligible");
    const input = lastProjectionInput(store);
    expect(input.eligibilityState).toBe("ineligible");
  });

  it("Runtime conformance 未通过 → runtime projection ineligible（Agent 侧无关）", async () => {
    const store = createStoreMock();
    seedRuntimeQueries();
    const base = runtimeEvidence();
    builderMocks.loadCurrentEvidence.mockResolvedValue({
      ...base,
      runtimeConformance: {
        ...base.runtimeConformance!,
        run: { ...base.runtimeConformance!.run!, overallResult: "failed" },
      },
    });

    const result = await createBuildRouteEligibility({ store })({
      tenantId: "tenant-1",
      routeId: "route-1",
    });

    expect(result.eligibilityState).toBe("ineligible");
  });
});

// ─── E. policy draft/withdrawn → 两种 target 皆 ineligible ──

describe("Policy fail-closed（E）", () => {
  it.each(["draft", "withdrawn"] as const)(
    "Agent target policyRevisionState=%s → ineligible",
    async (state) => {
      const store = createStoreMock();
      seedAgentQueries();
      builderMocks.loadCurrentEvidence.mockResolvedValue(
        agentEvidence({
          policyRequirement: {
            kind: "referenced",
            policyRevisionId: "policy-1",
            policyRevision: {
              id: "policy-1",
              revisionState: state,
              publishedAt: null,
            },
          },
        }),
      );

      const result = await createBuildRouteEligibility({ store })({
        tenantId: "tenant-1",
        routeId: "route-1",
      });

      expect(result.eligibilityState).toBe("ineligible");
    },
  );

  it.each(["draft", "withdrawn"] as const)(
    "Runtime target policyRevisionState=%s → ineligible",
    async (state) => {
      const store = createStoreMock();
      seedRuntimeQueries();
      builderMocks.loadCurrentEvidence.mockResolvedValue(
        runtimeEvidence({
          policyRequirement: {
            kind: "referenced",
            policyRevisionId: "policy-1",
            policyRevision: {
              id: "policy-1",
              revisionState: state,
              publishedAt: null,
            },
          },
        }),
      );

      const result = await createBuildRouteEligibility({ store })({
        tenantId: "tenant-1",
        routeId: "route-1",
      });

      expect(result.eligibilityState).toBe("ineligible");
    },
  );
});

// ─── F. projection digest / version ───────────────────────

describe("Projection digest & version（F）", () => {
  describe("computeNextVersion", () => {
    it("现有行不存在 → version = 1", () => {
      expect(computeNextVersion(null, "sha256:abc")).toBe(1);
    });

    it("Digest 相同 → 不增加版本", () => {
      const existing = { projectionVersionNo: 3, projectionContentDigest: "sha256:abc" };
      expect(computeNextVersion(existing, "sha256:abc")).toBe(3);
    });

    it("Digest 变化 → 版本 +1", () => {
      const existing = { projectionVersionNo: 3, projectionContentDigest: "sha256:abc" };
      expect(computeNextVersion(existing, "sha256:def")).toBe(4);
    });

    it("任何成功写入的 projectionVersionNo >= 1（递增链）", () => {
      let existing: { projectionVersionNo: number; projectionContentDigest: string } | null = null;
      let version = computeNextVersion(existing, "sha256:v1");
      expect(version).toBeGreaterThanOrEqual(1);
      existing = { projectionVersionNo: version, projectionContentDigest: "sha256:v1" };

      version = computeNextVersion(existing, "sha256:v2");
      expect(version).toBe(2);
      existing = { projectionVersionNo: version, projectionContentDigest: "sha256:v2" };

      version = computeNextVersion(existing, "sha256:v2");
      expect(version).toBe(2); // same digest → no increase
      existing = { projectionVersionNo: version, projectionContentDigest: "sha256:v2" };

      version = computeNextVersion(existing, "sha256:v3");
      expect(version).toBe(3);
    });
  });

  describe("computeProjectionContentDigest", () => {
    it("相同字段产生相同 digest", () => {
      const fields = { routeId: "r1", agentId: "a1", eligibilityState: "eligible" };
      const d1 = computeProjectionContentDigest(fields);
      const d2 = computeProjectionContentDigest(fields);
      expect(d1).toBe(d2);
      expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("不同字段产生不同 digest", () => {
      const d1 = computeProjectionContentDigest({ routeId: "r1", agentId: "a1" });
      const d2 = computeProjectionContentDigest({ routeId: "r2", agentId: "a1" });
      expect(d1).not.toBe(d2);
    });

    it("字段顺序不影响 digest", () => {
      const d1 = computeProjectionContentDigest({ a: 1, b: 2 });
      const d2 = computeProjectionContentDigest({ b: 2, a: 1 });
      expect(d1).toBe(d2);
    });
  });

  it("build 使用 exact version：初始=1（成功写入投影）", async () => {
    const store = createStoreMock();
    seedAgentQueries();
    builderMocks.loadCurrentEvidence.mockResolvedValue(agentEvidence());

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });
    expect(lastProjectionInput(store).projectionVersionNo).toBe(1);
  });
});

// ─── 纯逻辑：specificity ──────────────────────────────────

describe("normalizeEligibility + computeSpecificity", () => {
  it("空条件 → specificity=0", () => {
    const norm = normalizeEligibility({});
    expect(norm).toBeTruthy();
    if (norm) expect(computeSpecificity(norm)).toBe(0);
  });

  it("双条件 → specificity=2", () => {
    const norm = normalizeEligibility({ all: { environment: "prod", region: "cn" } });
    expect(norm).toBeTruthy();
    if (norm) expect(computeSpecificity(norm)).toBe(2);
  });
});

describe("computeCapabilityManifestDigest", () => {
  it("相同输入产生相同 digest", () => {
    const d1 = computeCapabilityManifestDigest({
      runtimeRevisionId: "rt-rev-1",
      runtimeCapabilities: { protocols: ["https"] },
    });
    const d2 = computeCapabilityManifestDigest({
      runtimeRevisionId: "rt-rev-1",
      runtimeCapabilities: { protocols: ["https"] },
    });
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
