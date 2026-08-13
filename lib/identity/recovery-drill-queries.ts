/**
 * 备份恢复演练仓储（S12-W08）。
 *
 * 事实源：docs/architecture/security.md §8
 * （数据库备份、对象版本/复制、配置和密钥恢复分别定义 RPO/RTO 与责任边界；
 * 恢复演练验证 Event sequence、投影 checkpoint、Artifact 引用、Legal Hold 和删除证据的一致性；
 * Runtime/Worker/队列故障演练覆盖未完成 ToolCall、unknown Effect、Job 恢复和 UserAction 等待；
 * 演练在隔离环境使用真实组件，不连接生产数据库，不以备份任务成功日志代替可恢复性）。
 *
 * 职责：
 * - createRecoveryDrill：创建演练（state=scheduled）+ 写审计 recovery.drill + 按 drillType 预填 check 项。
 * - startRecoveryDrill：scheduled → running（写审计 before/after）+ 记录 startedAt。
 * - completeRecoveryDrill：running → completed（写审计）+ 计算 consistencySummary + 记录 completedAt。
 * - failRecoveryDrill：running → failed（写审计）+ 记录 failureReason + completedAt。
 * - cancelRecoveryDrill：scheduled/running → cancelled（写审计）。
 * - getRecoveryDrillById：查询 + 跨租户隔离。
 * - listRecoveryDrills：cursor 分页（支持 drillType/state/executedBy 过滤）。
 * - Check 管理：listRecoveryDrillChecks / markCheckRunning / completeRecoveryDrillCheck / failRecoveryDrillCheck / skipRecoveryDrillCheck。
 * - computeDrillSummary：从 check 派生汇总（checkCount/passedCount/failedCount/skippedCount）。
 * - deriveDrillTerminalState：从 check 派生终态（全 passed/skipped → completed；含 failed → failed；否则保持 running）。
 *
 * 不变量：
 * - 同一 (drillId, checkType) 仅一条 check（唯一索引保证）。
 * - drillState=completed 要求所有 in-scope check 为 passed/skipped。
 * - drillState=failed 时至少一条 check 为 failed。
 * - 不写 ThreadEvent，只写管理域 AuditEvent（recovery.drill）。
 * - 不以备份任务成功日志代替可恢复性：passed/failed 要求 evidenceRef。
 * - 演练不连接生产数据库：environmentTag 标识隔离环境。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { type AuditActor, recordAuditEvent } from "@/lib/identity/audit";
import {
 DRILL_CHECK_MATRIX,
 type RecoveryCheckState,
 type RecoveryCheckType,
 type RecoveryDrill,
 type RecoveryDrillCheck,
 type RecoveryDrillState,
 type RecoveryDrillType,
 recoveryDrillCheckTable,
 recoveryDrillTable,
} from "@/lib/persistence/schema/recovery-drill";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";

// ─── 错误类型 ──────────────────────────────────────────────

/** 恢复演练错误。 */
export class RecoveryDrillError extends Error {
 constructor(
 public readonly code:
 | "drill_not_found"
 | "illegal_transition"
 | "check_not_found"
 | "missing_evidence"
 | "duplicate_active_drill"
 | "invalid_environment",
 message: string,
 ) {
 super(message);
 this.name = "RecoveryDrillError";
 }
}

// ─── 合法状态转移表 ────────────────────────────────────────

/**
 * 合法状态转移（state machine）。
 * - scheduled → running / cancelled
 * - running → completed / failed / cancelled
 * - completed / failed / cancelled 为终态，不再转移
 */
const LEGAL_DRILL_TRANSITIONS: Readonly<Record<RecoveryDrillState, readonly RecoveryDrillState[]>> =
 {
 scheduled: ["running", "cancelled"],
 running: ["completed", "failed", "cancelled"],
 completed: [],
 failed: [],
 cancelled: [],
 };

