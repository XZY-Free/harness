/**
 * audit_event 仓储。
 *
 * 事实源：docs/architecture/persistence.md §8、
 * docs/architecture/security.md 。
 *
 * 职责：
 * - appendAuditEvent：只追加写入（不提供 update/delete，保证不可修改）。
 * - listAuditEvents：按 tenantId + 可选 actor/target/action/时间范围/游标查询。
 * - getAuditEventById：单条查询。
 * - deleteExpiredEvents：仅数据生命周期阶段使用（依法清理）。
 *
 * 审计守卫（recordAuditEvent）在 lib/identity/audit.ts，
 * 本模块只提供数据访问，不包含业务判断。
 *
 * 只追加语义：本模块不导出任何 update/delete 函数（deleteExpiredEvents 除外，
 * 仅供阶段 12 数据生命周期流程使用，普通应用账号无权调用）。
 */
import { db } from "@/lib/db/client";
import {
 type AuditActorType,
 type AuditEvent,
 auditEvent,
} from "@/lib/persistence/schema/control-plane";
import { and, asc, eq, gte, lte } from "drizzle-orm";

/** 追加审计事件（只写不更新）。 */
export async function appendAuditEvent(params: {
 tenantId: string;
 actorType: AuditActorType;
 actorId: string;
 actionType: string;
 targetType: string;
 targetId?: string | null;
 beforeHash?: string | null;
 afterHash?: string | null;
 reason?: string | null;
 requestId: string;
 occurredAt?: Date;
}): Promise<AuditEvent> {
 const occurredAt = params.occurredAt ?? new Date();
 const id = crypto.randomUUID();
 await db.insert(auditEvent).values({
 id,
 tenantId: params.tenantId,
 actorType: params.actorType,
 actorId: params.actorId,
 actionType: params.actionType,
 targetType: params.targetType,
 targetId: params.targetId ?? null,
 beforeHash: params.beforeHash ?? null,
 afterHash: params.afterHash ?? null,
 reason: params.reason ?? null,
 requestId: params.requestId,
 occurredAt,
 });
 const [row] = await db.select().from(auditEvent).where(eq(auditEvent.id, id)).limit(1);
 if (!row) {
 throw new Error(`appendAuditEvent: 行未找到（id=${id}）`);
 }
 return row;
}

/** 按 id 获取审计事件。不存在返回 null。 */
export async function getAuditEventById(eventId: string): Promise<AuditEvent | null> {
 const [row] = await db.select().from(auditEvent).where(eq(auditEvent.id, eventId)).limit(1);
 return row ?? null;
}

/** 审计事件查询过滤条件。 */
export interface AuditEventFilter {
 tenantId: string;
 actorType?: AuditActorType;
 actorId?: string;
 actionType?: string;
 targetType?: string;
 targetId?: string;
 /** 起始时间（包含）。 */
 occurredFrom?: Date;
 /** 结束时间（包含）。 */
 occurredTo?: Date;
 /** 返回上限；默认 100，最大 500。 */
 limit?: number;
}

/**
 * 按条件列出审计事件（按 occurredAt 升序，支持时间范围与多维过滤）。
 * 跨租户隔离：tenantId 必填。
 */
export async function listAuditEvents(filter: AuditEventFilter): Promise<AuditEvent[]> {
 const limit = Math.min(filter.limit ?? 100, 500);
 const conditions = [eq(auditEvent.tenantId, filter.tenantId)];
 if (filter.actorType) {
 conditions.push(eq(auditEvent.actorType, filter.actorType));
 }
 if (filter.actorId) {
 conditions.push(eq(auditEvent.actorId, filter.actorId));
 }
 if (filter.actionType) {
 conditions.push(eq(auditEvent.actionType, filter.actionType));
 }
 if (filter.targetType) {
 conditions.push(eq(auditEvent.targetType, filter.targetType));
 }
 if (filter.targetId) {
 conditions.push(eq(auditEvent.targetId, filter.targetId));
 }
 if (filter.occurredFrom) {
 conditions.push(gte(auditEvent.occurredAt, filter.occurredFrom));
 }
 if (filter.occurredTo) {
 conditions.push(lte(auditEvent.occurredAt, filter.occurredTo));
 }

 return db
 .select()
 .from(auditEvent)
 .where(and(...conditions))
 .orderBy(asc(auditEvent.occurredAt))
 .limit(limit);
}

/**
 * 清理已过期审计事件（仅数据生命周期阶段使用，普通应用账号无权调用）。
 * 当前阶段保留全部审计事件；阶段 12 Retention 启用按 occurredAt 清理。
 *
 * @param tenantId 租户
 * @param olderThan 清理此时间之前的事件
 */
export async function deleteExpiredAuditEvents(tenantId: string, olderThan: Date): Promise<number> {
 const result = await db
 .delete(auditEvent)
 .where(and(eq(auditEvent.tenantId, tenantId), lte(auditEvent.occurredAt, olderThan)));
 return result[0].affectedRows;
}

/** Re-export 供外部统一从本模块引入类型。 */
export type {
 AuditActionType,
 AuditActorType,
 AuditEvent,
} from "@/lib/persistence/schema/control-plane";
