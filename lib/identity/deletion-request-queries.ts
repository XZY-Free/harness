/**
 * 可验证删除请求与步骤仓储（S12-W07）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-data-lifecycle.md §7
 *         （删除请求生成独立生命周期；部分失败保持 failed/partial 并可安全重试；
 *           completed 要求所有 in-scope step 有存储端 evidenceRef）。
 *
 * 职责：
 * - createDeletionRequest：受理请求（state=planning）+ 写审计 deletion.request。
 * - getDeletionRequestById / getDeletionRequestBySubject：查询 + 跨租户隔离。
 * - updateDeletionRequestState：状态机推进（写审计 before/after）。
 * - setBlockedReasonCodes / setAuditEventId：阻塞原因与审计回填。
 * - listDeletionRequests：cursor 分页（支持 subjectType/state/requestedBy 过滤）。
 * - Step 管理：insertDeletionSteps / listDeletionSteps / markStep* / completeDeletionStep / failDeletionStep。
 * - computeRequestSummary / deriveTerminalStateFromSteps：从 step 派生汇总与终态。
 *
 * 不变量：
 * - completed 要求所有 in-scope step（pending/running 除外）含 evidenceRef；局部失败保持 partial/failed。
 * - 不写 ThreadEvent 冒充已删除，只写管理域 AuditEvent（deletion.request）。
 * - 状态机仅允许合法转移；非法转移抛 illegal_transition。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { type AuditActor, recordAuditEvent } from "@/lib/identity/audit";
import {
  type DeletionDeleteMode,
  type DeletionRequest,
  type DeletionRequestPrincipalKind,
  type DeletionRequestState,
  type DeletionStep,
  type DeletionStepState,
  type DeletionStoreType,
  type DeletionSubjectType,
  TERMINAL_REQUEST_STATES,
  deletionRequestTable,
  deletionStepTable,
} from "@/lib/persistence/schema/deletion-request";
import { and, asc, eq, gt, inArray } from "drizzle-orm";

// ─── 错误类型 ──────────────────────────────────────────────

/** 删除请求错误。 */
export class DeletionRequestError extends Error {
  constructor(
    public readonly code:
      | "request_not_found"
      | "request_already_terminal"
      | "illegal_transition"
      | "duplicate_active_request"
      | "step_not_found"
      | "missing_evidence"
      | "invalid_subject",
    message: string,
  ) {
    super(message);
    this.name = "DeletionRequestError";
  }
}

// ─── 合法状态转移表 ────────────────────────────────────────

/**
 * 合法状态转移（state machine）。
 * - planning → blocked_by_hold / deleting / completed（无 in-scope step 时直接完成）/ cancelled
 * - blocked_by_hold → deleting（Hold 解除后重试）/ cancelled
 * - deleting → completed / partial / failed / cancelled
 * - partial → deleting（重试）/ cancelled
 * - completed / failed / cancelled 为终态，不再转移
 */
const LEGAL_TRANSITIONS: Readonly<Record<DeletionRequestState, readonly DeletionRequestState[]>> = {
  planning: ["blocked_by_hold", "deleting", "completed", "cancelled"],
  blocked_by_hold: ["deleting", "cancelled"],
  deleting: ["completed", "partial", "failed", "cancelled"],
  partial: ["deleting", "cancelled"],
  completed: [],
  failed: ["cancelled"],
  cancelled: [],
};

function assertLegalTransition(from: DeletionRequestState, to: DeletionRequestState): void {
  const allowed = LEGAL_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new DeletionRequestError(
      "illegal_transition",
      `非法状态转移：${from} → ${to}（允许：${allowed.join(", ") || "无（终态）"}）`,
    );
  }
}

// ─── 请求 CRUD ────────────────────────────────────────────

