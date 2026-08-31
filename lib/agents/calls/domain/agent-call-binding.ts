/**
 * AgentCallBinding — AgentCall 的不可变运行绑定。
 *
 * 回答：某次 AgentCall 用哪个 exact AgentRevision、通过哪个部署路由、用什么协议和
 * 凭据调用哪个外部 Agent。
 *
 * AgentCallBinding 在 AgentCall 创建时一次性冻结以下证据，之后不允许修改：
 * - exact AgentRevision + AgentContractSnapshot（contract/capability/context digest）；
 * - Agent Publication；
 * - exact Agent Route / RouteRevision / RouteActivation（targetKind=agent）；
 * - endpoint / identity / credential reference / networkZone / protocol；
 * - resolution digest / projection version；
 * - policy / governance 等真正相关证据。
 *
 * 关键边界：AgentCall evidence 绝不放回顶层 ExecutionBinding。ExecutionBinding 只绑定
 * Harness Runtime；AgentCallBinding 是 AgentCall 子执行域自己的证据容器。
 *
 * 不可变：binding 只有 create，没有 update；evidence 字段冻结后不允许变更。
 */

import { createHash } from "node:crypto";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const AGENT_IDENTITY_MODES = ["none", "bearer"] as const;
export type AgentIdentityMode = (typeof AGENT_IDENTITY_MODES)[number];

/**
 * AgentCallBinding 冻结配置（创建时一次性冻结）。
 */
export interface AgentCallBindingConfigInput {
  /** exact Agent.id（stable 能力资产）。 */
  agentId: string;
  /** exact AgentRevision.id（published 修订）。 */
  agentRevisionId: string;
  /** AgentContractSnapshot.id（黑盒合同 Authority）。 */
  agentContractSnapshotId: string;
  /** 合同 canonical digest（sha256: 前缀）。 */
  agentContractDigest: string;
  /** 合同 capability digest（sha256: 前缀）。 */
  agentCapabilityDigest: string;
  /** 合同 context digest（sha256: 前缀）。 */
  agentContextDigest: string;
  /** Agent PublicationRecord.id。 */
  agentPublicationRecordId: string;

  // ─── exact Agent Route（targetKind=agent）──────────
  deploymentRouteId: string;
  routeRevisionId: string;
  routeActivationId: string;
  /** Route 内容摘要（sha256: 前缀）。 */
  routeContentDigest: string;
  /** Resolver 输入摘要 — 冻结解析时刻的请求参数 Digest。 */
  resolutionInputDigest: string;
  /** Projection 版本号 — 检测 Projection 滞后。 */
  projectionVersionNo: number;

  // ─── endpoint / identity / credential / protocol ─────────
  /** 外部 Agent endpoint 引用（URL 或 managed endpoint 引用）。 */
  endpointRef: string;
  identityMode: AgentIdentityMode;
  /** 按 identityMode 条件要求；bearer 必填，none 可为 null。 */
  credentialRefId: string | null;
  networkZone: string;
  /** 协议类型（如 a2a）。 */
  protocolType: string;
  /** 协议合同修订（来自 AgentContractSnapshot，权威）。 */
  protocolContractRevision: string;

  // ─── policy / governance（真正相关证据）─────────────────
  policyRevisionId: string;
  policyRulesDigest: string;
  governanceConfigRevisionId: string;
  governanceConfigDigest: string;
}

/** Resolver/Application 提交给最终事务的候选；事务成功前不代表已冻结事实。 */
export type AgentCallBindingCandidate = AgentCallBindingConfigInput;

export interface AgentCallBinding extends AgentCallBindingConfigInput {
  callId: string;
  tenantId: string;
  /** 规范化证据的 SHA-256 digest — evidence 不可变的直接证明。 */
  bindingHash: string;
  boundAt: Date;
}

