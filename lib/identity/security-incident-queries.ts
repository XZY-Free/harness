/**
 * 安全事件与隔离止损仓储（S12-W09）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md §9
 *         （安全事件可按 Agent、Revision、ToolProvider、Credential、Runtime 或 Environment 隔离和止损；
 *           撤销 Credential、禁用能力或隔离 Route 后，新操作立即拒绝；进行中副作用进入核对而非静默重试；
 *           事故时间线从 Audit/Event/Trace 汇总，诊断内容访问仍受时限、脱敏和审计约束）。
 *
 * 职责：
 * - createSecurityIncident：创建事故（state=open）+ 写审计 security.incident + 按 targetType 预填 containment 项。
 * - startInvestigation：open → investigating（写审计）+ 记录 investigatingAt。
 * - containIncident：investigating → contained（写审计）+ 记录 containedAt + 要求所有 containment 已 applied/failed。
 * - resolveIncident：contained → resolved（写审计）+ 记录 resolvedAt + closedBy + closureReason。
 * - escalateIncident：open/investigating/contained → escalated（写审计）+ 记录 closedBy + closureReason。
 * - getSecurityIncidentById / getSecurityIncidentByKey：查询 + 跨租户隔离。
 * - listSecurityIncidents：cursor 分页（支持 severity/state/targetType/detectedBy 过滤）。
 * - Containment 管理：listIncidentContainments / getContainment / markContainmentApplied / markContainmentFailed / revertContainment。
 * - computeContainmentSummary：从 containment 派生汇总。
 * - deriveIncidentContainable：从 containment 派生是否可 contained（全 applied/failed）。
 * - buildIncidentTimeline：从 AuditEvent 汇总事故时间线。
 *
 * 不变量：
 * - 同一 (incidentId, actionType) 仅一条 containment（唯一索引保证）。
 * - incidentState=contained 要求所有 containment 为 applied/failed（无 pending）。
 * - incidentState=resolved 时可回滚 applied containment（reverted）。
 * - 不写 ThreadEvent，只写管理域 AuditEvent（security.incident）。
 * - 撤销立即生效：containment applied 后新操作立即拒绝。
 * - 不以日志文本冒充隔离成功：applied 要求 evidenceRef。
 * - escalated 事件需人工介入，不自动 resolve。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { type AuditActor, recordAuditEvent } from "@/lib/identity/audit";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import {
  CONTAINMENT_ACTION_MATRIX,
  type ContainmentActionType,
  type ContainmentState,
  type IncidentContainment,
  type IncidentSeverity,
  type IncidentState,
  type IncidentTargetType,
  type SecurityIncident,
  incidentContainmentTable,
  securityIncidentTable,
} from "@/lib/persistence/schema/security-incident";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";

// ─── 错误类型 ──────────────────────────────────────────────

/** 安全事件错误。 */
export class SecurityIncidentError extends Error {
  constructor(
    public readonly code:
      | "incident_not_found"
      | "illegal_transition"
      | "containment_not_found"
      | "missing_evidence"
      | "duplicate_incident_key"
      | "containment_pending",
    message: string,
  ) {
    super(message);
    this.name = "SecurityIncidentError";
  }
}

// ─── 合法状态转移表 ────────────────────────────────────────

/**
 * 合法状态转移（state machine）。
 * - open → investigating / contained / escalated
 * - investigating → contained / escalated
 * - contained → resolved / escalated
 * - resolved / escalated 为终态，不再转移
 */
const LEGAL_INCIDENT_TRANSITIONS: Readonly<Record<IncidentState, readonly IncidentState[]>> = {
  open: ["investigating", "contained", "escalated"],
  investigating: ["contained", "escalated"],
  contained: ["resolved", "escalated"],
  resolved: [],
  escalated: [],
};

function assertLegalIncidentTransition(from: IncidentState, to: IncidentState): void {
  const allowed = LEGAL_INCIDENT_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new SecurityIncidentError(
      "illegal_transition",
      `非法状态转移：${from} → ${to}（允许：${allowed.join(", ") || "无（终态）"}）`,
    );
  }
}

