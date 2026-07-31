/**
 * V11 控制面 schema：ToolCall + CapabilityReview（阶段 6 S06-C05）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.6（tool_call）
 * - ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §5（能力变化与审核）、§4.3（Tool 稳定边界）
 * - ../v11-agentkit-platform/12-capability-and-collaboration-api.md §3.2（TOOL_SCHEMA_CHANGED）
 *
 * ToolCall 记录一次 Invocation 内单次 Tool 调用的事实：
 * - 调用前解析当前 SchemaRevision，调用开始时固定 schemaHash。
 * - 同一 operation_id 不同 arguments_hash 返回冲突 → TOOL_SCHEMA_CHANGED (409)。
 * - UNIQUE(invocationId, callSequence)：Invocation 内 callSequence 单调递增。
 * - UNIQUE(toolId, operationId)：同 Tool + 同 operation_id 幂等。
 *
 * CapabilityReview 记录能力变化的审核请求：
 * - resourceType=skill/tool + oldRevisionId/newRevisionId 标识变化前后修订。
 * - diffType 描述风险差异类型；requiresReview 标记是否需集中审核。
 * - reviewState 状态机：pending → approved/rejected。
 * - affectedAgentsJson 记录可能受影响的 Agent id 列表。
 *
 * 关键约束：
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - tenantId 外键 → Tenant(id) ON DELETE CASCADE。
 * - invocationId / toolId / itemId 等不加 DB 级 FK，避免跨阶段耦合。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/v11/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  boolean,
  datetime,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── ToolCall State ──────────────────────────────────────

/**
 * ToolCall 状态机（§4.3 稳定边界是单次 ToolCall）。
 * - proposed：模型已决策，尚未开始执行。
 * - paused：因审批/治理暂停（未在 S06-C05 实现，留后续阶段）。
 * - running：执行中。
 * - succeeded：执行成功。
 * - failed：执行失败（业务错误）。
 * - cancelled：被取消（用户取消 / 上层取消）。
 * - unknown_effect：执行完成但副作用无法核对（§5.2 取消幂等）。
 */
export const TOOL_CALL_STATES = [
  "proposed",
  "paused",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown_effect",
] as const;
export type ToolCallState = (typeof TOOL_CALL_STATES)[number];

// ─── CapabilityReview Resource Type ──────────────────────

/**
 * CapabilityReview 资源类型。
 * - skill：Skill 能力资产。
 * - tool：Tool 能力资产。
 */
export const CAPABILITY_REVIEW_RESOURCE_TYPES = ["skill", "tool"] as const;
export type CapabilityReviewResourceType = (typeof CAPABILITY_REVIEW_RESOURCE_TYPES)[number];

// ─── CapabilityReview Review State ───────────────────────

/**
 * CapabilityReview 审核状态。
 * - pending：待审核。
 * - approved：已批准。
 * - rejected：已拒绝。
 */
export const CAPABILITY_REVIEW_STATES = ["pending", "approved", "rejected"] as const;
export type CapabilityReviewState = (typeof CAPABILITY_REVIEW_STATES)[number];

// ─── ToolCall ────────────────────────────────────────────

