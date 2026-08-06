/**
 * 会话域 schema：Thread、Turn、ThreadItem、Goal、ThreadRelation、ThreadEvent。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §5（thread/turn/thread_item/thread_event/pending_input/goal/thread_relation）、§9（事务边界）
 * - ../v11-agentkit-platform/09-unified-domain-model.md §4（域模型）、§10（不变量）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §5—8（Thread 容器、Turn 接纳、Item 投影、Event 主链）
 * - ../v11-agentkit-platform-development-plan/04-thread-turn-item-and-event-core.md /W02/W03/W04
 *
 * 关键约束：
 * - Thread 是连续容器，绑定租户、所有者和主 Agent；lifecycle_state active→archived→deleted。
 * - Turn 是正式接纳周期，turn_sequence 在 Thread 内单调递增；只有 job_result_projection Turn 允许无 Invocation 从 accepted 直接 completed。
 * - ThreadItem 是当前内容投影，item_sequence 在 Thread 内稳定展示顺序；superseded_by_item_id 不得成环。
 * - ThreadEvent 只追加，event_sequence 在 Thread 内单调递增；SSE id 直接使用十进制 event_sequence。
 * - Goal 一个 Thread 最多一个 active（生成列 UNIQUE 约束）。
 * - ThreadRelation 记录 fork/delegate/workflow_child 关系；handoff 不创建第二个 Thread。
 *
 * 旧 `Thread`/`Message`/`ThreadEvent`/`ThreadRun` 表保持只读兼容，最终迁移安排在阶段 13。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
 bigint,
 datetime,
 decimal,
 index,
 int,
 json,
 mysqlEnum,
 mysqlTable,
 text,
 uniqueIndex,
 varchar,
} from "drizzle-orm/mysql-core";

// ─── Thread Lifecycle ───────────────────────────────────────

/**
 * Thread 生命周期状态。
 * - active：可接受新 Turn。
 * - archived：归档，禁止新 Turn，但可查询。
 * - deleted：软删除，禁止新 Turn，按保留策略异步清理。
 */
export const THREAD_LIFECYCLE_STATES = ["active", "archived", "deleted"] as const;
export type ThreadLifecycleState = (typeof THREAD_LIFECYCLE_STATES)[number];

// ─── Turn Trigger Type ──────────────────────────────────────

/**
 * Turn 触发类型。
 * - user_message：员工用户消息。
 * - thread_schedule：计划触发。
 * - thread_webhook：Webhook 触发。
 * - job_result_projection：Job 结果投影（允许无 Invocation 直接 completed）。
 * - system：系统触发。
 */
export const TURN_TRIGGER_TYPES = [
 "user_message",
 "thread_schedule",
 "thread_webhook",
 "job_result_projection",
 "system",
] as const;
export type TurnTriggerType = (typeof TURN_TRIGGER_TYPES)[number];

// ─── Turn State ─────────────────────────────────────────────

/**
 * Turn 状态。
 * - accepted：输入和 Turn 已同事务落库。
 * - queued：已排队等待 Runtime。
 * - running：Runtime 正在执行。
 * - waiting_user：等待用户操作（UserActionRequest）。
 * - regenerating：Regenerate 进行中。
 * - completed：正常完成（终态）。
 * - interrupted：用户中断（终态）。
 * - failed：执行失败（终态）。
 * - cancelled：系统/管理员取消（终态，不可恢复）。
 */
export const TURN_STATES = [
 "accepted",
 "queued",
 "running",
 "waiting_user",
 "regenerating",
 "completed",
 "interrupted",
 "failed",
 "cancelled",
] as const;
export type TurnState = (typeof TURN_STATES)[number];

/** Turn 终态集合（不可恢复）。 */
export const TURN_TERMINAL_STATES: readonly TurnState[] = [
 "completed",
 "interrupted",
 "failed",
 "cancelled",
];

// ─── ThreadItem Type ────────────────────────────────────────

