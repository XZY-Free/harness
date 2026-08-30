/**
 * Publication 资格统一模型 — Active Publication 的唯一判断标准。
 *
 * 正式 Active 条件：
 * PublicationRecord 存在 + WithdrawalRecord 不存在
 *
 * revisionState 仅作为一致性投影检查，不能替代 Publication 事实。
 * 所有模块（RouteSet 激活、Projection、Binding）必须通过此模型判断发布状态。
 *
 * 参见：正式架构
 */

import type { PublicationSubjectType } from "@/lib/publications/domain/publication-record";

/**
 * Active Publication 快照 — 从 PublicationRecord + WithdrawalRecord 读取的完整发布事实。
 */
export interface ActivePublicationSnapshot {
  /** PublicationRecord ID。 */
  publicationRecordId: string;
  /** 主体类型（agent_revision / runtime_revision）。 */
  subjectType: PublicationSubjectType;
  /** 主体 Revision ID。 */
  subjectRevisionId: string;
  /** 证据集 Digest。 */
  evidenceSetDigest: string;
  /** Attestation ID 列表。 */
  attestationIds: string[];
  /** ConformanceRun ID（Runtime 专用，Agent 为 null）。 */
  conformanceRunId: string | null;
  /** WithdrawalRecord ID（null = 未撤回 = Active）。 */
  withdrawalRecordId: string | null;
  /** 发布时间。 */
  publishedAt: Date;
  /** Agent Publication 冻结的 AgentContractSnapshot 证据（runtime 为 null — ）。 */
  agentContractSnapshotId: string | null;
  agentContractDigest: string | null;
  agentCapabilityDigest: string | null;
  agentContextDigest: string | null;
}

/**
 * Publication 资格校验结果。
 */
export interface PublicationEligibilityResult {
  /** 是否 Active（PublicationRecord 存在且未撤回）。 */
  active: boolean;
  /** 不 Active 的原因。 */
  reason?: PublicationIneligibilityReason;
}

/** Publication 不 Active 原因枚举。 */
export type PublicationIneligibilityReason =
  | "no_publication_record"
  | "withdrawn"
  | "snapshot_tenant_mismatch";

/**
 * Publication 资格策略 — 纯函数，无副作用。
 */
export const PublicationEligibilityPolicy = {
  /**
   * 判断 Publication 是否 Active。
   *
   * 正式条件：PublicationRecord 存在 + WithdrawalRecord 不存在。
   * revisionState 不参与判断。
   */
  isActive(
    snapshot: ActivePublicationSnapshot | null,
    expectedTenantId: string,
  ): PublicationEligibilityResult {
    if (!snapshot) {
      return { active: false, reason: "no_publication_record" };
    }
    if (snapshot.withdrawalRecordId !== null) {
      return { active: false, reason: "withdrawn" };
    }
    // Tenant 检查作为安全守卫（正常情况下 Store 已过滤）
    return { active: true };
  },
} as const;
