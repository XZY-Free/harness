import { randomUUID } from "node:crypto";
import type { InferSelectModel } from "drizzle-orm";
import {
  bigint,
  boolean,
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

/**
 * SnowHarness 数据模型。
 *
 * - Thread：执行线程，承载 agent 生命周期（status 真状态列）
 * - Message：线程消息，type 列做消息分层（写入时按 role 填充）
 * - User：单租户固定用户（接 SSO）
 */

// ─── Thread Status ───────────────────────────────────────────

// 扩展为完整 agent 生命周期状态。新增值追加在尾部，保留既有 enum 存储顺序，
// 现有 chat 路径仍只写 idle/executing/ready_for_review/failed，不影响行为（）。
export const THREAD_STATUSES = [
  "idle",
  "executing",
  "ready_for_review",
  "failed",
  // V3 新增：planning / awaiting_input / awaiting_approval / verifying / delivering / completed / cancelled
  "planning",
  "awaiting_input",
  "awaiting_approval",
  "verifying",
  "delivering",
  "completed",
  "cancelled",
] as const;

export type ThreadStatus = (typeof THREAD_STATUSES)[number];

// ─── Message Type ────────────────────────────────────────────

export const MESSAGE_TYPES = [
  "user_input",
  "assistant_text",
  "tool_call",
  "tool_result",
  "system",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

/** 按消息 role 推导默认 type（消息分层最小实现，写入时调用）。 */
export function messageTypeForRole(role: string): MessageType {
  if (role === "user") return "user_input";
  if (role === "system") return "system";
  return "assistant_text";
}

// ─── Thread Event Types (.1 权威表) ─────────────────────

/**
 * 事件类型——取自蓝图 词表。
 * 本枚举是全文事件名的唯一权威定义。
 *
 * 激活：delivery.succeeded / delivery.failed（交付终态）+ git.checkpoint_*。
 * 预留但不实现的后续 Phase 事件：review.requested
 */
export const THREAD_EVENT_TYPES = [
  "agent.started",
  "agent.status_changed",
  "tool.called",
  "tool.succeeded",
  "tool.failed",
  "artifact.created",
  "artifact.updated",
  // context manifest 与 plan/todo 事件（只追加，不改旧事件含义）
  "context.snapshot_created",
  // a：上下文压缩（只追加，不改旧事件含义）
  "context.summary_created",
  "context.compressed",
  "plan.created",
  "plan.updated",
  "plan.item_updated",
  // 工具审批暂停/恢复（只追加）
  "tool.approval_requested",
  "tool.approval_resolved",
  // 后台任务生命周期（只追加）
  "task.started",
  "task.stopped",
  "task.failed",
  // 交付生命周期事件（从注释态激活）+ checkpoint 事件
  "delivery.succeeded",
  "delivery.failed",
  "git.checkpoint_created",
  "git.checkpoint_restored",
  // 外部资料与 MCP 调用（只追加，不改旧事件含义）
  // external.fetched：webFetch/webSearch/searchDocs 一次外部资料访问（payload 含来源/hash/artifact）
  // external.searched：webSearch 一次搜索（S1 06-，payload 含 query/resultCount）
  // external.docs_searched：searchDocs 一次文档搜索（S1 06-）
  // mcp.listed：listMcpTools 列出某 server 工具集
  // mcp.called：callMcpTool 一次 MCP 工具调用（payload 含 permissionKey/ok）
  "external.fetched",
  "external.searched",
  "external.docs_searched",
  "mcp.listed",
  "mcp.called",
  // 子代理生命周期（只追加，不改旧事件含义）
  // subagent.spawned：子代理发起（payload 含 runId/role/goal 摘要/writeScope?）
  // subagent.joined：子代理加入并收集结构化结果（payload 含 runId/status/resultSummary 摘要/outputArtifactId?）
  // subagent.failed：子代理失败/超时（payload 含 runId/errorMessage 摘要）
  "subagent.spawned",
  "subagent.joined",
  "subagent.failed",
  // 浏览器 QA gate 生命周期（只追加，不改旧事件含义）
  // qa.check_passed：一次 QA 检查通过（payload 含 checkId/kind/viewports/durationMs）
  // qa.check_failed：一次 QA 检查失败（payload 含 checkId/kind/failures[]/durationMs）
  // kind=gate 表示 reportReady 自动跑的 gate；其余表示 agent 主动调 QA 工具。
  "qa.check_passed",
  "qa.check_failed",
  // 部署与 secret 生命周期（只追加，不改旧事件含义）
  // deployment.deploying：部署已被 CI/CD 接收，等待终态（payload 含 deploymentId/environment/cicdJobId?/imageTag?）
  // deployment.succeeded：部署成功（payload 含 deploymentId/environment/cicdJobId?/imageTag?）
  // deployment.failed：部署失败（payload 含 deploymentId/errorMessage 摘要）
  // deployment.rolled_back：部署回滚（payload 含 deploymentId/previousDeploymentId）
  // secret.rotated：secret 轮换（payload 含 secretMountId/name/scope）
  // secret.revoked：secret 撤销（payload 含 secretMountId/name/scope）
  "deployment.deploying",
  "deployment.succeeded",
  "deployment.failed",
  "deployment.rolled_back",
  "secret.rotated",
  "secret.revoked",
  // P1 修复(01 AI Core ): agent 每轮 token 用量审计(供计费/用量分析)。
  // 由 chat route streamText.onFinish 落库,payload { promptTokens, completionTokens, totalTokens, model }。
  // 只追加,不改旧事件顺序(避免破坏 slice(0,7) 等历史断言)。
  "agent.usage",
  // 会话标题被自动或手动更新。payload { title, source, reason? }。
  "thread.title_updated",
  // 预留：Phase 3+ 事件
  // "review.requested",
] as const;

export type ThreadEventType = (typeof THREAD_EVENT_TYPES)[number];

// ─── Tool Run Statuses ──────────────────────────────────────

// 追加 awaiting_approval——ask 暂停时 tool_runs.status 设为该值（非 failed），
// 以区分「被治理暂停」与「业务失败」。既有按 succeeded/failed 过滤的查询不受影响。
export const TOOL_RUN_STATUSES = ["running", "succeeded", "failed", "awaiting_approval"] as const;

export type ToolRunStatus = (typeof TOOL_RUN_STATUSES)[number];

// ─── Tables ──────────────────────────────────────────────────

export const user = mysqlTable(
  "User",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // 公司用户中心 subject / employee id（：SSO 身份映射键）
    externalId: varchar("externalId", { length: 128 }).notNull(),
    email: varchar("email", { length: 128 }).notNull(),
    name: text("name"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    externalIdUq: uniqueIndex("User_externalId_uq").on(t.externalId),
  }),
);
export type User = InferSelectModel<typeof user>;

// ─── Tool Run (结构化工具执行记录) ──────────────────────────

export const toolRun = mysqlTable(
  "ToolRun",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // 所属 thread
    threadId: varchar("threadId", { length: 36 }).notNull(),
    // 工具名（如 writeFile / runCommand / reportReady）
    toolName: varchar("toolName", { length: 64 }).notNull(),
    // 执行状态
    status: mysqlEnum("status", TOOL_RUN_STATUSES).notNull().default("running"),
    // 工具输入
    input: json("input").notNull(),
    // 工具输出（成功时填充）
    output: json("output"),
    // 错误文本（失败时填充）
    error: text("error"),
    // 开始时间
    startedAt: datetime("startedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    // 结束时间
    finishedAt: datetime("finishedAt", { mode: "date" }),
    // 归属 ThreadRun（nullable（历史记录可空））。
    runId: varchar("runId", { length: 36 }),
  },
  (t) => ({
    // 高频查询维度（.1）：某 thread 的工具执行、按状态/时间筛失败
    threadStartedIdx: index("ToolRun_threadId_startedAt_idx").on(t.threadId, t.startedAt),
    threadToolIdx: index("ToolRun_threadId_toolName_idx").on(t.threadId, t.toolName),
    statusStartedIdx: index("ToolRun_status_startedAt_idx").on(t.status, t.startedAt),
    // P2-4: getRunDetail 按 runId 查 ToolRun
    runIdIdx: index("ToolRun_runId_idx").on(t.runId),
  }),
);
export type ToolRun = InferSelectModel<typeof toolRun>;

// ─── RBAC (: role → permission, user → role) ────────

/**
 * 内置角色 key（seed 灌 admin / member）。isSystem=true 的角色不可删除（保留扩展位）。
 * 权限是**固定常量集合**（见 lib/rbac.ts PERMISSIONS），不建动态权限表——避免过早抽象。
 */

// ─── Policy Config (: policy DB 化) ────────────────

/**
 * Policy 配置 KV 表（单行配置，按 key 存 JSON value）。
 *
 * P4-1 policy 原是 `lib/policy/config.ts` 的内存态（含函数成员 detect），无法多实例一致与
 * 后台展示。DB 化为纯数据（正则源 string + testFilePattern string），由 `lib/policy/interpreter.ts`
 * 编译为运行时 PolicyConfig（含 RegExp / detect 闭包）。
 *
 * 键集合：protectedPaths / commandDenyList / formatOnWrite / verifyBeforeDelivery。
 * value 形状见 `defaultPolicyConfig`（lib/policy/config.ts）+ testFilePattern（替代 detect）。
 */
export const policyConfig = mysqlTable("PolicyConfig", {
  key: varchar("key", { length: 64 }).primaryKey().notNull(),
  value: json("value").notNull(),
  updatedAt: datetime("updatedAt", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type PolicyConfigRow = InferSelectModel<typeof policyConfig>;

/**
 * Policy 配置变更历史表（版本管理 + before/after 快照）。
 *
 * 每次 PUT /studio/api/policies 写入一行：beforeSnapshot（变更前全量 JSON）、
 * afterSnapshot（变更后全量 JSON）、changedKeys（差异 key 列表）、changedBy/changedAt。
 * 供回滚与审计追溯，不替换 AdminAuditLog（审计仍记 metadata）。
 */
export const policyConfigHistory = mysqlTable("PolicyConfigHistory", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  changedBy: varchar("changed_by", { length: 36 }).notNull(),
  beforeSnapshot: text("before_snapshot").notNull(),
  afterSnapshot: text("after_snapshot").notNull(),
  changedKeys: text("changed_keys"),
  changedAt: datetime("changed_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type PolicyConfigHistoryRow = InferSelectModel<typeof policyConfigHistory>;

// ─── Admin Audit Log (切片 C: 后台敏感写操作审计) ────

/**
 * 后台敏感写操作审计事实流（append-only）。
 *
 * 记录 Settings 用户角色覆盖、policy 整配置覆盖、skill publish/rollback、
 * workspace 写/delete 的成功与业务失败（不记 401/403）。
 *
 * 设计选择（§2）：
 * - `action` 用固定字符串常量，但 DB 层用 varchar，避免每次新增动作都需要 enum migration。
 * - `outcome` 用 enum，只有 succeeded / failed。
 * - `metadata` 只放可追踪摘要（key 名、字节数、reasonCode），**绝不**放 secret/token、
 * 文件内容、完整 policy command 明文、完整命令输出。调用方经 `sanitizeAuditMetadata`
 * 脱敏后再传入；本表不做二次脱敏。
 * - 审计 append-only：应用层不提供 update/delete API（§约束 7）。
 */
export const ADMIN_AUDIT_ACTIONS = [
  "settings.user_roles.updated",
  "policies.updated",
  "skills.published",
  "skills.rolled_back",
  "skills.created",
  "skills.updated",
  "skills.deleted",
  "skills.matched",
  // 02 文档 capability-market 同步审计
  "skills.synced",
  "skills.unsynced",
  "workspace.file.written",
  "workspace.file.deleted",
  // 高危工具执行审计；权限规则变更审计
  "tool.high_risk.executed",
  "permission_rule.created",
  "permission_rule.updated",
  "permission_rule.deleted",
  // admin 彻底删除 thread(物理删主记录 + 子表)
  "thread.purged",
  // :审批决议独立 action(原复用 tool.high_risk.executed/policies.updated 语义错乱)
  "approval.resolved",
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

export const ADMIN_AUDIT_OUTCOMES = ["succeeded", "failed"] as const;

export type AdminAuditOutcome = (typeof ADMIN_AUDIT_OUTCOMES)[number];

export const adminAuditLog = mysqlTable(
  "AdminAuditLog",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // 操作者用户 id（发起写操作的 actor）
    actorUserId: varchar("actorUserId", { length: 36 })
      .notNull()
      .references(() => user.id),
    // 动作常量（见 ADMIN_AUDIT_ACTIONS）；varchar 便于扩展，不锁 enum
    action: varchar("action", { length: 64 }).notNull(),
    // 目标资源类型（user / policy / skill / workspace）
    targetType: varchar("targetType", { length: 32 }).notNull(),
    // 目标资源 id（用户 id / 'policy' / skill id / threadId:path）
    targetId: varchar("targetId", { length: 128 }).notNull(),
    outcome: mysqlEnum("outcome", ADMIN_AUDIT_OUTCOMES).notNull(),
    // 脱敏后的摘要（不含 secret/文件内容/完整命令）
    metadata: json("metadata").notNull(),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    createdIdx: index("AdminAuditLog_createdAt_idx").on(t.createdAt),
    actorCreatedIdx: index("AdminAuditLog_actorUserId_createdAt_idx").on(
      t.actorUserId,
      t.createdAt,
    ),
    targetCreatedIdx: index("AdminAuditLog_target_createdAt_idx").on(
      t.targetType,
      t.targetId,
      t.createdAt,
    ),
  }),
);
export type AdminAuditLog = InferSelectModel<typeof adminAuditLog>;

// ─── Agent Kernel: Context Snapshot / Plan / Todo ─────────
//
// 只铺数据地基与只读观测，不接入 agent 自动决策（）。
// - ContextSnapshot：每次模型调用前的上下文来源清单，只记来源与摘要，
// 不落完整 prompt / 用户消息正文 / 完整工具输出（隐私约束）。
// - ThreadPlan / ThreadPlanItem：thread 级计划容器与条目，不要求 agent 自动生成，
// 仅供 API/UI 只读展示与后续 todoWrite / subagent 复用。

/** ThreadPlan 状态。active=进行中，completed=已完成，abandoned=放弃。 */
export const THREAD_PLAN_STATUSES = ["active", "completed", "abandoned"] as const;
export type ThreadPlanStatus = (typeof THREAD_PLAN_STATUSES)[number];

/** ThreadPlan 来源。agent/user/system。暂不由 agent 自动写入。 */
export const THREAD_PLAN_SOURCES = ["agent", "user", "system"] as const;
export type ThreadPlanSource = (typeof THREAD_PLAN_SOURCES)[number];

/** ThreadPlanItem 状态。 */
export const THREAD_PLAN_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ThreadPlanItemStatus = (typeof THREAD_PLAN_ITEM_STATUSES)[number];

/**
 * Context Manifest 快照（）。
 *
 * 一行 = 一次模型调用前构建的上下文来源清单。layers/protectedRefs/excludedCandidates/
 * checksums 均为 JSON；inline 字段只允许摘要与计数，调用方负责不塞完整 prompt/消息/输出。
 */
export const contextSnapshot = mysqlTable(
  "ContextSnapshot",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    threadId: varchar("threadId", { length: 36 }).notNull(),
    // 触发场景，如 chat.user_message
    trigger: varchar("trigger", { length: 64 }).notNull(),
    // 本轮模型 id
    model: varchar("model", { length: 128 }).notNull(),
    // host / container
    runtimeType: varchar("runtimeType", { length: 32 }),
    // 当前冻结 skill 版本（无 skill 时 null）
    activeSkillVersionId: varchar("activeSkillVersionId", { length: 36 }),
    // 本轮模型可见工具名
    toolNames: json("toolNames").notNull(),
    // context layer entries（来源清单）
    layers: json("layers").notNull(),
    // 不可压缩来源引用
    protectedRefs: json("protectedRefs").notNull(),
    // 被预算排除的候选（可为空数组）
    excludedCandidates: json("excludedCandidates").notNull(),
    // 稳定层 checksum
    checksums: json("checksums").notNull(),
    // 粗略 token 估算（layers 之和；有 packageManifest 时为真实 afterTokens）
    estimatedTokens: int("estimatedTokens").notNull(),
    // 本轮是否压缩装配（与真实模型输入一致，非静态推断）
    compressed: boolean("compressed").notNull().default(false),
    // 本轮装配后真实模型输入 token（压缩后 ≠ estimatedTokens；nullable（旧快照可空））
    afterTokens: int("afterTokens"),
    // V8 Skill Run Resolver：本轮 Resolver 输入摘要（availableSkillCount / uiSelectedSkillIds）。
    // 不含完整 SKILL.md（懒加载约束）。nullable（历史快照可空）。
    skillResolverInput: json("skillResolverInput"),
    // V8：本轮 Resolver 输出（selectedSkillVersions 摘要 / decisionReason / ignoredUiSelectedSkillIds）。
    skillResolverOutput: json("skillResolverOutput"),
    // V8：readSkillFile 加载证据（文件路径 / contentHash / 是否截断 / skillVersionId）。
    // 运行结束 flush 写入；null = 未使用 Skill 或运行未结束。
    skillLoadEvidence: json("skillLoadEvidence"),
    // 归属 ThreadRun（nullable（历史快照可空））。
    runId: varchar("runId", { length: 36 }),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    threadCreatedIdx: index("ContextSnapshot_threadId_createdAt_idx").on(t.threadId, t.createdAt),
    threadIdIdx: index("ContextSnapshot_threadId_id_idx").on(t.threadId, t.id),
    // P2-4: getRunDetail 按 runId 查 ContextSnapshot
    runIdIdx: index("ContextSnapshot_runId_idx").on(t.runId),
  }),
);
export type ContextSnapshot = InferSelectModel<typeof contextSnapshot>;

// ─── a: Context Summary（压缩派生视图）──────────────────
//
// 一次压缩产生的结构化摘要；一行 = 一个被摘要的消息区段或工具证据区段。
// 原始 Message 不删，压缩只改变 streamText 的 messages 输入（派生视图，可回放可审计）。
// 摘要只做确定性结构化提取，不调 LLM（§1 决策）。
// supersededById 自引用链：区段扩展被重新摘要时，旧 summary 指向新 summary，
// 查询只取未 supersede 的。

/** 摘要类型。subagent 为前置空 slot，填充。 */
export const CONTEXT_SUMMARY_TYPES = [
  "turn",
  "toolRun",
  "diff",
  "debug",
  "decision",
  "subagent",
] as const;
export type ContextSummaryType = (typeof CONTEXT_SUMMARY_TYPES)[number];

export const contextSummary = mysqlTable(
  "ContextSummary",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    threadId: varchar("threadId", { length: 36 }).notNull(),
    // turn/toolRun/diff/debug/decision/subagent
    type: varchar("type", { length: 32 }).notNull(),
    // 被摘要的范围：{ messageIds?: string[], toolRunIds?: string[], range?: { from, to } }
    scope: json("scope").notNull(),
    // 确定性结构化摘要正文
    summaryText: text("summaryText").notNull(),
    // scope 内容的稳定 hash，复用判定（命中则不重算）
    checksum: varchar("checksum", { length: 64 }).notNull(),
    // 摘要本身估算 token
    tokenEstimate: int("tokenEstimate").notNull(),
    // 原始区段估算 token（压缩率审计）
    originalTokenEstimate: int("originalTokenEstimate").notNull(),
    // 本摘要保留的 protected 引用（若涉及）
    protectedRefs: json("protectedRefs").notNull(),
    // 被更新版 supersede 时的指向；null = 当前活跃
    supersededById: varchar("supersededById", { length: 36 }),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    threadTypeIdx: index("ContextSummary_threadId_type_idx").on(t.threadId, t.type),
    threadChecksumIdx: index("ContextSummary_threadId_checksum_idx").on(t.threadId, t.checksum),
    threadSupersededIdx: index("ContextSummary_threadId_supersededById_idx").on(
      t.threadId,
      t.supersededById,
    ),
  }),
);
export type ContextSummary = InferSelectModel<typeof contextSummary>;

/**
 * Thread 计划容器（）。一个 thread 可有多个 plan，但同时只有一个 active。
 */
export const threadPlan = mysqlTable(
  "ThreadPlan",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    threadId: varchar("threadId", { length: 36 }).notNull(),
    title: varchar("title", { length: 256 }).notNull(),
    status: mysqlEnum("status", THREAD_PLAN_STATUSES).notNull().default("active"),
    source: varchar("source", { length: 32 }).notNull().default("system"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    threadStatusIdx: index("ThreadPlan_threadId_status_idx").on(t.threadId, t.status),
  }),
);
export type ThreadPlan = InferSelectModel<typeof threadPlan>;