/**
 * ThreadItem 类型。
 * - user_message：员工用户消息。
 * - user_guidance：员工引导（steer），pending 状态不进入模型上下文。
 * - agent_message：Agent 回答。
 * - tool_call：Tool 调用。
 * - artifact：Artifact 引用。
 * - job_result：Job 结果。
 * - child_thread：子 Thread 引用。
 * - user_action：用户操作请求。
 */
export const THREAD_ITEM_TYPES = [
 "user_message",
 "user_guidance",
 "agent_message",
 "tool_call",
 "artifact",
 "job_result",
 "child_thread",
 "user_action",
] as const;
export type ThreadItemType = (typeof THREAD_ITEM_TYPES)[number];

// ─── ThreadItem State ───────────────────────────────────────

/**
 * ThreadItem 状态。
 * - pending：临时状态（如 steer user_guidance 未 ack）。
 * - completed：已完成。
 * - failed：失败。
 * - superseded：被新 Item 替代（Regenerate）。
 * - cancelled：取消。
 */
export const THREAD_ITEM_STATES = [
 "pending",
 "completed",
 "failed",
 "superseded",
 "cancelled",
] as const;
export type ThreadItemState = (typeof THREAD_ITEM_STATES)[number];

// ─── ThreadItem Author Type ─────────────────────────────────

export const THREAD_ITEM_AUTHOR_TYPES = ["user", "agent", "system", "tool"] as const;
export type ThreadItemAuthorType = (typeof THREAD_ITEM_AUTHOR_TYPES)[number];

// ─── ThreadItem Context Policy ──────────────────────────────

/**
 * Item 上下文策略。
 * - include：进入模型上下文。
 * - summary_only：只摘要进入。
 * - exclude：不进入。
 * - sensitive：敏感，需脱敏后摘要。
 */
export const CONTEXT_POLICIES = ["include", "summary_only", "exclude", "sensitive"] as const;
export type ContextPolicy = (typeof CONTEXT_POLICIES)[number];

// ─── Goal State ─────────────────────────────────────────────

export const GOAL_STATES = ["active", "blocked", "completed", "cancelled"] as const;
export type GoalState = (typeof GOAL_STATES)[number];

// ─── ThreadRelation Type ────────────────────────────────────

/**
 * Thread 关系类型。
 * - delegate：委派子 Thread。
 * - fork：分支。
 * - workflow_child：工作流子 Thread。
 * 注意：handoff 不创建第二个 Thread，不在此列。
 */
export const THREAD_RELATION_TYPES = ["delegate", "fork", "workflow_child"] as const;
export type ThreadRelationType = (typeof THREAD_RELATION_TYPES)[number];

// ─── ThreadRelation State ───────────────────────────────────

export const THREAD_RELATION_STATES = [
 "creating",
 "active",
 "cancel_requested",
 "completed",
 "failed",
 "cancelled",
] as const;
export type ThreadRelationState = (typeof THREAD_RELATION_STATES)[number];

// ─── ThreadEvent Actor Type ─────────────────────────────────

export const THREAD_EVENT_ACTOR_TYPES = ["user", "agent", "system", "tool", "service"] as const;
export type ThreadEventActorType = (typeof THREAD_EVENT_ACTOR_TYPES)[number];

// ─── Thread ─────────────────────────────────────────────────

