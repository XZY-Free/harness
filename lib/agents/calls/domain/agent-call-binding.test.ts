import {
  type AgentCallBindingConfigInput,
  AgentCallBindingEvidenceError,
  assertAgentCallBindingEvidence,
  computeAgentCallBindingHash,
} from "@/lib/agents/calls/domain/agent-call-binding";
import type { EnterpriseUserPublicContext } from "@/lib/identity/enterprise-user-access-policy";
import { describe, expect, it } from "vitest";

const D = (hex: string): string => `sha256:${hex.repeat(64)}`;

function validConfig(
  overrides?: Partial<AgentCallBindingConfigInput>,
): AgentCallBindingConfigInput {
  return {
    agentId: "agent-1",
    agentRevisionId: "agent-rev-1",
    agentContractSnapshotId: "contract-1",
    agentContractDigest: D("a"),
    agentCapabilityDigest: D("b"),
    agentContextDigest: D("c"),
    agentPublicationRecordId: "pub-1",
    deploymentRouteId: "route-1",
    routeRevisionId: "route-rev-1",
    routeActivationId: "route-act-1",
    routeContentDigest: D("1"),
    resolutionInputDigest: D("2"),
    projectionVersionNo: 3,
    endpointRef: "https://agent.example.com/a2a",
    identityMode: "bearer",
    credentialRefId: "cred-1",
    networkZone: "private",
    protocolType: "a2a",
    protocolContractRevision: "a2a-0.3.0",
    policyRevisionId: "policy-rev-1",
    policyRulesDigest: D("e"),
    governanceConfigRevisionId: "gov-rev-1",
    governanceConfigDigest: D("f"),
    ...overrides,
  };
}