/**
 * Plan/Todo 条目（）。parentId 预留轻量层级；position 排序；
 * evidence 存测试/toolRun/artifact 引用，可为空。
 */
export const threadPlanItem = mysqlTable(
  "ThreadPlanItem",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    planId: varchar("planId", { length: 36 })
      .notNull()
      .references(() => threadPlan.id),
    // 冗余 threadId，便于 owner scope 查询
    threadId: varchar("threadId", { length: 36 }).notNull(),
    parentId: varchar("parentId", { length: 36 }),
    position: int("position").notNull().default(0),
    title: varchar("title", { length: 512 }).notNull(),
    status: mysqlEnum("status", THREAD_PLAN_ITEM_STATUSES).notNull().default("pending"),
    evidence: json("evidence"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    threadPositionIdx: index("ThreadPlanItem_threadId_position_idx").on(t.threadId, t.position),
    planPositionIdx: index("ThreadPlanItem_planId_position_idx").on(t.planId, t.position),
  }),
);
export type ThreadPlanItem = InferSelectModel<typeof threadPlanItem>;

// ─── : Tool Permission Rule / Approval Request ───────────
//
// 把 deny-only 的 beforeTool 升级为 allow/deny/ask 三态权限引擎（蓝图 / §12 ）。
// - ToolPermissionRule：持久化规则。默认规则从 PolicyConfig 派生（protectedPaths/commandDenyList
// → deny；deleteFile/applyPatch/multiEditFile → ask），DB 行作覆盖。不做完整 UI 编辑（留后续）。
// - ToolApprovalRequest：一次 ask 暂停产生的待审批记录。批准复用语义由
// status=approved + approvedScope + argFingerprint 表达，不单建 ToolApproval 表（）。