export const threadTable = mysqlTable(
 "Thread",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 会话所有者 userIdentityId（逻辑外键 → UserIdentity.id）。 */
 ownerUserId: varchar("ownerUserId", { length: 36 }).notNull(),
 /** 当前主 Agent 稳定身份（逻辑外键 → Agent.id）。 */
 primaryAgentId: varchar("primaryAgentId", { length: 36 }).notNull(),
 /** 默认逻辑 Workspace（后续阶段接入）。 */
 defaultWorkspaceId: varchar("defaultWorkspaceId", { length: 36 }),
 /** 当前 active Goal id（逻辑外键 → Goal.id）。 */
 activeGoalId: varchar("activeGoalId", { length: 36 }),
 /** 首个 Turn 前可为空。 */
 title: text("title"),
 /** 下一新 Invocation 的模型偏好；实际值写 ExecutionBinding。 */
 defaultModelRef: varchar("defaultModelRef", { length: 256 }),
 /** 默认环境偏好，非实际 Lease。 */
 defaultEnvironmentDefinitionId: varchar("defaultEnvironmentDefinitionId", { length: 36 }),
 lifecycleState: mysqlEnum("lifecycleState", THREAD_LIFECYCLE_STATES)
 .notNull()
 .default("active"),
 /** 列表排序依据。 */
 lastActivityAt: datetime("lastActivityAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 /** Turn 序号分配基线。 */
 lastTurnSequence: bigint("lastTurnSequence", { mode: "number" }).notNull().default(0),
 /** Item 序号分配基线。 */
 lastItemSequence: bigint("lastItemSequence", { mode: "number" }).notNull().default(0),
 /** Event 序号分配基线（锁定此行原子递增，不用 max+1）。 */
 lastEventSequence: bigint("lastEventSequence", { mode: "number" }).notNull().default(0),
 /** PendingInput 全队列并发版本号。 */
 pendingQueueVersionNo: bigint("pendingQueueVersionNo", { mode: "number" }).notNull().default(1),
 /** 乐观并发版本号。 */
 versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 deletedAt: datetime("deletedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 tenantOwnerLifecycleActivityIdx: index("Thread_tenant_owner_lifecycle_activity_idx").on(
 t.tenantId,
 t.ownerUserId,
 t.lifecycleState,
 t.lastActivityAt,
 ),
 tenantAgentActivityIdx: index("Thread_tenant_agent_activity_idx").on(
 t.tenantId,
 t.primaryAgentId,
 t.lastActivityAt,
 ),
 }),
);

export type Thread = InferSelectModel<typeof threadTable>;
export type NewThread = InferInsertModel<typeof threadTable>;

// ─── Turn ───────────────────────────────────────────────────

export const turnTable = mysqlTable(
 "Turn",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 threadId: varchar("threadId", { length: 36 })
 .notNull()
 .references(() => threadTable.id),
 /** Thread 内单调递增序号。 */
 turnSequence: bigint("turnSequence", { mode: "number" }).notNull(),
 triggerType: mysqlEnum("triggerType", TURN_TRIGGER_TYPES).notNull(),
 /** 外部触发引用或计划 id。 */
 triggerRef: varchar("triggerRef", { length: 256 }),
 /** 用户触发时指向 user_message Item（逻辑外键 → ThreadItem.id）。 */
 triggerItemId: varchar("triggerItemId", { length: 36 }),
 turnState: mysqlEnum("turnState", TURN_STATES).notNull().default("accepted"),
 /** 当前 queued/running/waiting 执行（逻辑外键 → Invocation.id）；终态为空。 */
 activeInvocationId: varchar("activeInvocationId", { length: 36 }),
 /** 最近创建的执行，含失败的 Regenerate。 */
 latestInvocationId: varchar("latestInvocationId", { length: 36 }),
 /** 当前 final_item 所属会话执行；系统投影结果或无有效结果时为空。 */
 adoptedInvocationId: varchar("adoptedInvocationId", { length: 36 }),
 /** 当前正式回答或结果（逻辑外键 → ThreadItem.id）。 */
 finalItemId: varchar("finalItemId", { length: 36 }),
 /** 稳定错误码。 */
 errorCode: varchar("errorCode", { length: 128 }),
 /** 显式 Regenerate 次数。 */
 regenerationNo: bigint("regenerationNo", { mode: "number" }).notNull().default(0),
 /** regenerating 期间保存原终态，结束后清空。 */
 regenerationBaseState: mysqlEnum("regenerationBaseState", [
 "completed",
 "interrupted",
 "failed",
 ]),
 acceptedAt: datetime("acceptedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 startedAt: datetime("startedAt", { mode: "date", fsp: 3 }),
 waitingAt: datetime("waitingAt", { mode: "date", fsp: 3 }),
 finishedAt: datetime("finishedAt", { mode: "date", fsp: 3 }),
 /** 状态并发更新版本号。 */
 versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
 },
 (t) => ({
 threadSequenceUq: uniqueIndex("Turn_thread_sequence_uq").on(t.threadId, t.turnSequence),
 threadStateAcceptedIdx: index("Turn_thread_state_accepted_idx").on(
 t.threadId,
 t.turnState,
 t.acceptedAt,
 ),
 }),
);