describe("AgentCallBinding 不可变冻结", () => {
  it("合法配置通过校验", () => {
    expect(() => assertAgentCallBindingEvidence(validConfig())).not.toThrow();
  });

  it("digest 必须带 sha256: 前缀", () => {
    expect(() =>
      assertAgentCallBindingEvidence(validConfig({ agentContractDigest: "nope" })),
    ).toThrow(AgentCallBindingEvidenceError);
    expect(() =>
      assertAgentCallBindingEvidence(validConfig({ agentCapabilityDigest: "nope" })),
    ).toThrow(AgentCallBindingEvidenceError);
    expect(() =>
      assertAgentCallBindingEvidence(validConfig({ agentContextDigest: "nope" })),
    ).toThrow(AgentCallBindingEvidenceError);
  });

  it("缺少 Agent/Route/Publication 引用 fail-closed", () => {
    expect(() => assertAgentCallBindingEvidence(validConfig({ agentRevisionId: "" }))).toThrow(
      AgentCallBindingEvidenceError,
    );
    expect(() =>
      assertAgentCallBindingEvidence(validConfig({ agentPublicationRecordId: "" })),
    ).toThrow(AgentCallBindingEvidenceError);
    expect(() => assertAgentCallBindingEvidence(validConfig({ routeActivationId: "" }))).toThrow(
      AgentCallBindingEvidenceError,
    );
  });

  it("bearer identityMode 必须带 credentialRefId；none 不得带", () => {
    expect(() =>
      assertAgentCallBindingEvidence(
        validConfig({ identityMode: "bearer", credentialRefId: null }),
      ),
    ).toThrow(AgentCallBindingEvidenceError);
    expect(() =>
      assertAgentCallBindingEvidence(
        validConfig({ identityMode: "none", credentialRefId: "cred-1" }),
      ),
    ).toThrow(AgentCallBindingEvidenceError);
    expect(() =>
      assertAgentCallBindingEvidence(validConfig({ identityMode: "none", credentialRefId: null })),
    ).not.toThrow();
  });

  it("endpoint/networkZone/protocol 必须冻结", () => {
    expect(() => assertAgentCallBindingEvidence(validConfig({ endpointRef: "" }))).toThrow(
      AgentCallBindingEvidenceError,
    );
    expect(() => assertAgentCallBindingEvidence(validConfig({ networkZone: "" }))).toThrow(
      AgentCallBindingEvidenceError,
    );
    expect(() => assertAgentCallBindingEvidence(validConfig({ protocolType: "" }))).toThrow(
      AgentCallBindingEvidenceError,
    );
    expect(() =>
      assertAgentCallBindingEvidence(validConfig({ protocolContractRevision: "" })),
    ).toThrow(AgentCallBindingEvidenceError);
    expect(() => assertAgentCallBindingEvidence(validConfig({ endpointRef: "   " }))).toThrow(
      AgentCallBindingEvidenceError,
    );
    expect(() => assertAgentCallBindingEvidence(validConfig({ networkZone: "\t" }))).toThrow(
      AgentCallBindingEvidenceError,
    );
  });

  it("policy/governance 必须冻结", () => {
    expect(() => assertAgentCallBindingEvidence(validConfig({ policyRevisionId: "" }))).toThrow(
      AgentCallBindingEvidenceError,
    );
    expect(() =>
      assertAgentCallBindingEvidence(validConfig({ governanceConfigDigest: "nope" })),
    ).toThrow(AgentCallBindingEvidenceError);
  });

  it("config hash 对任意证据字段变化敏感（证据不可变）", () => {
    const base = validConfig();
    const hash = computeAgentCallBindingHash(base);
    expect(
      computeAgentCallBindingHash(validConfig({ endpointRef: "https://other.example.com" })),
    ).not.toBe(hash);
    expect(computeAgentCallBindingHash(validConfig({ agentRevisionId: "agent-rev-2" }))).not.toBe(
      hash,
    );
    expect(computeAgentCallBindingHash(validConfig({ routeContentDigest: D("9") }))).not.toBe(hash);
    expect(computeAgentCallBindingHash(validConfig({ projectionVersionNo: 4 }))).not.toBe(hash);
  });

  it("config hash 对字段顺序不敏感（规范化排序）", () => {
    expect(computeAgentCallBindingHash(validConfig())).toBe(
      computeAgentCallBindingHash(validConfig()),
    );
  });

  it("projectionVersionNo 必须为正整数，0 不得伪装成有效投影版本", () => {
    expect(() => computeAgentCallBindingHash(validConfig({ projectionVersionNo: -1 }))).toThrow(
      AgentCallBindingEvidenceError,
    );
    expect(() => computeAgentCallBindingHash(validConfig({ projectionVersionNo: 0 }))).toThrow(
      AgentCallBindingEvidenceError,
    );
  });
  it("冻结企业用户上下文时只接受安全投影，拒绝权限、数据范围和未登记字段", () => {
    const validContext: EnterpriseUserPublicContext = {
      context_version: "1",
      profile_status: "fresh",
      last_verified_at: "2026-09-05T00:00:00.000Z",
      fields: { employeeNo: "E-001" },
    };
    expect(() =>
      assertAgentCallBindingEvidence(validConfig({ enterpriseUserContext: validContext })),
    ).not.toThrow();
    const forbiddenFields: Record<string, unknown>[] = [
      { enterprisePermissions: ["payroll.read"] },
      { dataScopes: ["factory-a"] },
      { unknownField: "value" },
    ];
    for (const fields of forbiddenFields) {
      expect(() =>
        assertAgentCallBindingEvidence(
          validConfig({ enterpriseUserContext: { ...validContext, fields: fields as never } }),
        ),
      ).toThrow(AgentCallBindingEvidenceError);
    }
  });

  it("冻结企业用户上下文时拒绝非法版本、状态和验证时间", () => {
    for (const enterpriseUserContext of [
      {
        context_version: "2",
        profile_status: "fresh",
        last_verified_at: "2026-09-05T00:00:00.000Z",
        fields: {},
      },
      {
        context_version: "1",
        profile_status: "unavailable",
        last_verified_at: "2026-09-05T00:00:00.000Z",
        fields: {},
      },
      {
        context_version: "1",
        profile_status: "fresh",
        last_verified_at: "not-a-date",
        fields: {},
      },
    ]) {
      expect(() =>
        assertAgentCallBindingEvidence(
          validConfig({ enterpriseUserContext: enterpriseUserContext as never }),
        ),
      ).toThrow(AgentCallBindingEvidenceError);
    }
  });
});
