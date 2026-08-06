/**
 * Legal Hold 仓储（S12-W06）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-data-lifecycle.md §6
 * （Legal Hold 明确对象范围、原因、创建人、批准人、有效期和解除审计；
 * Hold 生效时阻止相关删除但不扩大到无关对象；解除后恢复原保留策略计算）。
 *
 * 职责：
 * - createLegalHold：创建 Legal Hold（active 状态，需双人审批）。
 * - releaseLegalHold：解除 Legal Hold（写审计，恢复保留策略计算）。
 * - getActiveLegalHold：查询目标是否有 active Legal Hold。
 * - isLegalHoldActive：判断目标是否被 Legal Hold 阻止删除。
 * - listLegalHolds：列出 Legal Hold（cursor 分页，支持 targetType/holdState 过滤）。
 * - deleteExpiredLegalHolds：清理过期 Hold（validUntil < now 且未解除）。
 *
 * 不变量：
 * - 同一 (tenantId, targetType, targetId) 仅一条记录（唯一索引保证）。
 * - 解除后 holdState=released，不可重新激活（需新建）。
 * - Legal Hold 不扩大到无关对象：仅匹配的 target 被阻止删除。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { type AuditActor, recordAuditEvent } from "@/lib/identity/audit";
import {
 type LegalHold,
 type LegalHoldTargetType,
 legalHoldTable,
} from "@/lib/persistence/schema/retention-policy";
import { and, asc, eq, gt, lt } from "drizzle-orm";

// ─── 错误类型 ──────────────────────────────────────────────

/** Legal Hold 错误。 */
export class LegalHoldError extends Error {
 constructor(
 public readonly code:
 | "hold_already_exists"
 | "hold_not_found"
 | "hold_already_released"
 | "hold_expired"
 | "invalid_target",
 message: string,
 ) {
 super(message);
 this.name = "LegalHoldError";
 }
}

// ─── CRUD ──────────────────────────────────────────────────

/** 创建 Legal Hold（active 状态）。 */
export async function createLegalHold(params: {
 tenantId: string;
 targetType: LegalHoldTargetType;
 targetId: string;
 reason: string;
 createdBy: string;
 approvedBy: string;
 validUntil: Date;
 actor: AuditActor;
 requestId?: string;
}): Promise<LegalHold> {
 // 唯一性检查：同一 target 不可重复 Hold
 const existing = await getLegalHoldByTarget(params.tenantId, params.targetType, params.targetId);
 if (existing) {
 throw new LegalHoldError(
 "hold_already_exists",
 `Legal Hold 已存在（tenantId=${params.tenantId}, targetType=${params.targetType}, targetId=${params.targetId}）`,
 );
 }

 // 有效期校验：validUntil 必须在未来
 const now = new Date();
 if (params.validUntil.getTime() <= now.getTime()) {
 throw new LegalHoldError(
 "hold_expired",
 `validUntil 必须在未来（当前=${params.validUntil.toISOString()}）`,
 );
 }

 // 双人审批校验：createdBy 与 approvedBy 不可相同
 if (params.createdBy === params.approvedBy) {
 throw new LegalHoldError("invalid_target", "createdBy 与 approvedBy 不可相同（需双人审批）");
 }

 const id = randomUUID();
 await db.insert(legalHoldTable).values({
 id,
 tenantId: params.tenantId,
 targetType: params.targetType,
 targetId: params.targetId,
 holdState: "active",
 reason: params.reason,
 createdBy: params.createdBy,
 approvedBy: params.approvedBy,
 validUntil: params.validUntil,
 });

 const [row] = await db.select().from(legalHoldTable).where(eq(legalHoldTable.id, id)).limit(1);
 if (!row) {
 throw new Error(`createLegalHold: 行未找到（id=${id}）`);
 }

 await recordAuditEvent({
 actor: params.actor,
 actionType: "legal_hold.manage",
 targetType: "legal_hold",
 targetId: id,
 after: {
 target_type: params.targetType,
 target_id: params.targetId,
 reason: params.reason,
 created_by: params.createdBy,
 approved_by: params.approvedBy,
 valid_until: params.validUntil.toISOString(),
 },
 reason: `创建 Legal Hold：${params.reason}`,
 requestId: params.requestId,
 });

 return row;
}

/** 解除 Legal Hold（写审计，恢复保留策略计算）。 */
export async function releaseLegalHold(params: {
 tenantId: string;
 id: string;
 releasedBy: string;
 releaseReason: string;
 actor: AuditActor;
 requestId?: string;
}): Promise<LegalHold> {
 const existing = await getLegalHoldById(params.tenantId, params.id);
 if (!existing) {
 throw new LegalHoldError("hold_not_found", `Legal Hold 不存在（id=${params.id}）`);
 }
 if (existing.holdState === "released") {
 throw new LegalHoldError("hold_already_released", `Legal Hold 已解除（id=${params.id}）`);
 }

 const releasedAt = new Date();
 await db
 .update(legalHoldTable)
 .set({
 holdState: "released",
 releasedAt,
 releasedBy: params.releasedBy,
 releaseReason: params.releaseReason,
 })
 .where(eq(legalHoldTable.id, params.id));

 const [row] = await db
 .select()
 .from(legalHoldTable)
 .where(eq(legalHoldTable.id, params.id))
 .limit(1);
 if (!row) {
 throw new Error(`releaseLegalHold: 行未找到（id=${params.id}）`);
 }

 await recordAuditEvent({
 actor: params.actor,
 actionType: "legal_hold.manage",
 targetType: "legal_hold",
 targetId: params.id,
 before: {
 hold_state: existing.holdState,
 reason: existing.reason,
 },
 after: {
 hold_state: "released",
 released_at: releasedAt.toISOString(),
 released_by: params.releasedBy,
 release_reason: params.releaseReason,
 },
 reason: `解除 Legal Hold：${params.releaseReason}`,
 requestId: params.requestId,
 });

 return row;
}