export type Turn = InferSelectModel<typeof turnTable>;
export type NewTurn = InferInsertModel<typeof turnTable>;

// ─── ThreadItem ─────────────────────────────────────────────

export const threadItemTable = mysqlTable(
 "ThreadItem",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 threadId: varchar("threadId", { length: 36 })
 .notNull()
 .references(() => threadTable.id),
 /** Item 必须属于 Turn（逻辑外键 → Turn.id）。 */
 turnId: varchar("turnId", { length: 36 }).notNull(),
 /** Thread 内稳定展示顺序。 */
 itemSequence: bigint("itemSequence", { mode: "number" }).notNull(),
 itemType: mysqlEnum("itemType", THREAD_ITEM_TYPES).notNull(),
 itemState: mysqlEnum("itemState", THREAD_ITEM_STATES).notNull().default("pending"),
 authorType: mysqlEnum("authorType", THREAD_ITEM_AUTHOR_TYPES).notNull(),
 authorId: varchar("authorId", { length: 36 }),
 /** 按 item_type 验证的当前内容或引用。 */
 contentJson: json("contentJson").notNull(),
 /** 内容 hash。 */
 contentHash: varchar("contentHash", { length: 128 }).notNull(),
 contextPolicy: mysqlEnum("contextPolicy", CONTEXT_POLICIES).notNull().default("include"),
 /** 产生该 Item 的执行（逻辑外键 → Invocation.id）。 */
 invocationId: varchar("invocationId", { length: 36 }),
 /** 被替代关系（逻辑外键 → ThreadItem.id）；不得成环。 */
 supersededByItemId: varchar("supersededByItemId", { length: 36 }),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 threadSequenceUq: uniqueIndex("ThreadItem_thread_sequence_uq").on(t.threadId, t.itemSequence),
 threadTurnSequenceIdx: index("ThreadItem_thread_turn_sequence_idx").on(
 t.threadId,
 t.turnId,
 t.itemSequence,
 ),
 invocationIdx: index("ThreadItem_invocation_idx").on(t.invocationId),
 }),
);

export type ThreadItem = InferSelectModel<typeof threadItemTable>;
export type NewThreadItem = InferInsertModel<typeof threadItemTable>;

// ─── ThreadEvent ────────────────────────────────────────────

export const threadEventTable = mysqlTable(
 "ThreadEvent",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 threadId: varchar("threadId", { length: 36 })
 .notNull()
 .references(() => threadTable.id),
 /** Thread 内单调递增，续读主游标；SSE id 直接使用此值。 */
 eventSequence: bigint("eventSequence", { mode: "number" }).notNull(),
 /** 稳定事件名（如 thread.created、turn.accepted、item.created）。 */
 eventType: varchar("eventType", { length: 128 }).notNull(),
 /** payload 版本。 */
 schemaVersion: int("schemaVersion").notNull().default(1),
 /** 关联 Turn（逻辑外键 → Turn.id）。 */
 turnId: varchar("turnId", { length: 36 }),
 /** 关联 Item（逻辑外键 → ThreadItem.id）。 */
 itemId: varchar("itemId", { length: 36 }),
 /** 关联 Invocation（逻辑外键 → Invocation.id）。 */
 invocationId: varchar("invocationId", { length: 36 }),
 actorType: mysqlEnum("actorType", THREAD_EVENT_ACTOR_TYPES).notNull(),
 actorId: varchar("actorId", { length: 36 }),
 /** 类型化且已脱敏的负载。 */
 payloadJson: json("payloadJson").notNull(),
 /** 关联标识（如 X-Request-Id `req_{uuid}`，40 字符；或 W3C traceparent，55 字符）。 */
 correlationId: varchar("correlationId", { length: 128 }),
 causationId: varchar("causationId", { length: 128 }),
 /** 生产者幂等键；非空时 UNIQUE(threadId, idempotencyKey)。 */
 idempotencyKey: varchar("idempotencyKey", { length: 128 }),
 occurredAt: datetime("occurredAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 ingestedAt: datetime("ingestedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 threadSequenceUq: uniqueIndex("ThreadEvent_thread_sequence_uq").on(t.threadId, t.eventSequence),
 threadIdempotencyUq: uniqueIndex("ThreadEvent_thread_idempotency_uq").on(
 t.threadId,
 t.idempotencyKey,
 ),
 threadOccurredIdIdx: index("ThreadEvent_thread_occurred_id_idx").on(
 t.threadId,
 t.occurredAt,
 t.id,
 ),
 turnSequenceIdx: index("ThreadEvent_turn_sequence_idx").on(t.turnId, t.eventSequence),
 invocationSequenceIdx: index("ThreadEvent_invocation_sequence_idx").on(
 t.invocationId,
 t.eventSequence,
 ),
 }),
);