/** 权限规则决策三态。 */
export const PERMISSION_DECISIONS = ["allow", "deny", "ask"] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

/** 权限规则 scope。global 为全局；tenant/project/thread/skill 绑 scopeRef。 */
export const PERMISSION_SCOPES = ["global", "tenant", "project", "thread", "skill"] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/**
 * 持久化的工具权限规则。匹配顺序：priority 降序；同优先级 deny > ask > allow。
 * argMatcher 形状：{ pathRegex?, commandRegex?, risk? }，null 表示无 arg 约束。
 */
export const toolPermissionRule = mysqlTable(
  "ToolPermissionRule",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    scope: mysqlEnum("scope", PERMISSION_SCOPES).notNull().default("global"),
    // scope 绑定对象 id（threadId/projectId 等）；global 为 null
    scopeRef: varchar("scopeRef", { length: 36 }),
    // toolPattern: "tool.writeFile" / "tool.*" / "*" 等
    toolPattern: varchar("toolPattern", { length: 128 }).notNull(),
    // { pathRegex?, commandRegex?, risk? }；null 表示无 arg 约束
    argMatcher: json("argMatcher"),
    decision: mysqlEnum("decision", PERMISSION_DECISIONS).notNull(),
    reason: varchar("reason", { length: 256 }),
    // 越大越优先；同优先级 deny > ask > allow
    priority: int("priority").notNull().default(0),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    scopeScopeRefIdx: index("ToolPermissionRule_scope_scopeRef_idx").on(t.scope, t.scopeRef),
    toolPatternIdx: index("ToolPermissionRule_toolPattern_idx").on(t.toolPattern),
  }),
);
export type ToolPermissionRule = InferSelectModel<typeof toolPermissionRule>;

