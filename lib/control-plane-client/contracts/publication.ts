/**
 * Publication / Withdrawal 控制面合同 — 稳定 DTO。
 *
 * Publication 和 Withdrawal 是不可变事件记录。
 * 客户端禁止通过 revisionState 推断 Publication 状态 —
 * 必须消费 publication_record_id 和 withdrawal_record_id 字段。
 */

/** Publication 主体类型。 */
export type PublicationSubjectType = "agent_revision" | "runtime_revision";

/** Publication 执行者类型。 */
export type PublicationActorType = "user" | "system" | "workload";

/** PublicationRecord 详情。 */
export interface PublicationRecordDTO {
  id: string;
  tenant_id: string;
  subject_type: PublicationSubjectType;
  subject_id: string;
  actor_type: PublicationActorType;
  actor_id: string;
  /** 发布时绑定的 Attestation — 不可变。 */
  attestation_ids: string[];
  /** 发布时绑定的 Conformance Run — 不可变。 */
  conformance_run_id: string | null;
  reason: string | null;
  published_at: string;
}

/** WithdrawalRecord 详情。 */
export interface WithdrawalRecordDTO {
  id: string;
  tenant_id: string;
  subject_type: PublicationSubjectType;
  subject_id: string;
  actor_type: PublicationActorType;
  actor_id: string;
  reason: string;
  withdrawn_at: string;
}

/** Publication 列表响应。 */
export interface PublicationListResponse {
  items: PublicationRecordDTO[];
  total: number;
}

/** Withdrawal 列表响应。 */
export interface WithdrawalListResponse {
  items: WithdrawalRecordDTO[];
  total: number;
}
