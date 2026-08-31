/**
 * AgentSessionBinding Store — 仓储接口。
 *
 * A2A contextId 只映射到 AgentSessionBinding.externalContextRef。
 * 查询按 tenant 隔离；复用匹配维度 Tenant + Thread + AgentRevision + RouteRevision + active。
 */
import type { AgentSessionBinding } from "@/lib/agents/calls/domain/agent-session-binding";

export interface StoreAgentSessionBindingInput {
  id: string;
  tenantId: string;
  threadId: string;
  agentId: string;
  agentRevisionId: string;
  deploymentRouteId: string;
  routeRevisionId: string;
  externalContextRef: string;
  now: Date;
}

export interface AgentSessionBindingStore {
  /** 幂等创建：UNIQUE(tenantId, agentRevisionId, routeRevisionId, externalContextRef) 冲突返回已存在。 */
  create(input: StoreAgentSessionBindingInput): Promise<AgentSessionBinding>;
  /** 按外部上下文精确查找同 Agent 会话（cross-tenant 隔离）。 */
  getByContext(params: {
    tenantId: string;
    agentId: string;
    externalContextRef: string;
  }): Promise<AgentSessionBinding | null>;
  /** 关闭会话（仅 active → closed）。 */
  close(params: {
    id: string;
    tenantId: string;
    now: Date;
  }): Promise<AgentSessionBinding>;
  /** 标记 lost（active → lost）。 */
  markLost(params: { id: string; tenantId: string; now: Date }): Promise<AgentSessionBinding>;
}