/** 审批请求状态。pending=待审批；approved/denied=已决议；expired/superseded=失效。 */
export const APPROVAL_REQUEST_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "superseded",
] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

/** 批准复用 scope。once=仅本次 toolRun；thread/project/always=按维度复用。 */
export const APPROVAL_SCOPES = ["once", "thread", "project", "always", "session"] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/**
 * 一次 ask 暂停产生的待审批记录。argFingerprint 为稳定 hash（不存原始 input）；
 * argSummary 为人可读摘要（path / command 首 token）。
 */
export const toolApprovalRequest = mysqlTable(
  "ToolApprovalRequest",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    threadId: varchar("threadId", { length: 36 }).notNull(),
    toolRunId: varchar("toolRunId", { length: 36 })
      .notNull()
      .references(() => toolRun.id),
    toolName: varchar("toolName", { length: 64 }).notNull(),
    permissionKey: varchar("permissionKey", { length: 128 }).notNull(),
    argFingerprint: varchar("argFingerprint", { length: 128 }).notNull(),
    argSummary: varchar("argSummary", { length: 512 }).notNull(),
    status: mysqlEnum("status", APPROVAL_REQUEST_STATUSES).notNull().default("pending"),
    approvedScope: mysqlEnum("approvedScope", APPROVAL_SCOPES),
    // project scope 审批跨 thread 复用——记录审批时的 projectId
    projectId: varchar("projectId", { length: 36 }),
    resolvedBy: varchar("resolvedBy", { length: 36 }).references(() => user.id),
    resolvedAt: datetime("resolvedAt", { mode: "date" }),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    // 默认 24h 过期（由应用层写入时设置）
    expiresAt: datetime("expiresAt", { mode: "date" }),
  },
  (t) => ({
    threadStatusIdx: index("ToolApprovalRequest_threadId_status_idx").on(t.threadId, t.status),
    statusIdx: index("ToolApprovalRequest_status_idx").on(t.status),
    // project scope 跨 thread 查询索引
    scopeProjectIdx: index("ToolApprovalRequest_scope_projectId_idx").on(
      t.approvedScope,
      t.projectId,
    ),
  }),
);
export type ToolApprovalRequest = InferSelectModel<typeof toolApprovalRequest>;