export class AgentCallBindingEvidenceError extends Error {
  constructor(message: string) {
    super(`AgentCallBinding 控制面证据无效：${message}`);
    this.name = "AgentCallBindingEvidenceError";
  }
}

export class AgentCallBindingAlreadyExistsError extends Error {
  constructor(callId: string) {
    super(`AgentCall ${callId} 已存在 AgentCallBinding`);
    this.name = "AgentCallBindingAlreadyExistsError";
  }
}

/**
 * 计算 AgentCallBinding 规范化证据 digest。
 *
 * 任意证据字段变化 → digest 变化 → 证明 binding 不可变冻结（evidence 一致性可审计）。
 */
export function computeAgentCallBindingHash(input: AgentCallBindingConfigInput): string {
  assertAgentCallBindingEvidence(input);
  if (!Number.isInteger(input.projectionVersionNo) || input.projectionVersionNo <= 0) {
    throw new AgentCallBindingEvidenceError("projectionVersionNo 必须为正整数");
  }
  const canonical = JSON.stringify(sortKeys(input));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * 校验 AgentCallBinding 证据完整性（fail-closed）。
 *
 * - Agent 证据四元组（contract/capability/context digest + publication）必须完整。
 * - Route / resolution / projection 证据必须完整。
 * - digest 必须带 sha256: 前缀。
 * - bearer identityMode 必须带 credentialRefId；none 不得带。
 */
export function assertAgentCallBindingEvidence(input: AgentCallBindingConfigInput): void {
  const agentDigests = [
    input.agentContractDigest,
    input.agentCapabilityDigest,
    input.agentContextDigest,
  ];
  if (agentDigests.some((value) => !SHA256.test(value))) {
    throw new AgentCallBindingEvidenceError("Agent contract/capability/context digest 格式非法");
  }
  const identifiers = [
    input.agentId,
    input.agentRevisionId,
    input.agentContractSnapshotId,
    input.agentPublicationRecordId,
    input.deploymentRouteId,
    input.routeRevisionId,
    input.routeActivationId,
  ];
  if (identifiers.some(isBlankString)) {
    throw new AgentCallBindingEvidenceError("缺少 Agent/Route/Publication 引用");
  }
  if (!SHA256.test(input.routeContentDigest) || !SHA256.test(input.resolutionInputDigest)) {
    throw new AgentCallBindingEvidenceError("routeContentDigest/resolutionInputDigest 格式非法");
  }
  if (isBlankString(input.endpointRef)) {
    throw new AgentCallBindingEvidenceError("AgentCall 必须冻结 endpointRef");
  }
  if (isBlankString(input.networkZone)) {
    throw new AgentCallBindingEvidenceError("AgentCall 必须冻结 networkZone");
  }
  if (isBlankString(input.protocolType) || isBlankString(input.protocolContractRevision)) {
    throw new AgentCallBindingEvidenceError("AgentCall 必须冻结 protocol 事实");
  }
  if (!AGENT_IDENTITY_MODES.includes(input.identityMode)) {
    throw new AgentCallBindingEvidenceError(`identityMode 非法: ${input.identityMode}`);
  }
  if (input.identityMode === "bearer" && isBlankString(input.credentialRefId)) {
    throw new AgentCallBindingEvidenceError("bearer identityMode 必须冻结 credentialRefId");
  }
  if (input.identityMode === "none" && input.credentialRefId) {
    throw new AgentCallBindingEvidenceError("none identityMode 不允许携带 credentialRefId");
  }
  if (isBlankString(input.policyRevisionId) || !SHA256.test(input.policyRulesDigest)) {
    throw new AgentCallBindingEvidenceError("AgentCall 必须冻结有效 policy 证据");
  }
  if (
    isBlankString(input.governanceConfigRevisionId) ||
    !SHA256.test(input.governanceConfigDigest)
  ) {
    throw new AgentCallBindingEvidenceError("AgentCall 必须冻结有效 governance 证据");
  }
}

function isBlankString(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return result;
}
