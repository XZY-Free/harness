/**
 * V11 Job 域 schema：Job、JobEvent、JobCommand、JobResultProjection。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.1（Job 表）、§6.1 文末（JobEvent）、§6.12（JobCommand）、§5.4（job_result Item 关联 job_result_projection）、§9（事务边界）
 * - ../v11-agentkit-platform/13-memory-and-job-api.md §4（Job Control API）
 * - ../v11-agentkit-platform/09-unified-domain-model.md §5.2、§5.3（域模型：Job 与会话分离）
 * - ../v11-agentkit-platform/12-capability-and-collaboration-api.md §4、§5（能力与协作 API）
 * - ../v11-agentkit-platform/05-continuity-collaboration-and-reliability.md §16（取消流程）
 * - ../v11-agentkit-platform/contracts/event-catalog.json（18 个 job.* 事件）
 * - ../v11-agentkit-platform-development-plan/09-collaboration-jobs-and-recovery.md S09-W04、S09-C04
 *
 * 关键约束（§6.1、§9.1）：
 * - Job 不复活：终态 Job 不能改回 queued；retry 必须创建新 replacement Job 并通过 replaces_job_id 引用。
 * - JobEvent sequence 通过锁定 Job.last_event_sequence 原子递增（不用 max+1）。
 * - JobEvent UNIQUE(job_id, event_sequence) + UNIQUE(job_id, idempotency_key)（idempotency_key 非空时）。
 * - JobCommand UNIQUE(job_id, idempotency_key)。
 * - 一个 Invocation 必须且只能属于一个 Turn 或一个 Job（turnId/jobId 恰有一个非空，应用层校验）。
 * - Job 创建只能来自所属领域服务；不提供通用 POST /jobs 入口。
 * - JobEvent 不出现在员工 Thread SSE；只有 job_result projection 才进入 ThreadEvent。
 * - completion_policy_json 决定整个 Job 终态；单 Invocation 终态只写 job.invocation_*。
 * - 跨租户隔离：所有查询按 tenantId 过滤；tenantId 外键 → Tenant(id) ON DELETE CASCADE。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/v11/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── Job Type ───────────────────────────────────────────────

/**
 * Job 类型（§6.1）。
 * - scheduled：定时触发。
 * - batch：批量任务。
 * - deployment：部署任务。
 * - evaluation：评测任务。
 * - knowledge_build：知识构建任务。
 * - system：系统维护任务。
 *
 * Job 类型决定创建入口（领域服务），不决定执行路径（执行路径由 Runtime 协议决定）。
 */
