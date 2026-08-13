/**
 * Evaluation schema：EvaluationRun / EvaluationCase / EvaluationResult（S11-W06）。
 *
 * 事实源：
 * - docs/architecture/persistence.md（Evaluation 域），
 * - docs/architecture/runtime-control-plane.md S11-W06。
 *
 * 关键约束：
 * - EvaluationRun 是评测运行根：明确绑定 AgentRevision、RuntimeRevision、Route、模型、数据集和评测策略。
 * - 评测执行使用独立 Job/Environment、真实持久数据和受控工具；不使用生产数据或生产 Credential。
 * - EvaluationCase 保留案例级证据：输入已脱敏、期望/实际结果、失败原因、版本引用。
 * - EvaluationResult 是结果投影：可比较指标（higher_better/lower_better/threshold），阈值只按 Agent 风险配置。
 * - 跨租户隔离：所有查询按 tenant_id 过滤；tenant_id 外键 → Tenant(id) ON DELETE CASCADE。
 *
 * 与 OpenAPI 契约一致：列名严格使用 snake_case。
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  datetime,
  decimal,
  index,
  json,
  mysqlTable,
  varchar,
} from "drizzle-orm/mysql-core";
import { tenant } from "./identity";
import { jobTable } from "./job";

// ─── Evaluation Run State ─────────────────────────────────

/** EvaluationRun 状态。 */
export const EVALUATION_RUN_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type EvaluationRunState = (typeof EVALUATION_RUN_STATES)[number];

// ─── Evaluation Case State ────────────────────────────────

/** EvaluationCase 状态。 */
export const EVALUATION_CASE_STATES = ["pending", "passed", "failed", "skipped", "error"] as const;
export type EvaluationCaseState = (typeof EVALUATION_CASE_STATES)[number];

// ─── Evaluation Comparator ────────────────────────────────

/** 结果比较器：higher_better/lower_better/threshold。 */
export const EVALUATION_COMPARATORS = ["higher_better", "lower_better", "threshold"] as const;
export type EvaluationComparator = (typeof EVALUATION_COMPARATORS)[number];

// ─── Evaluation Strategy Keys ─────────────────────────────

/**
 * 评测策略 key：先覆盖确定性协议/安全/权限/工具 Schema/回归场景，
 * 再增加模型评分或人工评审（后续扩展）。
 */
export const STRATEGY_KEYS = [
  "deterministic_protocol",
  "safety",
  "permission",
  "tool_schema",
  "regression",
] as const;
export type EvaluationStrategyKey = (typeof STRATEGY_KEYS)[number];

// ─── EvaluationRun ─────────────────────────────────────

