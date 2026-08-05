/**
 * idempotency_record 仓储。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §2.2、
 *         ../v11-agentkit-platform/11-api-and-event-boundaries.md §2.3。
 *
 * 职责：
 * - 登记新 processing 记录（enforceIdempotency 调用，处理唯一约束并发）。
 * - 完成/失败回填（completeIdempotencyRecord / failIdempotencyRecord）。
 * - 查询：按唯一键查找、按 id 查找、按过期时间清理。
 * - failed 记录重置为 processing（retry_allowed 路径使用）。
 *
 * 幂等守卫（enforceIdempotency）在 lib/identity/idempotency.ts，
 * 本模块只提供数据访问，不包含业务判断。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import type { ApiAudience } from "@/lib/http";
import {
  type IdempotencyAudience,
  type IdempotencyCallerType,
  type IdempotencyProcessingState,
  type IdempotencyRecord,
  idempotencyRecord,
} from "@/lib/v11/schema/idempotency";
import { and, eq, lte } from "drizzle-orm";

/** 唯一键查询参数（与 UNIQUE 索引对齐）。 */
export interface IdempotencyUniqueKey {
  tenantId: string;
  audience: IdempotencyAudience;
  callerType: IdempotencyCallerType;
  callerId: string;
  commandScope: string;
  idempotencyKey: string;
}

/** 按唯一键查找幂等记录。不存在返回 null。 */
export async function findIdempotencyRecord(
  key: IdempotencyUniqueKey,
): Promise<IdempotencyRecord | null> {
  const [row] = await db
    .select()
    .from(idempotencyRecord)
    .where(
      and(
        eq(idempotencyRecord.tenantId, key.tenantId),
        eq(idempotencyRecord.audience, key.audience),
        eq(idempotencyRecord.callerType, key.callerType),
        eq(idempotencyRecord.callerId, key.callerId),
        eq(idempotencyRecord.commandScope, key.commandScope),
        eq(idempotencyRecord.idempotencyKey, key.idempotencyKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 按 id 查找幂等记录。不存在返回 null。 */
export async function getIdempotencyRecordById(
  recordId: string,
): Promise<IdempotencyRecord | null> {
  const [row] = await db
    .select()
    .from(idempotencyRecord)
    .where(eq(idempotencyRecord.id, recordId))
    .limit(1);
  return row ?? null;
}

/**
 * 插入新 processing 记录。
 *
 * @throws 唯一约束冲突（并发同 key）时抛 MySQL ER_DUP_ENTRY，调用方应捕获后重新 findIdempotencyRecord。
 */
export async function insertProcessingRecord(params: {
  tenantId: string;
  audience: IdempotencyAudience;
  callerType: IdempotencyCallerType;
  callerId: string;
  commandScope: string;
  idempotencyKey: string;
  requestHash: string;
  /** 过期时间；默认 24h 后（生产由调用方按命令语义传入）。 */
  expiresAt?: Date;
}): Promise<IdempotencyRecord> {
  const id = randomUUID();
  const expiresAt = params.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.insert(idempotencyRecord).values({
    id,
    tenantId: params.tenantId,
    audience: params.audience,
    callerType: params.callerType,
    callerId: params.callerId,
    commandScope: params.commandScope,
    idempotencyKey: params.idempotencyKey,
    requestHash: params.requestHash,
    processingState: "processing",
    expiresAt,
  });
  const [row] = await db
    .select()
    .from(idempotencyRecord)
    .where(eq(idempotencyRecord.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`insertProcessingRecord: 行未找到（id=${id}）`);
  }
  return row;
}

/**
 * 完成幂等记录：回填 processingState=completed + httpStatus + responseRef + responseRedactedJson + completedAt。
 * 不存在或非 processing 状态返回 false。
 */
export async function completeIdempotencyRecord(params: {
  recordId: string;
  httpStatus: number;
  responseRef?: string | null;
  responseRedactedJson?: string | null;
}): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(idempotencyRecord)
    .set({
      processingState: "completed",
      httpStatus: params.httpStatus,
      responseRef: params.responseRef ?? null,
      responseRedactedJson: params.responseRedactedJson ?? null,
      completedAt: now,
    })
    .where(
      and(
        eq(idempotencyRecord.id, params.recordId),
        eq(idempotencyRecord.processingState, "processing"),
      ),
    );
  return result[0].affectedRows > 0;
}

/**
 * 标记幂等记录失败：回填 processingState=failed + completedAt。
 * 失败记录允许同 key 重试（由 enforceIdempotency 的 retry_allowed 路径处理）。
 * 不存在或非 processing 状态返回 false。
 */
export async function failIdempotencyRecord(recordId: string): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(idempotencyRecord)
    .set({ processingState: "failed", completedAt: now })
    .where(
      and(eq(idempotencyRecord.id, recordId), eq(idempotencyRecord.processingState, "processing")),
    );
  return result[0].affectedRows > 0;
}

/**
 * 重置 failed 记录为 processing（retry_allowed 路径使用）。
 * 同时更新 requestHash（新重试可能携带新 body）和 expiresAt。
 * 非 failed 状态返回 false（不允许重置 processing/completed）。
 */
export async function resetFailedForRetry(params: {
  recordId: string;
  requestHash: string;
  expiresAt?: Date;
}): Promise<boolean> {
  const expiresAt = params.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
  const result = await db
    .update(idempotencyRecord)
    .set({
      processingState: "processing",
      requestHash: params.requestHash,
      expiresAt,
      completedAt: null,
      httpStatus: null,
      responseRef: null,
      responseRedactedJson: null,
    })
    .where(
      and(
        eq(idempotencyRecord.id, params.recordId),
        eq(idempotencyRecord.processingState, "failed"),
      ),
    );
  return result[0].affectedRows > 0;
}

/** 清理已过期记录（数据生命周期阶段正式启用；当前供测试与诊断用）。 */
export async function deleteExpiredRecords(now: Date = new Date()): Promise<number> {
  const result = await db.delete(idempotencyRecord).where(lte(idempotencyRecord.expiresAt, now));
  return result[0].affectedRows;
}

/** Re-export 供外部统一从本模块引入类型。 */
export type {
  IdempotencyAudience,
  IdempotencyCallerType,
  IdempotencyProcessingState,
} from "@/lib/v11/schema/idempotency";
export type { IdempotencyRecord } from "@/lib/v11/schema/idempotency";

/** audience 兼容别名（lib/http.ts ApiAudience 与 IdempotencyAudience 同构）。 */
export type { ApiAudience } from "@/lib/http";
