/**
 * Agent 控制面合同 — 稳定 DTO。
 *
 * Web 端和桌面端共用此合同消费服务端 API。
 * 合同字段与 /admin/api/v1 wire format (snake_case) 对齐。
 *
 * 禁止：
 * - 页面直接引用数据库 Record；
 * - 通过 currentRevisionId 推断执行资格；
 * - 通过 revisionState 推断 Publication 状态。
 */

// ─── Agent ────────────────────────────────────────────────

/** Agent 生命周期状态 — 服务端权威枚举。 */
export type AgentLifecycleState = "enabled" | "disabled" | "deleted";

/** Agent 列表项（不含 Revision 详情）。 */
export interface AgentDTO {
  id: string;
  agent_key: string;
  display_name: string;
  description: string | null;
  lifecycle_state: AgentLifecycleState;
  current_revision_id: string | null;
  owner_user_id: string | null;
  visibility_policy_id: string | null;
  updated_at: string | null;
}

/** Agent 列表响应。 */
export interface AgentListResponse {
  items: AgentDTO[];
  total: number;
}

// ─── AgentRevision ────────────────────────────────────────

/** AgentRevision 状态 — 服务端权威枚举。 */
export type AgentRevisionState = "draft" | "published" | "withdrawn";

/** AgentRevision 来源。 */
export type AgentRevisionSourceType = "upload" | "import" | "system";

/** AgentRevision 详情。 */
export interface AgentRevisionDTO {
  id: string;
  agent_id: string;
  revision_state: AgentRevisionState;
  source_type: AgentRevisionSourceType;
  artifact_digest: string | null;
  artifact_ref: string | null;
  /** 当前 Attestation 列表 — 不为 null 时表示已验证。 */
  attestation_ids: string[] | null;
  /** 当前 Publication Record — 不为 null 时表示已发布。 */
  publication_record_id: string | null;
  /** 当前 Withdrawal Record — 不为 null 时表示已撤回。 */
  withdrawal_record_id: string | null;
  /** 执行资格 — 由服务端 Eligibility Policy 计算，客户端禁止推断。 */
  execution_eligible: boolean;
  /** 资格不足原因 — eligible 为 false 时非空。 */
  ineligibility_reasons: string[];
  created_at: string;
  updated_at: string | null;
}

/** AgentRevision 列表响应。 */
export interface AgentRevisionListResponse {
  items: AgentRevisionDTO[];
  total: number;
}

/** 创建 Draft AgentRevision 请求。 */
export interface CreateAgentRevisionRequest {
  artifact_ref: string;
  artifact_digest: string;
}
