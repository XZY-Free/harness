import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type {
  RouteResolution,
  RouteResolutionOutcome,
  RouteTarget,
} from "@/lib/routes/domain/route-resolution-policy";
import {
  type ResolvedExecutionPlan,
  extractModelInfo,
  resolveExecutionPlan,
} from "@/lib/runtime/resolve-execution-plan";
import { describe, expect, it } from "vitest";

// ─── 完整 Runtime Resolution 构造（与 resolver buildRouteResolution 输出同构） ───

const runtimeResolution: RouteResolution = {
  deploymentRouteId: "route-1",
  routeSetId: "route-set-1",
  routeSetVersionNo: 3,
  routeRevisionId: "route-revision-1",
  routeRevisionNo: 2,
  routeActivationId: "route-activation-1",
  routeActivationSequence: 1,
  policyRevisionId: "policy-revision-1",
  routeContentDigest: `sha256:${"1".repeat(64)}`,
  routeGroupId: "group-1",
  specificity: 1,
  priorityNo: 1,
  trafficWeight: 10000,
  trafficBucket: 0,
  resolutionKeyDigest: `sha256:${"2".repeat(64)}`,
  resolutionInputDigest: `sha256:${"6".repeat(64)}`,
  resolvedAt: new Date("2026-08-30T00:00:00Z"),
  projectionVersionNo: 7,
  target: { kind: "runtime", runtimeRevisionId: "runtime-revision-1" },
  controlPlaneEvidence: {
    kind: "runtime",
    runtimeArtifactId: "runtime-artifact-1",
    runtimeArtifactDigest: `sha256:${"3".repeat(64)}`,
    runtimeConfigDigest: `sha256:${"4".repeat(64)}`,
    runtimeEvidenceKind: "hosted_artifact",
    runtimeTargetDigest: `sha256:${"t".repeat(64)}`,
    capabilityManifestDigest: `sha256:${"5".repeat(64)}`,
    runtimeAttestationIds: ["runtime-attestation-1"],
    runtimePublicationRecordId: "runtime-publication-1",
    conformanceRunId: "conformance-run-1",
  },
};

const runtimeOutcome: RouteResolutionOutcome = {
  status: "resolved",
  resolution: runtimeResolution,
  eligibleCandidateCount: 1,
};

// ─── Agent Resolution 构造（resolver 违反 runtime-target 命令时返回） ───

const agentResolution: RouteResolution = {
  ...runtimeResolution,
  target: {
    kind: "agent",
    agentRevisionId: "agent-revision-1",
    agentEndpointRef: "endpoint-1",
    agentIdentityMode: "bearer",
    agentCredentialRefId: "credential-1",
    agentNetworkZone: "zone-1",
  },
  controlPlaneEvidence: {
    kind: "agent",
    agentContractSnapshotId: "contract-snapshot-1",
    agentContractDigest: `sha256:${"a".repeat(64)}`,
    agentContextDigest: `sha256:${"b".repeat(64)}`,
    agentPublicationRecordId: "agent-publication-1",
  },
};

const agentOutcome: RouteResolutionOutcome = {
  status: "resolved",
  resolution: agentResolution,
  eligibleCandidateCount: 1,
};

function resolveWith(outcome: RouteResolutionOutcome): RouteResolver {
  return async () => outcome;
}

describe("extractModelInfo", () => {
  it("员工为本次 Invocation 选择模型时覆盖 Agent 的默认模型", () => {
    expect(
      extractModelInfo(
        { default: "doubao-pro", provider: "tokenplan", revision: "policy-v1" },
        "auto",
      ),
    ).toEqual({
      modelProvider: "tokenplan",
      modelId: "auto",
      modelRevisionRef: "policy-v1",
    });
  });

  it("员工未选择模型时使用 AgentRevision 的默认模型", () => {
    expect(extractModelInfo({ default: "doubao-pro", provider: "doubao" }, null)).toEqual({
      modelProvider: "doubao",
      modelId: "doubao-pro",
      modelRevisionRef: null,
    });
  });

  it("AgentRevision 已声明模型策略时平台默认模型不参与解析", () => {
    expect(
      extractModelInfo({ default: "doubao-pro", provider: "doubao" }, null, "deepseek-v4-flash"),
    ).toEqual({
      modelProvider: "doubao",
      modelId: "doubao-pro",
      modelRevisionRef: null,
    });
  });

  it("会话与 AgentRevision 都未声明模型时回落平台默认模型", () => {
    expect(extractModelInfo({ provider: "doubao" }, null, "deepseek-v4-flash")).toEqual({
      modelProvider: "doubao",
      modelId: "deepseek-v4-flash",
      modelRevisionRef: null,
    });
  });

  it("平台默认模型缺省时回落占位值", () => {
    expect(extractModelInfo({}, null)).toEqual({
      modelProvider: "default",
      modelId: "default",
      modelRevisionRef: null,
    });
  });
});

describe("resolveExecutionPlan runtime-target authority", () => {
  it("Resolver 恒以 target:{kind:'runtime'} 被调用", async () => {
    const received: RouteTarget[] = [];
    const resolver: RouteResolver = async (command) => {
      received.push(command.target);
      return runtimeOutcome;
    };
    await resolveExecutionPlan(
      {
        tenantId: "tenant-1",
        routeScopeKey: "scope-1",
        businessKey: { threadId: "thread-1" },
        threadDefaultModelRef: null,
      },
      resolver,
    );
    expect(received).toEqual([{ kind: "runtime" }]);
  });

  it("从 target.runtimeRevisionId 提取嵌套 runtimeRevisionId 并返回收窄后的 route resolution", async () => {
    const plan = await resolveExecutionPlan(
      {
        tenantId: "tenant-1",
        routeScopeKey: "scope-1",
        businessKey: { threadId: "thread-1" },
        threadDefaultModelRef: null,
      },
      resolveWith(runtimeOutcome),
    );
    expect(plan.resolved).toBe(true);
    if (!plan.resolved) return;
    const resolved = plan as ResolvedExecutionPlan;
    expect(resolved.runtimeRevisionId).toBe("runtime-revision-1");
    expect(resolved.routeResolution).toBe(runtimeResolution);
    expect(resolved.routeResolution.target).toEqual({
      kind: "runtime",
      runtimeRevisionId: "runtime-revision-1",
    });
    expect(resolved.routeResolution.controlPlaneEvidence.kind).toBe("runtime");
    expect(resolved.routeOutcome.status).toBe("resolved");
    if (resolved.routeOutcome.status !== "resolved") return;
    expect(resolved.routeOutcome.resolution.target.kind).toBe("runtime");
    expect(resolved.projectionVersionNo).toBe(7);
  });

  it("Resolver 返回 Agent Resolution 时 fail-closed，绝不产出 runtimeRevisionId=undefined", async () => {
    await expect(
      resolveExecutionPlan(
        {
          tenantId: "tenant-1",
          routeScopeKey: "scope-1",
          businessKey: { threadId: "thread-1" },
          threadDefaultModelRef: null,
        },
        resolveWith(agentOutcome),
      ),
    ).rejects.toThrow(/runtime/i);
  });
});
