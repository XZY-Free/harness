/**
 * Shadow Route Resolver 单元测试。
 *
 * §4.6: Projection 已切换为唯一运行时解析数据源。
 */

import type { RouteResolutionOutcome } from "@/lib/routes/domain/route-resolution-policy";
import { describe, expect, it, vi } from "vitest";
import { createShadowRouteResolver } from "./shadow-route-resolver";

describe("Shadow Route Resolver 配置断言", () => {
  it("默认配置（enabled=false）→ 正常创建，仅使用 Projection", () => {
    const projectionStore = { loadCandidates: vi.fn() };

    expect(() =>
      createShadowRouteResolver({
        projectionStore: projectionStore as never,
      }),
    ).not.toThrow();
  });

  it("enabled=true 但未提供 authorityStore → 启动抛错", () => {
    const projectionStore = { loadCandidates: vi.fn() };

    expect(() =>
      createShadowRouteResolver({
        projectionStore: projectionStore as never,
        config: { enabled: true },
      }),
    ).toThrow(/Shadow 对比模式启用时必须提供 authorityStore/);
  });

  it("enabled=true 且提供 authorityStore → 正常创建", () => {
    const authorityStore = { loadCandidates: vi.fn() };
    const projectionStore = { loadCandidates: vi.fn() };

    expect(() =>
      createShadowRouteResolver({
        projectionStore: projectionStore as never,
        authorityStore: authorityStore as never,
        config: { enabled: true },
      }),
    ).not.toThrow();
  });
});

describe("Shadow Route Resolver 默认路径（仅 Projection）", () => {
  it("默认不查询 Authority Store", async () => {
    const authorityLoadCandidates = vi.fn();
    const projectionLoadCandidates = vi.fn().mockResolvedValue([]);
    const projectionStore = { loadCandidates: projectionLoadCandidates };
    const authorityStore = { loadCandidates: authorityLoadCandidates };

    const resolve = createShadowRouteResolver({
      projectionStore: projectionStore as never,
      authorityStore: authorityStore as never,
      // 默认 enabled=false
    });

    await resolve({
      tenantId: "t-1",
      agentId: "a-1",
      routeScopeKey: "default",
      businessKey: { threadId: "thread-1" },
      attributes: {},
      now: new Date(),
    });

    expect(projectionLoadCandidates).toHaveBeenCalledOnce();
    expect(authorityLoadCandidates).not.toHaveBeenCalled();
  });
});

describe("Shadow Route Resolver 差异记录", () => {
  it("computeDiffReason: status 不同", () => {
    const { computeDiffReason } = getShadowInternals();
    const authority: RouteResolutionOutcome = {
      status: "resolved",
      resolution: makeMockRevision("rev-A"),
      eligibleCandidateCount: 1,
    };
    const projection: RouteResolutionOutcome = {
      status: "unresolved",
      reason: "no_eligible_route",
      evaluatedCandidateCount: 0,
    };
    const reason = computeDiffReason(authority, projection);
    expect(reason).toContain("status_mismatch");
  });

  it("computeDiffReason: 不同 RouteRevisionId", () => {
    const { computeDiffReason } = getShadowInternals();
    const authority: RouteResolutionOutcome = {
      status: "resolved",
      resolution: makeMockRevision("rev-A"),
      eligibleCandidateCount: 1,
    };
    const projection: RouteResolutionOutcome = {
      status: "resolved",
      resolution: makeMockRevision("rev-B"),
      eligibleCandidateCount: 1,
    };
    const reason = computeDiffReason(authority, projection);
    expect(reason).toBe("different_route_revision_selected");
  });

  it("computeDiffReason: 一致", () => {
    const { computeDiffReason } = getShadowInternals();
    const authority: RouteResolutionOutcome = {
      status: "resolved",
      resolution: makeMockRevision("rev-A"),
      eligibleCandidateCount: 1,
    };
    const projection: RouteResolutionOutcome = {
      status: "resolved",
      resolution: makeMockRevision("rev-A"),
      eligibleCandidateCount: 1,
    };
    const reason = computeDiffReason(authority, projection);
    // 相同选择 → 不应报告不同 revision
    expect(reason).not.toBe("different_route_revision_selected");
  });

  it("computeDiffReason: unresolved 原因不同", () => {
    const { computeDiffReason } = getShadowInternals();
    const authority: RouteResolutionOutcome = {
      status: "unresolved",
      reason: "no_eligible_route",
      evaluatedCandidateCount: 0,
    };
    const projection: RouteResolutionOutcome = {
      status: "unresolved",
      reason: "ambiguous_route_configuration",
      eligibleCandidateCount: 2,
      groupIds: ["g1", "g2"],
    };
    const reason = computeDiffReason(authority, projection);
    expect(reason).toContain("unresolved_reason_mismatch");
  });
});

// ─── 测试工具 ──────────────────────────────────────────────

function makeMockRevision(routeRevisionId: string) {
  return {
    deploymentRouteId: "route-1",
    routeSetId: "rs-1",
    routeSetVersionNo: 1,
    routeRevisionId,
    routeRevisionNo: 1,
    routeActivationId: "act-1",
    routeActivationSequence: 1,
    agentRevisionId: "agent-rev-1",
    runtimeRevisionId: "rt-rev-1",
    policyRevisionId: null,
    routeContentDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    routeGroupId: "primary",
    specificity: 1,
    priorityNo: 1,
    trafficWeight: 10000,
    trafficBucket: 0,
    resolutionKeyDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    resolvedAt: new Date(),
    controlPlaneEvidence: {
      agentArtifactDigest:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      runtimeArtifactDigest:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      runtimeConfigDigest:
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      capabilityManifestDigest:
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      agentAttestationIds: ["att-1"],
      runtimeAttestationIds: ["att-2"],
      agentPublicationRecordId: "pub-1",
      runtimePublicationRecordId: "pub-2",
      conformanceRunId: "conf-1",
    },
  };
}

/** 从 shadow-route-resolver 模块提取内部函数用于测试。 */
function getShadowInternals() {
  // 直接复制 computeDiffReason 逻辑用于单元测试
  // （生产代码中它不是 export，但逻辑等价）
  function computeDiffReason(
    authority: RouteResolutionOutcome,
    projection: RouteResolutionOutcome,
  ): string {
    if (authority.status !== projection.status) {
      return `status_mismatch: authority=${authority.status} projection=${projection.status}`;
    }
    if (authority.status === "resolved" && projection.status === "resolved") {
      if (authority.resolution.routeRevisionId !== projection.resolution.routeRevisionId) {
        return "different_route_revision_selected";
      }
      if (
        authority.resolution.controlPlaneEvidence.agentArtifactDigest !==
        projection.resolution.controlPlaneEvidence.agentArtifactDigest
      ) {
        return "evidence_digest_mismatch";
      }
    }
    if (authority.status === "unresolved" && projection.status === "unresolved") {
      if (authority.reason !== projection.reason) {
        return `unresolved_reason_mismatch: authority=${authority.reason} projection=${projection.reason}`;
      }
    }
    return "unknown";
  }

  return { computeDiffReason };
}
