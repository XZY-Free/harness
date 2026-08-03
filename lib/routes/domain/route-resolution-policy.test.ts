import { describe, expect, it } from "vitest";
import { type RouteResolutionCandidate, resolveRouteCandidates } from "./route-resolution-policy";

const NOW = new Date("2026-08-03T01:00:00.000Z");

function evidence(id: string) {
  return {
    agentArtifactDigest: `sha256:${"1".repeat(64)}`,
    runtimeArtifactDigest: `sha256:${"2".repeat(64)}`,
    runtimeConfigDigest: `sha256:${"3".repeat(64)}`,
    capabilityManifestDigest: `sha256:${"4".repeat(64)}`,
    agentAttestationIds: [`agent-attestation-${id}`],
    runtimeAttestationIds: [`runtime-attestation-${id}`],
    agentPublicationRecordId: `agent-publication-${id}`,
    runtimePublicationRecordId: `runtime-publication-${id}`,
    conformanceRunId: `conformance-run-${id}`,
  };
}

function candidate(
  id: string,
  overrides: Partial<RouteResolutionCandidate> = {},
): RouteResolutionCandidate {
  return {
    deploymentRouteId: `route-${id}`,
    routeSetId: "route-set-1",
    routeSetVersionNo: 7,
    routeRevisionId: `route-revision-${id}`,
    routeRevisionNo: 1,
    routeActivationId: `route-activation-${id}`,
    routeActivationSequence: 1,
    agentRevisionId: `agent-revision-${id}`,
    runtimeRevisionId: `runtime-revision-${id}`,
    policyRevisionId: null,
    contentDigest: `sha256:${id.padEnd(64, "0")}`,
    trafficWeight: 5_000,
    routeGroupId: "primary",
    priorityNo: 0,
    effectiveFrom: null,
    effectiveUntil: null,
    eligibilityConditions: {},
    activationState: "active",
    agentLifecycleState: "enabled",
    agentRevisionState: "published",
    agentPublicationActive: true,
    agentEvidenceValid: true,
    runtimeLifecycleState: "enabled",
    runtimeRevisionState: "published",
    runtimePublicationActive: true,
    runtimeEvidenceValid: true,
    runtimeConformanceValid: true,
    policyRevisionState: null,
    controlPlaneEvidence: evidence(id),
    ...overrides,
  } as RouteResolutionCandidate;
}

function resolve(
  candidates: RouteResolutionCandidate[],
  overrides: Partial<Parameters<typeof resolveRouteCandidates>[0]> = {},
) {
  return resolveRouteCandidates({
    tenantId: "tenant-1",
    agentId: "agent-1",
    routeScopeKey: "prod",
    businessKey: { threadId: "thread-1" },
    attributes: {},
    candidates,
    now: NOW,
    ...overrides,
  });
}

describe("deterministic route resolution policy", () => {
  it("candidate 输入顺序变化不会改变稳定权重选择", () => {
    const first = candidate("a");
    const second = candidate("b");

    const forward = resolve([first, second]);
    const reverse = resolve([second, first]);

    expect(forward.status).toBe("resolved");
    expect(reverse).toEqual(forward);
  });

  it("只接受 active、窗口内且控制面资格仍有效的 RouteRevision", () => {
    const eligible = candidate("eligible", { trafficWeight: 10_000 });
    const candidates = [
      candidate("disabled", { activationState: "disabled" }),
      candidate("future", { effectiveFrom: new Date("2026-08-03T01:00:00.001Z") }),
      candidate("expired", { effectiveUntil: NOW }),
      candidate("withdrawn-agent", { agentPublicationActive: false }),
      candidate("disabled-runtime", { runtimeLifecycleState: "disabled" }),
      candidate("revoked-evidence", { runtimeEvidenceValid: false }),
      candidate("failed-conformance", { runtimeConformanceValid: false }),
      eligible,
    ];

    const result = resolve(candidates);

    expect(result).toMatchObject({
      status: "resolved",
      resolution: {
        routeRevisionId: eligible.routeRevisionId,
        controlPlaneEvidence: evidence("eligible"),
      },
    });
  });

  it("先按 specificity、priority、RouteRevision 序号选择最高层级", () => {
    const broad = candidate("broad", { trafficWeight: 10_000, priorityNo: 100 });
    const specificOld = candidate("specific-old", {
      trafficWeight: 10_000,
      eligibilityConditions: { all: { environment: "prod" } },
      priorityNo: 1,
      routeRevisionNo: 2,
    });
    const specificNew = candidate("specific-new", {
      trafficWeight: 10_000,
      eligibilityConditions: { all: { environment: "prod" } },
      priorityNo: 1,
      routeRevisionNo: 3,
    });

    const result = resolve([broad, specificOld, specificNew], {
      attributes: { environment: "prod" },
    });

    expect(result).toMatchObject({
      status: "resolved",
      resolution: { routeRevisionId: specificNew.routeRevisionId, specificity: 1 },
    });
  });

  it("同一最高层级流量组权重总和不是10000时 fail-closed", () => {
    const result = resolve([
      candidate("a", { trafficWeight: 4_000 }),
      candidate("b", { trafficWeight: 5_000 }),
    ]);

    expect(result).toEqual({
      status: "unresolved",
      reason: "invalid_traffic_weight_total",
      eligibleCandidateCount: 2,
      trafficWeightTotal: 9_000,
    });
  });

  it("非法 eligibility 条件和缺失属性不会被宽松放行", () => {
    const result = resolve([
      candidate("missing", {
        trafficWeight: 5_000,
        eligibilityConditions: { all: { environment: "prod" } },
      }),
      candidate("invalid", {
        trafficWeight: 5_000,
        eligibilityConditions: { unknown: true },
      }),
    ]);

    expect(result).toEqual({
      status: "unresolved",
      reason: "no_eligible_route",
      evaluatedCandidateCount: 2,
    });
  });

  it("threadId 与 jobId 必须且只能提供一个", () => {
    expect(() => resolve([], { businessKey: { threadId: "thread-1", jobId: "job-1" } })).toThrow(
      /threadId.*jobId/,
    );
    expect(() => resolve([], { businessKey: {} })).toThrow(/threadId.*jobId/);
  });
});
