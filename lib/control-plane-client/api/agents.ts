/**
 * Agent API Client — 消费 /admin/api/agents 端点。
 *
 * 使用 control-plane-client/contracts 中的稳定 DTO。
 */

import type {
  AgentContractListResponse,
  AgentDTO,
  AgentListResponse,
  AgentRevisionDTO,
  AgentRevisionListResponse,
  AgentRevisionSummaryDTO,
  CreateAgentRevisionRequest,
  PublishAgentRevisionRequest,
  PublishAgentRevisionResponse,
  RegisterAgentContractRequest,
  RegisterAgentContractResponse,
  WithdrawAgentRevisionRequest,
  WithdrawAgentRevisionResponse,
} from "../contracts/agent";
import { type ApiClientConfig, createControlPlaneRequest } from "../http-client";

/** Agent API Client。 */
export interface AgentApiClient {
  /** 列出 Agent。 */
  list(): Promise<AgentListResponse>;
  delete(agentId: string, opts: { ifMatch: string }): Promise<{ id: string; deleted: true }>;
  /** 获取 Agent 详情。 */
  get(agentId: string): Promise<AgentDTO>;
  /** 列出 AgentRevision。 */
  listRevisions(agentId: string): Promise<AgentRevisionListResponse>;
  /** 列出已导入并结构化保存的合同快照。 */
  listContracts(agentId: string): Promise<AgentContractListResponse>;
  /** 获取 AgentRevision 详情。 */
  getRevision(revisionId: string): Promise<AgentRevisionDTO>;
  /**
   * 登记 Public Agent Contract（07 §4：POST /admin/api/agent-registrations）。
   * 只发送 protocol + contract；禁止 URL/Git/源码路径/endpoint/凭证字段。
   */
  registerContract(
    body: RegisterAgentContractRequest,
    opts: { idempotencyKey: string },
  ): Promise<RegisterAgentContractResponse>;
  /** 创建 Draft AgentRevision。 */
  createRevision(
    agentId: string,
    body: CreateAgentRevisionRequest,
    opts: { idempotencyKey: string },
  ): Promise<AgentRevisionSummaryDTO>;
  /** 发布 AgentRevision。 */
  publishRevision(
    revisionId: string,
    body: PublishAgentRevisionRequest,
    opts: { idempotencyKey: string; ifMatch: string },
  ): Promise<PublishAgentRevisionResponse>;
  /** 撤回 AgentRevision。 */
  withdrawRevision(
    revisionId: string,
    body: WithdrawAgentRevisionRequest,
    opts: { idempotencyKey: string; ifMatch: string },
  ): Promise<WithdrawAgentRevisionResponse>;
}

/** 创建 Agent API Client。 */
export function createAgentApiClient(config: ApiClientConfig): AgentApiClient {
  const request = createControlPlaneRequest(config);

  return {
    delete: (agentId, opts) =>
      request(`/admin/api/agents/${agentId}`, {
        method: "DELETE",
        headers: { "If-Match": opts.ifMatch },
      }),
    list: () => request<AgentListResponse>("/admin/api/agents"),
    get: (agentId) => request<AgentDTO>(`/admin/api/agents/${agentId}`),
    listRevisions: (agentId) =>
      request<AgentRevisionListResponse>(`/admin/api/agents/${agentId}/revisions`),
    listContracts: (agentId) =>
      request<AgentContractListResponse>(`/admin/api/agents/${agentId}/contracts`),
    getRevision: (revisionId) =>
      request<AgentRevisionDTO>(`/admin/api/agent-revisions/${revisionId}`),
    registerContract: (body, opts) =>
      request<RegisterAgentContractResponse>("/admin/api/agent-registrations", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Idempotency-Key": opts.idempotencyKey },
      }),
    createRevision: (agentId, body, opts) =>
      request<AgentRevisionSummaryDTO>(`/admin/api/agents/${agentId}/revisions`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Idempotency-Key": opts.idempotencyKey },
      }),
    publishRevision: (revisionId, body, opts) =>
      request<PublishAgentRevisionResponse>(`/admin/api/agent-revisions/${revisionId}/publish`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Idempotency-Key": opts.idempotencyKey,
          "If-Match": opts.ifMatch,
        },
      }),
    withdrawRevision: (revisionId, body, opts) =>
      request<WithdrawAgentRevisionResponse>(`/admin/api/agent-revisions/${revisionId}/withdraw`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Idempotency-Key": opts.idempotencyKey,
          "If-Match": opts.ifMatch,
        },
      }),
  };
}
