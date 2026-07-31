/**
 * V11 Admin Export schema：V11AdminExport（S11-W08）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md（管理导出任务），
 * - ../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W08。
 *
 * 关键约束：
 * - 管理导出任务覆盖：audit_events/usage_records/cost_aggregates/capacity_snapshots/traces/evaluation_runs。
 * - 列表、筛选、分页和导出遵守租户/组织/Action Scope；导出同样脱敏并审计。
 * - redactionSummary 记录哪些字段被脱敏，便于审计与排障。
 * - 跨租户隔离：所有查询按 tenant_id 过滤；tenant_id 外键 → Tenant(id) ON DELETE CASCADE。
 *
 * 与 OpenAPI 契约一致：列名严格使用 snake_case。
 */
import { sql } from "drizzle-orm";
import { datetime, index, int, json, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { tenant } from "./identity";

// ─── Export Kind ──────────────────────────────────────────

/** 导出数据种类。 */
export const EXPORT_KINDS = [
  "audit_events",
  "usage_records",
  "cost_aggregates",
  "capacity_snapshots",
  "traces",
  "evaluation_runs",
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

// ─── Export Status ────────────────────────────────────────

/** 导出任务状态。 */
export const EXPORT_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

// ─── Export Format ────────────────────────────────────────

/** 导出结果格式。 */
export const EXPORT_FORMATS = ["ndjson", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// ─── Export Principal Kind ────────────────────────────────

/** 发起导出的主体类型（与 idempotency caller 对齐）。 */
export const EXPORT_PRINCIPAL_KINDS = ["user", "service"] as const;
export type ExportPrincipalKind = (typeof EXPORT_PRINCIPAL_KINDS)[number];

// ─── V11AdminExport ───────────────────────────────────────

export const v11AdminExport = mysqlTable(
  "v11_admin_export",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 请求人 userIdentity 或 serviceId。 */
    requestedBy: varchar("requested_by", { length: 128 }).notNull(),
    /** 请求主体类型（user/service）。 */
    requestPrincipalKind: varchar("request_principal_kind", { length: 16 })
      .$type<ExportPrincipalKind>()
      .notNull(),
    /** 导出数据种类（EXPORT_KINDS）。 */
    exportKind: varchar("export_kind", { length: 32 }).$type<ExportKind>().notNull(),
    /** 导出参数：scope_type/scope_ref/dimension/state/window_from/window_to 等。 */
    filterJson: json("filter_json").$type<Record<string, unknown>>(),
    /** 任务状态（EXPORT_STATUSES）。 */
    status: varchar("status", { length: 32 }).$type<ExportStatus>().notNull().default("pending"),
    /** 导出结果引用：/exports/{id}/download 或对象存储 key。 */
    resultRef: varchar("result_ref", { length: 512 }),
    /** 导出结果格式（默认 ndjson）。 */
    resultFormat: varchar("result_format", { length: 16 })
      .$type<ExportFormat>()
      .notNull()
      .default("ndjson"),
    /** 导出记录数。 */
    recordCount: int("record_count").notNull().default(0),
    /** 脱敏摘要：哪些字段被脱敏。 */
    redactionSummary: varchar("redaction_summary", { length: 256 }),
    /** 失败原因（status=failed 时填）。 */
    failureReason: varchar("failure_reason", { length: 256 }),
    /** 乐观锁版本号。 */
    versionNo: varchar("version_no", { length: 36 }).notNull().default("1"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    /** 完成时间（status=completed/failed/cancelled 时填）。 */
    completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
  },
  (table) => ({
    tenantStatusIdx: index("tenant_status_idx").on(table.tenantId, table.status),
    tenantKindIdx: index("tenant_kind_idx").on(table.tenantId, table.exportKind),
    tenantRequestedByIdx: index("tenant_requested_by_idx").on(table.tenantId, table.requestedBy),
  }),
);

export type V11AdminExport = typeof v11AdminExport.$inferSelect;
export type V11AdminExportInsert = typeof v11AdminExport.$inferInsert;