export const evaluationRunTable = mysqlTable(
  "evaluation_run",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 评测执行关联 Job（可空，未通过 Job 触发时为 null）。 */
    jobId: varchar("job_id", { length: 36 }).references(() => jobTable.id),
    /** 被评测的 AgentRevision id（必填，绑定评测对象）。 */
    agentRevisionId: varchar("agent_revision_id", { length: 36 }).notNull(),
    /** 被评测的 RuntimeRevision id（可空，仅 Runtime 相关策略时填）。 */
    runtimeRevisionId: varchar("runtime_revision_id", { length: 36 }),
    /** 被评测的 Route id（可空，按 Route 评测时填）。 */
    routeId: varchar("route_id", { length: 36 }),
    /** 模型引用（可空，如 "doubao-pro-32k"）。 */
    modelRef: varchar("model_ref", { length: 128 }),
    /** 数据集引用（必填，如 "dataset://protocol/case-v1"）。 */
    datasetRef: varchar("dataset_ref", { length: 256 }).notNull(),
    /** 评测策略 key（必填，对应 STRATEGY_KEYS）。 */
    strategyKey: varchar("strategy_key", { length: 64 }).notNull(),
    runState: varchar("run_state", { length: 32 }).notNull().default("queued"),
    /** 阈值配置（按 Agent 风险配置，不一刀切）。 */
    thresholdConfigJson: json("threshold_config_json"),
    /** 可比较指标摘要（Run 终态时写入）。 */
    summaryJson: json("summary_json"),
    startedAt: datetime("started_at", { mode: "date", fsp: 3 }),
    finishedAt: datetime("finished_at", { mode: "date", fsp: 3 }),
    createdBy: varchar("created_by", { length: 36 }),
    versionNo: varchar("version_no", { length: 36 }).notNull().default("1"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => ({
    tenantStateIdx: index("tenant_state_idx").on(table.tenantId, table.runState),
    tenantJobIdx: index("tenant_job_idx").on(table.tenantId, table.jobId),
    tenantAgentRevisionIdx: index("tenant_agent_revision_idx").on(
      table.tenantId,
      table.agentRevisionId,
    ),
  }),
);

export type EvaluationRun = typeof evaluationRunTable.$inferSelect;
export type EvaluationRunInsert = typeof evaluationRunTable.$inferInsert;

// ─── EvaluationCase ────────────────────────────────────

export const evaluationCaseTable = mysqlTable(
  "evaluation_case",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    runId: varchar("run_id", { length: 36 })
      .notNull()
      .references(() => evaluationRunTable.id),
    /** Case 在数据集内稳定 key（与 run_id 组合唯一）。 */
    caseKey: varchar("case_key", { length: 128 }).notNull(),
    /** 场景引用（可空，如 "scenario://protocol/dispatch-binds-immutable-config"）。 */
    scenarioRef: varchar("scenario_ref", { length: 256 }),
    /** 已脱敏的输入内容（写入前由 content-policy 处理）。 */
    inputRedactedJson: json("input_redacted_json").notNull(),
    /** 期望结果（可空，回归场景必填）。 */
    expectedJson: json("expected_json"),
    /** 实际结果（已脱敏，Case 执行后写入）。 */
    actualRedactedJson: json("actual_redacted_json"),
    caseState: varchar("case_state", { length: 32 }).notNull().default("pending"),
    /** 失败原因（caseState=failed/error 时填）。 */
    failureReason: varchar("failure_reason", { length: 256 }),
    /** 证据引用与版本快照（如 trace_id、span_id、revision 引用）。 */
    evidenceJson: json("evidence_json"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => ({
    tenantRunIdx: index("tenant_run_idx").on(table.tenantId, table.runId),
    tenantCaseStateIdx: index("tenant_case_state_idx").on(table.tenantId, table.caseState),
  }),
);

export type EvaluationCase = typeof evaluationCaseTable.$inferSelect;
export type EvaluationCaseInsert = typeof evaluationCaseTable.$inferInsert;

// ─── EvaluationResult ──────────────────────────────────

export const evaluationResultTable = mysqlTable(
  "evaluation_result",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    runId: varchar("run_id", { length: 36 })
      .notNull()
      .references(() => evaluationRunTable.id),
    /** 案例级指标时引用 Case；Run 级指标为 null。 */
    caseId: varchar("case_id", { length: 36 }).references(() => evaluationCaseTable.id),
    /** 指标 key（如 "pass_rate"、"latency_p95_ms"、"protocol_violation_count"）。 */
    metricKey: varchar("metric_key", { length: 64 }).notNull(),
    metricValue: decimal("metric_value", { precision: 20, scale: 6 }).notNull(),
    comparator: varchar("comparator", { length: 32 }).notNull().default("higher_better"),
    /** 阈值（comparator=threshold 时生效；按 Agent 风险配置）。 */
    thresholdValue: decimal("threshold_value", { precision: 20, scale: 6 }),
    passed: boolean("passed").notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => ({
    tenantRunIdx: index("tenant_run_idx").on(table.tenantId, table.runId),
    tenantCaseIdx: index("tenant_case_idx").on(table.tenantId, table.caseId),
    tenantMetricIdx: index("tenant_metric_idx").on(table.tenantId, table.metricKey),
  }),
);

export type EvaluationResult = typeof evaluationResultTable.$inferSelect;
export type EvaluationResultInsert = typeof evaluationResultTable.$inferInsert;
