/**
 * 数据保留策略仓储与解析引擎（S12-W06）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-data-lifecycle.md §6
 * （为 Thread/Event/Trace/Audit/Artifact/Memory/Knowledge/Job/安全记录定义独立保留策略；
 * 保留策略使用组织/数据分类/对象类型和法定要求解析，不把一个天数硬编码到所有存储）。
 *
 * 职责：
 * - createRetentionPolicy：创建保留策略（按 tenantId+objectType 唯一）。
 * - getRetentionPolicy：按 tenantId+objectType 查询策略。
 * - updateRetentionPolicy：更新策略（保留审计）。
 * - deleteRetentionPolicy：删除策略（保留审计）。
 * - listRetentionPolicies：列出租户所有策略（支持 dataClass 过滤 + cursor 分页）。
 * - resolveRetentionDays：解析引擎 — 按 objectType + dataClass + statutoryRequirements 计算保留天数。
 * - isRetentionExpired：判断对象是否已过保留期（结合 Legal Hold 窗口）。
 *
 * 解析引擎规则：
 * - 策略按 (tenantId, objectType) 唯一定位。
 * - retentionDays 支持整数天数或 "permanent"（永久保留）。
 * - legalHoldDays（可空）：Legal Hold 解除后的额外保留窗口。
 * - 无策略时返回默认保留天数（按 objectType 分级，不硬编码单一值）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { type AuditActor, recordAuditEvent } from "@/lib/identity/audit";
import {
 type RetentionObjectType,
 type RetentionPolicy,
 retentionPolicyTable,
} from "@/lib/persistence/schema/retention-policy";
import { and, asc, eq, gt } from "drizzle-orm";

// ─── 默认保留天数（按对象类型分级） ──────────────────────────

/**
 * 默认保留天数（无显式策略时使用）。
 *
 * 按对象类型分级，不硬编码单一值：
 * - audit/security_log：长期保留（合规要求）
 * - thread/event/trace：中期保留（排障需要）
 * - artifact/memory/knowledge/job：短期保留（运行需要）
 */
export const DEFAULT_RETENTION_DAYS: Readonly<Record<RetentionObjectType, number>> = {
 audit: 365 * 7, // 7 年（合规审计要求）
 security_log: 365 * 7, // 7 年（安全合规要求）
 thread: 365, // 1 年
 event: 365, // 1 年
 trace: 90, // 90 天
 artifact: 180, // 180 天
 memory: 90, // 90 天
 knowledge: 365, // 1 年
 job: 90, // 90 天
};

// ─── 错误类型 ──────────────────────────────────────────────

/** 保留策略错误。 */
export class RetentionPolicyError extends Error {
 constructor(
 public readonly code:
 | "policy_already_exists"
 | "policy_not_found"
 | "invalid_retention_days"
 | "invalid_object_type",
 message: string,
 ) {
 super(message);
 this.name = "RetentionPolicyError";
 }
}

// ─── 校验工具 ──────────────────────────────────────────────

/** 校验保留天数字符串：正整数天数或 "permanent"。 */
export function validateRetentionDays(value: string): void {
 if (value === "permanent") return;
 const days = Number(value);
 if (!Number.isInteger(days) || days <= 0) {
 throw new RetentionPolicyError(
 "invalid_retention_days",
 `retentionDays 必须是正整数或 "permanent"（当前=${value}）`,
 );
 }
}

/** 解析保留天数为数值；"permanent" 返回 Number.POSITIVE_INFINITY。 */
export function parseRetentionDays(value: string): number {
 if (value === "permanent") return Number.POSITIVE_INFINITY;
 const days = Number(value);
 if (!Number.isInteger(days) || days <= 0) {
 throw new RetentionPolicyError(
 "invalid_retention_days",
 `retentionDays 必须是正整数或 "permanent"（当前=${value}）`,
 );
 }
 return days;
}

// ─── CRUD ──────────────────────────────────────────────────