/** 创建删除请求（state=planning）+ 写审计 deletion.request；返回请求行。 */
export async function createDeletionRequest(params: {
  tenantId: string;
  subjectType: DeletionSubjectType;
  subjectId: string;
  deleteMode: DeletionDeleteMode;
  reasonCode: string;
  policyRevisionId?: string | null;
  requestedBy: string;
  requestPrincipalKind: DeletionRequestPrincipalKind;
  actor: AuditActor;
  requestId?: string;
}): Promise<DeletionRequest> {
  // 同一 (tenantId, subjectType, subjectId) 已有非终态请求时拒绝（避免重复受理）。
  const active = await getActiveDeletionRequestBySubject(
    params.tenantId,
    params.subjectType,
    params.subjectId,
  );
  if (active) {
    throw new DeletionRequestError(
      "duplicate_active_request",
      `该对象已有未完成的删除请求（id=${active.id}）`,
    );
  }

  const id = randomUUID();
  await db.insert(deletionRequestTable).values({
    id,
    tenantId: params.tenantId,
    subjectType: params.subjectType,
    subjectId: params.subjectId,
    deleteMode: params.deleteMode,
    reasonCode: params.reasonCode,
    policyRevisionId: params.policyRevisionId ?? null,
    requestedBy: params.requestedBy,
    requestPrincipalKind: params.requestPrincipalKind,
    requestState: "planning",
  });

  const [row] = await db
    .select()
    .from(deletionRequestTable)
    .where(eq(deletionRequestTable.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`createDeletionRequest: 行未找到（id=${id}）`);
  }

  const auditEvent = await recordAuditEvent({
    actor: params.actor,
    actionType: "deletion.request",
    targetType: "deletion_request",
    targetId: id,
    after: {
      subject_type: params.subjectType,
      subject_id: params.subjectId,
      delete_mode: params.deleteMode,
      reason_code: params.reasonCode,
      policy_revision_id: params.policyRevisionId ?? null,
      requested_by: params.requestedBy,
      request_state: "planning",
    },
    reason: `受理删除请求：${params.reasonCode}（${params.subjectType}:${params.subjectId}）`,
    requestId: params.requestId,
  });

  // 回填审计事件 id（管理端响应需要 audit_event_id）。
  await db
    .update(deletionRequestTable)
    .set({ auditEventId: auditEvent.id, updatedAt: new Date() })
    .where(eq(deletionRequestTable.id, id));

  const [finalRow] = await db
    .select()
    .from(deletionRequestTable)
    .where(eq(deletionRequestTable.id, id))
    .limit(1);
  return finalRow ?? row;
}

/** 按 id 查询请求；不存在返回 null。 */
export async function getDeletionRequestById(
  tenantId: string,
  id: string,
): Promise<DeletionRequest | null> {
  const [row] = await db
    .select()
    .from(deletionRequestTable)
    .where(and(eq(deletionRequestTable.tenantId, tenantId), eq(deletionRequestTable.id, id)))
    .limit(1);
  return row ?? null;
}

/** 查询某 subject 的非终态请求（避免重复受理）；不存在返回 null。 */
export async function getActiveDeletionRequestBySubject(
  tenantId: string,
  subjectType: DeletionSubjectType,
  subjectId: string,
): Promise<DeletionRequest | null> {
  const [row] = await db
    .select()
    .from(deletionRequestTable)
    .where(
      and(
        eq(deletionRequestTable.tenantId, tenantId),
        eq(deletionRequestTable.subjectType, subjectType),
        eq(deletionRequestTable.subjectId, subjectId),
      ),
    )
    .orderBy(asc(deletionRequestTable.acceptedAt))
    .limit(50);
  // 过滤终态，返回第一个非终态
  const active = row && !TERMINAL_REQUEST_STATES.has(row.requestState) ? row : null;
  return active;
}

// ─── 状态机推进 ────────────────────────────────────────────

/** 推进请求状态机（写审计 before/after）；终态自动回填 completedAt。 */
export async function updateDeletionRequestState(params: {
  tenantId: string;
  id: string;
  nextState: DeletionRequestState;
  actor: AuditActor;
  reason?: string;
  requestId?: string;
}): Promise<DeletionRequest> {
  const existing = await getDeletionRequestById(params.tenantId, params.id);
  if (!existing) {
    throw new DeletionRequestError("request_not_found", `删除请求不存在（id=${params.id}）`);
  }
  if (TERMINAL_REQUEST_STATES.has(existing.requestState) && params.nextState !== "cancelled") {
    throw new DeletionRequestError(
      "request_already_terminal",
      `删除请求已终态（state=${existing.requestState}，id=${params.id}）`,
    );
  }
  assertLegalTransition(existing.requestState, params.nextState);

  const now = new Date();
  const updates: Partial<DeletionRequest> = {
    requestState: params.nextState,
    updatedAt: now,
  };
  if (TERMINAL_REQUEST_STATES.has(params.nextState)) {
    updates.completedAt = now;
  }

  await db.update(deletionRequestTable).set(updates).where(eq(deletionRequestTable.id, params.id));

  const [row] = await db
    .select()
    .from(deletionRequestTable)
    .where(eq(deletionRequestTable.id, params.id))
    .limit(1);
  if (!row) {
    throw new Error(`updateDeletionRequestState: 行未找到（id=${params.id}）`);
  }

  await recordAuditEvent({
    actor: params.actor,
    actionType: "deletion.request",
    targetType: "deletion_request",
    targetId: params.id,
    before: { request_state: existing.requestState },
    after: { request_state: params.nextState },
    reason: params.reason ?? `状态转移：${existing.requestState} → ${params.nextState}`,
    requestId: params.requestId,
  });

  return row;
}