export type ThreadEvent = InferSelectModel<typeof threadEventTable>;
export type NewThreadEvent = InferInsertModel<typeof threadEventTable>;

// ─── Goal ───────────────────────────────────────────────────

export const goalTable = mysqlTable(
 "Goal",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 threadId: varchar("threadId", { length: 36 })
 .notNull()
 .references(() => threadTable.id),
 objective: text("objective").notNull(),
 successCriteriaJson: json("successCriteriaJson").notNull(),
 constraintsJson: json("constraintsJson"),
 currentStateJson: json("currentStateJson"),
 goalState: mysqlEnum("goalState", GOAL_STATES).notNull().default("active"),
 /** 创建者 userIdentityId 或 serviceId。 */
 createdBy: varchar("createdBy", { length: 128 }).notNull(),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 completedAt: datetime("completedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 threadStateIdx: index("Goal_thread_state_idx").on(t.threadId, t.goalState),
 }),
);

export type Goal = InferSelectModel<typeof goalTable>;
export type NewGoal = InferInsertModel<typeof goalTable>;

// ─── ThreadRelation ─────────────────────────────────────────

export const threadRelationTable = mysqlTable(
 "ThreadRelation",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 parentThreadId: varchar("parentThreadId", { length: 36 })
 .notNull()
 .references(() => threadTable.id),
 childThreadId: varchar("childThreadId", { length: 36 })
 .notNull()
 .references(() => threadTable.id),
 relationType: mysqlEnum("relationType", THREAD_RELATION_TYPES).notNull(),
 /** Fork 来源 Turn；delegate 可为空。 */
 sourceTurnId: varchar("sourceTurnId", { length: 36 }),
 sourceItemId: varchar("sourceItemId", { length: 36 }),
 /** delegate 必须有；fork 可为空并继承主 Agent。 */
 sourceInvocationId: varchar("sourceInvocationId", { length: 36 }),
 /** delegate 目标 Agent；fork 可为空。 */
 targetAgentId: varchar("targetAgentId", { length: 36 }),
 taskPayloadRef: varchar("taskPayloadRef", { length: 512 }),
 taskPayloadHash: varchar("taskPayloadHash", { length: 128 }),
 contextTransferPolicyJson: json("contextTransferPolicyJson"),
 budgetPolicyJson: json("budgetPolicyJson"),
 /**
 * 子 Thread 实际预算用量累积（S09-C02）。
 * 形状：{ tokens, cost, tool_calls, wall_clock_ms, unknown_effect }
 * 与 budgetPolicyJson（上限）分离存储；预算耗尽由应用服务发出 cancel command。
 */
 budgetUsedJson: json("budgetUsedJson"),
 relationState: mysqlEnum("relationState", THREAD_RELATION_STATES).notNull().default("creating"),
 /** 员工可见 ChildThread Item；一对一。 */
 itemId: varchar("itemId", { length: 36 }),
 /** 回传父 Thread 的结果 Item。 */
 resultItemId: varchar("resultItemId", { length: 36 }),
 /** 子 Thread 终态结果引用。 */
 resultRef: varchar("resultRef", { length: 512 }),
 resultHash: varchar("resultHash", { length: 128 }),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 completedAt: datetime("completedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 parentChildTypeUq: uniqueIndex("ThreadRelation_parent_child_type_uq").on(
 t.parentThreadId,
 t.childThreadId,
 t.relationType,
 ),
 parentStateIdx: index("ThreadRelation_parent_state_idx").on(t.parentThreadId, t.relationState),
 childIdx: index("ThreadRelation_child_idx").on(t.childThreadId),
 }),
);

