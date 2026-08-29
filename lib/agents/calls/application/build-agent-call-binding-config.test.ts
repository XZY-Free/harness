/**
 * buildAgentCallBindingConfig — 从 RouteResolution 装配不可变冻结配置（单元测试，无 DB）。
 *
 * 目标不变量（专题01 Batch4 补漏 + Batch7）：
 * 1. 从合法 targetKind=agent RouteResolution（携带 endpoint facts）装配完整 binding config。
 * 2. endpoint/identity/credential/network 直接冻结自 RouteResolution 的 exact agent route facts。
 * 3. digest 从 RouteResolution 的 controlPlaneEvidence 提取（exact AgentRevision/Contract）。
 * 4. fail-closed：resolution 非 agent / route 证据缺失 / endpoint 事实缺失 → AgentCallBindingEvidenceError。
 */
import {
  type AgentProtocolFacts,
  buildAgentCallBindingConfig,
} from "@/lib/agents/calls/application/build-agent-call-binding-config";
import { AgentCallBindingEvidenceError } from "@/lib/agents/calls/domain/agent-call-binding";
import { D, validAgentRouteResolution } from "@/lib/agents/calls/test/agent-call-test-fixtures";
import { describe, expect, it } from "vitest";

function validProtocolFacts(overrides?: Partial<AgentProtocolFacts>): AgentProtocolFacts {
  return {
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
    protocolFacts: validProtocolFacts(),
    policyRevisionId: "policy-rev-1",
    policyRulesDigest: D("e"),
    governanceConfigRevisionId: "gov-rev-1",
    governanceConfigDigest: D("f"),
    ...overrides,
  };
}

describe("buildAgentCallBindingConfig", () => {
  it("从合法 RouteResolution 直接冻结 endpoint 事实，装配完整冻结配置", () => {
    const config = buildAgentCallBindingConfig(validInput());
    expect(config.agentRevisionId).toBe("agent-rev-1");
    expect(config.deploymentRouteId).toBe("route-1");
    expect(config.routeRevisionId).toBe("route-rev-1");
    expect(config.routeActivationId).toBe("route-act-1");
    expect(config.routeContentDigest).toBe(D("1"));
    expect(config.resolutionInputDigest).toBe(D("2"));
    expect(config.projectionVersionNo).toBe(3);
    // endpoint 事实直接来自 RouteResolution（Batch4 补漏）。
    expect(config.endpointRef).toBe("https://agent.example.com/a2a");
    expect(config.identityMode).toBe("bearer");
    expect(config.credentialRefId).toBe("cred-1");
    expect(config.networkZone).toBe("private");
    // 协议事实来自 ContractSnapshot（权威）。
    expect(config.protocolContractRevision).toBe("a2a-0.3.0");
    // digest 从 RouteResolution controlPlaneEvidence 提取。
    expect(config.agentContractDigest).toBe(D("a"));
    expect(config.agentContextDigest).toBe(D("c"));
  });

  it("resolution 非 agent target → fail-closed", () => {
    const resolution = validAgentRouteResolution({ targetKind: "runtime" });
    expect(() => buildAgentCallBindingConfig(validInput({ resolution }))).toThrow(
      AgentCallBindingEvidenceError,
    );
  });

  it("resolution 缺 route 证据 → fail-closed", () => {
    const resolution = validAgentRouteResolution({ routeActivationId: "" });
    expect(() => buildAgentCallBindingConfig(validInput({ resolution }))).toThrow(
      AgentCallBindingEvidenceError,
    );
  });

  it("RouteResolution endpoint 事实缺失 → fail-closed", () => {
    // endpointRef 缺失 → agent route facts 不完整。
    const noEndpoint = validAgentRouteResolution({ agentEndpointRef: null });
    expect(() => buildAgentCallBindingConfig(validInput({ resolution: noEndpoint }))).toThrow(
      AgentCallBindingEvidenceError,
    );
    // bearer identityMode 但无 credential → fail-closed。
    const noCred = validAgentRouteResolution({
      agentEndpointRef: "https://agent.example.com/a2a",
      agentIdentityMode: "bearer",
      agentCredentialRefId: null,
    });
    expect(() => buildAgentCallBindingConfig(validInput({ resolution: noCred }))).toThrow(
      AgentCallBindingEvidenceError,
    );
  });
});
