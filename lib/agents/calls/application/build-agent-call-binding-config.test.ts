/**
 * buildAgentCallBindingConfig — 从 RouteResolution 装配不可变冻结配置（单元测试，无 DB）。
 *
 * 目标不变量：
 * 1. 从合法 targetKind=agent RouteResolution + endpoint 事实装配完整 binding config。
 * 2. digest 从 RouteResolution 的 controlPlaneEvidence 提取（exact AgentRevision/Contract）。
 * 3. fail-closed：endpoint 事实缺失 / resolution 不完整 → AgentCallBindingEvidenceError。
 */
import {
  type AgentEndpointFacts,
  buildAgentCallBindingConfig,
} from "@/lib/agents/calls/application/build-agent-call-binding-config";
import { AgentCallBindingEvidenceError } from "@/lib/agents/calls/domain/agent-call-binding";
import { D, validAgentRouteResolution } from "@/lib/agents/calls/test/agent-call-test-fixtures";
import { describe, expect, it } from "vitest";

function validEndpointFacts(overrides?: Partial<AgentEndpointFacts>): AgentEndpointFacts {
  return {
    endpointRef: "https://agent.example.com/a2a",
    identityMode: "bearer",
    credentialRefId: "cred-1",
    networkZone: "private",
    protocolType: "a2a",
    protocolContractRevision: "a2a-0.3.0",
    ...overrides,
  };
}

function validInput(overrides?: Partial<Parameters<typeof buildAgentCallBindingConfig>[0]>) {
  return {
    tenantId: "tenant-1",
    resolution: validAgentRouteResolution(),
    agentId: "agent-1",
    agentRevisionId: "agent-rev-1",
    agentContractSnapshotId: "contract-1",
    agentContractDigest: D("a"),
    agentCapabilityDigest: D("b"),
    agentContextDigest: D("c"),
    agentPublicationRecordId: "pub-1",
    endpointFacts: validEndpointFacts(),
    policyRevisionId: "policy-rev-1",
    policyRulesDigest: D("e"),
    governanceConfigRevisionId: "gov-rev-1",
    governanceConfigDigest: D("f"),
    ...overrides,
  };
}

describe("buildAgentCallBindingConfig", () => {
  it("从合法 RouteResolution + endpoint 事实装配完整冻结配置", () => {
    const config = buildAgentCallBindingConfig(validInput());
    expect(config.agentRevisionId).toBe("agent-rev-1");
    expect(config.deploymentRouteId).toBe("route-1");
    expect(config.routeRevisionId).toBe("route-rev-1");
    expect(config.routeActivationId).toBe("route-act-1");
    expect(config.routeContentDigest).toBe(D("1"));
    expect(config.resolutionInputDigest).toBe(D("2"));
    expect(config.projectionVersionNo).toBe(3);
    expect(config.endpointRef).toBe("https://agent.example.com/a2a");
    expect(config.identityMode).toBe("bearer");
    expect(config.credentialRefId).toBe("cred-1");
    expect(config.protocolContractRevision).toBe("a2a-0.3.0");
    // digest 从 RouteResolution controlPlaneEvidence 提取。
    expect(config.agentContractDigest).toBe(D("a"));
    expect(config.agentContextDigest).toBe(D("c"));
  });

  it("resolution 缺 route 证据 → fail-closed", () => {
    const resolution = validAgentRouteResolution({ routeActivationId: "" });
    expect(() => buildAgentCallBindingConfig(validInput({ resolution }))).toThrow(
      AgentCallBindingEvidenceError,
    );
  });

  it("endpoint 缺失 → fail-closed", () => {
    expect(() =>
      buildAgentCallBindingConfig(
        validInput({ endpointFacts: validEndpointFacts({ endpointRef: "" }) }),
      ),
    ).toThrow(AgentCallBindingEvidenceError);
    expect(() =>
      buildAgentCallBindingConfig(
        validInput({ endpointFacts: validEndpointFacts({ networkZone: "" }) }),
      ),
    ).toThrow(AgentCallBindingEvidenceError);
    expect(() =>
      buildAgentCallBindingConfig(
        validInput({
          endpointFacts: validEndpointFacts({ identityMode: "bearer", credentialRefId: null }),
        }),
      ),
    ).toThrow(AgentCallBindingEvidenceError);
  });
});