export type ThreadRelation = InferSelectModel<typeof threadRelationTable>;
export type NewThreadRelation = InferInsertModel<typeof threadRelationTable>;

// ─── PendingInput ──────────────────────────────────────────

/**
 * PendingInput 队列状态。
 * - pending：待接纳，仍可编辑/删除/重排。
 * - admitted：已被某 Turn 接纳为输入；不可再编辑或删除。
 * - removed：员工显式从队列移除；不可再编辑或删除。
 */
export const PENDING_INPUT_STATES = ["pending", "admitted", "removed"] as const;
export type PendingInputState = (typeof PENDING_INPUT_STATES)[number];

/**
 * PendingInput 表：Thread 内待接纳输入队列。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md （PendingInput 表，行 324-339）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md （创建 PendingInput 不生成 user_message Item）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md （删除 PendingInput 不生成 user_message Item）
 *
 * 关键约束：
 * - UNIQUE(thread_id, client_message_id) 防止客户端重发同 ID 创建重复行。
 * - queue_position 用于排序，新创建追加到队尾用 max(queue_position)+1000（首个为 1000）。
 * - input_state=pending 才可编辑/删除/重排；admitted/removed 不可变。
 * - versionNo 是资源 ETag 来源；Thread.pendingQueueVersionNo 是队列 ETag 来源。
 */
export const pendingInputTable = mysqlTable(
 "PendingInput",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 threadId: varchar("threadId", { length: 36 })
 .notNull()
 .references(() => threadTable.id),
 /** 客户端幂等键（防止同 Thread 内重发同 ID）。 */
 clientMessageId: varchar("clientMessageId", { length: 128 }),
 inputState: mysqlEnum("inputState", PENDING_INPUT_STATES).notNull().default("pending"),
 /** 队列排序位置；DECIMAL(20,10) 与契约 行 327 对齐。 */
 queuePosition: decimal("queuePosition", { precision: 20, scale: 10 }).notNull(),
 /** 结构化输入（{ type, text }）。 */
 inputJson: json("inputJson").notNull(),
 /** 内容 hash（sha256）。 */
 inputHash: varchar("inputHash", { length: 128 }).notNull(),
 /** 接纳后指向 Turn（逻辑外键 → Turn.id）。 */
 admittedTurnId: varchar("admittedTurnId", { length: 36 }),
 /** 接纳后指向 user_message/user_guidance Item（逻辑外键 → ThreadItem.id）。 */
 admittedItemId: varchar("admittedItemId", { length: 36 }),
 /** 资源 ETag 来源；每次编辑递增。 */
 versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 removedAt: datetime("removedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 threadClientMessageUq: uniqueIndex("PendingInput_thread_client_message_uq").on(
 t.threadId,
 t.clientMessageId,
 ),
 threadStatePositionIdx: index("PendingInput_thread_state_position_idx").on(
 t.threadId,
 t.inputState,
 t.queuePosition,
 ),
 }),
);

export type PendingInput = InferSelectModel<typeof pendingInputTable>;
export type NewPendingInput = InferInsertModel<typeof pendingInputTable>;

// ─── InvocationCommand ─────────────────────────────────────

/**
 * InvocationCommand 命令状态。
 * - queued：已入队，等待 Runtime 拉取（本阶段 Runtime 未接入，命令停留在 queued）。
 * - dispatched：已派发给 Runtime。
 * - acknowledged：Runtime 已 ack（开始执行）。
 * - failed：Runtime 拒绝或执行失败（不能伪装成执行完成，行 366）。
 * - cancelled：在 Runtime ack 前被显式取消。
 */
