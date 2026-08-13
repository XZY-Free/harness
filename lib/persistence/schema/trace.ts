/**
 * Observability schema：Trace / Span / Observation（S11-W05）。
 *
 * 事实源：
 * - docs/architecture/persistence.md §11（Observability），
 * - docs/architecture/runtime-control-plane.md S11-W05。
 *
 * 关键约束：
 * - Trace 是排障与观测的根资源，关联 invocation/job/thread 任一根类型。
 * - Span 构成树形结构（parentSpanId 自引用），spanKey 对应 W3C span_id。
 * - Observation 是已脱敏的观测记录，contentMode 决定可见内容深度。
 * - Observation.containsSecret 强制为 false：写入前由 content-policy 脱敏，永不存储原始 secret。
 * - 跨租户隔离：所有查询按 tenant_id 过滤；tenant_id 外键 → Tenant(id) ON DELETE CASCADE。
 * - 不扩展 Runtime ingress 协议；Trace 由 admin API 或未来 runtime 适配器写入。
 *
 * 与 OpenAPI 契约一致：列名严格使用 snake_case。
 */
import { sql } from "drizzle-orm";
import { datetime, index, json, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { tenant } from "./identity";

// ─── Trace Root Type ───────────────────────────────────────

/** Trace 根资源类型。 */
export const TRACE_ROOT_TYPES = ["invocation", "job", "thread"] as const;
export type TraceRootType = (typeof TRACE_ROOT_TYPES)[number];

// ─── Trace State ───────────────────────────────────────────

/** Trace 状态。 */
export const TRACE_STATES = ["active", "completed", "failed", "lost"] as const;
export type TraceState = (typeof TRACE_STATES)[number];

// ─── Trace Content Mode ────────────────────────────────────

/** 内容模式。 */
export const TRACE_CONTENT_MODES = ["metadata", "redacted", "diagnostic"] as const;
export type TraceContentMode = (typeof TRACE_CONTENT_MODES)[number];

// ─── Trace Sampling Policy ─────────────────────────────────

/** 采样策略。 */
export const TRACE_SAMPLING_POLICIES = ["always", "probabilistic", "never"] as const;
export type TraceSamplingPolicy = (typeof TRACE_SAMPLING_POLICIES)[number];

// ─── Trace ──────────────────────────────────────────────

export const traceTable = mysqlTable(
 "trace",
 {
 id: varchar("id", { length: 36 }).primaryKey(),
 tenantId: varchar("tenant_id", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** Trace 根资源类型：invocation/job/thread。 */
 rootType: varchar("root_type", { length: 32 }).notNull(),
 /** Trace 根资源 id（Invocation.id / Job.id / Thread.id）。 */
 rootId: varchar("root_id", { length: 36 }).notNull(),
 /** W3C trace_id。 */
 traceKey: varchar("trace_key", { length: 128 }).notNull(),
 /** 关联 span.id（根 Span）。 */
 rootSpanId: varchar("root_span_id", { length: 36 }),
 contentMode: varchar("content_mode", { length: 32 }).notNull().default("metadata"),
 samplingPolicy: varchar("sampling_policy", { length: 32 }).notNull().default("always"),
 /** 0-1 概率（samplingPolicy=probabilistic 时生效）。 */
 samplingRate: json("sampling_rate"),
 traceState: varchar("trace_state", { length: 32 }).notNull().default("active"),
 startedAt: datetime("started_at", { mode: "date", fsp: 3 }).notNull(),
 finishedAt: datetime("finished_at", { mode: "date", fsp: 3 }),
 attributesJson: json("attributes_json"),
 versionNo: varchar("version_no", { length: 36 }).notNull().default("1"),
 createdAt: datetime("created_at", { mode: "date", fsp: 3 })
 .notNull()
 .default(sql`CURRENT_TIMESTAMP(3)`),
 updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
 .notNull()
 .default(sql`CURRENT_TIMESTAMP(3)`),
 },
 (table) => ({
 tenantRootIdx: index("tenant_root_idx").on(table.tenantId, table.rootType, table.rootId),
 tenantTraceKeyIdx: index("tenant_trace_key_idx").on(table.tenantId, table.traceKey),
 tenantStateIdx: index("tenant_state_idx").on(table.tenantId, table.traceState),
 }),
);

export type Trace = typeof traceTable.$inferSelect;
export type TraceInsert = typeof traceTable.$inferInsert;

// ─── Span Kind / State ─────────────────────────────────────

export const SPAN_KINDS = [
 "model",
 "skill",
 "tool",
 "knowledge",
 "memory",
 "desktop",
 "browser",
 "workspace",
 "permission",
 "subtask",
] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

export const SPAN_STATES = ["active", "completed", "failed", "cancelled"] as const;
export type SpanState = (typeof SPAN_STATES)[number];

// ─── Span ───────────────────────────────────────────────

export const spanTable = mysqlTable(
 "span",
 {
 id: varchar("id", { length: 36 }).primaryKey(),
 tenantId: varchar("tenant_id", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 traceId: varchar("trace_id", { length: 36 }).notNull(),
 /** 父 Span id（自引用，根 Span 为 null）。 */
 parentSpanId: varchar("parent_span_id", { length: 36 }),
 /** W3C span_id。 */
 spanKey: varchar("span_key", { length: 36 }).notNull(),
 name: varchar("name", { length: 256 }).notNull(),
 kind: varchar("kind", { length: 32 }).notNull(),
 spanState: varchar("span_state", { length: 32 }).notNull().default("active"),
 startedAt: datetime("started_at", { mode: "date", fsp: 3 }).notNull(),
 finishedAt: datetime("finished_at", { mode: "date", fsp: 3 }),
 attributesJson: json("attributes_json"),
 /** Span 事件数组。 */
 eventsJson: json("events_json"),
 versionNo: varchar("version_no", { length: 36 }).notNull().default("1"),
 createdAt: datetime("created_at", { mode: "date", fsp: 3 })
 .notNull()
 .default(sql`CURRENT_TIMESTAMP(3)`),
 updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
 .notNull()
 .default(sql`CURRENT_TIMESTAMP(3)`),
 },
 (table) => ({
 tenantTraceIdx: index("tenant_trace_idx").on(table.tenantId, table.traceId),
 tenantParentIdx: index("tenant_parent_idx").on(table.tenantId, table.parentSpanId),
 tenantKindIdx: index("tenant_kind_idx").on(table.tenantId, table.kind),
 }),
);

export type Span = typeof spanTable.$inferSelect;
export type SpanInsert = typeof spanTable.$inferInsert;

// ─── Observation ───────────────────────────────────────────

export const OBSERVATION_KINDS = SPAN_KINDS;
export type ObservationKind = SpanKind;

export const OBSERVATION_CONTENT_MODES = TRACE_CONTENT_MODES;
export type ObservationContentMode = TraceContentMode;

export const observationTable = mysqlTable(
 "observation",
 {
 id: varchar("id", { length: 36 }).primaryKey(),
 tenantId: varchar("tenant_id", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 traceId: varchar("trace_id", { length: 36 }).notNull(),
 /** 关联 Span（可选）。 */
 spanId: varchar("span_id", { length: 36 }),
 /** 关联 Invocation（可选，用于跨 Span 聚合查询）。 */
 invocationId: varchar("invocation_id", { length: 36 }),
 kind: varchar("kind", { length: 32 }).notNull(),
 contentMode: varchar("content_mode", { length: 32 }).notNull().default("metadata"),
 /** 已脱敏的内容（由 content-policy 处理）。 */
 contentJson: json("content_json"),
 /** 强制 false：写入前已脱敏，永不存储原始 secret。 */
 containsSecret: json("contains_secret").notNull().default(sql`CAST(false AS JSON)`),
 redactionSummary: varchar("redaction_summary", { length: 256 }),
 observedAt: datetime("observed_at", { mode: "date", fsp: 3 }).notNull(),
 createdAt: datetime("created_at", { mode: "date", fsp: 3 })
 .notNull()
 .default(sql`CURRENT_TIMESTAMP(3)`),
 },
 (table) => ({
 tenantTraceIdx: index("tenant_trace_idx").on(table.tenantId, table.traceId),
 tenantSpanIdx: index("tenant_span_idx").on(table.tenantId, table.spanId),
 tenantInvocationIdx: index("tenant_invocation_idx").on(table.tenantId, table.invocationId),
 tenantKindIdx: index("tenant_kind_idx").on(table.tenantId, table.kind),
 }),
);

export type Observation = typeof observationTable.$inferSelect;
export type ObservationInsert = typeof observationTable.$inferInsert;