// ─── : Git Checkpoint ───────────────────────────────────
//
// 一次风险前快照，关联 git tag 与 thread，供 rollback 与审计。
// tag 名 `snow-checkpoint-{shortId}`（轻量 tag），commitSha 为快照指向的 HEAD。
// restoredAt 在被 restore 时回填（一个 checkpoint 可被多次 restore，仅记最后一次）。
// 不加 DB 级 FK 到 ToolRun（createdByToolRunId 可空，保持逻辑外键）。

export const gitCheckpoint = mysqlTable(
  "GitCheckpoint",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    threadId: varchar("threadId", { length: 36 }).notNull(),
    // snow-checkpoint-{shortId}，git tag 名
    tag: varchar("tag", { length: 128 }).notNull(),
    // 快照指向的 commit sha
    commitSha: varchar("commitSha", { length: 64 }).notNull(),
    // 创建原因（如 before gitPush）
    reason: varchar("reason", { length: 256 }).notNull(),
    // 触发它的 ToolRun（可空）
    createdByToolRunId: varchar("createdByToolRunId", { length: 36 }),
    // 被 restore 的时间（若曾回滚）
    restoredAt: datetime("restoredAt", { mode: "date" }),
    // 变更文件列表（git diff --stat 摘要），供回滚前快速判断 checkpoint 内容
    filesChanged: text("filesChanged"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    threadCreatedIdx: index("GitCheckpoint_threadId_createdAt_idx").on(t.threadId, t.createdAt),
    threadTagIdx: index("GitCheckpoint_threadId_tag_idx").on(t.threadId, t.tag),
  }),
);

