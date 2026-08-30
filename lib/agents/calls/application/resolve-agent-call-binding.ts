import { buildAgentCallBindingCandidate } from "@/lib/agents/calls/application/build-agent-call-binding-config";
import type { AgentCallBindingCandidate } from "@/lib/agents/calls/domain/agent-call-binding";
/**
 * resolveRequiredAgentBinding — 解析 Agent target Route 并装配 AgentCallBinding candidate
 * Harness 与 Gateway 共用这一条 exact binding 解析路径。
 *
 * 单一冻结链（唯一 Route Authority）：
 *   resolveRoute(target={kind:"agent", agentId}) → 断言 agent target + AgentRevision
 *   → 读取 exact AgentContractSnapshot（capabilityDigest + protocol 事实，权威）
 *   → buildAgentCallBindingCandidate 装配候选事实
 *     （endpoint/identity/credential/network 直接来自 RouteResolution）。
 *
 * harness-required-agent（Harness Loop 进程内）与 Gateway AgentCall endpoints（HTTP）
 * 共用同一冻结链，不重复 Domain，保证 hosted 与 external Runtime 走同一正式路径。
 *
 * 事实源：
 * - docs/architecture/agent-control-plane.md
 * - docs/architecture/api-and-events.md
 * - 冻结架构：Agent Route Authority 是唯一 Agent target 权威。
 */
import { mysqlAgentContractStore } from "@/lib/agents/persistence/agent-contract-store";
import { db } from "@/lib/db/client";
import { resolveBindingGovernance } from "@/lib/executions/application/resolve-binding-governance";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type { RouteResolution } from "@/lib/routes/domain/route-resolution-policy";

/** required Agent 无法满足（fail closed）。 */
export class RequiredAgentUnavailableError extends Error {
  constructor(agentId: string, reason: string) {
    super(`required Agent ${agentId} 无法满足：${reason}`);
    this.name = "RequiredAgentUnavailableError";
  }
}

export interface ResolveRequiredAgentBindingParams {
  tenantId: string;
  agentId: string;
  /** Agent target Route Resolver（唯一 Route Authority）。 */
  resolveRoute: RouteResolver;
  routeScopeKey?: string;
  /** 确定性业务键（如 { threadId } 或 { invocationId }）。 */
  businessKey: Record<string, string>;
}

export interface ResolvedRequiredAgentBinding {
  resolution: RouteResolution;
  /** Resolver 组装的候选；只有 finalizeAgentCall 事务成功后才成为冻结 Binding。 */
  bindingCandidate: AgentCallBindingCandidate;
  agentRevisionId: string;
  contractSnapshotId: string;
  contractDigest: string;
  contextDigest: string;
  publicationRecordId: string;
}

/**
 * 解析 Agent target Route 并装配待最终事务验证的 AgentCallBinding candidate。
 * 失败即抛 RequiredAgentUnavailableError（fail closed）。
 */
export async function resolveRequiredAgentBinding(
  params: ResolveRequiredAgentBindingParams,
): Promise<ResolvedRequiredAgentBinding> {
  const { tenantId, agentId } = params;

  // 1. 解析 Agent Route（target={kind:"agent", agentId}）— 唯一 Route Authority。
  const routeOutcome = await params.resolveRoute({
    tenantId,
    target: { kind: "agent", agentId },
    routeScopeKey: params.routeScopeKey ?? "default",
    businessKey: params.businessKey,
  });
  if (routeOutcome.status !== "resolved") {
    throw new RequiredAgentUnavailableError(
      agentId,
      routeOutcome.status === "unresolved"
        ? routeOutcome.reason
        : "route 解析未找到 eligible Agent Route",
    );
  }
  const resolution = routeOutcome.resolution;
  // 判别式 agent target：只接受 resolution.target.kind=agent（runtime 一律 fail-closed）。
  // resolveRoute 按 target:{kind:"agent", agentId} 解析，Projection loader 已按 agentId
  // 过滤候选，resolution 必属于该 Agent；这里只断言确实是 agent target（不比较
  // agentRevisionId 与 agentId——二者本就不是同一身份：agentId 是 Agent.id，
  // agentRevisionId 是 AgentRevision.id，比较恒不成立）。agent target 必带 revision。
  if (resolution.target.kind !== "agent") {
    throw new RequiredAgentUnavailableError(agentId, "解析结果不是 agent Route");
  }
  const agentRevisionId = resolution.target.agentRevisionId;
  if (!agentRevisionId) {
    throw new RequiredAgentUnavailableError(agentId, "agent Route 缺少 AgentRevision");
  }

  // 2. 读取 exact AgentContractSnapshot（capabilityDigest + protocol 事实，权威）。
  // 已判定 target=agent 后仍须显式确认 controlPlaneEvidence.kind==="agent"（nested
  // discriminant 收窄不会自动关联 controlPlaneEvidence；矛盾时 fail-closed），
  // 只从 agent evidence 读取 Contract 字段，绝不把 runtime evidence 带入。
  if (resolution.controlPlaneEvidence.kind !== "agent") {
    throw new RequiredAgentUnavailableError(agentId, "Agent Route 缺少 exact Agent Contract 证据");
  }
  const contractSnapshotId = resolution.controlPlaneEvidence.agentContractSnapshotId;
  const contractDigest = resolution.controlPlaneEvidence.agentContractDigest;
  const contextDigest = resolution.controlPlaneEvidence.agentContextDigest;
  const publicationRecordId = resolution.controlPlaneEvidence.agentPublicationRecordId;
  if (!contractSnapshotId || !contractDigest || !contextDigest || !publicationRecordId) {
    throw new RequiredAgentUnavailableError(agentId, "Agent Route 缺少 exact Agent Contract 证据");
  }
  const snapshot = await mysqlAgentContractStore.transaction((s) =>
    s.findContractSnapshotById(tenantId, contractSnapshotId),
  );
  if (!snapshot) {
    throw new RequiredAgentUnavailableError(agentId, "AgentContractSnapshot 不存在");
  }

  // 3. 装配 AgentCallBinding candidate（endpoint facts 来自 RouteResolution；
  //    protocol facts 来自 ContractSnapshot）。
  const policy = await resolveBindingGovernance(db, tenantId, resolution.policyRevisionId);
  const bindingCandidate = buildAgentCallBindingCandidate({
    tenantId,
    resolution,
    agentId,
    agentRevisionId,
    agentContractSnapshotId: contractSnapshotId,
    agentContractDigest: contractDigest,
    agentCapabilityDigest: snapshot.capabilityDigest,
    agentContextDigest: contextDigest,
    agentPublicationRecordId: publicationRecordId,
    protocolFacts: {
      protocolType: snapshot.protocolType,
      protocolContractRevision: snapshot.protocolContractRevision,
    },
    policyRevisionId: policy.policyRevisionId,
    policyRulesDigest: policy.policyRulesDigest,
    governanceConfigRevisionId: policy.governanceConfigRevisionId,
    governanceConfigDigest: policy.governanceConfigDigest,
  });

  return {
    resolution,
    bindingCandidate,
    agentRevisionId,
    contractSnapshotId,
    contractDigest,
    contextDigest,
    publicationRecordId,
  };
}
