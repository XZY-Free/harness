/**
 * buildAgentCallBindingConfig — 从 RouteResolution 装配不可变冻结配置（单元测试，无 DB）。
 *
 * 目标不变量（专题01 Batch10 收口：仅从判别式 Agent RouteResolution 冻结）：
 * 1. 合法 agent resolution 直接冻结 exact target 事实 — endpoint/identity/credential/network
 *    全部从 resolution.target（kind=agent）读取，绝不从平铺字段或默认值伪造。
 * 2. runtime resolution（resolution.target.kind=runtime）必须 fail-closed。
 * 3. agent target 缺 endpoint / 缺 network / bearer 缺 credential → fail-closed。
 * 4. binding 不接受旧平铺字段（targetKind/agentEndpointRef/...）或默认填充值
 *    （"" / "none" / null）—— 只冻结判别 target 的真实事实。
 * 5. digest 从 resolution.controlPlaneEvidence（kind=agent）提取（exact AgentRevision/Contract）。
 */
import {
  type AgentProtocolFacts,
  buildAgentCallBindingConfig,
} from "@/lib/agents/calls/application/build-agent-call-binding-config";
import { AgentCallBindingEvidenceError } from "@/lib/agents/calls/domain/agent-call-binding";
import {
  D,
  agentResolutionWithAgentTarget,
  runtimeRouteResolution,
  validAgentRouteResolution,
} from "@/lib/agents/calls/test/agent-call-test-fixtures";
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
  it("合法 agent resolution 冻结 exact target 事实（endpoint/identity/credential/network 全部来自 target）", () => {
    const resolution = validAgentRouteResolution();
    const config = buildAgentCallBindingConfig(validInput({ resolution }));
    expect(config.agentRevisionId).toBe("agent-rev-1");
    expect(config.deploymentRouteId).toBe("route-1");
    expect(config.routeRevisionId).toBe("route-rev-1");
    expect(config.routeActivationId).toBe("route-act-1");
    expect(config.routeContentDigest).toBe(D("1"));
    expect(config.resolutionInputDigest).toBe(D("2"));
    expect(config.projectionVersionNo).toBe(3);
    // 生产事实直接来自判别 target（kind=agent），不是平铺字段/默认值。
    expect(resolution.target.kind).toBe("agent");
    if (resolution.target.kind !== "agent") return;
    expect(config.endpointRef).toBe(resolution.target.agentEndpointRef);
    expect(config.identityMode).toBe(resolution.target.agentIdentityMode);
    expect(config.credentialRefId).toBe(resolution.target.agentCredentialRefId);
    expect(config.networkZone).toBe(resolution.target.agentNetworkZone);
    // 协议事实来自 ContractSnapshot（权威）。
    expect(config.protocolContractRevision).toBe("a2a-0.3.0");
    // digest 从 controlPlaneEvidence（kind=agent）提取。
    expect(resolution.controlPlaneEvidence.kind).toBe("agent");
    if (resolution.controlPlaneEvidence.kind !== "agent") return;
    expect(config.agentContractDigest).toBe(resolution.controlPlaneEvidence.agentContractDigest);
    expect(config.agentContextDigest).toBe(resolution.controlPlaneEvidence.agentContextDigest);
  });

  it("runtime resolution（target.kind=runtime）→ fail-closed", () => {
    const resolution = runtimeRouteResolution();
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

  it("agent target 缺 endpoint → fail-closed（不以空字符串默认值伪造）", () => {
    const resolution = agentResolutionWithAgentTarget({
      kind: "agent",
      agentRevisionId: "agent-rev-1",
      // 故意缺 agentEndpointRef — 类型无法表达，经 fixture 组装边界模拟 untrusted 缺事实。
    });
    expect(() => buildAgentCallBindingConfig(validInput({ resolution }))).toThrow(
      AgentCallBindingEvidenceError,
    );
  });

  it("agent target 缺 network → fail-closed（不以空字符串默认值伪造）", () => {
    const resolution = agentResolutionWithAgentTarget({
      kind: "agent",
      agentRevisionId: "agent-rev-1",
      agentEndpointRef: "https://agent.example.com/a2a",
      agentIdentityMode: "bearer",
      agentCredentialRefId: "cred-1",
      // 故意缺 agentNetworkZone。
    });
    expect(() => buildAgentCallBindingConfig(validInput({ resolution }))).toThrow(
      AgentCallBindingEvidenceError,
    );
  });

  it("agent target bearer 缺 credential → fail-closed（不以 null 默认值伪造）", () => {
    const resolution = agentResolutionWithAgentTarget({
      kind: "agent",
      agentRevisionId: "agent-rev-1",
      agentEndpointRef: "https://agent.example.com/a2a",
      agentIdentityMode: "bearer",
      agentNetworkZone: "private",
      // 故意缺 agentCredentialRefId（bearer 必须冻结 credential）。
    });
    expect(() => buildAgentCallBindingConfig(validInput({ resolution }))).toThrow(
      AgentCallBindingEvidenceError,
    );
  });

  it("binding 只接受判别 target 事实，不接受旧平铺字段或默认填充值", () => {
    // 旧平铺字段（targetKind/agentEndpointRef/agentIdentityMode/...）在冻结模型下不存在；
    // 若 builder 仍尝试读取它们（当前旧实现），得到 undefined → 以 "" / "none" / null 默认值
    // 填充 → 证据校验失败，绝不可能产出"伪造"的合法 binding。
    const config = buildAgentCallBindingConfig(validInput());
    // 合法 agent target 的真实事实被冻结，绝无默认填充值混入。
    expect(config.endpointRef).toBe("https://agent.example.com/a2a");
    expect(config.identityMode).toBe("bearer");
    expect(config.credentialRefId).toBe("cred-1");
    expect(config.networkZone).toBe("private");
    // binding 不携带任何旧平铺字段名。
    const bindingAsRecord = config as unknown as Record<string, unknown>;
    expect(bindingAsRecord).not.toHaveProperty("targetKind");
    expect(bindingAsRecord).not.toHaveProperty("agentEndpointRef");
    expect(bindingAsRecord).not.toHaveProperty("agentIdentityMode");
    expect(bindingAsRecord).not.toHaveProperty("agentCredentialRefId");
    expect(bindingAsRecord).not.toHaveProperty("agentNetworkZone");
    expect(bindingAsRecord).not.toHaveProperty("runtimeRevisionId");
  });
});
