import { describe, expect, it } from "vitest";
import { computeResolutionInputDigest } from "./resolution-input-digest";
import { type RouteResolutionCandidate, resolveRouteCandidates } from "./route-resolution-policy";

const NOW = new Date("2026-08-03T01:00:00.000Z");

function runtimeEvidence(id: string) {
  return {
    kind: "runtime",
    runtimeArtifactId: `runtime-artifact-${id}`,
    runtimeArtifactDigest: `sha256:${"2".repeat(64)}`,
    runtimeConfigDigest: `sha256:${"3".repeat(64)}`,
    runtimeEvidenceKind: "hosted_artifact",
    runtimeTargetDigest: `sha256:${"4".repeat(64)}`,
    capabilityManifestDigest: `sha256:${"5".repeat(64)}`,
    runtimeAttestationIds: [`runtime-attestation-${id}`],
    runtimePublicationRecordId: `runtime-publication-${id}`,
    conformanceRunId: `conformance-run-${id}`,
  } as const;
}

function agentEvidence(id: string) {
  return {
    kind: "agent",
    agentContractSnapshotId: `agent-contract-snapshot-${id}`,
    agentContractDigest: `sha256:${"6".repeat(64)}`,
    agentContextDigest: `sha256:${"7".repeat(64)}`,
    agentPublicationRecordId: `agent-publication-${id}`,
  } as const;
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
    target: {
      kind: "agent",
      agentRevisionId: `agent-revision-${id}`,
      agentEndpointRef: "https://agent.example.com/capability",
      agentIdentityMode: "bearer",
      agentCredentialRefId: "cred-1",
      agentNetworkZone: "cn-north",
    },
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
    policyRevisionState: null,
    projectionVersionNo: 3,
    controlPlaneEvidence: agentEvidence(id),
    ...overrides,
  } as RouteResolutionCandidate;
}