/** 按 id 查询 Legal Hold；不存在返回 null。 */
export async function getLegalHoldById(tenantId: string, id: string): Promise<LegalHold | null> {
 const [row] = await db
 .select()
 .from(legalHoldTable)
 .where(and(eq(legalHoldTable.tenantId, tenantId), eq(legalHoldTable.id, id)))
 .limit(1);
 return row ?? null;
}

/** 按 target 查询 Legal Hold（含已解除）；不存在返回 null。 */
export async function getLegalHoldByTarget(
 tenantId: string,
 targetType: LegalHoldTargetType,
 targetId: string,
): Promise<LegalHold | null> {
 const [row] = await db
 .select()
 .from(legalHoldTable)
 .where(
 and(
 eq(legalHoldTable.tenantId, tenantId),
 eq(legalHoldTable.targetType, targetType),
 eq(legalHoldTable.targetId, targetId),
 ),
 )
 .limit(1);
 return row ?? null;
}

/** 查询目标的 active Legal Hold；不存在或已解除返回 null。 */
export async function getActiveLegalHold(
 tenantId: string,
 targetType: LegalHoldTargetType,
 targetId: string,
): Promise<LegalHold | null> {
 const [row] = await db
 .select()
 .from(legalHoldTable)
 .where(
 and(
 eq(legalHoldTable.tenantId, tenantId),
 eq(legalHoldTable.targetType, targetType),
 eq(legalHoldTable.targetId, targetId),
 eq(legalHoldTable.holdState, "active"),
 ),
 )
 .limit(1);
 return row ?? null;
}

/**
 * 判断目标是否被 Legal Hold 阻止删除。
 *
 * active 且未过期的 Hold 阻止删除；已解除或已过期的 Hold 不阻止。
 */
export async function isLegalHoldActive(
 tenantId: string,
 targetType: LegalHoldTargetType,
 targetId: string,
 now: Date = new Date(),
): Promise<boolean> {
 const hold = await getActiveLegalHold(tenantId, targetType, targetId);
 if (!hold) return false;
 // 过期的 Hold 自动失效（但不改变状态，由清理任务处理）
 return hold.validUntil.getTime() > now.getTime();
}

// ─── 列表查询（cursor 分页） ────────────────────────────────

export interface LegalHoldFilter {
 tenantId: string;
 targetType?: LegalHoldTargetType;
 targetId?: string;
 holdState?: "active" | "released";
 limit?: number;
 cursor?: string; // createdAt RFC 3339
}

export interface LegalHoldPage {
 items: LegalHold[];
 nextCursor: string | null;
}

/** 列出 Legal Hold（cursor 分页，按 createdAt 降序）。 */
export async function listLegalHolds(filter: LegalHoldFilter): Promise<LegalHoldPage> {
 const limit = Math.min(filter.limit ?? 50, 200);
 const conditions = [eq(legalHoldTable.tenantId, filter.tenantId)];
 if (filter.targetType) {
 conditions.push(eq(legalHoldTable.targetType, filter.targetType));
 }
 if (filter.targetId) {
 conditions.push(eq(legalHoldTable.targetId, filter.targetId));
 }
 if (filter.holdState) {
 conditions.push(eq(legalHoldTable.holdState, filter.holdState));
 }
 if (filter.cursor) {
 const cursorDate = new Date(filter.cursor);
 conditions.push(gt(legalHoldTable.createdAt, cursorDate));
 }

 const rows = await db
 .select()
 .from(legalHoldTable)
 .where(and(...conditions))
 .orderBy(asc(legalHoldTable.createdAt))
 .limit(limit + 1);

 const hasMore = rows.length > limit;
 const page = hasMore ? rows.slice(0, limit) : rows;
 const lastRow = page[page.length - 1];
 const nextCursor = hasMore && lastRow ? lastRow.createdAt.toISOString() : null;

 return { items: page, nextCursor };
}

// ─── 清理 ──────────────────────────────────────────────────

/**
 * 清理过期的 active Legal Hold（validUntil < now）。
 *
 * 注意：过期 Hold 不自动解除（保留审计痕迹），仅由清理任务标记为 expired
 * 或由管理员手动解除。本函数返回过期但未解除的 Hold 列表，供清理任务处理。
 *
 * @returns 过期但未解除的 Hold 列表
 */
export async function listExpiredActiveHolds(now: Date = new Date()): Promise<LegalHold[]> {
 const rows = await db
 .select()
 .from(legalHoldTable)
 .where(and(eq(legalHoldTable.holdState, "active"), lt(legalHoldTable.validUntil, now)))
 .orderBy(asc(legalHoldTable.validUntil));
 return rows;
}
