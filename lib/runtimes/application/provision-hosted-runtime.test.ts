import { describe, expect, it, vi } from "vitest";
import {
  type HostedRuntimeControlPlane,
  HostedRuntimeProvisioningError,
  type HostedRuntimeRoute,
  createProvisionHostedRuntime,
} from "./provision-hosted-runtime";

const command = {
  tenantId: "tenant-1",
  agentId: "agent-1",
  routeScopeKey: "default",
};

const route: HostedRuntimeRoute = {
  routeId: "route-1",
  routeRevisionId: "route-revision-1",
  routeActivationId: "route-activation-1",
  agentRevisionId: "agent-revision-1",
  runtimeRevisionId: "runtime-revision-1",
};

function controlPlane(overrides: Partial<HostedRuntimeControlPlane> = {}) {
  const calls: string[] = [];
  let resolutionCount = 0;
  const value: HostedRuntimeControlPlane = {
    async resolveEligibleRoute() {
      calls.push("resolve");
      resolutionCount += 1;
      return resolutionCount === 1 ? null : route;
    },
    async ensurePublishedAgentRevision() {
      calls.push("agent");
      return {
        revisionId: route.agentRevisionId,
        publicationRecordId: "agent-publication-1",
        attestationId: "agent-attestation-1",
      };
    },
    async ensurePublishedRuntimeRevision() {
      calls.push("runtime");
      return {
        revisionId: route.runtimeRevisionId,
        publicationRecordId: "runtime-publication-1",
        attestationId: "runtime-attestation-1",
        conformanceRunId: "conformance-run-1",
      };
    },
    async activateRoute() {
      calls.push("activate");
    },
    ...overrides,
  };
  return { value, calls };
}

describe("provisionHostedRuntime", () => {
  it("按 Attestation、Publication、Conformance、RouteActivation 顺序供应并重读权威路由", async () => {
    const { value, calls } = controlPlane();

    const result = await createProvisionHostedRuntime({ controlPlane: value })(command);

    expect(result).toEqual(route);
    expect(calls).toEqual(["resolve", "agent", "runtime", "activate", "resolve"]);
  });

  it("已有合格路由时幂等返回，不重复写控制面", async () => {
    const { value } = controlPlane({
      resolveEligibleRoute: vi.fn().mockResolvedValue(route),
    });

    const result = await createProvisionHostedRuntime({ controlPlane: value })(command);

    expect(result).toEqual(route);
    expect(value.resolveEligibleRoute).toHaveBeenCalledTimes(1);
  });

  it("激活后若正式 Resolver 仍拒绝路由则失败关闭", async () => {
    const { value } = controlPlane({
      resolveEligibleRoute: vi.fn().mockResolvedValue(null),
    });

    await expect(
      createProvisionHostedRuntime({ controlPlane: value })(command),
    ).rejects.toBeInstanceOf(HostedRuntimeProvisioningError);
  });

  it("拒绝返回与本次正式发布事实不一致的路由", async () => {
    const { value } = controlPlane({
      resolveEligibleRoute: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...route, runtimeRevisionId: "other-runtime-revision" }),
    });

    await expect(createProvisionHostedRuntime({ controlPlane: value })(command)).rejects.toThrow(
      "RuntimeRevision 不一致",
    );
  });
});