/** 设置阻塞原因码（JSON 数组）；常用于 blocked_by_hold 转移前。 */
export async function setBlockedReasonCodes(params: {
  tenantId: string;
  id: string;
  reasonCodes: string[];
}): Promise<void> {
  await db
    .update(deletionRequestTable)
    .set({
      blockedReasonCodes: params.reasonCodes.length > 0 ? JSON.stringify(params.reasonCodes) : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deletionRequestTable.tenantId, params.tenantId),
        eq(deletionRequestTable.id, params.id),
      ),
    );
}

/** 解析阻塞原因码（JSON 数组）；为空返回空数组。 */
export function parseBlockedReasonCodes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ─── 列表查询（cursor 分页） ────────────────────────────────

export interface DeletionRequestFilter {
  tenantId: string;
  subjectType?: DeletionSubjectType;
  requestState?: DeletionRequestState;
  requestedBy?: string;
  limit?: number;
  cursor?: string; // acceptedAt RFC 3339
}

export interface DeletionRequestPage {
  items: DeletionRequest[];
  nextCursor: string | null;
}

/** 列出删除请求（cursor 分页，按 acceptedAt 升序）。 */
export async function listDeletionRequests(
  filter: DeletionRequestFilter,
): Promise<DeletionRequestPage> {
  const limit = Math.min(filter.limit ?? 50, 200);
  const conditions = [eq(deletionRequestTable.tenantId, filter.tenantId)];
  if (filter.subjectType) {
    conditions.push(eq(deletionRequestTable.subjectType, filter.subjectType));
  }
  if (filter.requestState) {
    conditions.push(eq(deletionRequestTable.requestState, filter.requestState));
  }
  if (filter.requestedBy) {
    conditions.push(eq(deletionRequestTable.requestedBy, filter.requestedBy));
  }
  if (filter.cursor) {
    const cursorDate = new Date(filter.cursor);
    conditions.push(gt(deletionRequestTable.acceptedAt, cursorDate));
  }

  const rows = await db
    .select()
    .from(deletionRequestTable)
    .where(and(...conditions))
    .orderBy(asc(deletionRequestTable.acceptedAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = page[page.length - 1];
  const nextCursor = hasMore && lastRow ? lastRow.acceptedAt.toISOString() : null;

  return { items: page, nextCursor };
}

// ─── Step 管理 ────────────────────────────────────────────

/** 规划的步骤输入（由 deletion-planner 生成）。 */
export interface PlannedStep {
  storeType: DeletionStoreType;
  subjectRef: string;
  stepState?: DeletionStepState;
  failureReason?: string | null;
}

/** 批量插入规划步骤（planner 生成后调用）。 */
export async function insertDeletionSteps(params: {
  tenantId: string;
  requestId: string;
  steps: PlannedStep[];
}): Promise<DeletionStep[]> {
  if (params.steps.length === 0) return [];
  const now = new Date();
  const rows = params.steps.map((s) => ({
    id: randomUUID(),
    tenantId: params.tenantId,
    requestId: params.requestId,
    storeType: s.storeType,
    subjectRef: s.subjectRef,
    stepState: s.stepState ?? "pending",
    failureReason: s.failureReason ?? null,
    createdAt: now,
    updatedAt: now,
    completedAt:
      s.stepState === "completed" || s.stepState === "retained" || s.stepState === "skipped"
        ? now
        : null,
  }));
  await db.insert(deletionStepTable).values(rows);

  const inserted = await db
    .select()
    .from(deletionStepTable)
    .where(eq(deletionStepTable.requestId, params.requestId));
  return inserted;
}

/** 列出请求的所有步骤（按 storeType, subjectRef 排序）。 */
export async function listDeletionSteps(
  tenantId: string,
  requestId: string,
): Promise<DeletionStep[]> {
  return db
    .select()
    .from(deletionStepTable)
    .where(
      and(eq(deletionStepTable.tenantId, tenantId), eq(deletionStepTable.requestId, requestId)),
    )
    .orderBy(asc(deletionStepTable.storeType), asc(deletionStepTable.subjectRef));
}

/** 按 (requestId, storeType, subjectRef) 查询单步；不存在返回 null。 */
export async function getDeletionStep(params: {
  tenantId: string;
  requestId: string;
  storeType: DeletionStoreType;
  subjectRef: string;
}): Promise<DeletionStep | null> {
  const [row] = await db
    .select()
    .from(deletionStepTable)
    .where(
      and(
        eq(deletionStepTable.tenantId, params.tenantId),
        eq(deletionStepTable.requestId, params.requestId),
        eq(deletionStepTable.storeType, params.storeType),
        eq(deletionStepTable.subjectRef, params.subjectRef),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 标记步骤 running（attemptCount +1）；仅 pending/failed 可转移。 */
export async function markStepRunning(params: {
  tenantId: string;
  stepId: string;
}): Promise<DeletionStep> {
  const [existing] = await db
    .select()
    .from(deletionStepTable)
    .where(
      and(eq(deletionStepTable.tenantId, params.tenantId), eq(deletionStepTable.id, params.stepId)),
    )
    .limit(1);
  if (!existing) {
    throw new DeletionRequestError("step_not_found", `步骤不存在（id=${params.stepId}）`);
  }
  if (existing.stepState !== "pending" && existing.stepState !== "failed") {
    // 已完成/保留的步骤不重复执行（幂等）
    return existing;
  }
  await db
    .update(deletionStepTable)
    .set({
      stepState: "running",
      attemptCount: existing.attemptCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(deletionStepTable.id, params.stepId));

  const [row] = await db
    .select()
    .from(deletionStepTable)
    .where(eq(deletionStepTable.id, params.stepId))
    .limit(1);
  if (!row) {
    throw new Error(`markStepRunning: 行未找到（id=${params.stepId}）`);
  }
  return row;
}

/** 完成步骤（写 evidenceRef；completed 必须有 evidenceRef）。 */
export async function completeDeletionStep(params: {
  tenantId: string;
  stepId: string;
  evidenceRef: string;
}): Promise<DeletionStep> {
  if (!params.evidenceRef) {
    throw new DeletionRequestError(
      "missing_evidence",
      "completed 步骤必须有 evidenceRef（存储端删除证据）",
    );
  }
  const now = new Date();
  await db
    .update(deletionStepTable)
    .set({
      stepState: "completed",
      evidenceRef: params.evidenceRef,
      failureReason: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(deletionStepTable.tenantId, params.tenantId), eq(deletionStepTable.id, params.stepId)),
    );

  const [row] = await db
    .select()
    .from(deletionStepTable)
    .where(eq(deletionStepTable.id, params.stepId))
    .limit(1);
  if (!row) {
    throw new Error(`completeDeletionStep: 行未找到（id=${params.stepId}）`);
  }
  return row;
}

/** 标记步骤失败（写 failureReason；可重试）。 */
export async function failDeletionStep(params: {
  tenantId: string;
  stepId: string;
  failureReason: string;
}): Promise<DeletionStep> {
  const now = new Date();
  await db
    .update(deletionStepTable)
    .set({ stepState: "failed", failureReason: params.failureReason, updatedAt: now })
    .where(
      and(eq(deletionStepTable.tenantId, params.tenantId), eq(deletionStepTable.id, params.stepId)),
    );

  const [row] = await db
    .select()
    .from(deletionStepTable)
    .where(eq(deletionStepTable.id, params.stepId))
    .limit(1);
  if (!row) {
    throw new Error(`failDeletionStep: 行未找到（id=${params.stepId}）`);
  }
  return row;
}

/** 标记步骤为保留（共享资源不删除，记录原因）。 */
export async function markStepRetained(params: {
  tenantId: string;
  stepId: string;
  reason: string;
}): Promise<DeletionStep> {
  const now = new Date();
  await db
    .update(deletionStepTable)
    .set({
      stepState: "retained",
      failureReason: params.reason,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(deletionStepTable.tenantId, params.tenantId), eq(deletionStepTable.id, params.stepId)),
    );

  const [row] = await db
    .select()
    .from(deletionStepTable)
    .where(eq(deletionStepTable.id, params.stepId))
    .limit(1);
  if (!row) {
    throw new Error(`markStepRetained: 行未找到（id=${params.stepId}）`);
  }
  return row;
}

/** 标记步骤为阻塞（Legal Hold/法规保留阻止）。 */
export async function markStepBlocked(params: {
  tenantId: string;
  stepId: string;
  reason: string;
}): Promise<DeletionStep> {
  const now = new Date();
  await db
    .update(deletionStepTable)
    .set({ stepState: "blocked", failureReason: params.reason, updatedAt: now })
    .where(
      and(eq(deletionStepTable.tenantId, params.tenantId), eq(deletionStepTable.id, params.stepId)),
    );

  const [row] = await db
    .select()
    .from(deletionStepTable)
    .where(eq(deletionStepTable.id, params.stepId))
    .limit(1);
  if (!row) {
    throw new Error(`markStepBlocked: 行未找到（id=${params.stepId}）`);
  }
  return row;
}

/** 标记步骤为跳过（规划阶段决定该存储无相关数据）。 */
export async function markStepSkipped(params: {
  tenantId: string;
  stepId: string;
  reason: string;
}): Promise<DeletionStep> {
  const now = new Date();
  await db
    .update(deletionStepTable)
    .set({
      stepState: "skipped",
      failureReason: params.reason,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(deletionStepTable.tenantId, params.tenantId), eq(deletionStepTable.id, params.stepId)),
    );

  const [row] = await db
    .select()
    .from(deletionStepTable)
    .where(eq(deletionStepTable.id, params.stepId))
    .limit(1);
  if (!row) {
    throw new Error(`markStepSkipped: 行未找到（id=${params.stepId}）`);
  }
  return row;
}

// ─── 汇总与终态派生 ────────────────────────────────────────

/** 请求汇总（从 step 派生）。 */
export interface DeletionRequestSummary {
  plannedSteps: number;
  completedSteps: number;
  failedSteps: number;
  blockedSteps: number;
  /** 阻塞资源数（blocked + blocked_by_hold 时未删除的对象）。 */
  blockedResourceCount: number;
  /** 保留的共享资源数（retained）。 */
  retainedSharedResourceCount: number;
}

/** 从步骤列表派生汇总。 */
export function computeRequestSummary(steps: DeletionStep[]): DeletionRequestSummary {
  let completed = 0;
  let failed = 0;
  let blocked = 0;
  let retained = 0;
  for (const s of steps) {
    switch (s.stepState) {
      case "completed":
      case "skipped":
        completed += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "blocked":
        blocked += 1;
        break;
      case "retained":
        retained += 1;
        break;
      default:
        break;
    }
  }
  return {
    plannedSteps: steps.length,
    completedSteps: completed,
    failedSteps: failed,
    blockedSteps: blocked,
    blockedResourceCount: blocked,
    retainedSharedResourceCount: retained,
  };
}

/**
 * 从步骤状态派生请求终态（executor 完成所有可执行 step 后调用）。
 *
 * - 全部 completed/retained/skipped（无 failed/blocked/pending/running）→ completed
 * - 含 failed 且无 blocked/pending/running → partial（可重试）
 * - 含 blocked → 仍 deleting（等待 Hold 解除；不自动 completed）
 * - 含 pending/running → deleting（尚未跑完）
 *
 * 注意：blocked_by_hold 在请求级由 planner 处理，此处只看 step。
 */
export function deriveTerminalStateFromSteps(steps: DeletionStep[]): DeletionRequestState | null {
  if (steps.length === 0) return "completed"; // 无 in-scope step，直接完成
  let hasFailed = false;
  let hasBlocked = false;
  let hasPendingOrRunning = false;
  for (const s of steps) {
    switch (s.stepState) {
      case "failed":
        hasFailed = true;
        break;
      case "blocked":
        hasBlocked = true;
        break;
      case "pending":
      case "running":
        hasPendingOrRunning = true;
        break;
      default:
        break;
    }
  }
  if (hasPendingOrRunning) return null; // 尚未跑完，不派生终态
  if (hasBlocked) return null; // 有阻塞，不自动终态
  return hasFailed ? "partial" : "completed";
}

/** 查询待执行步骤（pending 或 failed 可重试）。 */
export async function listRunnableSteps(
  tenantId: string,
  requestId: string,
): Promise<DeletionStep[]> {
  return db
    .select()
    .from(deletionStepTable)
    .where(
      and(
        eq(deletionStepTable.tenantId, tenantId),
        eq(deletionStepTable.requestId, requestId),
        inArray(deletionStepTable.stepState, ["pending", "failed"]),
      ),
    )
    .orderBy(asc(deletionStepTable.storeType), asc(deletionStepTable.subjectRef));
}

/** 查询某状态集合的步骤数（用于状态判断）。 */
export async function countStepsByStates(
  tenantId: string,
  requestId: string,
  states: DeletionStepState[],
): Promise<number> {
  if (states.length === 0) return 0;
  const rows = await db
    .select({ id: deletionStepTable.id })
    .from(deletionStepTable)
    .where(
      and(
        eq(deletionStepTable.tenantId, tenantId),
        eq(deletionStepTable.requestId, requestId),
        inArray(deletionStepTable.stepState, states),
      ),
    );
  return rows.length;
}