export type GitCheckpoint = InferSelectModel<typeof gitCheckpoint>;

// ─── : MCP Server Registry / Custom Tools ───────────────
//
// 外部能力接入（蓝图 ）。MCP server 与自定义工具都是「外部不可信能力」，
// 须经声明 + 权限（默认 ask）才能调用，与内置工具分离。
// - McpServerConfig：一个已注册 MCP server 配置（stdio/http/sse）。env 含 secret，存储/返回脱敏，
// 调用时注入真实 env，不写日志/事件。工具名归一 mcp.<server>.<tool> 作为 permissionKey。
// - CustomTool：用户/平台声明的自定义工具。executor 分 webhook（走域名 allowlist 防 SSRF）
// 与 script（只跑平台预置白名单脚本，绝不执行用户提供的任意代码）。permissionKey = custom.<name>。
// 两表均单租户信任环境（与 deliverToGit 一致），多租户留后续。

/** MCP server 传输类型。 */
export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const mcpServerConfig = mysqlTable(
  "McpServerConfig",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // server 名（permissionKey mcp.<name>.<tool> 的 <name>）；唯一
    name: varchar("name", { length: 64 }).notNull(),
    // stdio/http/sse
    transport: varchar("transport", { length: 16 }).notNull(),
    // stdio 命令（transport=stdio 时必填）
    command: varchar("command", { length: 512 }),
    // stdio 参数数组
    args: json("args"),
    // http/sse URL（transport=http/sse 时必填）
    url: varchar("url", { length: 512 }),
    // 环境变量（含 secret，存储脱敏；调用时注入真实 env）
    env: json("env"),
    // 允许的工具名白名单（null=全部）
    allowedTools: json("allowedTools"),
    enabled: boolean("enabled").notNull().default(true),
    // 连接时协商到的 server 版本/能力（best-effort 回写，审计兼容性）
    lastServerVersion: varchar("lastServerVersion", { length: 128 }),
    lastCapabilities: json("lastCapabilities"),
    lastConnectedAt: datetime("lastConnectedAt", { mode: "date" }),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    nameUq: uniqueIndex("McpServerConfig_name_uq").on(t.name),
    enabledIdx: index("McpServerConfig_enabled_idx").on(t.enabled),
  }),
);
export type McpServerConfig = InferSelectModel<typeof mcpServerConfig>;