/** 创建保留策略（按 tenantId+objectType 唯一，重复抛 policy_already_exists）。 */
export async function createRetentionPolicy(params: {
 tenantId: string;
 objectType: RetentionObjectType;
 retentionDays: string;
 legalHoldDays?: string;
 dataClass: string;
 statutoryRequirements: string;
 description: string;
 createdBy: string;
 actor: AuditActor;
 requestId?: string;
}): Promise<RetentionPolicy> {
 validateRetentionDays(params.retentionDays);
 if (params.legalHoldDays) validateRetentionDays(params.legalHoldDays);

 // 唯一性检查
 const existing = await getRetentionPolicy(params.tenantId, params.objectType);
 if (existing) {
 throw new RetentionPolicyError(
 "policy_already_exists",
 `保留策略已存在（tenantId=${params.tenantId}, objectType=${params.objectType}）`,
 );
 }

 const id = randomUUID();
 await db.insert(retentionPolicyTable).values({
 id,
 tenantId: params.tenantId,
 objectType: params.objectType,
 retentionDays: params.retentionDays,
 legalHoldDays: params.legalHoldDays ?? null,
 dataClass: params.dataClass,
 statutoryRequirements: params.statutoryRequirements,
 description: params.description,
 createdBy: params.createdBy,
 updatedBy: params.createdBy,
 });

 const [row] = await db
 .select()
 .from(retentionPolicyTable)
 .where(eq(retentionPolicyTable.id, id))
 .limit(1);
 if (!row) {
 throw new Error(`createRetentionPolicy: 行未找到（id=${id}）`);
 }

 await recordAuditEvent({
 actor: params.actor,
 actionType: "legal_hold.manage",
 targetType: "retention_policy",
 targetId: id,
 after: {
 object_type: params.objectType,
 retention_days: params.retentionDays,
 legal_hold_days: params.legalHoldDays ?? null,
 data_class: params.dataClass,
 statutory_requirements: params.statutoryRequirements,
 },
 reason: `创建保留策略：${params.description}`,
 requestId: params.requestId,
 });

 return row;
}

/** 按 tenantId+objectType 查询策略；不存在返回 null。 */
export async function getRetentionPolicy(
 tenantId: string,
 objectType: RetentionObjectType,
): Promise<RetentionPolicy | null> {
 const [row] = await db
 .select()
 .from(retentionPolicyTable)
 .where(
 and(
 eq(retentionPolicyTable.tenantId, tenantId),
 eq(retentionPolicyTable.objectType, objectType),
 ),
 )
 .limit(1);
 return row ?? null;
}

/** 按 id 查询策略；不存在返回 null。 */
export async function getRetentionPolicyById(
 tenantId: string,
 id: string,
): Promise<RetentionPolicy | null> {
 const [row] = await db
 .select()
 .from(retentionPolicyTable)
 .where(and(eq(retentionPolicyTable.tenantId, tenantId), eq(retentionPolicyTable.id, id)))
 .limit(1);
 return row ?? null;
}

/** 更新策略（保留审计）。 */
export async function updateRetentionPolicy(params: {
 tenantId: string;
 id: string;
 retentionDays?: string;
 legalHoldDays?: string | null;
 dataClass?: string;
 statutoryRequirements?: string;
 description?: string;
 updatedBy: string;
 actor: AuditActor;
 requestId?: string;
}): Promise<RetentionPolicy> {
 const existing = await getRetentionPolicyById(params.tenantId, params.id);
 if (!existing) {
 throw new RetentionPolicyError("policy_not_found", `保留策略不存在（id=${params.id}）`);
 }

 if (params.retentionDays !== undefined) validateRetentionDays(params.retentionDays);
 if (params.legalHoldDays) validateRetentionDays(params.legalHoldDays);

 const updates: Partial<RetentionPolicy> = { updatedBy: params.updatedBy };
 if (params.retentionDays !== undefined) updates.retentionDays = params.retentionDays;
 if (params.legalHoldDays !== undefined) {
 updates.legalHoldDays = params.legalHoldDays === null ? null : params.legalHoldDays;
 }
 if (params.dataClass !== undefined) updates.dataClass = params.dataClass;
 if (params.statutoryRequirements !== undefined) {
 updates.statutoryRequirements = params.statutoryRequirements;
 }
 if (params.description !== undefined) updates.description = params.description;

 await db
 .update(retentionPolicyTable)
 .set({ ...updates, updatedAt: new Date() })
 .where(eq(retentionPolicyTable.id, params.id));

 const [row] = await db
 .select()
 .from(retentionPolicyTable)
 .where(eq(retentionPolicyTable.id, params.id))
 .limit(1);
 if (!row) {
 throw new Error(`updateRetentionPolicy: 行未找到（id=${params.id}）`);
 }

 await recordAuditEvent({
 actor: params.actor,
 actionType: "legal_hold.manage",
 targetType: "retention_policy",
 targetId: params.id,
 before: {
 retention_days: existing.retentionDays,
 legal_hold_days: existing.legalHoldDays,
 data_class: existing.dataClass,
 },
 after: {
 retention_days: row.retentionDays,
 legal_hold_days: row.legalHoldDays,
 data_class: row.dataClass,
 },
 reason: `更新保留策略：${row.description}`,
 requestId: params.requestId,
 });

 return row;
}

/** 删除策略（保留审计）。 */
export async function deleteRetentionPolicy(params: {
 tenantId: string;
 id: string;
 deletedBy: string;
 actor: AuditActor;
 requestId?: string;
}): Promise<void> {
 const existing = await getRetentionPolicyById(params.tenantId, params.id);
 if (!existing) {
 throw new RetentionPolicyError("policy_not_found", `保留策略不存在（id=${params.id}）`);
 }

 await db.delete(retentionPolicyTable).where(eq(retentionPolicyTable.id, params.id));

 await recordAuditEvent({
 actor: params.actor,
 actionType: "legal_hold.manage",
 targetType: "retention_policy",
 targetId: params.id,
 before: {
 object_type: existing.objectType,
 retention_days: existing.retentionDays,
 data_class: existing.dataClass,
 },
 reason: `删除保留策略：${existing.description}`,
 requestId: params.requestId,
 });
}

