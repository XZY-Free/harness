/**
 * Agent API Client — 消费 /admin/api/v1/agents 端点。
 *
 * 使用 control-plane-client/contracts 中的稳定 DTO。
 */

import type {
  AgentDTO,
  AgentListResponse,
  AgentRevisionDTO,
  AgentRevisionListResponse,
  CreateAgentRevisionRequest,
} from "../contracts/agent";
import type { ControlPlaneError } from "../errors/control-plane-error";

/** API Client 基础配置。 */
export interface ApiClientConfig {
  baseUrl: string;
  headers: () => Record<string, string>;
}

/** Agent API Client。 */
export interface AgentApiClient {
  /** 列出 Agent。 */
  list(): Promise<AgentListResponse>;
  /** 获取 Agent 详情。 */
  get(agentId: string): Promise<AgentDTO>;
  /** 列出 AgentRevision。 */
  listRevisions(agentId: string): Promise<AgentRevisionListResponse>;
  /** 获取 AgentRevision 详情。 */
  getRevision(revisionId: string): Promise<AgentRevisionDTO>;
  /** 创建 Draft AgentRevision。 */
  createRevision(agentId: string, body: CreateAgentRevisionRequest): Promise<AgentRevisionDTO>;
  /** 发布 AgentRevision。 */
  publishRevision(revisionId: string): Promise<AgentRevisionDTO>;
  /** 撤回 AgentRevision。 */
  withdrawRevision(revisionId: string, reason: string): Promise<AgentRevisionDTO>;
}

/** 创建 Agent API Client。 */
export function createAgentApiClient(config: ApiClientConfig): AgentApiClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${config.baseUrl}${path}`;
    const headers = { ...config.headers(), "Content-Type": "application/json" };
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(body.message ?? `HTTP ${res.status}`), {
        code: body.code,
        request_id: body.request_id,
        details: body.details,
      } as ControlPlaneError);
    }
    return res.json();
  }

  return {
    list: () => request<AgentListResponse>("/admin/api/v1/agents"),
    get: (agentId) => request<AgentDTO>(`/admin/api/v1/agents/${agentId}`),
    listRevisions: (agentId) =>
      request<AgentRevisionListResponse>(`/admin/api/v1/agents/${agentId}/revisions`),
    getRevision: (revisionId) =>
      request<AgentRevisionDTO>(`/admin/api/v1/agent-revisions/${revisionId}`),
    createRevision: (agentId, body) =>
      request<AgentRevisionDTO>(`/admin/api/v1/agents/${agentId}/revisions`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    publishRevision: (revisionId) =>
      request<AgentRevisionDTO>(`/admin/api/v1/agent-revisions/${revisionId}:publish`, {
        method: "POST",
      }),
    withdrawRevision: (revisionId, reason) =>
      request<AgentRevisionDTO>(`/admin/api/v1/agent-revisions/${revisionId}:withdraw`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
  };
}