/** 自定义工具 executor 类型。 */
export const CUSTOM_TOOL_EXECUTOR_TYPES = ["webhook", "script"] as const;
export type CustomToolExecutorType = (typeof CUSTOM_TOOL_EXECUTOR_TYPES)[number];

export const customTool = mysqlTable(
  "CustomTool",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // 工具名（permissionKey custom.<name>）；唯一
    name: varchar("name", { length: 64 }).notNull(),
    description: varchar("description", { length: 1024 }).notNull(),
    // JSON Schema（工具入参）
    inputSchema: json("inputSchema").notNull(),
    // webhook/script
    executorType: varchar("executorType", { length: 16 }).notNull(),
    // webhook: { url, method, headers? }; script: { scriptId }（预定义白名单）
    executorConfig: json("executorConfig").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    nameUq: uniqueIndex("CustomTool_name_uq").on(t.name),
    enabledIdx: index("CustomTool_enabled_idx").on(t.enabled),
  }),
);
export type CustomTool = InferSelectModel<typeof customTool>;

// ─── : Secret Mount（加密存储的 secret 挂载）──────────────
//
// 生产级 secret at rest 保护（plan §1/）：
// - 不存明文：ciphertext 是 AES-256-GCM 加密后的值（含 IV + tag）
// - 按 thread/skill/tool scope 注入 env，全链路脱敏
// - 生命周期：create / rotate（轮换值，旧值清除）/ revoke（撤销，停止注入）

export const SECRET_MOUNT_SCOPES = ["thread", "project", "skill", "tool"] as const;
export type SecretMountScope = (typeof SECRET_MOUNT_SCOPES)[number];

export const SECRET_MOUNT_STATUSES = ["active", "revoked"] as const;
export type SecretMountStatus = (typeof SECRET_MOUNT_STATUSES)[number];

export const secretMount = mysqlTable(
  "SecretMount",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // env 变量名（如 API_KEY）
    name: varchar("name", { length: 64 }).notNull(),
    // thread/project/skill/tool
    scope: mysqlEnum("scope", SECRET_MOUNT_SCOPES).notNull(),
    // scope 绑定 id（threadId/projectId/skillId/toolName）；thread scope 必填
    scopeRef: varchar("scopeRef", { length: 36 }),
    // 加密用 master key id（支持后续 key 轮换识别需 re-encrypt 的密文）
    keyId: varchar("keyId", { length: 64 }).notNull(),
    // AES-256-GCM 密文（base64(iv[12] || ciphertext || tag[16])）
    ciphertext: text("ciphertext").notNull(),
    status: mysqlEnum("status", SECRET_MOUNT_STATUSES).notNull().default("active"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    // 最近轮换时间（null=未轮换过）
    rotatedAt: datetime("rotatedAt", { mode: "date" }),
  },
  (t) => ({
    scopeScopeRefStatusIdx: index("SecretMount_scope_scopeRef_status_idx").on(
      t.scope,
      t.scopeRef,
      t.status,
    ),
    nameScopeIdx: index("SecretMount_name_scope_idx").on(t.name, t.scope),
  }),
);
export type SecretMount = InferSelectModel<typeof secretMount>;

