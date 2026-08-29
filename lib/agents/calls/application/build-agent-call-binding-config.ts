/**
 * buildAgentCallBindingConfig — 从 Agent Route 解析结果构建不可变冻结配置。
 *
 * 专题01 冻结架构：AgentCallBinding 冻结 exact AgentRevision / Contract / Publication /
 * Route / endpoint / credential / resolution digest / projection / policy。
 *
 * endpoint/identity/credential/network 事实直接冻结自本次 exact Agent Route 解析结果
 * （Batch4 补漏：Agent Route/RouteRevision 承载生产调用事实，RouteResolver 解析 agent
 * target 时返回，Batch7 直接冻结，不另设第二套 endpoint authority）。
 * protocol 事实以 exact AgentContractSnapshot 为权威（Route 不维护第二份协议真相），
 * 由调用方从 ContractSnapshot 提供。本 builder 只做证据装配 + fail-closed 校验。
 */
import {
  type AgentCallBindingConfigInput,
  AgentCallBindingEvidenceError,
  assertAgentCallBindingEvidence,
} from "@/lib/agents/calls/domain/agent-call-binding";
import type { RouteResolution } from "@/lib/routes/domain/route-resolution-policy";

/** 协议事实（来自 exact AgentContractSnapshot，权威）。 */
export interface AgentProtocolFacts {
  protocolType: string;
  protocolContractRevision: string;
}

export interface BuildAgentCallBindingConfigInput {
  tenantId: string;
  /** Batch4/7 完成的 exact Agent Route 解析结果（agent target 携带 endpoint 事实）。 */
  resolution: RouteResolution;
  agentId: string;
  agentRevisionId: string;
  agentContractSnapshotId: string;
  agentContractDigest: string;
  agentCapabilityDigest: string;
  agentContextDigest: string;
  agentPublicationRecordId: string;
  /** 协议事实（以 exact AgentContractSnapshot 为权威）。 */
  protocolFacts: AgentProtocolFacts;
  policyRevisionId: string;
  policyRulesDigest: string;
  governanceConfigRevisionId: string;
  governanceConfigDigest: string;
}

/**
 * 构建并校验 AgentCallBinding 冻结配置。
 * 返回不可变配置；任何证据缺失/非法 → AgentCallBindingEvidenceError（fail-closed）。
 */
export function buildAgentCallBindingConfig(
  input: BuildAgentCallBindingConfigInput,
): AgentCallBindingConfigInput {
  const resolution = input.resolution;
  if (resolution.targetKind !== "agent") {
    throw new AgentCallBindingEvidenceError(
      `AgentCallBinding 只能从 targetKind=agent 的 RouteResolution 冻结（收到 ${resolution.targetKind}）`,
    );
  }
  const config: AgentCallBindingConfigInput = {
    agentId: input.agentId,
    agentRevisionId: input.agentRevisionId,
    agentContractSnapshotId: input.agentContractSnapshotId,
    agentContractDigest: input.agentContractDigest,
    agentCapabilityDigest: input.agentCapabilityDigest,
    agentContextDigest: input.agentContextDigest,
    agentPublicationRecordId: input.agentPublicationRecordId,
    deploymentRouteId: resolution.deploymentRouteId,
    routeRevisionId: resolution.routeRevisionId,
    routeActivationId: resolution.routeActivationId,
    routeContentDigest: resolution.routeContentDigest,
    resolutionInputDigest: resolution.resolutionInputDigest,
    projectionVersionNo: resolution.projectionVersionNo ?? 0,
    // 直接冻结 RouteResolution 的 exact agent route facts（Batch4 补漏）。
    endpointRef: resolution.agentEndpointRef ?? "",
    identityMode: resolution.agentIdentityMode ?? "none",
    credentialRefId: resolution.agentCredentialRefId ?? null,
    networkZone: resolution.agentNetworkZone ?? "",
    protocolType: input.protocolFacts.protocolType,
    protocolContractRevision: input.protocolFacts.protocolContractRevision,
    policyRevisionId: input.policyRevisionId,
    policyRulesDigest: input.policyRulesDigest,
    governanceConfigRevisionId: input.governanceConfigRevisionId,
    governanceConfigDigest: input.governanceConfigDigest,
  };
  assertAgentCallBindingEvidence(config);
  return config;
}
