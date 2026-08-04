/**
 * Cutover Store 接口 — 应用服务依赖的持久化 Port。
 */

import type {
  CutoverPlanRow,
  CutoverItemRow,
} from "./cutover-record";
import type {
  CutoverPlanState,
} from "../domain/cutover-plan";
import type {
  CutoverItemState,
  CutoverItemSubjectType,
  QualificationCategory,
} from "../domain/cutover-item";

/** Cutover Store。 */
export interface CutoverStore {
  // ─── Plan ───────────────────────────────────────────────

  /** 插入 Plan。 */
  insertPlan(plan: NewCutoverPlanInput): Promise<CutoverPlanRow>;

  /** 按 ID 读取 Plan（跨租户隔离）。 */
  getPlanById(params: { tenantId: string; planId: string }): Promise<CutoverPlanRow | null>;

  /** 按 RouteSet 查找 Plan。 */
  getPlanByRouteSet(params: { tenantId: string; routeSetId: string }): Promise<CutoverPlanRow | null>;

  /** 更新 Plan 状态。 */
  updatePlanState(params: {
    planId: string;
    state: CutoverPlanState;
    targetRouteSetVersionNo?: number | null;
    startedAt?: Date | null;
    completedAt?: Date | null;
    failedAt?: Date | null;
    failureReason?: string | null;
  }): Promise<CutoverPlanRow>;

  // ─── Item ───────────────────────────────────────────────

  /** 批量插入 Item。 */
  insertItems(items: NewCutoverItemInput[]): Promise<CutoverItemRow[]>;

  /** 按 Plan 读取所有 Item。 */
  listItemsByPlan(planId: string): Promise<CutoverItemRow[]>;

  /** 按 Plan + Subject 读取 Item。 */
  getItemBySubject(params: {
    planId: string;
    subjectType: CutoverItemSubjectType;
    sourceSubjectId: string;
  }): Promise<CutoverItemRow | null>;

  /** 更新 Item 状态。 */
  updateItemState(params: {
    itemId: string;
    state: CutoverItemState;
    replacementSubjectId?: string | null;
    attemptCount?: number;
    nextAttemptAt?: Date | null;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    lastError?: string | null;
  }): Promise<CutoverItemRow>;

  /** 领取可处理的 Item（FOR UPDATE SKIP LOCKED）。 */
  claimItems(params: {
    tenantId: string;
    workerId: string;
    leaseMs: number;
    batchSize: number;
    now: Date;
  }): Promise<CutoverItemRow[]>;

  /** 释放租约（Worker 崩溃后由其他 Worker 接管）。 */
  releaseLease(params: { itemId: string }): Promise<void>;
}

/** 新建 Plan 输入。 */
export interface NewCutoverPlanInput {
  id: string;
  tenantId: string;
  routeSetId: string;
  sourceRouteSetVersionNo: number;
  state?: CutoverPlanState;
  createdBy: string;
  createdAt: Date;
}

/** 新建 Item 输入。 */
export interface NewCutoverItemInput {
  id: string;
  planId: string;
  tenantId: string;
  subjectType: CutoverItemSubjectType;
  sourceSubjectId: string;
  qualificationCategory: QualificationCategory;
  state?: CutoverItemState;
  createdAt: Date;
  updatedAt: Date;
}