// ─── 非终态状态集合 ────────────────────────────────────────

const NON_TERMINAL_INCIDENT_STATES: ReadonlySet<IncidentState> = new Set([
  "open",
  "investigating",
  "contained",
]);

// ─── Containment 合法转移 ──────────────────────────────────

/**
 * Containment 状态机：
 * - pending → applied / failed
 * - applied → reverted
 * - failed / reverted 为终态
 */
const LEGAL_CONTAINMENT_TRANSITIONS: Readonly<
  Record<ContainmentState, readonly ContainmentState[]>
> = {
  pending: ["applied", "failed"],
  applied: ["reverted"],
  failed: [],
  reverted: [],
};

function assertLegalContainmentTransition(from: ContainmentState, to: ContainmentState): void {
  const allowed = LEGAL_CONTAINMENT_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new SecurityIncidentError(
      "illegal_transition",
      `Containment 非法状态转移：${from} → ${to}（允许：${allowed.join(", ") || "无（终态）"}）`,
    );
  }
}

// ─── Containment 汇总 ─────────────────────────────────────

export interface ContainmentSummary {
  containmentCount: number;
  appliedCount: number;
  failedCount: number;
  pendingCount: number;
  revertedCount: number;
}

/** 从 containment 列表派生汇总。 */
export function computeContainmentSummary(containments: IncidentContainment[]): ContainmentSummary {
  const summary: ContainmentSummary = {
    containmentCount: containments.length,
    appliedCount: 0,
    failedCount: 0,
    pendingCount: 0,
    revertedCount: 0,
  };
  for (const c of containments) {
    switch (c.actionState) {
      case "applied":
        summary.appliedCount += 1;
        break;
      case "failed":
        summary.failedCount += 1;
        break;
      case "pending":
        summary.pendingCount += 1;
        break;
      case "reverted":
        summary.revertedCount += 1;
        break;
    }
  }
  return summary;
}

/**
 * 从 containment 列表派生是否可 contained。
 * - 全 applied/failed（无 pending）→ true
 * - 含 pending → false
 */
export function deriveIncidentContainable(containments: IncidentContainment[]): boolean {
  if (containments.length === 0) return true;
  return !containments.some((c) => c.actionState === "pending");
}

// ─── createSecurityIncident ───────────────────────────────

/**
 * 创建安全事件（state=open）+ 写审计 security.incident + 按 targetType 预填 containment 项。
 *
 * 流程：
 * 1. 检查同租户 incidentKey 是否已存在（业务幂等）。
 * 2. 插入 SecurityIncident（state=open）。
 * 3. 写审计 security.incident（targetType=security_incident, targetId=incident.id）。
 * 4. 按 CONTAINMENT_ACTION_MATRIX 预填 containment 项（state=pending）。
 * 5. 回填 auditEventId。
 *
 * @throws SecurityIncidentError duplicate_incident_key
 */