// ─── 列表查询（cursor 分页） ────────────────────────────────

export interface RetentionPolicyFilter {
 tenantId: string;
 dataClass?: string;
 objectType?: RetentionObjectType;
 limit?: number;
 cursor?: string; // createdAt RFC 3339
}

export interface RetentionPolicyPage {
 items: RetentionPolicy[];
 nextCursor: string | null;
}

/** 列出保留策略（cursor 分页，按 createdAt 降序）。 */
export async function listRetentionPolicies(
 filter: RetentionPolicyFilter,
): Promise<RetentionPolicyPage> {
 const limit = Math.min(filter.limit ?? 50, 200);
 const conditions = [eq(retentionPolicyTable.tenantId, filter.tenantId)];
 if (filter.dataClass) {
 conditions.push(eq(retentionPolicyTable.dataClass, filter.dataClass));
 }
 if (filter.objectType) {
 conditions.push(eq(retentionPolicyTable.objectType, filter.objectType));
 }
 if (filter.cursor) {
 const cursorDate = new Date(filter.cursor);
 conditions.push(gt(retentionPolicyTable.createdAt, cursorDate));
 }

 const rows = await db
 .select()
 .from(retentionPolicyTable)
 .where(and(...conditions))
 .orderBy(asc(retentionPolicyTable.createdAt))
 .limit(limit + 1);

 const hasMore = rows.length > limit;
 const page = hasMore ? rows.slice(0, limit) : rows;
 const lastRow = page[page.length - 1];
 const nextCursor = hasMore && lastRow ? lastRow.createdAt.toISOString() : null;

 return { items: page, nextCursor };
}

// ─── 解析引擎 ──────────────────────────────────────────────

/**
 * 解析对象的有效保留天数。
 *
 * 解析顺序：
 * 1. 查询 (tenantId, objectType) 的显式策略。
 * 2. 无策略时使用 DEFAULT_RETENTION_DAYS 默认值。
 * 3. "permanent" 返回 Number.POSITIVE_INFINITY。
 *
 * @returns 保留天数（正整数或 Number.POSITIVE_INFINITY）
 */
export async function resolveRetentionDays(
 tenantId: string,
 objectType: RetentionObjectType,
): Promise<number> {
 const policy = await getRetentionPolicy(tenantId, objectType);
 if (policy) {
 return parseRetentionDays(policy.retentionDays);
 }
 return DEFAULT_RETENTION_DAYS[objectType];
}

/**
 * 解析 Legal Hold 解除后的额外保留天数。
 *
 * @returns 额外保留天数（无策略或 legalHoldDays 为空返回 0；"permanent" 返回 Infinity）
 */
export async function resolveLegalHoldRetentionDays(
 tenantId: string,
 objectType: RetentionObjectType,
): Promise<number> {
 const policy = await getRetentionPolicy(tenantId, objectType);
 if (!policy || !policy.legalHoldDays) return 0;
 return parseRetentionDays(policy.legalHoldDays);
}

/**
 * 判断对象是否已过保留期。
 *
 * @param createdAt 对象创建时间
 * @param releasedAt Legal Hold 解除时间（可空，表示从未被 Hold）
 * @returns true 表示已过保留期，可清理
 */
export async function isRetentionExpired(params: {
 tenantId: string;
 objectType: RetentionObjectType;
 createdAt: Date;
 releasedAt?: Date | null;
 now?: Date;
}): Promise<boolean> {
 const now = params.now ?? new Date();

 // 计算保留截止时间
 const retentionDays = await resolveRetentionDays(params.tenantId, params.objectType);
 if (retentionDays === Number.POSITIVE_INFINITY) return false; // 永久保留

 const retentionDeadline = new Date(
 params.createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000,
 );

 // 无 Legal Hold 解除：仅按 retentionDays 判断
 if (!params.releasedAt) {
 return now.getTime() > retentionDeadline.getTime();
 }

 // 有 Legal Hold 解除：retentionDays + legalHoldDays 从 releasedAt 起算
 const legalHoldDays = await resolveLegalHoldRetentionDays(params.tenantId, params.objectType);
 if (legalHoldDays === Number.POSITIVE_INFINITY) return false;

 const holdDeadline = new Date(params.releasedAt.getTime() + legalHoldDays * 24 * 60 * 60 * 1000);

 // 取两者较晚的截止时间
 const effectiveDeadline =
 holdDeadline.getTime() > retentionDeadline.getTime() ? holdDeadline : retentionDeadline;
 return now.getTime() > effectiveDeadline.getTime();
}
