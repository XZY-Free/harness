/**
 * ControlPlaneCutoverItem — 切换计划中的单个资格重建项。
 *
 * 每个 Item 对应一个需要重新认证的 AgentRevision 或 RuntimeRevision。
 * Item 独立重试，独立保存 Checkpoint，独立管理租约。
 */

/** Item subjectType。 */
export const CUTOVER_ITEM_SUBJECT_TYPES = [
  "agent_revision",
  "runtime_revision",
] as const;
export type CutoverItemSubjectType = (typeof CUTOVER_ITEM_SUBJECT_TYPES)[number];

/** Item 状态机。 */
export const CUTOVER_ITEM_STATES = [
  "pending",
  "artifact_pending",
  "attestation_pending",
  "conformance_pending",
  "publication_pending",
  "ready",
  "failed",
  "manual_review",
] as const;
export type CutoverItemState = (typeof CUTOVER_ITEM_STATES)[number];

/** 资格分类。 */
export const QUALIFICATION_CATEGORIES = [
  "trusted",
  "legacy_projection_only",
  "missing_artifact",
  "missing_attestation",
  "missing_conformance",
  "withdrawn",
  "invalid_digest",
  "manual_review_needed",
] as const;
export type QualificationCategory = (typeof QUALIFICATION_CATEGORIES)[number];

/** CutoverItem 实体。 */
export interface ControlPlaneCutoverItem {
  id: string;
  planId: string;
  tenantId: string;
  subjectType: CutoverItemSubjectType;
  sourceSubjectId: string;
  replacementSubjectId: string | null;
  state: CutoverItemState;
  qualificationCategory: QualificationCategory;
  attemptCount: number;
  nextAttemptAt: Date | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Item 状态转换规则。 */
export function isValidItemTransition(
  from: CutoverItemState,
  to: CutoverItemState,
): boolean {
  const ALLOWED: Record<CutoverItemState, CutoverItemState[]> = {
    pending: ["artifact_pending", "ready", "failed", "manual_review"],
    artifact_pending: ["attestation_pending", "failed", "manual_review"],
    attestation_pending: ["conformance_pending", "publication_pending", "failed", "manual_review"],
    conformance_pending: ["publication_pending", "failed", "manual_review"],
    publication_pending: ["ready", "failed", "manual_review"],
    ready: [],
    failed: ["pending"], // 允许重试
    manual_review: ["pending"], // 允许人工干预后重试
  };
  return ALLOWED[from].includes(to);
}

/** 判断 Item 是否需要资格重建（非 trusted 且非 ready）。 */
export function itemNeedsRequalification(item: ControlPlaneCutoverItem): boolean {
  return item.qualificationCategory !== "trusted" && item.state !== "ready";
}

/** 判断 Item 是否可被 Worker 领取。 */
export function itemIsClaimable(item: ControlPlaneCutoverItem, now: Date): boolean {
  if (item.state === "ready" || item.state === "manual_review") return false;
  if (item.leaseExpiresAt && item.leaseExpiresAt > now) return false;
  if (item.nextAttemptAt && item.nextAttemptAt > now) return false;
  return true;
}

/** 计算指数退避的 nextAttemptAt。 */
export function computeNextAttemptAt(
  attemptCount: number,
  baseMs: number = 5_000,
  maxMs: number = 300_000,
): Date {
  const delay = Math.min(baseMs * Math.pow(2, attemptCount), maxMs);
  return new Date(Date.now() + delay);
}
