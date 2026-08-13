/**
 * Usage / Capacity / SLI schema：UsageRecord / CostAggregate / CapacitySnapshot / ServiceLevelIndicator（S11-W07）。
 *
 * 事实源：
 * - docs/architecture/persistence.md §11（Observability），
 * - docs/architecture/runtime-control-plane.md S11-W07。
 *
 * 关键约束：
 * - UsageRecord 是用量原子记录：dimension（token_input/token_output/model_call/tool_call/runtime_seconds/queue_wait_seconds/env_seconds/artifact_bytes）
 * × scopeType（tenant/organization/agent/agent_revision/model/tool_provider/environment/job）。
 * - CostAggregate 是按维度聚合投影：按 granularity（hour/day/week/month）+ 时间窗口预聚合，供运营仪表盘切分。
 * - CapacitySnapshot 区分调用量、并发、冷启动、积压、限额、故障，不只展示总 Token。
 * - ServiceLevelIndicator 是可执行阈值：breach=true 时告警，并能跳转相关 Invocation/Trace（不建设无来源的装饰仪表盘）。
 * - 跨租户隔离：所有查询按 tenant_id 过滤；tenant_id 外键 → Tenant(id) ON DELETE CASCADE。
 * - bigint 字段（quantity / totalQuantity / totalCostMicros / unitCostMicros / limitTokensPerMinute / limitCostPerHourMicros）
 * 序列化为 string（避免 JSON 精度丢失）。
 *
 * 与 OpenAPI 契约一致：列名严格使用 snake_case。
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  datetime,
  decimal,
  index,
  int,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { tenant } from "./identity";

// ─── Usage Dimensions ─────────────────────────────────────

/**
 * 用量维度枚举：
 * - token_input / token_output：LLM Token 计量（输入/输出）。
 * - model_call / tool_call：模型/工具调用次数。
 * - runtime_seconds：Runtime 执行秒数。
 * - queue_wait_seconds：队列等待秒数。
 * - env_seconds：Environment 占用秒数。
 * - artifact_bytes：Artifact 存储字节。
 */
export const USAGE_DIMENSIONS = [
  "token_input",
  "token_output",
  "model_call",
  "tool_call",
  "runtime_seconds",
  "queue_wait_seconds",
  "env_seconds",
  "artifact_bytes",
] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

// ─── Usage Scope Types ────────────────────────────────────

/**
 * UsageRecord 维度切分 scope：
 * - tenant / organization / agent / agent_revision：组织与版本切分。
 * - model / tool_provider：能力提供方切分。
 * - environment / job：执行域与 Job 类型切分。
 */
export const USAGE_SCOPE_TYPES = [
  "tenant",
  "organization",
  "agent",
  "agent_revision",
  "model",
  "tool_provider",
  "environment",
  "job",
] as const;
export type UsageScopeType = (typeof USAGE_SCOPE_TYPES)[number];

// ─── Cost Granularities ───────────────────────────────────

/** CostAggregate 时间窗口粒度。 */
export const COST_GRANULARITIES = ["hour", "day", "week", "month"] as const;
export type CostGranularity = (typeof COST_GRANULARITIES)[number];

// ─── Capacity Scope Types ─────────────────────────────────

/**
 * CapacitySnapshot 维度 scope：
 * - tenant：租户级总览。
 * - agent / runtime：执行域切分。
 * - environment / queue：环境与队列切分。
 */
export const CAPACITY_SCOPE_TYPES = ["tenant", "agent", "runtime", "environment", "queue"] as const;
export type CapacityScopeType = (typeof CAPACITY_SCOPE_TYPES)[number];

// ─── Service Level Indicator Keys ─────────────────────────

/**
 * SLI 指标 key（S12-W03 扩展为覆盖 spec 八类能力）：
 * - invocation_p50_ms / p95_ms / p99_ms：Invocation 延迟分位（毫秒）。
 * - queue_wait_p95_ms：队列等待 p95（毫秒）。
 * - job_success_rate：Job 成功率（0-1）。
 * - tool_call_failure_rate：Tool 调用失败率（0-1）。
 * - api_availability_rate：API 可用性（0-1，成功请求/总请求）。
 * - event_persist_p95_ms：事件落库延迟 p95（毫秒）。
 * - sse_recovery_p95_ms：SSE 恢复延迟 p95（毫秒，从断连到成功恢复）。
 * - invocation_cancel_p95_ms：Invocation 取消确认延迟 p95（毫秒）。
 * - tool_unknown_effect_rate：Tool unknown_effect 比例（0-1）。
 * - job_recovery_success_rate：Job 恢复成功率（0-1）。
 * - deletion_planning_p95_ms：删除 planning 延迟 p95（毫秒）。
 * - deletion_overdue_count：删除超期请求数（整数，threshold_value 为允许上限）。
 * - projection_max_lag_events：投影最大 lag（事件数）。
 * - projection_quarantined_streams：quarantined stream 数（整数）。
 * - employee_idempotency_conflict_rate：幂等冲突率（0-1）。
 * - event_cursor_expired_rate：cursor expired 比例（0-1）。
 * - runtime_unavailable_rate：无可用 Runtime 比例（0-1）。
 * - security_unverified_artifact_blocked：未验证制品发布拦截数（整数）。
 * - security_credential_leak_hits：Credential 泄露扫描命中数（整数）。
 */