function resolve(
  candidates: RouteResolutionCandidate[],
  overrides: Partial<Parameters<typeof resolveRouteCandidates>[0]> = {},
) {
  return resolveRouteCandidates({
    tenantId: "tenant-1",
    target: { kind: "agent", agentId: "agent-1" },
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

  it("resolved 结果携带本次完整输入的 resolutionInputDigest", () => {
    const input = {
      tenantId: "tenant-1",
      target: { kind: "agent", agentId: "agent-1" } as const,
      routeScopeKey: "prod",
      businessKey: { threadId: "thread-1" },
      attributes: { environment: "prod" },
      threadDefaultModelRef: "model-v1",
    };
    const result = resolve(
      [
        candidate("digest", {
          trafficWeight: 10_000,
          eligibilityConditions: { all: { environment: "prod" } },
        }),
      ],
      input,
    );

    expect(result).toMatchObject({
      status: "resolved",
      resolution: {
        resolutionInputDigest: computeResolutionInputDigest(input),
      },
    });
  });

  it("只接受 active、窗口内且控制面资格仍有效的 RouteRevision", () => {
    const eligible = candidate("eligible", { trafficWeight: 10_000 });
    const candidates = [
      candidate("disabled", { activationState: "disabled" }),
      candidate("future", { effectiveFrom: new Date("2026-08-03T01:00:00.001Z") }),
      candidate("expired", { effectiveUntil: NOW }),
      candidate("withdrawn-agent", { agentPublicationActive: false }),
      candidate("revoked-agent-evidence", { agentEvidenceValid: false }),
      candidate("unpublished-agent", { agentRevisionState: "draft" }),
      eligible,
    ];

    const result = resolve(candidates);

    expect(result).toMatchObject({
      status: "resolved",
      resolution: {
        routeRevisionId: eligible.routeRevisionId,
        controlPlaneEvidence: agentEvidence("eligible"),
      },
    });
  });

  it("先按 specificity、priority 选择最高层级，同组按 deploymentRouteId 稳定排序", () => {
    const broad = candidate("broad", { trafficWeight: 10_000, priorityNo: 100 });
    const specificA = candidate("specific-a", {
      trafficWeight: 6_000,
      eligibilityConditions: { all: { environment: "prod" } },
      priorityNo: 1,
    });
    const specificB = candidate("specific-b", {
      trafficWeight: 4_000,
      eligibilityConditions: { all: { environment: "prod" } },
      priorityNo: 1,
    });

    const result = resolve([broad, specificA, specificB], {
      attributes: { environment: "prod" },
    });

    expect(result).toMatchObject({
      status: "resolved",
      resolution: { specificity: 1 },
    });
  });

  it("多个 Route Group 在同 Specificity + Priority 下 → ambiguous_route_configuration", () => {
    const a = candidate("a", {
      trafficWeight: 10_000,
      routeGroupId: "canary",
    });
    const b = candidate("b", {
      trafficWeight: 10_000,
      routeGroupId: "primary",
    });

    const result = resolve([a, b]);

    expect(result).toEqual({
      status: "unresolved",
      reason: "ambiguous_route_configuration",
      eligibleCandidateCount: 2,
      groupIds: ["canary", "primary"],
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

/** 合法 runtime 候选 — 只携带 Runtime target 事实与 Runtime 证据。 */
function runtimeCandidate(
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
    target: { kind: "runtime", runtimeRevisionId: `runtime-revision-${id}` },
    policyRevisionId: null,
    contentDigest: `sha256:${id.padEnd(64, "0")}`,
    trafficWeight: 5_000,
    routeGroupId: "primary",
    priorityNo: 0,
    effectiveFrom: null,
    effectiveUntil: null,
    eligibilityConditions: {},
    activationState: "active",
    runtimeLifecycleState: "enabled",
    runtimeRevisionState: "published",
    runtimePublicationActive: true,
    runtimeEvidenceValid: true,
    runtimeConformanceValid: true,
    policyRevisionState: null,
    projectionVersionNo: 3,
    controlPlaneEvidence: runtimeEvidence(id),
    ...overrides,
  } as RouteResolutionCandidate;
}

describe("RouteResolution target 判别隔离（专题01 冻结架构）", () => {
  it("输入 target 与候选 target kind 必须匹配，不匹配不可 resolved", () => {
    // 输入 target 为 runtime，候选却是 agent → 必须 fail-closed（unresolved）。
    const agentCandidate = candidate("mismatch", { trafficWeight: 10_000 });
    const result = resolve([agentCandidate], { target: { kind: "runtime" } });
    expect(result).toMatchObject({ status: "unresolved" });
  });

  it("Agent Route 解析不要求 Runtime 证据/发布/conformance", () => {
    // Agent 候选只携带 Agent target 事实，解析成功且不 inspect 任何 Runtime 事实。
    const agentCandidate = candidate("agent-no-runtime", { trafficWeight: 10_000 });
    const result = resolve([agentCandidate], { target: { kind: "agent", agentId: "agent-1" } });
    expect(result).toMatchObject({ status: "resolved" });
  });

  it("projectionVersionNo 缺失/为0/非整数不可 resolved", () => {
    // 公开类型要求 projectionVersionNo 必填 number；畸形/缺失值经 untrusted 记录 cast 模拟。
    const base = candidate("proj", { trafficWeight: 10_000 });
    const malformed = (value: number | undefined): RouteResolutionCandidate =>
      ({ ...base, projectionVersionNo: value }) as RouteResolutionCandidate;
    expect(resolve([malformed(undefined)])).toMatchObject({ status: "unresolved" });
    expect(resolve([malformed(0)])).toMatchObject({ status: "unresolved" });
    expect(resolve([malformed(1.5)])).toMatchObject({ status: "unresolved" });
  });

  it("正整数 projectionVersionNo 被保留", () => {
    const result = resolve([
      candidate("proj-ok", { trafficWeight: 10_000, projectionVersionNo: 3 }),
    ]);
    expect(result).toMatchObject({
      status: "resolved",
      resolution: { projectionVersionNo: 3 },
    });
  });

  it("Agent 解析/证据不含任何 Runtime 事实", () => {
    const agentCandidate = candidate("agent-isolation", { trafficWeight: 10_000 });
    const result = resolve([agentCandidate], { target: { kind: "agent", agentId: "agent-1" } });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    const evidence = result.resolution.controlPlaneEvidence;
    // Agent 证据不含 runtime 发布/conformance/artifact 事实。
    expect(evidence).not.toHaveProperty("runtimeArtifactId");
    expect(evidence).not.toHaveProperty("runtimeConfigDigest");
    expect(evidence).not.toHaveProperty("runtimeTargetDigest");
    expect(evidence).not.toHaveProperty("runtimePublicationRecordId");
    expect(evidence).not.toHaveProperty("conformanceRunId");
    expect(evidence).not.toHaveProperty("runtimeAttestationIds");
  });

  it("Runtime 解析/证据不含任何 Agent 事实", () => {
    const runtimeCand = runtimeCandidate("runtime-isolation", { trafficWeight: 10_000 });
    const result = resolve([runtimeCand], { target: { kind: "runtime" } });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    const evidence = result.resolution.controlPlaneEvidence;
    // Runtime 证据不含 agentRevisionId、Agent contract/publication 事实。
    expect(evidence).not.toHaveProperty("agentRevisionId");
    expect(evidence).not.toHaveProperty("agentContractSnapshotId");
    expect(evidence).not.toHaveProperty("agentPublicationRecordId");
  });
});
