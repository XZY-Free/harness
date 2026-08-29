/**
 * Projection 构建器领域逻辑单元测试。
 *
 * 测试 eligibility 判定、specificity 计算等纯逻辑。
 * 不测试数据库交互（留给集成测试）。
 */

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

const builderMocks = vi.hoisted(() => {
  const queryResults: unknown[][] = [];
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
    query.from.mockReturnValue(query);
    query.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.orderBy.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    return query;
  });
  return {
    queryResults,
    select,
    loadCurrentEvidence: vi.fn(),
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

const route = {
  id: "route-1",
  routeSetId: "route-set-1",
  activeRouteRevisionId: null,
  routeState: "enabled",
};
const routeSet = {
  id: "route-set-1",
  tenantId: "tenant-1",
  targetKind: "agent",
  agentId: "agent-1",
  routeScopeKey: "prod",
};
const activation = {
  id: "activation-2",
  routeId: "route-1",
  routeRevisionId: "revision-2",
  routeSetId: "route-set-1",
  routeSetVersionNo: 2,
  activationSequence: 2,
  activationState: "active",
};
const revision = {
  id: "revision-2",
  tenantId: "tenant-1",
  routeId: "route-1",
  routeSetId: "route-set-1",
  agentRevisionId: "agent-revision-1",
  runtimeRevisionId: "runtime-revision-1",
  // 专题01 Batch4 补漏：Agent Route 生产调用事实（agent route 必须冻结）。
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
};

describe("Projection authority", () => {
  beforeEach(() => {
    builderMocks.queryResults.length = 0;
    builderMocks.select.mockClear();
    builderMocks.loadCurrentEvidence.mockReset();
  });

  it("忽略漂移的 activeRouteRevisionId 并按 latest activation 指向的 revision 构建", async () => {
    const store = createStoreMock();
    builderMocks.queryResults.push(
      [{ ...route, activeRouteRevisionId: null }],
      [activation],
      [revision],
      [routeSet],
      [{ id: "agent-1", lifecycleState: "enabled", deletedAt: null }],
      [
        {
          id: "agent-revision-1",
          revisionState: "published",
          artifactDigest: "sha256:agent",
          agentInterfaceRequirementsJson: {},
        },
      ],
      [
        {
          id: "runtime-revision-1",
          runtimeId: "runtime-1",
          revisionState: "published",
          artifactDigest: "sha256:runtime",
          configHash: "sha256:config",
          protocolContractRevision: "agent-runtime-protocol@1",
          runtimeCapabilitiesJson: {},
        },
      ],
      [{ id: "runtime-1", lifecycleState: "enabled", deletedAt: null }],
    );
    builderMocks.loadCurrentEvidence.mockResolvedValue({
      tenantId: "tenant-1",
      agentRevisionId: "agent-revision-1",
      agentArtifactEvidence: {
        artifactId: "agent-artifact-1",
        verificationState: "verified",
        revokedAt: null,
      },
      agentPublication: {
        publicationRecordId: "agent-publication-1",
        attestationIds: ["agent-attestation-1"],
      },
      agentLifecycleState: "active",
      agentRevisionState: "published",
      runtimeRevisionId: "runtime-revision-1",
      runtimeArtifactEvidence: {
        artifactId: "runtime-artifact-1",
        verificationState: "verified",
        revokedAt: null,
      },
      runtimePublication: {
        publicationRecordId: "runtime-publication-1",
        attestationIds: ["runtime-attestation-1"],
        conformanceRunId: "conformance-1",
      },
      runtimeConformance: {
        run: {
          runId: "conformance-1",
          tenantId: "tenant-1",
          runtimeRevisionId: "runtime-revision-1",
          overallResult: "passed",
          runtimeArtifactDigest: "sha256:runtime",
          runtimeConfigDigest: "sha256:config",
          protocolContractRevision: "agent-runtime-protocol@1",
          suiteRevision: "runtime-conformance@1",
          conformanceFormat: "standard_dsse",
        },
        caseResults: PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({ caseId, passed: true })),
        expected: {
          tenantId: "tenant-1",
          runtimeRevisionId: "runtime-revision-1",
          runtimeArtifactDigest: "sha256:runtime",
          runtimeConfigDigest: "sha256:config",
          protocolContractRevision: "agent-runtime-protocol@1",
          allowedFormats: ["standard_dsse"],
        },
      },
      runtimeLifecycleState: "active",
      runtimeRevisionState: "published",
      runtimeCapabilities: [],
      policyRequirement: { kind: "none" },
    });

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(store.upsertProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        routeRevisionId: "revision-2",
        routeActivationId: "activation-2",
      }),
    );
  });

  it("latest activation 缺失时删除既有投影且不写 placeholder", async () => {
    const store = createStoreMock();
    builderMocks.queryResults.push([{ ...route, activeRouteRevisionId: "drifted-revision" }], []);

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(store.deleteProjection).toHaveBeenCalledWith("route-1");
    expect(store.upsertProjection).not.toHaveBeenCalled();
  });

  it("错误 tenantId 不能删除其他租户的既有投影", async () => {
    const store = createStoreMock();
    builderMocks.queryResults.push([]);

    await createBuildRouteEligibility({ store })({
      tenantId: "foreign-tenant",
      routeId: "route-1",
    });

    expect(store.deleteProjection).not.toHaveBeenCalled();
    expect(store.upsertProjection).not.toHaveBeenCalled();
  });

  it("latest activation 指向的 revision 缺失时删除既有投影", async () => {
    const store = createStoreMock();
    builderMocks.queryResults.push([route], [activation], []);

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(store.deleteProjection).toHaveBeenCalledWith("route-1");
    expect(store.upsertProjection).not.toHaveBeenCalled();
  });

  it("authority RouteSet 缺失时删除既有投影", async () => {
    const store = createStoreMock();
    builderMocks.queryResults.push([route], [activation], [revision], []);

    await createBuildRouteEligibility({ store })({ tenantId: "tenant-1", routeId: "route-1" });

    expect(store.deleteProjection).toHaveBeenCalledWith("route-1");
    expect(store.upsertProjection).not.toHaveBeenCalled();
  });
});