export const SLI_KEYS = [
  "invocation_p50_ms",
  "invocation_p95_ms",
  "invocation_p99_ms",
  "queue_wait_p95_ms",
  "job_success_rate",
  "tool_call_failure_rate",
  "api_availability_rate",
  "event_persist_p95_ms",
  "sse_recovery_p95_ms",
  "invocation_cancel_p95_ms",
  "tool_unknown_effect_rate",
  "job_recovery_success_rate",
  "deletion_planning_p95_ms",
  "deletion_overdue_count",
  "projection_max_lag_events",
  "projection_quarantined_streams",
  "employee_idempotency_conflict_rate",
  "event_cursor_expired_rate",
  "runtime_unavailable_rate",
  "security_unverified_artifact_blocked",
  "security_credential_leak_hits",
] as const;
export type SliKey = (typeof SLI_KEYS)[number];

// ─── UsageRecord ───────────────────────────────────────

export const usageRecordTable = mysqlTable(
  "usage_record",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 用量维度（USAGE_DIMENSIONS）。 */
    dimension: varchar("dimension", { length: 32 }).notNull(),
    /** 维度切分 scope 类型（USAGE_SCOPE_TYPES）。 */
    scopeType: varchar("scope_type", { length: 32 }).notNull(),
    /** scope 引用标识（如 organization slug、agent id、model ref 等）。 */
    scopeRef: varchar("scope_ref", { length: 128 }),
    /** 关联 AgentRevision id（agent_revision/agent scope 时填）。 */
    agentRevisionId: varchar("agent_revision_id", { length: 36 }),
    /** 模型引用（model scope 时填，如 "doubao-pro-32k"）。 */
    modelRef: varchar("model_ref", { length: 128 }),
    /** ToolProvider id（tool_provider scope 时填）。 */
    toolProviderId: varchar("tool_provider_id", { length: 36 }),
    /** Environment id（environment scope 时填）。 */
    environmentId: varchar("environment_id", { length: 36 }),
    /** Job id（job scope 时填）。 */
    jobId: varchar("job_id", { length: 36 }),
    /** Invocation id（细粒度归因时填，便于告警跳转）。 */
    invocationId: varchar("invocation_id", { length: 36 }),
    /** 用量数值（bigint，序列化为 string）。 */
    quantity: bigint("quantity", { mode: "bigint" }).notNull(),
    /** 单位成本（微美分/微秒/微字节等，bigint，序列化为 string）。 */
    unitCostMicros: bigint("unit_cost_micros", { mode: "bigint" }),
    /** 总成本（微美分，bigint，序列化为 string）。 */
    totalCostMicros: bigint("total_cost_micros", { mode: "bigint" }),
    observedAt: datetime("observed_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => ({
    tenantDimScopeIdx: index("tenant_dim_scope_idx").on(
      table.tenantId,
      table.dimension,
      table.scopeType,
    ),
    tenantObservedIdx: index("tenant_observed_idx").on(table.tenantId, table.observedAt),
    tenantInvocationIdx: index("tenant_invocation_idx").on(table.tenantId, table.invocationId),
    tenantJobIdx: index("tenant_job_idx").on(table.tenantId, table.jobId),
    tenantAgentRevisionIdx: index("tenant_agent_revision_idx").on(
      table.tenantId,
      table.agentRevisionId,
    ),
  }),
);

export type UsageRecord = typeof usageRecordTable.$inferSelect;
export type UsageRecordInsert = typeof usageRecordTable.$inferInsert;

// ─── CostAggregate ────────────────────────────────────

export const costAggregateTable = mysqlTable(
  "cost_aggregate",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 用量维度（与 usage_record.dimension 对齐）。 */
    dimension: varchar("dimension", { length: 32 }).notNull(),
    /** 维度切分 scope 类型（与 usage_record.scope_type 对齐）。 */
    scopeType: varchar("scope_type", { length: 32 }).notNull(),
    /** scope 引用标识。 */
    scopeRef: varchar("scope_ref", { length: 128 }),
    /** 窗口起点（含）。 */
    windowStart: datetime("window_start", { mode: "date", fsp: 3 }).notNull(),
    /** 窗口终点（不含）。 */
    windowEnd: datetime("window_end", { mode: "date", fsp: 3 }).notNull(),
    /** 粒度（COST_GRANULARITIES）。 */
    granularity: varchar("granularity", { length: 16 }).notNull(),
    /** 累计用量（bigint，序列化为 string）。 */
    totalQuantity: bigint("total_quantity", { mode: "bigint" }).notNull(),
    /** 累计成本（微美分，bigint，序列化为 string）。 */
    totalCostMicros: bigint("total_cost_micros", { mode: "bigint" }).notNull(),
    /** 聚合源记录数。 */
    recordCount: int("record_count").notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => ({
    tenantDimScopeWindowIdx: index("tenant_dim_scope_window_idx").on(
      table.tenantId,
      table.dimension,
      table.scopeType,
      table.windowStart,
      table.granularity,
    ),
    /** UNIQUE 防止重复聚合：同 tenant × dimension × scope_type × scope_ref × window_start × granularity 只允许一行。 */
    tenantDimScopeWindowGranularityUq: uniqueIndex("tenant_dim_scope_window_granularity_uq").on(
      table.tenantId,
      table.dimension,
      table.scopeType,
      table.scopeRef,
      table.windowStart,
      table.granularity,
    ),
  }),
);