function assertLegalDrillTransition(from: RecoveryDrillState, to: RecoveryDrillState): void {
 const allowed = LEGAL_DRILL_TRANSITIONS[from];
 if (!allowed.includes(to)) {
 throw new RecoveryDrillError(
 "illegal_transition",
 `非法状态转移：${from} → ${to}（允许：${allowed.join(", ") || "无（终态）"}）`,
 );
 }
}

// ─── RPO/RTO 默认值（按 drillType） ────────────────────────

/**
 * 各 drillType 的默认 RPO/RTO 目标（秒）。
 *
 * 设计依据方案 §8 责任边界：
 * - db_restore：RPO=300s（5min）、RTO=900s（15min）— 主库恢复要求最严。
 * - object_version：RPO=3600s（1h）、RTO=3600s（1h）— 对象版本可异步恢复。
 * - secret_restore：RPO=0（密钥不丢失）、RTO=300s（5min）— 密钥恢复要求立即。
 * - runtime_failover：RPO=0（无数据丢失）、RTO=60s（1min）— Runtime 快速切换。
 * - queue_failover：RPO=0（队列持久化）、RTO=120s（2min）— 队列快速恢复。
 */
export const DRILL_RPO_RTO_DEFAULTS: Record<
 RecoveryDrillType,
 { rpoTargetSeconds: number; rtoTargetSeconds: number }
> = {
 db_restore: { rpoTargetSeconds: 300, rtoTargetSeconds: 900 },
 object_version: { rpoTargetSeconds: 3600, rtoTargetSeconds: 3600 },
 secret_restore: { rpoTargetSeconds: 0, rtoTargetSeconds: 300 },
 runtime_failover: { rpoTargetSeconds: 0, rtoTargetSeconds: 60 },
 queue_failover: { rpoTargetSeconds: 0, rtoTargetSeconds: 120 },
};

// ─── 非终态状态集合 ────────────────────────────────────────

const NON_TERMINAL_DRILL_STATES: ReadonlySet<RecoveryDrillState> = new Set([
 "scheduled",
 "running",
]);

// ─── Check 合法转移 ────────────────────────────────────────

/**
 * Check 状态机：
 * - pending → running / skipped
 * - running → passed / failed
 * - passed / failed / skipped 为终态
 */
const LEGAL_CHECK_TRANSITIONS: Readonly<Record<RecoveryCheckState, readonly RecoveryCheckState[]>> =
 {
 pending: ["running", "skipped"],
 running: ["passed", "failed"],
 passed: [],
 failed: [],
 skipped: [],
 };

function assertLegalCheckTransition(from: RecoveryCheckState, to: RecoveryCheckState): void {
 const allowed = LEGAL_CHECK_TRANSITIONS[from];
 if (!allowed.includes(to)) {
 throw new RecoveryDrillError(
 "illegal_transition",
 `Check 非法状态转移：${from} → ${to}（允许：${allowed.join(", ") || "无（终态）"}）`,
 );
 }
}

// ─── 一致性汇总 ────────────────────────────────────────────

export interface RecoveryDrillSummary {
 checkCount: number;
 passedCount: number;
 failedCount: number;
 skippedCount: number;
 pendingCount: number;
 runningCount: number;
}

/** 从 check 列表派生汇总。 */
export function computeDrillSummary(checks: RecoveryDrillCheck[]): RecoveryDrillSummary {
 const summary: RecoveryDrillSummary = {
 checkCount: checks.length,
 passedCount: 0,
 failedCount: 0,
 skippedCount: 0,
 pendingCount: 0,
 runningCount: 0,
 };
 for (const c of checks) {
 switch (c.checkState) {
 case "passed":
 summary.passedCount += 1;
 break;
 case "failed":
 summary.failedCount += 1;
 break;
 case "skipped":
 summary.skippedCount += 1;
 break;
 case "pending":
 summary.pendingCount += 1;
 break;
 case "running":
 summary.runningCount += 1;
 break;
 }
 }
 return summary;
}

