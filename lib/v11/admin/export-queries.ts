/**
 * V11 AdminExport 仓储（S11-W08）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md（管理导出任务），
 * - ../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W08。
 *
 * 职责：
 * - createAdminExport：登记新导出任务（status=pending）+ 写审计 admin.export.requested。
 * - getAdminExportById：单条查询（跨租户隔离）。
 * - listAdminExportsByTenant：cursor 分页，支持 status/exportKind/requestedBy 过滤。
 * - updateAdminExportStatus：状态转换（running/completed/failed/cancelled）+ 审计。
 * - updateAdminExportResult：写入 resultRef + recordCount + redactionSummary + completedAt + 审计。
 *
 * 关键约束：
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - 写入时审计：requested/completed/failed 三种审计事件由本模块触发。
 * - cursor 分页采用 limit+1 策略（与 lib/v11/operations/usage-queries.ts 一致）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { decodeCursor, encodeCursor } from "@/lib/http";
import { recordAuditEvent } from "@/lib/identity/audit";
import type { AuditActor } from "@/lib/identity/audit";
import {
  type ExportFormat,
  type ExportKind,
  type ExportPrincipalKind,
  type ExportStatus,
  type V11AdminExport,
  v11AdminExport,
} from "@/lib/v11/schema/admin-export";
import { and, desc, eq, lt, or } from "drizzle-orm";

// ─── createAdminExport ────────────────────────────────────

/** createAdminExport 入参。 */
export interface CreateAdminExportParams {
  tenantId: string;
  requestedBy: string;
  requestPrincipalKind: ExportPrincipalKind;
  exportKind: ExportKind;
  filterJson?: Record<string, unknown> | null;
  resultFormat?: ExportFormat;
  /** 审计 actor（由 route 层从 principal 提取）。 */
  actor: AuditActor;
  /** 关联请求 id（写入审计事件）。 */
  requestId?: string;
  /** 显式 created_at（测试用，确保 cursor 分页顺序确定性）；省略时由 DB 默认 CURRENT_TIMESTAMP(3) 生成。 */
  createdAt?: Date;
}

/** 创建导出任务（status=pending）+ 写审计 admin.export.requested。 */
export async function createAdminExport(params: CreateAdminExportParams): Promise<V11AdminExport> {
  const id = randomUUID();
  await db.insert(v11AdminExport).values({
    id,
    tenantId: params.tenantId,
    requestedBy: params.requestedBy,
    requestPrincipalKind: params.requestPrincipalKind,
    exportKind: params.exportKind,
    filterJson: params.filterJson ?? null,
    status: "pending",
    resultRef: null,
    resultFormat: params.resultFormat ?? "ndjson",
    recordCount: 0,
    redactionSummary: null,
    failureReason: null,
    versionNo: "1",
    completedAt: null,
    ...(params.createdAt ? { createdAt: params.createdAt } : {}),
  });

  const [row] = await db
    .select()
    .from(v11AdminExport)
    .where(and(eq(v11AdminExport.tenantId, params.tenantId), eq(v11AdminExport.id, id)))
    .limit(1);
  if (!row) {
    throw new Error(`createAdminExport: 行未找到（id=${id}）`);
  }

  await recordAuditEvent({
    actor: params.actor,
    actionType: "admin.export.requested",
    targetType: "tenant",
    targetId: params.tenantId,
    after: { export_id: id, export_kind: params.exportKind },
    requestId: params.requestId,
  });

  return row;
}

// ─── getAdminExportById ───────────────────────────────────

/** 按 id 获取导出任务（跨租户隔离）。不存在返回 null。 */
export async function getAdminExportById(
  tenantId: string,
  exportId: string,
): Promise<V11AdminExport | null> {
  const [row] = await db
    .select()
    .from(v11AdminExport)
    .where(and(eq(v11AdminExport.tenantId, tenantId), eq(v11AdminExport.id, exportId)))
    .limit(1);
  return row ?? null;
}

// ─── listAdminExportsByTenant ─────────────────────────────

/** listAdminExportsByTenant 选项。 */
export interface ListAdminExportsByTenantOptions {
  status?: ExportStatus;
  exportKind?: ExportKind;
  requestedBy?: string;
  limit?: number;
  cursor?: string | null;
}