export async function createSecurityIncident(params: {
  tenantId: string;
  incidentKey: string;
  severity: IncidentSeverity;
  targetType: IncidentTargetType;
  targetId: string;
  summary?: string;
  detectedBy: string;
  actor: AuditActor;
  requestId?: string;
}): Promise<SecurityIncident> {
  // 1. 检查 incidentKey 唯一性
  const existing = await db
    .select({ id: securityIncidentTable.id })
    .from(securityIncidentTable)
    .where(
      and(
        eq(securityIncidentTable.tenantId, params.tenantId),
        eq(securityIncidentTable.incidentKey, params.incidentKey),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw new SecurityIncidentError(
      "duplicate_incident_key",
      `同租户已有相同 incidentKey 的事故（id=${existing[0]?.id}）`,
    );
  }

  // 2. 插入事故
  const incidentId = randomUUID();
  const now = new Date();
  await db.insert(securityIncidentTable).values({
    id: incidentId,
    tenantId: params.tenantId,
    incidentKey: params.incidentKey,
    severity: params.severity,
    incidentState: "open",
    targetType: params.targetType,
    targetId: params.targetId,
    summary: params.summary ?? null,
    detectedBy: params.detectedBy,
    detectedAt: now,
    updatedAt: now,
    requestId: params.requestId ?? null,
  });

  // 3. 写审计
  const auditEvent = await recordAuditEvent({
    actor: params.actor,
    actionType: "security.incident",
    targetType: "security_incident",
    targetId: incidentId,
    after: {
      incidentKey: params.incidentKey,
      severity: params.severity,
      incidentState: "open",
      targetType: params.targetType,
      targetId: params.targetId,
      detectedBy: params.detectedBy,
    },
    reason: params.summary ?? `创建安全事件：${params.targetType}:${params.targetId}`,
    requestId: params.requestId,
  });

  // 4. 预填 containment 项
  const actionTypes = CONTAINMENT_ACTION_MATRIX[params.targetType];
  if (actionTypes.length > 0) {
    const containmentRows: Array<typeof incidentContainmentTable.$inferInsert> = actionTypes.map(
      (actionType) => ({
        id: randomUUID(),
        tenantId: params.tenantId,
        incidentId,
        actionType,
        actionState: "pending" as const,
        targetRef: `${actionType.split("_").slice(-1)[0]}:${params.targetId}`,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await db.insert(incidentContainmentTable).values(containmentRows);
  }

  // 5. 回填 auditEventId
  await db
    .update(securityIncidentTable)
    .set({ auditEventId: auditEvent.id, updatedAt: new Date() })
    .where(eq(securityIncidentTable.id, incidentId));

  const created = await getSecurityIncidentById(params.tenantId, incidentId);
  if (!created) {
    throw new SecurityIncidentError("incident_not_found", `创建后查询失败（id=${incidentId}）`);
  }
  return created;
}

// ─── 查询 ──────────────────────────────────────────────────

/** 按 id 查询事故（跨租户隔离）。 */
export async function getSecurityIncidentById(
  tenantId: string,
  incidentId: string,
): Promise<SecurityIncident | null> {
  const rows = await db
    .select()
    .from(securityIncidentTable)
    .where(
      and(eq(securityIncidentTable.tenantId, tenantId), eq(securityIncidentTable.id, incidentId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** 按 incidentKey 查询事故（跨租户隔离）。 */
export async function getSecurityIncidentByKey(
  tenantId: string,
  incidentKey: string,
): Promise<SecurityIncident | null> {
  const rows = await db
    .select()
    .from(securityIncidentTable)
    .where(
      and(
        eq(securityIncidentTable.tenantId, tenantId),
        eq(securityIncidentTable.incidentKey, incidentKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** 列出事故（cursor 分页，支持 severity/state/targetType/detectedBy 过滤）。 */
export async function listSecurityIncidents(params: {
  tenantId: string;
  severity?: IncidentSeverity;
  incidentState?: IncidentState;
  targetType?: IncidentTargetType;
  detectedBy?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ items: SecurityIncident[]; nextCursor: string | null }> {
  const limit = Math.min(params.limit ?? 50, 200);
  const conditions = [eq(securityIncidentTable.tenantId, params.tenantId)];
  if (params.severity) {
    conditions.push(eq(securityIncidentTable.severity, params.severity));
  }
  if (params.incidentState) {
    conditions.push(eq(securityIncidentTable.incidentState, params.incidentState));
  }
  if (params.targetType) {
    conditions.push(eq(securityIncidentTable.targetType, params.targetType));
  }
  if (params.detectedBy) {
    conditions.push(eq(securityIncidentTable.detectedBy, params.detectedBy));
  }

  // cursor 分页：detectedAt ASC, id ASC（复合游标，处理同毫秒并发的场景）
  let cursorCondition: ReturnType<typeof and> | undefined;
  if (params.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf-8")) as {
        detectedAt: string;
        id: string;
      };
      cursorCondition = and(
        ...conditions,
        or(
          gt(securityIncidentTable.detectedAt, new Date(decoded.detectedAt)),
          and(
            eq(securityIncidentTable.detectedAt, new Date(decoded.detectedAt)),
            gt(securityIncidentTable.id, decoded.id),
          ),
        ),
      );
    } catch {
      throw new SecurityIncidentError("illegal_transition", "非法 cursor（无法解码）");
    }
  }

  const rows = await db
    .select()
    .from(securityIncidentTable)
    .where(cursorCondition ?? and(...conditions))
    .orderBy(asc(securityIncidentTable.detectedAt), asc(securityIncidentTable.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    if (last) {
      nextCursor = Buffer.from(
        JSON.stringify({
          detectedAt: last.detectedAt.toISOString(),
          id: last.id,
        }),
        "utf-8",
      ).toString("base64url");
    }
  }
  return { items, nextCursor };
}

// ─── 状态机推进 ────────────────────────────────────────────

/**
 * 推进事故状态（写审计 before/after）。
 *
 * @throws SecurityIncidentError incident_not_found / illegal_transition / containment_pending
 */
export async function updateIncidentState(params: {
  tenantId: string;
  id: string;
  nextState: IncidentState;
  actor: AuditActor;
  closedBy?: string;
  closureReason?: string;
  requestId?: string;
}): Promise<SecurityIncident> {
  const existing = await getSecurityIncidentById(params.tenantId, params.id);
  if (!existing) {
    throw new SecurityIncidentError("incident_not_found", `安全事件不存在（id=${params.id}）`);
  }
  assertLegalIncidentTransition(existing.incidentState, params.nextState);

  // contained 前置校验：所有 containment 必须 applied/failed（无 pending）
  if (params.nextState === "contained") {
    const containments = await listIncidentContainments(params.tenantId, params.id);
    if (!deriveIncidentContainable(containments)) {
      throw new SecurityIncidentError(
        "containment_pending",
        `存在未完成的 containment（无法 contained，id=${params.id}）`,
      );
    }
  }

  const now = new Date();
  const updates: Partial<SecurityIncident> = {
    incidentState: params.nextState,
    updatedAt: now,
  };
  if (params.nextState === "investigating") {
    updates.investigatingAt = now;
  }
  if (params.nextState === "contained") {
    updates.containedAt = now;
    // 回填 containmentSummaryJson
    const containments = await listIncidentContainments(params.tenantId, params.id);
    const summary = computeContainmentSummary(containments);
    updates.containmentSummaryJson = JSON.stringify(summary);
  }
  if (params.nextState === "resolved") {
    updates.resolvedAt = now;
    updates.closedBy = params.closedBy ?? null;
    updates.closureReason = params.closureReason ?? null;
  }
  if (params.nextState === "escalated") {
    updates.closedBy = params.closedBy ?? null;
    updates.closureReason = params.closureReason ?? null;
  }

  await db
    .update(securityIncidentTable)
    .set(updates)
    .where(eq(securityIncidentTable.id, params.id));

  const [row] = await db
    .select()
    .from(securityIncidentTable)
    .where(eq(securityIncidentTable.id, params.id))
    .limit(1);
  if (!row) {
    throw new Error(`updateIncidentState: 行未找到（id=${params.id}）`);
  }

  await recordAuditEvent({
    actor: params.actor,
    actionType: "security.incident",
    targetType: "security_incident",
    targetId: params.id,
    before: { incidentState: existing.incidentState },
    after: { incidentState: params.nextState },
    reason: params.closureReason ?? `状态转移：${existing.incidentState} → ${params.nextState}`,
    requestId: params.requestId,
  });

  return row;
}

// ─── 便捷封装 ──────────────────────────────────────────────

/** open → investigating。 */
export async function startInvestigation(params: {
  tenantId: string;
  id: string;
  actor: AuditActor;
  requestId?: string;
}): Promise<SecurityIncident> {
  return updateIncidentState({
    ...params,
    nextState: "investigating",
  });
}

/** investigating → contained（要求所有 containment 已 applied/failed）。 */
export async function containIncident(params: {
  tenantId: string;
  id: string;
  actor: AuditActor;
  requestId?: string;
}): Promise<SecurityIncident> {
  return updateIncidentState({
    ...params,
    nextState: "contained",
  });
}

/** contained → resolved。 */
export async function resolveIncident(params: {
  tenantId: string;
  id: string;
  actor: AuditActor;
  closedBy: string;
  closureReason?: string;
  requestId?: string;
}): Promise<SecurityIncident> {
  return updateIncidentState({
    ...params,
    nextState: "resolved",
  });
}

/** open/investigating/contained → escalated。 */
export async function escalateIncident(params: {
  tenantId: string;
  id: string;
  actor: AuditActor;
  closedBy: string;
  closureReason?: string;
  requestId?: string;
}): Promise<SecurityIncident> {
  return updateIncidentState({
    ...params,
    nextState: "escalated",
  });
}

// ─── Containment 管理 ─────────────────────────────────────

/** 列出事故下的所有 containment（按 actionType 升序，MySQL enum 定义序）。 */
export async function listIncidentContainments(
  tenantId: string,
  incidentId: string,
): Promise<IncidentContainment[]> {
  const rows = await db
    .select()
    .from(incidentContainmentTable)
    .where(
      and(
        eq(incidentContainmentTable.tenantId, tenantId),
        eq(incidentContainmentTable.incidentId, incidentId),
      ),
    )
    .orderBy(asc(incidentContainmentTable.actionType));
  return rows;
}

/** 按 id 查询 containment（跨租户隔离）。 */
export async function getContainment(
  tenantId: string,
  containmentId: string,
): Promise<IncidentContainment | null> {
  const rows = await db
    .select()
    .from(incidentContainmentTable)
    .where(
      and(
        eq(incidentContainmentTable.tenantId, tenantId),
        eq(incidentContainmentTable.id, containmentId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 标记 containment 已应用隔离（pending → applied）。
 *
 * @throws SecurityIncidentError containment_not_found / illegal_transition / missing_evidence
 */
export async function markContainmentApplied(params: {
  tenantId: string;
  containmentId: string;
  evidenceRef: string;
  detailsJson?: string;
}): Promise<IncidentContainment> {
  const existing = await getContainment(params.tenantId, params.containmentId);
  if (!existing) {
    throw new SecurityIncidentError(
      "containment_not_found",
      `Containment 不存在（id=${params.containmentId}）`,
    );
  }
  assertLegalContainmentTransition(existing.actionState, "applied");

  // evidenceRef 必填（不以日志文本冒充隔离成功）
  if (!params.evidenceRef.trim()) {
    throw new SecurityIncidentError(
      "missing_evidence",
      "applied 要求 evidenceRef（存储端证据，不能用日志文本冒充）",
    );
  }

  const now = new Date();
  await db
    .update(incidentContainmentTable)
    .set({
      actionState: "applied",
      evidenceRef: params.evidenceRef,
      detailsJson: params.detailsJson ?? null,
      appliedAt: now,
      updatedAt: now,
    })
    .where(eq(incidentContainmentTable.id, params.containmentId));

  const [row] = await db
    .select()
    .from(incidentContainmentTable)
    .where(eq(incidentContainmentTable.id, params.containmentId))
    .limit(1);
  if (!row) {
    throw new Error(`markContainmentApplied: 行未找到（id=${params.containmentId}）`);
  }
  return row;
}

/**
 * 标记 containment 应用失败（pending → failed）。
 *
 * @throws SecurityIncidentError containment_not_found / illegal_transition
 */
export async function markContainmentFailed(params: {
  tenantId: string;
  containmentId: string;
  failureReason: string;
  evidenceRef?: string;
}): Promise<IncidentContainment> {
  const existing = await getContainment(params.tenantId, params.containmentId);
  if (!existing) {
    throw new SecurityIncidentError(
      "containment_not_found",
      `Containment 不存在（id=${params.containmentId}）`,
    );
  }
  assertLegalContainmentTransition(existing.actionState, "failed");

  const now = new Date();
  await db
    .update(incidentContainmentTable)
    .set({
      actionState: "failed",
      failureReason: params.failureReason,
      evidenceRef: params.evidenceRef ?? null,
      updatedAt: now,
    })
    .where(eq(incidentContainmentTable.id, params.containmentId));

  const [row] = await db
    .select()
    .from(incidentContainmentTable)
    .where(eq(incidentContainmentTable.id, params.containmentId))
    .limit(1);
  if (!row) {
    throw new Error(`markContainmentFailed: 行未找到（id=${params.containmentId}）`);
  }
  return row;
}

/**
 * 回滚 containment（applied → reverted，incident resolved 时使用）。
 *
 * @throws SecurityIncidentError containment_not_found / illegal_transition
 */
export async function revertContainment(params: {
  tenantId: string;
  containmentId: string;
  reason?: string;
}): Promise<IncidentContainment> {
  const existing = await getContainment(params.tenantId, params.containmentId);
  if (!existing) {
    throw new SecurityIncidentError(
      "containment_not_found",
      `Containment 不存在（id=${params.containmentId}）`,
    );
  }
  assertLegalContainmentTransition(existing.actionState, "reverted");

  const now = new Date();
  await db
    .update(incidentContainmentTable)
    .set({
      actionState: "reverted",
      revertedAt: now,
      updatedAt: now,
    })
    .where(eq(incidentContainmentTable.id, params.containmentId));

  const [row] = await db
    .select()
    .from(incidentContainmentTable)
    .where(eq(incidentContainmentTable.id, params.containmentId))
    .limit(1);
  if (!row) {
    throw new Error(`revertContainment: 行未找到（id=${params.containmentId}）`);
  }
  return row;
}

// ─── 事故时间线汇总 ───────────────────────────────────────

/**
 * 从事故的 AuditEvent 汇总时间线（按 occurredAt 升序）。
 *
 * 事实源：方案 §9「事故时间线从 Audit/Event/Trace 汇总，诊断内容访问仍受时限、脱敏和审计约束」。
 * 本函数只汇总 AuditEvent（管理域审计），ThreadEvent/Trace 汇总由后续扩展。
 *
 * 诊断内容访问约束：
 * - 调用方需持有 security.incident.* action scope（由 Admin API 路由层校验）。
 * - AuditEvent 的 beforeHash/afterHash 为摘要，不含原始敏感字段。
 */
export async function buildIncidentTimeline(
  tenantId: string,
  incidentId: string,
): Promise<
  Array<{
    id: string;
    occurredAt: Date;
    actionType: string;
    actorType: string;
    actorId: string;
    reason: string | null;
  }>
> {
  const events = await listAuditEvents({
    tenantId,
    targetType: "security_incident",
    targetId: incidentId,
    limit: 500,
  });
  return events.map((e) => ({
    id: e.id,
    occurredAt: e.occurredAt,
    actionType: e.actionType,
    actorType: e.actorType,
    actorId: e.actorId,
    reason: e.reason,
  }));
}

// ─── 非终态状态查询 helper ─────────────────────────────────

/** 查询同租户同 targetType+targetId 的非终态事故（用于检测是否已有活跃事故）。 */
export async function getActiveIncidentByTarget(
  tenantId: string,
  targetType: IncidentTargetType,
  targetId: string,
): Promise<SecurityIncident | null> {
  const rows = await db
    .select()
    .from(securityIncidentTable)
    .where(
      and(
        eq(securityIncidentTable.tenantId, tenantId),
        eq(securityIncidentTable.targetType, targetType),
        eq(securityIncidentTable.targetId, targetId),
        inArray(securityIncidentTable.incidentState, [...NON_TERMINAL_INCIDENT_STATES]),
      ),
    )
    .orderBy(asc(securityIncidentTable.detectedAt))
    .limit(1);
  return rows[0] ?? null;
}