export const JOB_TYPES = [
  "scheduled",
  "batch",
  "deployment",
  "evaluation",
  "knowledge_build",
  "system",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

// ─── Job State ──────────────────────────────────────────────

/**
 * Job 状态机（§6.1）。
 * - queued：已创建排队，等待首次 Invocation。
 * - running：至少一个 Invocation 在执行。
 * - waiting_external：等待外部回调或定时触发。
 * - completed：正常完成（终态）。
 * - failed：执行失败（终态）。
 * - cancelled：被取消（终态）。
 *
 * 状态转换约束：
 * - queued → running → waiting_external → running → completed/failed/cancelled
 * - 终态不可恢复（job 不复活）；retry 通过 replaces_job_id 创建新 Job。
 */
export const JOB_STATES = [
  "queued",
  "running",
  "waiting_external",
  "completed",
  "failed",
  "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Job 终态集合（不可恢复）。 */
export const JOB_TERMINAL_STATES: readonly JobState[] = ["completed", "failed", "cancelled"];

// ─── Job Command Type ───────────────────────────────────────

/**
 * JobCommand 类型（§6.12）。
 * - cancel：取消 Job（先 cancel_requested，调度器核对全部 Invocation/Effect 后才 cancelled）。
 * - retry：重新运行终态 Job（同一事务创建新 replacement Job）。
 */
export const JOB_COMMAND_TYPES = ["cancel", "retry"] as const;
export type JobCommandType = (typeof JOB_COMMAND_TYPES)[number];

/**
 * JobCommand 状态（§6.12）。
 * - queued：已入队，等待调度器处理。
 * - dispatched：已派发给调度器。
 * - acknowledged：调度器已确认并完成命令（Job 终态或 replacement Job 已创建）。
 * - rejected：调度器拒绝（如 Job 已终态 / unknown_effect 未核对 / override 不允许）。
 */
export const JOB_COMMAND_STATES = ["queued", "dispatched", "acknowledged", "rejected"] as const;
export type JobCommandState = (typeof JOB_COMMAND_STATES)[number];

// ─── Job Event Type ─────────────────────────────────────────

/**
 * JobEvent 事件类型（event-catalog.json 18 个 job.* 事件）。
 *
 * 顶层 Job 事件（10 个）：
 * - job.queued：Job 创建（创建时由领域服务触发）。
 * - job.started：Job 首次进入 running。
 * - job.progress_updated：进度更新（唯一 skippable_for_projection=true）。
 * - job.result_recorded：结果记录（resultRef/resultHash 写入）。
 * - job.waiting：Job 进入 waiting_external。
 * - job.cancel_requested：取消请求（cancel 命令已入队，Job 状态未变）。
 * - job.retry_requested：重跑请求（retry 命令已入队，原 Job 状态未变）。
 * - job.completed：Job 正常完成（终态）。
 * - job.failed：Job 执行失败（终态）。
 * - job.cancelled：Job 已取消（终态）。
 *
 * Invocation 级事件（8 个，job_id + invocation_id 都非空）：
 * - job.invocation_queued、job.invocation_started、job.invocation_waiting、
 *   job.invocation_resumed、job.invocation_completed、job.invocation_failed、
 *   job.invocation_cancelled、job.invocation_lost
 */
export const JOB_EVENT_TYPES = [
  // 顶层 Job 事件
  "job.queued",
  "job.started",
  "job.progress_updated",
  "job.result_recorded",
  "job.waiting",
  "job.cancel_requested",
  "job.retry_requested",
  "job.completed",
  "job.failed",
  "job.cancelled",
  // Invocation 级事件
  "job.invocation_queued",
  "job.invocation_started",
  "job.invocation_waiting",
  "job.invocation_resumed",
  "job.invocation_completed",
  "job.invocation_failed",
  "job.invocation_cancelled",
  "job.invocation_lost",
] as const;
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

// ─── Job Event Actor Type ───────────────────────────────────

/**
 * JobEvent actor 类型（与 ThreadEvent.actorType 同枚举）。
 * - user：员工用户。
 * - agent：Agent。
 * - system：平台内部（不含 service）。
 * - tool：Tool 执行。
 * - service：Workflow / 调度器等平台服务。
 */
export const JOB_EVENT_ACTOR_TYPES = ["user", "agent", "system", "tool", "service"] as const;
export type JobEventActorType = (typeof JOB_EVENT_ACTOR_TYPES)[number];

// ─── V11Job ─────────────────────────────────────────────────

/**
 * V11Job 表：后台任务（§6.1）。
 *
 * 关键约束：
 * - tenantId/agentId 必填；agentId 必须为同租户 enabled Agent。
 * - jobType 必填；triggerRef 必填（领域触发引用，如 schedule_id、batch_id）。
 * - threadId 可选：仅结果需要进入员工会话时填；Job 创建时预先关联 Thread。
 * - replacesJobId 可选：retry 时指向原 Job；原 Job 状态/事件不被覆盖。
 * - completionPolicyJson 必填：all_success / fail_fast / threshold / 自定义。
 * - lastEventSequence 与 JobEvent.event_sequence 单调递增（SELECT FOR UPDATE 锁定）。
 * - resultRef/resultHash 终态时写入（job.result_recorded Event 触发）。
 * - 终态不可恢复（job 不复活）。
 */
export const v11Job = mysqlTable(
  "V11Job",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 执行 Job 的 Agent。 */
    agentId: varchar("agentId", { length: 36 }).notNull(),
    jobType: mysqlEnum("jobType", JOB_TYPES).notNull(),
    /** 领域触发引用（如 schedule_id、batch_id、deployment_id）。 */
    triggerRef: varchar("triggerRef", { length: 256 }).notNull(),
    jobState: mysqlEnum("jobState", JOB_STATES).notNull().default("queued"),
    /** retry 时指向原 Job；原 Job 状态/事件不被覆盖。 */
    replacesJobId: varchar("replacesJobId", { length: 36 }),
    /** 结果需要进入员工会话时预先关联的 Thread。 */
    threadId: varchar("threadId", { length: 36 }),
    /** 完成策略：all_success / fail_fast / threshold / 自定义。 */
    completionPolicyJson: json("completionPolicyJson").notNull(),
    /** Job 输入引用（领域服务保证输入仍可访问）。 */
    inputRef: varchar("inputRef", { length: 512 }),
    inputHash: varchar("inputHash", { length: 128 }),
    /** JobEvent sequence 原子游标（与 Thread.lastEventSequence 同模式）。 */
    lastEventSequence: bigint("lastEventSequence", { mode: "number" }).notNull().default(0),
    /** Job 终态结果引用。 */
    resultRef: varchar("resultRef", { length: 512 }),
    resultHash: varchar("resultHash", { length: 128 }),
    /** Job 终态错误信息。 */
    errorCode: varchar("errorCode", { length: 128 }),
    errorSummary: text("errorSummary"),
    createdBy: varchar("createdBy", { length: 36 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    startedAt: datetime("startedAt", { mode: "date", fsp: 3 }),
    finishedAt: datetime("finishedAt", { mode: "date", fsp: 3 }),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
  },
  (t) => ({
    tenantAgentIdx: index("V11Job_tenant_agent_idx").on(t.tenantId, t.agentId),
    tenantStateIdx: index("V11Job_tenant_state_idx").on(t.tenantId, t.jobState),
    tenantThreadIdx: index("V11Job_tenant_thread_idx").on(t.tenantId, t.threadId),
    tenantReplacesIdx: index("V11Job_tenant_replaces_idx").on(t.tenantId, t.replacesJobId),
    tenantTypeStateIdx: index("V11Job_tenant_type_state_idx").on(t.tenantId, t.jobType, t.jobState),
  }),
);

export type V11Job = InferSelectModel<typeof v11Job>;
export type NewV11Job = InferInsertModel<typeof v11Job>;

// ─── V11JobEvent ────────────────────────────────────────────

/**
 * V11JobEvent 表：Job 事件 Outbox（§6.1 文末、§9.2）。
 *
 * 关键约束：
 * - UNIQUE(jobId, eventSequence)：sequence 在 Job 内单调递增。
 * - UNIQUE(jobId, idempotencyKey)：idempotencyKey 非空时去重。
 * - sequence 通过锁定 Job.lastEventSequence 原子递增（不用 max+1）。
 * - JobEvent 不出现在员工 Thread SSE；只有 job_result projection 才进入 ThreadEvent。
 * - 与 ThreadEvent 平行承担各自事件流，复用 V11ProjectionCheckpoint/V11EventDeliveryFailure。
 */
export const v11JobEvent = mysqlTable(
  "V11JobEvent",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    jobId: varchar("jobId", { length: 36 }).notNull(),
    eventSequence: bigint("eventSequence", { mode: "number" }).notNull(),
    eventType: mysqlEnum("eventType", JOB_EVENT_TYPES).notNull(),
    schemaVersion: int("schemaVersion").notNull().default(1),
    /** Invocation 级事件非空；顶层 Job 事件为空。 */
    invocationId: varchar("invocationId", { length: 36 }),
    actorType: mysqlEnum("actorType", JOB_EVENT_ACTOR_TYPES).notNull(),
    actorId: varchar("actorId", { length: 36 }),
    payloadJson: json("payloadJson").notNull(),
    correlationId: varchar("correlationId", { length: 128 }),
    causationId: varchar("causationId", { length: 128 }),
    /** 生产者幂等键；非空时 UNIQUE(jobId, idempotencyKey)。 */
    idempotencyKey: varchar("idempotencyKey", { length: 128 }),
    occurredAt: datetime("occurredAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    ingestedAt: datetime("ingestedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    jobSequenceUq: uniqueIndex("V11JobEvent_job_sequence_uq").on(t.jobId, t.eventSequence),
    jobIdempotencyUq: uniqueIndex("V11JobEvent_job_idempotency_uq").on(t.jobId, t.idempotencyKey),
    tenantJobIdx: index("V11JobEvent_tenant_job_idx").on(t.tenantId, t.jobId),
    tenantJobInvocationIdx: index("V11JobEvent_tenant_job_invocation_idx").on(
      t.tenantId,
      t.jobId,
      t.invocationId,
    ),
    tenantJobOccurredIdx: index("V11JobEvent_tenant_job_occurred_idx").on(
      t.tenantId,
      t.jobId,
      t.occurredAt,
    ),
  }),
);

export type V11JobEvent = InferSelectModel<typeof v11JobEvent>;
export type NewV11JobEvent = InferInsertModel<typeof v11JobEvent>;

// ─── V11JobCommand ──────────────────────────────────────────

/**
 * V11JobCommand 表：Job 控制命令（§6.12）。
 *
 * 关键约束：
 * - UNIQUE(jobId, idempotencyKey)：相同命令重放返回原结果。
 * - cancel 命令：Job 必须非终态；先写 job.cancel_requested，Job 状态未变。
 * - retry 命令：Job 必须终态；同事务创建 replacement Job 并填 replacementJobId。
 * - commandState: queued → dispatched → acknowledged/rejected。
 */
export const v11JobCommand = mysqlTable(
  "V11JobCommand",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    jobId: varchar("jobId", { length: 36 }).notNull(),
    commandType: mysqlEnum("commandType", JOB_COMMAND_TYPES).notNull(),
    commandState: mysqlEnum("commandState", JOB_COMMAND_STATES).notNull().default("queued"),
    /** 生产者幂等键；UNIQUE(jobId, idempotencyKey)。 */
    idempotencyKey: varchar("idempotencyKey", { length: 128 }),
    /** 命令发起者（员工 user_id 或 service 标识）。 */
    requestedBy: varchar("requestedBy", { length: 36 }),
    reasonCode: varchar("reasonCode", { length: 128 }),
    /** retry 命令专用：新创建的 replacement Job id。 */
    replacementJobId: varchar("replacementJobId", { length: 36 }),
    /** 调度器拒绝原因码（如 JOB_ALREADY_TERMINAL / JOB_RETRY_BLOCKED_BY_UNKNOWN_EFFECT）。 */
    errorCode: varchar("errorCode", { length: 128 }),
    errorSummary: text("errorSummary"),
    /** 命令 payload（retry 的 override / reuse_input 等）。 */
    commandPayloadJson: json("commandPayloadJson"),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    dispatchedAt: datetime("dispatchedAt", { mode: "date", fsp: 3 }),
    acknowledgedAt: datetime("acknowledgedAt", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    jobIdempotencyUq: uniqueIndex("V11JobCommand_job_idempotency_uq").on(t.jobId, t.idempotencyKey),
    tenantJobStateIdx: index("V11JobCommand_tenant_job_state_idx").on(
      t.tenantId,
      t.jobId,
      t.commandState,
    ),
    tenantReplacementIdx: index("V11JobCommand_tenant_replacement_idx").on(
      t.tenantId,
      t.replacementJobId,
    ),
  }),
);

export type V11JobCommand = InferSelectModel<typeof v11JobCommand>;
export type NewV11JobCommand = InferInsertModel<typeof v11JobCommand>;

// ─── V11JobResultProjection ─────────────────────────────────

/**
 * V11JobResultProjection 表：job_result ThreadItem 的权威关联对象（§5.4）。
 *
 * 关键约束：
 * - itemId 唯一外键 → V11ThreadItem(id)（一对一）。
 * - jobId 外键 → V11Job(id)。
 * - sourceTurnId 标识结果投影来源 Turn（existing_source_turn 或 system_triggered_turn）。
 * - resultRef/resultHash 与 Job 终态一致；不可修改。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */
export const v11JobResultProjection = mysqlTable(
  "V11JobResultProjection",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 一对一关联 job_result ThreadItem。 */
    itemId: varchar("itemId", { length: 36 }).notNull(),
    jobId: varchar("jobId", { length: 36 }).notNull(),
    /** 结果投影来源 Turn：existing_source_turn 或 system_triggered_turn。 */
    sourceTurnId: varchar("sourceTurnId", { length: 36 }).notNull(),
    /** 结果投影类型（§5.2 域模型）。 */
    projectionKind: mysqlEnum("projectionKind", [
      "existing_source_turn",
      "system_triggered_turn",
    ]).notNull(),
    resultRef: varchar("resultRef", { length: 512 }).notNull(),
    resultHash: varchar("resultHash", { length: 128 }).notNull(),
    /** 结构化结果摘要（写入 ThreadItem.contentJson.summary）。 */
    resultSummaryJson: json("resultSummaryJson"),
    createdBy: varchar("createdBy", { length: 36 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    itemUq: uniqueIndex("V11JobResultProjection_item_uq").on(t.itemId),
    tenantJobIdx: index("V11JobResultProjection_tenant_job_idx").on(t.tenantId, t.jobId),
    tenantSourceTurnIdx: index("V11JobResultProjection_tenant_source_turn_idx").on(
      t.tenantId,
      t.sourceTurnId,
    ),
  }),
);

export type V11JobResultProjection = InferSelectModel<typeof v11JobResultProjection>;
export type NewV11JobResultProjection = InferInsertModel<typeof v11JobResultProjection>;