export type CostAggregate = typeof costAggregateTable.$inferSelect;
export type CostAggregateInsert = typeof costAggregateTable.$inferInsert;

// ─── CapacitySnapshot ──────────────────────────────────

export const capacitySnapshotTable = mysqlTable(
  "capacity_snapshot",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 维度 scope 类型（CAPACITY_SCOPE_TYPES）。 */
    scopeType: varchar("scope_type", { length: 32 }).notNull(),
    /** scope 引用标识。 */
    scopeRef: varchar("scope_ref", { length: 128 }),
    /** 当前活跃 Invocation 数。 */
    activeInvocations: int("active_invocations").notNull().default(0),
    /** 队列中等待的 Job 数。 */
    queuedJobs: int("queued_jobs").notNull().default(0),
    /** 最近 1 小时冷启动次数。 */
    coldStartsLastHour: int("cold_starts_last_hour").notNull().default(0),
    /** 每分钟 Invocation 限额（可空，未设置时为 null）。 */
    limitInvocationsPerMinute: int("limit_invocations_per_minute"),
    /** 每分钟 Token 限额（bigint，序列化为 string）。 */
    limitTokensPerMinute: bigint("limit_tokens_per_minute", { mode: "bigint" }),
    /** 每小时成本限额（微美分，bigint，序列化为 string）。 */
    limitCostPerHourMicros: bigint("limit_cost_per_hour_micros", { mode: "bigint" }),
    /** 最近 1 小时故障数。 */
    failureCountLastHour: int("failure_count_last_hour").notNull().default(0),
    snapshotAt: datetime("snapshot_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => ({
    tenantScopeSnapshotIdx: index("tenant_scope_snapshot_idx").on(
      table.tenantId,
      table.scopeType,
      table.scopeRef,
      table.snapshotAt,
    ),
  }),
);

export type CapacitySnapshot = typeof capacitySnapshotTable.$inferSelect;
export type CapacitySnapshotInsert = typeof capacitySnapshotTable.$inferInsert;

// ─── ServiceLevelIndicator ─────────────────────────────

export const serviceLevelIndicatorTable = mysqlTable(
  "service_level_indicator",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 维度 scope 类型（与 CapacitySnapshot 对齐，便于按 scope 联合查询）。 */
    scopeType: varchar("scope_type", { length: 32 }).notNull(),
    /** scope 引用标识。 */
    scopeRef: varchar("scope_ref", { length: 128 }),
    /** 指标 key（SLI_KEYS）。 */
    indicatorKey: varchar("indicator_key", { length: 64 }).notNull(),
    /** 指标值（decimal(20,6)）。 */
    indicatorValue: decimal("indicator_value", { precision: 20, scale: 6 }).notNull(),
    /** 阈值（可空，未配置时为 null）。 */
    thresholdValue: decimal("threshold_value", { precision: 20, scale: 6 }),
    /** 是否违约（thresholdValue 非空时按 comparator 判定）。 */
    breach: boolean("breach").notNull().default(false),
    /** 告警跳转：关联 Invocation id（可空）。 */
    alertInvocationId: varchar("alert_invocation_id", { length: 36 }),
    /** 告警跳转：关联 Trace id（可空）。 */
    alertTraceId: varchar("alert_trace_id", { length: 36 }),
    /** 告警错误码（S12-W03）：breach=true 时填入触发的 错误码（如 STREAM_BACKPRESSURE）。 */
    errorCode: varchar("error_code", { length: 64 }),
    measuredAt: datetime("measured_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => ({
    tenantScopeKeyMeasuredIdx: index("tenant_scope_key_measured_idx").on(
      table.tenantId,
      table.scopeType,
      table.indicatorKey,
      table.measuredAt,
    ),
    tenantBreachIdx: index("tenant_breach_idx").on(table.tenantId, table.breach),
    tenantErrorCodeIdx: index("tenant_error_code_idx").on(table.tenantId, table.errorCode),
  }),
);

export type ServiceLevelIndicator = typeof serviceLevelIndicatorTable.$inferSelect;
export type ServiceLevelIndicatorInsert = typeof serviceLevelIndicatorTable.$inferInsert;