/**
 * 从 check 列表派生演练终态。
 * - 全 passed/skipped → completed
 * - 含 failed 且无 pending/running → failed
 * - 含 pending/running → null（保持 running，不自动终态）
 */
export function deriveDrillTerminalState(checks: RecoveryDrillCheck[]): RecoveryDrillState | null {
 if (checks.length === 0) return "completed";
 const hasPendingOrRunning = checks.some(
 (c) => c.checkState === "pending" || c.checkState === "running",
 );
 if (hasPendingOrRunning) return null;
 const hasFailed = checks.some((c) => c.checkState === "failed");
 if (hasFailed) return "failed";
 return "completed";
}

// ─── createRecoveryDrill ──────────────────────────────────

/**
 * 创建恢复演练（state=scheduled）+ 写审计 recovery.drill + 按 drillType 预填 check 项。
 *
 * 流程：
 * 1. 校验 environmentTag 非空（隔离环境标识，不连接生产数据库）。
 * 2. 检查同租户同 drillType 是否已有非终态演练（避免并发演练冲突）。
 * 3. 计算 RPO/RTO 目标（未传时用 DRILL_RPO_RTO_DEFAULTS）。
 * 4. 插入 RecoveryDrill（state=scheduled）。
 * 5. 写审计 recovery.drill（targetType=recovery_drill, targetId=drill.id）。
 * 6. 按 DRILL_CHECK_MATRIX 预填 check 项（state=pending）。
 * 7. 回填 auditEventId。
 *
 * @throws RecoveryDrillError duplicate_active_drill / invalid_environment
 */
export async function createRecoveryDrill(params: {
 tenantId: string;
 drillType: RecoveryDrillType;
 environmentTag: string;
 reason?: string;
 executedBy: string;
 executedByKind?: "user" | "service";
 rpoTargetSeconds?: number;
 rtoTargetSeconds?: number;
 actor: AuditActor;
 requestId?: string;
}): Promise<RecoveryDrill> {
 // 1. 校验 environmentTag
 if (!params.environmentTag.trim()) {
 throw new RecoveryDrillError(
 "invalid_environment",
 "environmentTag 不能为空（演练必须在隔离环境执行）",
 );
 }

 // 2. 检查同租户同 drillType 是否已有非终态演练
 const existing = await db
 .select({ id: recoveryDrillTable.id })
 .from(recoveryDrillTable)
 .where(
 and(
 eq(recoveryDrillTable.tenantId, params.tenantId),
 eq(recoveryDrillTable.drillType, params.drillType),
 inArray(recoveryDrillTable.drillState, [...NON_TERMINAL_DRILL_STATES]),
 ),
 )
 .limit(1);
 if (existing.length > 0) {
 throw new RecoveryDrillError(
 "duplicate_active_drill",
 `同租户已有未完成的 ${params.drillType} 演练（id=${existing[0]?.id}）`,
 );
 }

 // 3. 计算 RPO/RTO 目标
 const defaults = DRILL_RPO_RTO_DEFAULTS[params.drillType];
 const rpoTargetSeconds = params.rpoTargetSeconds ?? defaults.rpoTargetSeconds;
 const rtoTargetSeconds = params.rtoTargetSeconds ?? defaults.rtoTargetSeconds;

 // 4. 插入演练
 const drillId = randomUUID();
 const now = new Date();
 await db.insert(recoveryDrillTable).values({
 id: drillId,
 tenantId: params.tenantId,
 drillType: params.drillType,
 drillState: "scheduled",
 rpoTargetSeconds,
 rtoTargetSeconds,
 environmentTag: params.environmentTag,
 reason: params.reason ?? null,
 executedBy: params.executedBy,
 executedByKind: params.executedByKind ?? "user",
 scheduledAt: now,
 updatedAt: now,
 requestId: params.requestId ?? null,
 });

 // 5. 写审计
 const auditEvent = await recordAuditEvent({
 actor: params.actor,
 actionType: "recovery.drill",
 targetType: "recovery_drill",
 targetId: drillId,
 after: {
 drillType: params.drillType,
 drillState: "scheduled",
 environmentTag: params.environmentTag,
 rpoTargetSeconds,
 rtoTargetSeconds,
 },
 reason: params.reason ?? `创建恢复演练：${params.drillType}`,
 requestId: params.requestId,
 });

 // 6. 预填 check 项
 const checkTypes = DRILL_CHECK_MATRIX[params.drillType];
 if (checkTypes.length > 0) {
 const checkRows: Array<typeof recoveryDrillCheckTable.$inferInsert> = checkTypes.map(
 (checkType) => ({
 id: randomUUID(),
 tenantId: params.tenantId,
 drillId,
 checkType,
 checkState: "pending" as const,
 createdAt: now,
 updatedAt: now,
 }),
 );
 await db.insert(recoveryDrillCheckTable).values(checkRows);
 }

 // 7. 回填 auditEventId
 await db
 .update(recoveryDrillTable)
 .set({ auditEventId: auditEvent.id, updatedAt: new Date() })
 .where(eq(recoveryDrillTable.id, drillId));

 const created = await getRecoveryDrillById(params.tenantId, drillId);
 if (!created) {
 throw new RecoveryDrillError("drill_not_found", `创建后查询失败（id=${drillId}）`);
 }
 return created;
}