export const v11ToolCall = mysqlTable(
  "V11ToolCall",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 所属执行 Invocation id（逻辑外键 → Invocation；不加 DB 级 FK）。 */
    invocationId: varchar("invocationId", { length: 36 }).notNull(),
    /** 会话 ToolCall 必填：所属 Thread id（逻辑外键）。 */
    threadId: varchar("threadId", { length: 36 }),
    /** 会话 ToolCall 必填：所属 Turn id（逻辑外键）。 */
    turnId: varchar("turnId", { length: 36 }),
    /** 纯 Job ToolCall 必填：所属 Job id（逻辑外键）。 */
    jobId: varchar("jobId", { length: 36 }),
    /** Invocation 内递增调用序号。 */
    callSequence: bigint("callSequence", { mode: "number" }).notNull(),
    /** 被调用的 Tool id（逻辑外键 → V11Tool.id）。 */
    toolId: varchar("toolId", { length: 36 }).notNull(),
    /** 调用时锁定的 ToolSchemaRevision id。 */
    toolSchemaRevisionId: varchar("toolSchemaRevisionId", { length: 36 }).notNull(),
    /** 调用时 Schema hash（sha256: 前缀，调用开始后固定）。 */
    schemaHash: varchar("schemaHash", { length: 128 }).notNull(),
    /** 调用状态（proposed/paused/running/succeeded/failed/cancelled/unknown_effect）。 */
    callState: varchar("callState", { length: 32 }).notNull().default("proposed"),
    /** 稳定业务操作幂等 id（同 toolId + operationId 幂等）。 */
    operationId: varchar("operationId", { length: 128 }).notNull(),
    /** 脱敏参数（去除 secret/PII 后的 JSON）。 */
    argumentsRedactedJson: json("argumentsRedactedJson").notNull(),
    /** 原参数 hash（sha256: 前缀，用于幂等比对）。 */
    argumentsHash: varchar("argumentsHash", { length: 128 }).notNull(),
    /** 实际执行环境 lease id（本阶段可空，留后续阶段）。 */
    environmentLeaseId: varchar("environmentLeaseId", { length: 36 }),
    /** 结果摘要（成功时填充，JSON）。 */
    resultSummaryJson: json("resultSummaryJson"),
    /** 结果 artifact id（逻辑外键 → Artifact）。 */
    resultArtifactId: varchar("resultArtifactId", { length: 36 }),
    /** 员工可见 ToolCall Item id（逻辑外键 → ThreadItem）。 */
    itemId: varchar("itemId", { length: 36 }),
    /** 错误代码（失败时填充）。 */
    errorCode: varchar("errorCode", { length: 128 }),
    /** 错误摘要（失败时填充）。 */
    errorSummary: text("errorSummary"),
    startedAt: datetime("startedAt", { mode: "date", fsp: 3 }),
    finishedAt: datetime("finishedAt", { mode: "date", fsp: 3 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    invocationSequenceUq: uniqueIndex("V11ToolCall_invocation_callSequence_uq").on(
      t.invocationId,
      t.callSequence,
    ),
    toolOperationUq: uniqueIndex("V11ToolCall_tool_operationId_uq").on(t.toolId, t.operationId),
    tenantInvocationIdx: index("V11ToolCall_tenant_invocation_idx").on(t.tenantId, t.invocationId),
    tenantToolStateIdx: index("V11ToolCall_tenant_tool_state_idx").on(
      t.tenantId,
      t.toolId,
      t.callState,
    ),
  }),
);

export type V11ToolCall = InferSelectModel<typeof v11ToolCall>;
export type NewV11ToolCall = InferInsertModel<typeof v11ToolCall>;

// ─── CapabilityReview ────────────────────────────────────

export const v11CapabilityReview = mysqlTable(
  "V11CapabilityReview",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 资源类型（skill/tool）。 */
    resourceType: mysqlEnum("resourceType", CAPABILITY_REVIEW_RESOURCE_TYPES).notNull(),
    /** 资源稳定 id（如 Tool.id / Skill.id）。 */
    resourceId: varchar("resourceId", { length: 36 }).notNull(),
    /** 旧修订 id（首次发布时可为空）。 */
    oldRevisionId: varchar("oldRevisionId", { length: 36 }),
    /** 新修订 id（必填）。 */
    newRevisionId: varchar("newRevisionId", { length: 36 }).notNull(),
    /** 风险差异类型（read_to_write/new_destructive_op/...）。 */
    diffType: varchar("diffType", { length: 64 }).notNull(),
    /** 是否需要集中审核（§5.2 列表命中则 true）。 */
    requiresReview: boolean("requiresReview").notNull().default(false),
    /** 风险差异描述（人类可读）。 */
    description: text("description").notNull(),
    /** 受影响的 Agent id 列表（JSON string[]）。 */
    affectedAgentsJson: json("affectedAgentsJson").notNull(),
    /** 审核状态（pending/approved/rejected）。 */
    reviewState: mysqlEnum("reviewState", CAPABILITY_REVIEW_STATES).notNull().default("pending"),
    /** 审核人 userIdentityId 或 serviceId（pending 时为空）。 */
    reviewedBy: varchar("reviewedBy", { length: 128 }),
    reviewedAt: datetime("reviewedAt", { mode: "date", fsp: 3 }),
    /** 审核备注。 */
    reviewNotes: text("reviewNotes"),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantStateCreatedIdx: index("V11CapabilityReview_tenant_state_created_idx").on(
      t.tenantId,
      t.reviewState,
      t.createdAt,
    ),
    tenantResourceIdx: index("V11CapabilityReview_tenant_resource_idx").on(
      t.tenantId,
      t.resourceType,
      t.resourceId,
    ),
  }),
);

export type V11CapabilityReview = InferSelectModel<typeof v11CapabilityReview>;
export type NewV11CapabilityReview = InferInsertModel<typeof v11CapabilityReview>;
