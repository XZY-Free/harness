/**
 * buildAgentCallBindingConfig — 从 Agent Route 解析结果 + endpoint 事实构建不可变冻结配置。
 *
 * 专题01 冻结架构：AgentCallBinding 冻结 exact AgentRevision / Contract / Publication /
 * Route / endpoint / credential / resolution digest / projection / policy。
 *
 * 本 builder 只做证据装配 + 校验（assertAgentCallBindingEvidence fail-closed）。
 * endpoint/credential/networkZone 等 endpoint 事实由调用方提供（Batch6 从 Agent Route
 * 权威读取；Batch5 测试用明确 test fake）。本 builder 不解析 AgentRevision，不触碰 Runtime。
 */
import {
  type AgentCallBindingConfigInput,
  assertAgentCallBindingEvidence,
} from "@/lib/agents/calls/domain/agent-call-binding";
import type { RouteResolution } from "@/lib/routes/domain/route-resolution-policy";

export interface AgentEndpointFacts {
  endpointRef: string;
  identityMode: "none" | "bearer";
  credentialRefId: string | null;
  networkZone: string;
  /** 协议事实以 exact AgentContractSnapshot 为权威（Route 不再维护第二份协议真相）。 */
  protocolType: string;
  protocolContractRevision: string;
}

export interface BuildAgentCallBindingConfigInput {
  tenantId: string;
  /** Batch4 完成的 exact Agent Route 解析结果。 */
  resolution: RouteResolution;
  agentId: string;
  agentRevisionId: string;
  agentContractSnapshotId: string;
  agentContractDigest: string;
  agentCapabilityDigest: string;
  agentContextDigest: string;
  agentPublicationRecordId: string;
  endpointFacts: AgentEndpointFacts;
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
  const config: AgentCallBindingConfigInput = {
    agentId: input.agentId,
    agentRevisionId: input.agentRevisionId,
    agentContractSnapshotId: input.agentContractSnapshotId,
    agentContractDigest: input.agentContractDigest,
    agentCapabilityDigest: input.agentCapabilityDigest,
    agentContextDigest: input.agentContextDigest,
    agentPublicationRecordId: input.agentPublicationRecordId,
    deploymentRouteId: input.resolution.deploymentRouteId,
    routeRevisionId: input.resolution.routeRevisionId,
    routeActivationId: input.resolution.routeActivationId,
    routeContentDigest: input.resolution.routeContentDigest,
    resolutionInputDigest: input.resolution.resolutionInputDigest,
    projectionVersionNo: input.resolution.projectionVersionNo ?? 0,
    endpointRef: input.endpointFacts.endpointRef,
    identityMode: input.endpointFacts.identityMode,
    credentialRefId: input.endpointFacts.credentialRefId,
    networkZone: input.endpointFacts.networkZone,
    protocolType: input.endpointFacts.protocolType,
    protocolContractRevision: input.endpointFacts.protocolContractRevision,
    policyRevisionId: input.policyRevisionId,
    policyRulesDigest: input.policyRulesDigest,
    governanceConfigRevisionId: input.governanceConfigRevisionId,
    governanceConfigDigest: input.governanceConfigDigest,
  };
  assertAgentCallBindingEvidence(config);
  return config;
}