// ─── 查询 ──────────────────────────────────────────────────

/** 按 id 查询演练（跨租户隔离）。 */
export async function getRecoveryDrillById(
 tenantId: string,
 drillId: string,
): Promise<RecoveryDrill | null> {
 const rows = await db
 .select()
 .from(recoveryDrillTable)
 .where(and(eq(recoveryDrillTable.tenantId, tenantId), eq(recoveryDrillTable.id, drillId)))
 .limit(1);
 return rows[0] ?? null;
}

/** 列出演练（cursor 分页，支持 drillType/state/executedBy 过滤）。 */
export async function listRecoveryDrills(params: {
 tenantId: string;
 drillType?: RecoveryDrillType;
 drillState?: RecoveryDrillState;
 executedBy?: string;
 limit?: number;
 cursor?: string;
}): Promise<{ items: RecoveryDrill[]; nextCursor: string | null }> {
 const limit = Math.min(params.limit ?? 50, 200);
 const conditions = [eq(recoveryDrillTable.tenantId, params.tenantId)];
 if (params.drillType) {
 conditions.push(eq(recoveryDrillTable.drillType, params.drillType));
 }
 if (params.drillState) {
 conditions.push(eq(recoveryDrillTable.drillState, params.drillState));
 }
 if (params.executedBy) {
 conditions.push(eq(recoveryDrillTable.executedBy, params.executedBy));
 }

 // cursor 分页：scheduledAt ASC, id ASC（复合游标，处理同毫秒并发的场景）
 // cursor 编码为 base64url(JSON({scheduledAt, id}))
 let cursorCondition: ReturnType<typeof and> | undefined;
 if (params.cursor) {
 try {
 const decoded = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf-8")) as {
 scheduledAt: string;
 id: string;
 };
 cursorCondition = and(
 ...conditions,
 or(
 gt(recoveryDrillTable.scheduledAt, new Date(decoded.scheduledAt)),
 and(
 eq(recoveryDrillTable.scheduledAt, new Date(decoded.scheduledAt)),
 gt(recoveryDrillTable.id, decoded.id),
 ),
 ),
 );
 } catch {
 throw new RecoveryDrillError("illegal_transition", "非法 cursor（无法解码）");
 }
 }

 const rows = await db
 .select()
 .from(recoveryDrillTable)
 .where(cursorCondition ?? and(...conditions))
 .orderBy(asc(recoveryDrillTable.scheduledAt), asc(recoveryDrillTable.id))
 .limit(limit + 1);

 const items = rows.slice(0, limit);
 const hasMore = rows.length > limit;
 let nextCursor: string | null = null;
 if (hasMore && items.length > 0) {
 const last = items[items.length - 1];
 if (last) {
 nextCursor = Buffer.from(
 JSON.stringify({
 scheduledAt: last.scheduledAt.toISOString(),
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
 * 推进演练状态（写审计 before/after）。
 *
 * @throws RecoveryDrillError drill_not_found / illegal_transition
 */
export async function updateRecoveryDrillState(params: {
 tenantId: string;
 id: string;
 nextState: RecoveryDrillState;
 actor: AuditActor;
 reason?: string;
 requestId?: string;
 rpoActualSeconds?: number;
 rtoActualSeconds?: number;
 failureReason?: string;
}): Promise<RecoveryDrill> {
 const current = await getRecoveryDrillById(params.tenantId, params.id);
 if (!current) {
 throw new RecoveryDrillError("drill_not_found", `演练不存在（id=${params.id}）`);
 }
 assertLegalDrillTransition(current.drillState, params.nextState);

 const now = new Date();
 const updateFields: Partial<typeof recoveryDrillTable.$inferInsert> = {
 drillState: params.nextState,
 updatedAt: now,
 };
 if (params.nextState === "running") {
 updateFields.startedAt = now;
 }
 if (
 params.nextState === "completed" ||
 params.nextState === "failed" ||
 params.nextState === "cancelled"
 ) {
 updateFields.completedAt = now;
 }
 if (params.rpoActualSeconds !== undefined) {
 updateFields.rpoActualSeconds = params.rpoActualSeconds;
 }
 if (params.rtoActualSeconds !== undefined) {
 updateFields.rtoActualSeconds = params.rtoActualSeconds;
 }
 if (params.failureReason) {
 updateFields.failureReason = params.failureReason;
 }

 // 写审计 before/after
 const auditEvent = await recordAuditEvent({
 actor: params.actor,
 actionType: "recovery.drill",
 targetType: "recovery_drill",
 targetId: params.id,
 before: { drillState: current.drillState },
 after: { drillState: params.nextState },
 reason: params.reason ?? `演练状态转移：${current.drillState} → ${params.nextState}`,
 requestId: params.requestId,
 });

 await db
 .update(recoveryDrillTable)
 .set({ ...updateFields, auditEventId: auditEvent.id })
 .where(eq(recoveryDrillTable.id, params.id));

 const updated = await getRecoveryDrillById(params.tenantId, params.id);
 if (!updated) {
 throw new RecoveryDrillError("drill_not_found", `更新后查询失败（id=${params.id}）`);
 }
 return updated;
}

/** scheduled → running（便捷封装）。 */
export async function startRecoveryDrill(params: {
 tenantId: string;
 id: string;
 actor: AuditActor;
 requestId?: string;
}): Promise<RecoveryDrill> {
 return updateRecoveryDrillState({
 ...params,
 nextState: "running",
 reason: "演练开始执行（故障注入 + 恢复 + 一致性核对）",
 });
}

/**
 * running → completed（便捷封装）。
 * 要求所有 in-scope check 为 passed/skipped（deriveDrillTerminalState 校验）。
 */
export async function completeRecoveryDrill(params: {
 tenantId: string;
 id: string;
 actor: AuditActor;
 requestId?: string;
 rpoActualSeconds?: number;
 rtoActualSeconds?: number;
}): Promise<RecoveryDrill> {
 const checks = await listRecoveryDrillChecks(params.tenantId, params.id);
 const terminal = deriveDrillTerminalState(checks);
 if (terminal !== "completed") {
 throw new RecoveryDrillError(
 "illegal_transition",
 `演练不可完成：存在未通过或未完成的 check（deriveDrillTerminalState=${terminal ?? "null"}）`,
 );
 }
 const summary = computeDrillSummary(checks);
 const updated = await updateRecoveryDrillState({
 ...params,
 nextState: "completed",
 reason: `演练完成（${summary.passedCount} passed, ${summary.skippedCount} skipped）`,
 });

 // 回填 consistencySummaryJson
 await db
 .update(recoveryDrillTable)
 .set({
 consistencySummaryJson: JSON.stringify(summary),
 updatedAt: new Date(),
 })
 .where(eq(recoveryDrillTable.id, params.id));

 const refreshed = await getRecoveryDrillById(params.tenantId, params.id);
 if (!refreshed) {
 throw new RecoveryDrillError("drill_not_found", `完成后查询失败（id=${params.id}）`);
 }
 return refreshed;
}

/** running → failed（便捷封装）。 */
export async function failRecoveryDrill(params: {
 tenantId: string;
 id: string;
 actor: AuditActor;
 failureReason: string;
 requestId?: string;
 rpoActualSeconds?: number;
 rtoActualSeconds?: number;
}): Promise<RecoveryDrill> {
 const checks = await listRecoveryDrillChecks(params.tenantId, params.id);
 const summary = computeDrillSummary(checks);
 const updated = await updateRecoveryDrillState({
 ...params,
 nextState: "failed",
 reason: `演练失败（${summary.failedCount} failed）`,
 failureReason: params.failureReason,
 });

 await db
 .update(recoveryDrillTable)
 .set({
 consistencySummaryJson: JSON.stringify(summary),
 updatedAt: new Date(),
 })
 .where(eq(recoveryDrillTable.id, params.id));

 const refreshed = await getRecoveryDrillById(params.tenantId, params.id);
 if (!refreshed) {
 throw new RecoveryDrillError("drill_not_found", `失败后查询失败（id=${params.id}）`);
 }
 return refreshed;
}

/** scheduled/running → cancelled（便捷封装）。 */
export async function cancelRecoveryDrill(params: {
 tenantId: string;
 id: string;
 actor: AuditActor;
 reason: string;
 requestId?: string;
}): Promise<RecoveryDrill> {
 return updateRecoveryDrillState({
 ...params,
 nextState: "cancelled",
 });
}

// ─── Check 管理 ────────────────────────────────────────────

/** 列出演练下所有 check（按 checkType 排序）。 */
export async function listRecoveryDrillChecks(
 tenantId: string,
 drillId: string,
): Promise<RecoveryDrillCheck[]> {
 return db
 .select()
 .from(recoveryDrillCheckTable)
 .where(
 and(
 eq(recoveryDrillCheckTable.tenantId, tenantId),
 eq(recoveryDrillCheckTable.drillId, drillId),
 ),
 )
 .orderBy(asc(recoveryDrillCheckTable.checkType));
}

/** 按 id 查询单个 check。 */
export async function getRecoveryDrillCheck(
 tenantId: string,
 checkId: string,
): Promise<RecoveryDrillCheck | null> {
 const rows = await db
 .select()
 .from(recoveryDrillCheckTable)
 .where(
 and(eq(recoveryDrillCheckTable.tenantId, tenantId), eq(recoveryDrillCheckTable.id, checkId)),
 )
 .limit(1);
 return rows[0] ?? null;
}

/** markCheckRunning：pending → running（幂等：已终态则原样返回）。 */
export async function markCheckRunning(params: {
 tenantId: string;
 checkId: string;
}): Promise<RecoveryDrillCheck> {
 const current = await getRecoveryDrillCheck(params.tenantId, params.checkId);
 if (!current) {
 throw new RecoveryDrillError("check_not_found", `Check 不存在（id=${params.checkId}）`);
 }
 if (current.checkState !== "pending") {
 // 幂等：非 pending 原样返回（不重复执行）
 return current;
 }
 await db
 .update(recoveryDrillCheckTable)
 .set({ checkState: "running", updatedAt: new Date() })
 .where(eq(recoveryDrillCheckTable.id, params.checkId));
 const updated = await getRecoveryDrillCheck(params.tenantId, params.checkId);
 if (!updated) {
 throw new RecoveryDrillError("check_not_found", `更新后查询失败（id=${params.checkId}）`);
 }
 return updated;
}

/**
 * completeRecoveryDrillCheck：running → passed。
 * 要求 evidenceRef 非空（不以日志文本冒充可恢复性）。
 */
export async function completeRecoveryDrillCheck(params: {
 tenantId: string;
 checkId: string;
 evidenceRef: string;
 detailsJson?: string;
 durationMs?: number;
}): Promise<RecoveryDrillCheck> {
 if (!params.evidenceRef.trim()) {
 throw new RecoveryDrillError(
 "missing_evidence",
 "evidenceRef 不能为空（passed 要求存储端证据）",
 );
 }
 const current = await getRecoveryDrillCheck(params.tenantId, params.checkId);
 if (!current) {
 throw new RecoveryDrillError("check_not_found", `Check 不存在（id=${params.checkId}）`);
 }
 assertLegalCheckTransition(current.checkState, "passed");
 const now = new Date();
 await db
 .update(recoveryDrillCheckTable)
 .set({
 checkState: "passed",
 evidenceRef: params.evidenceRef,
 detailsJson: params.detailsJson ?? null,
 durationMs: params.durationMs ?? null,
 completedAt: now,
 updatedAt: now,
 })
 .where(eq(recoveryDrillCheckTable.id, params.checkId));
 const updated = await getRecoveryDrillCheck(params.tenantId, params.checkId);
 if (!updated) {
 throw new RecoveryDrillError("check_not_found", `完成后查询失败（id=${params.checkId}）`);
 }
 return updated;
}

/** failRecoveryDrillCheck：running → failed。要求 evidenceRef 非空。 */
export async function failRecoveryDrillCheck(params: {
 tenantId: string;
 checkId: string;
 evidenceRef: string;
 failureReason: string;
 detailsJson?: string;
 durationMs?: number;
}): Promise<RecoveryDrillCheck> {
 if (!params.evidenceRef.trim()) {
 throw new RecoveryDrillError(
 "missing_evidence",
 "evidenceRef 不能为空（failed 要求存储端证据）",
 );
 }
 const current = await getRecoveryDrillCheck(params.tenantId, params.checkId);
 if (!current) {
 throw new RecoveryDrillError("check_not_found", `Check 不存在（id=${params.checkId}）`);
 }
 assertLegalCheckTransition(current.checkState, "failed");
 const now = new Date();
 await db
 .update(recoveryDrillCheckTable)
 .set({
 checkState: "failed",
 evidenceRef: params.evidenceRef,
 failureReason: params.failureReason,
 detailsJson: params.detailsJson ?? null,
 durationMs: params.durationMs ?? null,
 completedAt: now,
 updatedAt: now,
 })
 .where(eq(recoveryDrillCheckTable.id, params.checkId));
 const updated = await getRecoveryDrillCheck(params.tenantId, params.checkId);
 if (!updated) {
 throw new RecoveryDrillError("check_not_found", `失败后查询失败（id=${params.checkId}）`);
 }
 return updated;
}

/** skipRecoveryDrillCheck：pending → skipped。 */
export async function skipRecoveryDrillCheck(params: {
 tenantId: string;
 checkId: string;
 reason: string;
}): Promise<RecoveryDrillCheck> {
 const current = await getRecoveryDrillCheck(params.tenantId, params.checkId);
 if (!current) {
 throw new RecoveryDrillError("check_not_found", `Check 不存在（id=${params.checkId}）`);
 }
 assertLegalCheckTransition(current.checkState, "skipped");
 const now = new Date();
 await db
 .update(recoveryDrillCheckTable)
 .set({
 checkState: "skipped",
 failureReason: params.reason,
 completedAt: now,
 updatedAt: now,
 })
 .where(eq(recoveryDrillCheckTable.id, params.checkId));
 const updated = await getRecoveryDrillCheck(params.tenantId, params.checkId);
 if (!updated) {
 throw new RecoveryDrillError("check_not_found", `跳过后查询失败（id=${params.checkId}）`);
 }
 return updated;
}