/** 列出租户的导出任务（cursor 分页，按 created_at 降序）。 */
export async function listAdminExportsByTenant(
  tenantId: string,
  options?: ListAdminExportsByTenantOptions,
): Promise<{ items: V11AdminExport[]; nextCursor: string | null }> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [eq(v11AdminExport.tenantId, tenantId)];
  if (options?.status) {
    conditions.push(eq(v11AdminExport.status, options.status));
  }
  if (options?.exportKind) {
    conditions.push(eq(v11AdminExport.exportKind, options.exportKind));
  }
  if (options?.requestedBy) {
    conditions.push(eq(v11AdminExport.requestedBy, options.requestedBy));
  }

  // cursor 解码：{ created_at, id }
  let afterCreatedAt: Date | undefined;
  let afterId: string | undefined;
  if (options?.cursor) {
    const decoded = decodeCursor(options.cursor) as {
      created_at?: string;
      id?: string;
    };
    if (typeof decoded.created_at !== "string" || typeof decoded.id !== "string") {
      throw new Error("listAdminExportsByTenant: cursor 缺少 created_at/id 字段");
    }
    afterCreatedAt = new Date(decoded.created_at);
    if (Number.isNaN(afterCreatedAt.getTime())) {
      throw new Error("listAdminExportsByTenant: cursor.created_at 不是合法 ISO 时间");
    }
    afterId = decoded.id;
  }

  if (afterCreatedAt && afterId) {
    // (created_at, id) < (afterCreatedAt, afterId) in DESC order：
    // 使用 Drizzle 原生操作符确保 Date 参数绑定与列类型一致（sql 模板对 Date 的时区处理不一致）
    const cursorCond = or(
      lt(v11AdminExport.createdAt, afterCreatedAt),
      and(eq(v11AdminExport.createdAt, afterCreatedAt), lt(v11AdminExport.id, afterId)),
    );
    if (cursorCond) conditions.push(cursorCond);
  }

  const rows = await db
    .select()
    .from(v11AdminExport)
    .where(and(...conditions))
    .orderBy(desc(v11AdminExport.createdAt), desc(v11AdminExport.id))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  let items = rows;
  if (rows.length > limit) {
    items = rows.slice(0, limit);
    const lastKept = items[items.length - 1];
    if (lastKept) {
      nextCursor = encodeCursor({
        created_at: lastKept.createdAt.toISOString(),
        id: lastKept.id,
      });
    }
  }

  return { items, nextCursor };
}

// ─── updateAdminExportStatus ──────────────────────────────

/** updateAdminExportStatus 入参。 */
export interface UpdateAdminExportStatusParams {
  tenantId: string;
  exportId: string;
  status: ExportStatus;
  /** status=failed 时填失败原因。 */
  failureReason?: string | null;
  /** 审计 actor。 */
  actor: AuditActor;
  /** 关联请求 id。 */
  requestId?: string;
}

/**
 * 更新导出任务状态（running/completed/failed/cancelled）。
 *
 * - status=failed 时写审计 admin.export.failed + failureReason。
 * - status=completed 时由 updateAdminExportResult 单独处理审计（含 resultRef 等额外字段）。
 * - 其他状态（running/cancelled）只更新状态，不写审计。
 */
export async function updateAdminExportStatus(
  params: UpdateAdminExportStatusParams,
): Promise<V11AdminExport> {
  const setClause: Partial<V11AdminExport> = {
    status: params.status,
    updatedAt: new Date(),
  };
  if (params.failureReason !== undefined) {
    setClause.failureReason = params.failureReason ?? null;
  }
  if (params.status === "failed" || params.status === "cancelled") {
    setClause.completedAt = new Date();
  }

  await db
    .update(v11AdminExport)
    .set(setClause)
    .where(
      and(eq(v11AdminExport.tenantId, params.tenantId), eq(v11AdminExport.id, params.exportId)),
    );

  const [row] = await db
    .select()
    .from(v11AdminExport)
    .where(
      and(eq(v11AdminExport.tenantId, params.tenantId), eq(v11AdminExport.id, params.exportId)),
    )
    .limit(1);
  if (!row) {
    throw new Error(`updateAdminExportStatus: 行未找到（id=${params.exportId}）`);
  }

  if (params.status === "failed") {
    await recordAuditEvent({
      actor: params.actor,
      actionType: "admin.export.failed",
      targetType: "tenant",
      targetId: params.tenantId,
      after: { export_id: params.exportId, failure_reason: params.failureReason ?? null },
      requestId: params.requestId,
    });
  }

  return row;
}

// ─── updateAdminExportResult ──────────────────────────────

/** updateAdminExportResult 入参。 */
export interface UpdateAdminExportResultParams {
  tenantId: string;
  exportId: string;
  resultRef: string;
  recordCount: number;
  redactionSummary: string | null;
  /** 审计 actor。 */
  actor: AuditActor;
  /** 关联请求 id。 */
  requestId?: string;
}

/**
 * 写入导出结果（resultRef + recordCount + redactionSummary + completedAt + status=completed）。
 * 同步写审计 admin.export.completed。
 */
export async function updateAdminExportResult(
  params: UpdateAdminExportResultParams,
): Promise<V11AdminExport> {
  const now = new Date();
  await db
    .update(v11AdminExport)
    .set({
      status: "completed",
      resultRef: params.resultRef,
      recordCount: params.recordCount,
      redactionSummary: params.redactionSummary,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(v11AdminExport.tenantId, params.tenantId), eq(v11AdminExport.id, params.exportId)),
    );

  const [row] = await db
    .select()
    .from(v11AdminExport)
    .where(
      and(eq(v11AdminExport.tenantId, params.tenantId), eq(v11AdminExport.id, params.exportId)),
    )
    .limit(1);
  if (!row) {
    throw new Error(`updateAdminExportResult: 行未找到（id=${params.exportId}）`);
  }

  await recordAuditEvent({
    actor: params.actor,
    actionType: "admin.export.completed",
    targetType: "tenant",
    targetId: params.tenantId,
    after: {
      export_id: params.exportId,
      record_count: params.recordCount,
      redaction_summary: params.redactionSummary,
    },
    requestId: params.requestId,
  });

  return row;
}

// ─── re-export 供外部统一从本模块引入类型 ───────────────────

export type {
  ExportFormat,
  ExportKind,
  ExportPrincipalKind,
  ExportStatus,
  V11AdminExport,
} from "@/lib/v11/schema/admin-export";