describe("Projection 资格判定逻辑", () => {
  describe("normalizeEligibility + computeSpecificity", () => {
    it("空条件 → specificity=0", () => {
      const norm = normalizeEligibility({});
      expect(norm).toBeTruthy();
      if (norm) {
        const spec = computeSpecificity(norm);
        expect(spec).toBe(0);
      }
    });

    it("单条件 → specificity=1", () => {
      const norm = normalizeEligibility({ all: { environment: "prod" } });
      expect(norm).toBeTruthy();
      if (norm) {
        const spec = computeSpecificity(norm);
        expect(spec).toBe(1);
      }
    });

    it("双条件 → specificity=2", () => {
      const norm = normalizeEligibility({ all: { environment: "prod", region: "cn" } });
      expect(norm).toBeTruthy();
      if (norm) {
        const spec = computeSpecificity(norm);
        expect(spec).toBe(2);
      }
    });

    it("null 输入 → 返回空 all", () => {
      const norm = normalizeEligibility(null);
      // normalizeEligibility 对 null 返回默认空条件
      expect(norm).toBeTruthy();
      if (norm) {
        expect(Object.keys(norm.all)).toHaveLength(0);
      }
    });
  });

  describe("computeCapabilityManifestDigest", () => {
    it("相同输入产生相同 digest", () => {
      const input = {
        agentRevisionId: "agent-rev-1",
        agentInterfaceRequirements: { tools: ["read", "write"] },
        runtimeRevisionId: "rt-rev-1",
        runtimeCapabilities: { protocols: ["https"] },
      };
      const d1 = computeCapabilityManifestDigest(input);
      const d2 = computeCapabilityManifestDigest(input);
      expect(d1).toBe(d2);
      expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("不同输入产生不同 digest", () => {
      const d1 = computeCapabilityManifestDigest({
        agentRevisionId: "agent-rev-1",
        agentInterfaceRequirements: { tools: ["read"] },
        runtimeRevisionId: "rt-rev-1",
        runtimeCapabilities: {},
      });
      const d2 = computeCapabilityManifestDigest({
        agentRevisionId: "agent-rev-2",
        agentInterfaceRequirements: { tools: ["read"] },
        runtimeRevisionId: "rt-rev-1",
        runtimeCapabilities: {},
      });
      expect(d1).not.toBe(d2);
    });
  });
});

describe("Projection eligibilityState 逻辑", () => {
  it("所有条件满足 → eligible", () => {
    const conditions = {
      activationState: "active",
      agentLifecycleState: "enabled",
      agentRevisionState: "published",
      agentPublicationActive: 1,
      agentEvidenceValid: 1,
      runtimeLifecycleState: "enabled",
      runtimeRevisionState: "published",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      policyRevisionState: null, // 无 Policy → 不阻塞
    };
    const isEligible = isControlPlaneEligibleFromProjection(conditions);
    expect(isEligible).toBe(true);
  });

  it("Agent 不 enabled → ineligible", () => {
    const conditions = {
      activationState: "active",
      agentLifecycleState: "disabled",
      agentRevisionState: "published",
      agentPublicationActive: 1,
      agentEvidenceValid: 1,
      runtimeLifecycleState: "enabled",
      runtimeRevisionState: "published",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      policyRevisionState: null,
    };
    expect(isControlPlaneEligibleFromProjection(conditions)).toBe(false);
  });

  it("Evidence 无效 → ineligible", () => {
    const conditions = {
      activationState: "active",
      agentLifecycleState: "enabled",
      agentRevisionState: "published",
      agentPublicationActive: 1,
      agentEvidenceValid: 0, // ← 无效
      runtimeLifecycleState: "enabled",
      runtimeRevisionState: "published",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      policyRevisionState: null,
    };
    expect(isControlPlaneEligibleFromProjection(conditions)).toBe(false);
  });

  it("Conformance 未通过 → ineligible", () => {
    const conditions = {
      activationState: "active",
      agentLifecycleState: "enabled",
      agentRevisionState: "published",
      agentPublicationActive: 1,
      agentEvidenceValid: 1,
      runtimeLifecycleState: "enabled",
      runtimeRevisionState: "published",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 0, // ← 未通过
      policyRevisionState: null,
    };
    expect(isControlPlaneEligibleFromProjection(conditions)).toBe(false);
  });

  it("Policy 非 published → ineligible", () => {
    const conditions = {
      activationState: "active",
      agentLifecycleState: "enabled",
      agentRevisionState: "published",
      agentPublicationActive: 1,
      agentEvidenceValid: 1,
      runtimeLifecycleState: "enabled",
      runtimeRevisionState: "published",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      policyRevisionState: "draft", // ← 非 published
    };
    expect(isControlPlaneEligibleFromProjection(conditions)).toBe(false);
  });

  it("Route disabled → ineligible", () => {
    const conditions = {
      activationState: "disabled", // ← 禁用
      agentLifecycleState: "enabled",
      agentRevisionState: "published",
      agentPublicationActive: 1,
      agentEvidenceValid: 1,
      runtimeLifecycleState: "enabled",
      runtimeRevisionState: "published",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      policyRevisionState: null,
    };
    expect(isControlPlaneEligibleFromProjection(conditions)).toBe(false);
  });
});

/** 从 Projection 布尔字段计算 eligibility — 与 build-route-eligibility.ts 逻辑一致。 */

// ─── §05.5: projectionContentDigest 测试 ──────────────────────

describe("§05.5 computeProjectionContentDigest", () => {
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

  it("eligibilityConditionsJson 嵌套条件变化会改变 digest 和版本", () => {
    const d1 = computeProjectionContentDigest({
      routeId: "r1",
      eligibilityConditionsJson: { all: { environment: "prod", region: "cn" } },
    });
    const d2 = computeProjectionContentDigest({
      routeId: "r1",
      eligibilityConditionsJson: { all: { environment: "staging", region: "cn" } },
    });

    expect(d2).not.toBe(d1);
    expect(computeNextVersion({ projectionVersionNo: 4, projectionContentDigest: d1 }, d2)).toBe(5);
  });
});

describe("§05.5 computeNextVersion", () => {
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

  it("连续变化 → 递增", () => {
    let existing: { projectionVersionNo: number; projectionContentDigest: string } | null = null;
    existing = {
      projectionVersionNo: computeNextVersion(existing, "sha256:v1"),
      projectionContentDigest: "sha256:v1",
    };
    expect(existing.projectionVersionNo).toBe(1);
    existing = {
      projectionVersionNo: computeNextVersion(existing, "sha256:v2"),
      projectionContentDigest: "sha256:v2",
    };
    expect(existing.projectionVersionNo).toBe(2);
    existing = {
      projectionVersionNo: computeNextVersion(existing, "sha256:v2"),
      projectionContentDigest: "sha256:v2",
    };
    expect(existing.projectionVersionNo).toBe(2); // same digest → no increase
    existing = {
      projectionVersionNo: computeNextVersion(existing, "sha256:v3"),
      projectionContentDigest: "sha256:v3",
    };
    expect(existing.projectionVersionNo).toBe(3);
  });
});

function isControlPlaneEligibleFromProjection(c: {
  activationState: string;
  agentLifecycleState: string;
  agentRevisionState: string;
  agentPublicationActive: number;
  agentEvidenceValid: number;
  runtimeLifecycleState: string;
  runtimeRevisionState: string;
  runtimePublicationActive: number;
  runtimeEvidenceValid: number;
  runtimeConformanceValid: number;
  policyRevisionState: string | null;
}): boolean {
  return Boolean(
    c.activationState === "active" &&
      c.agentLifecycleState === "enabled" &&
      c.agentRevisionState === "published" &&
      c.agentPublicationActive === 1 &&
      c.agentEvidenceValid === 1 &&
      c.runtimeLifecycleState === "enabled" &&
      c.runtimeRevisionState === "published" &&
      c.runtimePublicationActive === 1 &&
      c.runtimeEvidenceValid === 1 &&
      c.runtimeConformanceValid === 1 &&
      (c.policyRevisionState === null || c.policyRevisionState === "published"),
  );
}