export const INVOCATION_COMMAND_STATES = [
 "queued",
 "dispatched",
 "acknowledged",
 "failed",
 "cancelled",
] as const;
export type InvocationCommandState = (typeof INVOCATION_COMMAND_STATES)[number];

/**
 * InvocationCommand 命令类型。
 * - steer：员工引导（steer），将 user_guidance Item 加入当前 Turn。
 * - interrupt：请求中断 Turn（Runtime ack 后才进入终态）。
 * - regenerate：请求 Regenerate（生成新 Invocation 替代当前 final_item）。
 * - resume：请求 Runtime 恢复 waiting_user Invocation（携带用户响应 resume_payload）。
 * - cancel：请求取消一条 delegate Child Thread 关系（S09-C01；携带 relation_id 与 reason）。
 * 取消请求 ≠ 已取消：relation_state 由 active → cancel_requested → cancelled，
 * 终态由 Runtime/应用服务在执行确认后落库（05 文档 §9 行 412-417）。
 */
export const INVOCATION_COMMAND_TYPES = [
 "steer",
 "interrupt",
 "regenerate",
 "resume",
 "cancel",
] as const;
export type InvocationCommandType = (typeof INVOCATION_COMMAND_TYPES)[number];

/**
 * InvocationCommand 表：员工命令入队（Steer/Interrupt/Regenerate）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md 行 504（InvocationCommand 表）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md （Steer）、（Stop/Interrupt）、（Regenerate）
 *
 * 关键约束：
 * - command_state=queued 时 invocation_id 可空（Runtime 拉取后才绑定）。
 * - UNIQUE(thread_id, idempotency_key) 防止同 Thread 内重发同 Idempotency-Key。
 * - Runtime 拒绝时不能伪造成功（command 标记 failed，行 366）。
 * - 本阶段 Runtime 未接入：所有命令停留在 queued，不模拟 Runtime ack。
 */
export const invocationCommandTable = mysqlTable(
 "InvocationCommand",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 /** 命令目标 Invocation；queued 状态时可能为空。 */
 invocationId: varchar("invocationId", { length: 36 }),
 threadId: varchar("threadId", { length: 36 })
 .notNull()
 .references(() => threadTable.id),
 /** 命令目标 Turn。 */
 turnId: varchar("turnId", { length: 36 }),
 commandType: mysqlEnum("commandType", INVOCATION_COMMAND_TYPES).notNull(),
 /** 命令参数（按 command_type 验证）。 */
 commandPayloadJson: json("commandPayloadJson").notNull(),
 commandPayloadHash: varchar("commandPayloadHash", { length: 128 }).notNull(),
 commandState: mysqlEnum("commandState", INVOCATION_COMMAND_STATES).notNull().default("queued"),
 /** Runtime 执行引用（dispatched 后由 Runtime 写入）。 */
 runtimeExecutionRef: varchar("runtimeExecutionRef", { length: 256 }),
 idempotencyKey: varchar("idempotencyKey", { length: 128 }),
 /** 失败时填入稳定错误码。 */
 errorCode: varchar("errorCode", { length: 128 }),
 errorMessage: text("errorMessage"),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 dispatchedAt: datetime("dispatchedAt", { mode: "date", fsp: 3 }),
 acknowledgedAt: datetime("acknowledgedAt", { mode: "date", fsp: 3 }),
 failedAt: datetime("failedAt", { mode: "date", fsp: 3 }),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 threadTurnIdx: index("InvocationCommand_thread_turn_idx").on(t.threadId, t.turnId),
 invocationIdx: index("InvocationCommand_invocation_idx").on(t.invocationId),
 threadIdempotencyUq: uniqueIndex("InvocationCommand_thread_idempotency_uq").on(
 t.threadId,
 t.idempotencyKey,
 ),
 }),
);

export type InvocationCommand = InferSelectModel<typeof invocationCommandTable>;
export type NewInvocationCommand = InferInsertModel<typeof invocationCommandTable>;