// ─── : Deployment（部署审计记录）──────────────────────────

export const DEPLOYMENT_STATUSES = [
  "pending",
  "deploying",
  "deployed",
  "failed",
  "rolled_back",
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const deployment = mysqlTable(
  "Deployment",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    threadId: varchar("threadId", { length: 36 }).notNull(),
    // 目标环境（如 staging/prod）
    environment: varchar("environment", { length: 64 }).notNull(),
    // 来源 commit（finalizeThreadRun）
    commitSha: varchar("commitSha", { length: 64 }),
    // 部署的 image tag（若 CI/CD 用）
    imageTag: varchar("imageTag", { length: 256 }),
    // 交付 artifact 引用
    artifactRef: varchar("artifactRef", { length: 512 }),
    // CI/CD 返回的 job id
    cicdJobId: varchar("cicdJobId", { length: 128 }),
    // CI/CD job 日志链接
    cicdJobUrl: varchar("cicdJobUrl", { length: 512 }),
    status: mysqlEnum("status", DEPLOYMENT_STATUSES).notNull().default("pending"),
    // 回滚时的上一版部署 id
    previousDeploymentId: varchar("previousDeploymentId", { length: 36 }),
    deployedAt: datetime("deployedAt", { mode: "date" }),
    rolledBackAt: datetime("rolledBackAt", { mode: "date" }),
    // 失败原因（不含 secret）
    errorMessage: text("errorMessage"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    threadStatusIdx: index("Deployment_threadId_status_idx").on(t.threadId, t.status),
    threadCreatedIdx: index("Deployment_threadId_createdAt_idx").on(t.threadId, t.createdAt),
    environmentIdx: index("Deployment_environment_idx").on(t.environment),
  }),
);
export type Deployment = InferSelectModel<typeof deployment>;

// ─── V6-M1-3: Audit Failure Log（审计失败重试队列）──────────────

/**
 * 审计写入失败记录表（V6-M1-3 G3）。
 *
 * 高危工具审计写入失败时，不再 console.warn 丢弃，而是落库到本表，
 * 供后续重试/告警/人工介入。fail-closed 语义：审计丢失有补救。
 */
export const auditFailureLog = mysqlTable(
  "AuditFailureLog",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    threadId: varchar("threadId", { length: 36 }).notNull(),
    toolName: varchar("toolName", { length: 128 }).notNull(),
    runId: varchar("runId", { length: 36 }),
    errorMessage: text("errorMessage").notNull(),
    // 原始审计 payload（JSON 序列化）
    payload: text("payload"),
    // P2-10: 重试次数,超限(10)移死信(删除),防毒丸永久重试
    retryCount: int("retryCount").notNull().default(0),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    threadCreatedIdx: index("AuditFailureLog_threadId_createdAt_idx").on(t.threadId, t.createdAt),
  }),
);
export type AuditFailureLog = InferSelectModel<typeof auditFailureLog>;

// ：V9 内置浏览器表（UserBrowserProfile / BrowserSession /
// BrowserDownload）已移除。原表由破坏性 migration 0059 删除。
// Desktop 浏览器的 Profile / Session / Download 由 Desktop 本地 SQLite
// 管理（Phase 3+），不经 Server MySQL。

// ─── Schema（阶段 2 起拆入身份、授权、幂等、审计表组）─────────
export * from "@/lib/persistence/schema/identity";
export * from "@/lib/runtime/persistence/runtime-conformance-run-record";
export * from "@/lib/persistence/schema/device";
export * from "@/lib/persistence/schema/authorization";
export * from "@/lib/persistence/schema/idempotency";
export * from "@/lib/persistence/schema/audit";
export * from "@/lib/persistence/schema/agent";
export * from "@/lib/persistence/schema/runtime";
export * from "@/lib/persistence/schema/artifact";
export * from "@/lib/persistence/schema/deployment-route";
export * from "@/lib/persistence/schema/conversation";
export * from "@/lib/persistence/schema/projection";
export * from "@/lib/persistence/schema/skill";
export * from "@/lib/persistence/schema/tool";
export * from "@/lib/persistence/schema/catalog";
export * from "@/lib/persistence/schema/capability-use";
export * from "@/lib/persistence/schema/tool-call";
export * from "@/lib/persistence/schema/workspace";
export * from "@/lib/persistence/schema/workspace-lock";
