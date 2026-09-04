/**
 * AgentSessionBinding — Agent 会话的持久化外部上下文绑定。
 *
 * 冻结映射：
 * - A2A contextId → AgentSessionBinding.externalContextRef
 * - A2A taskId     → AgentCallAttempt.externalTaskRef
 *
 * 禁止：
 * - contextId → RuntimeSessionBinding
 * - taskId     → Invocation.runtimeExecutionRef
 *
 * AgentSessionBinding 是 Agent 会话的连续容器：复用匹配维度
 * Tenant + Thread + AgentRevision + active Route endpoint + active state。
 *
 * 状态：
 * - active：Agent 会话活跃。
 * - closed：显式关闭。
 * - lost：心跳超时或自报丢失。
 */

export const AGENT_SESSION_BINDING_STATES = ["active", "closed", "lost"] as const;
export type AgentSessionBindingState = (typeof AGENT_SESSION_BINDING_STATES)[number];

export interface AgentSessionBinding {
  id: string;
  tenantId: string;
  threadId: string | null;
  /** stable Agent.id。 */
  agentId: string;
  /** exact AgentRevision.id。 */
  agentRevisionId: string;
  deploymentRouteId: string;
  routeRevisionId: string;
  /** A2A contextId — 平台仅持久化，不解析其内容。 */
  externalContextRef: string;
  bindingState: AgentSessionBindingState;
  createdAt: Date;
  lastUsedAt: Date;
  closedAt: Date | null;
}

export function isAgentSessionBindingActive(state: AgentSessionBindingState): boolean {
  return state === "active";
}
