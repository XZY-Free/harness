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
  // 长期记忆生命周期（只追加）
  "memory.created",
  "memory.revoked",
  // embedding 索引重建（payload 含 memoryId/provider/model/status/dimension?/errorCode?）。
  // 纯应用层 const 追加——事件 type 在 DB 是 varchar（非 enum 约束），故零 migration SQL。
  "memory.reindexed",
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
  // subagent.spawned：spawnSubagent 创建一个 SubagentRun（payload 含 runId/role/goal 摘要/writeScope?）
  // subagent.joined：joinSubagent 收集到结构化结果（payload 含 runId/status/resultSummary 摘要/outputArtifactId?）
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

// ─── Skill Registry (Phase 3) ───────────────────────────────

/** skill 稳定身份状态。archived 表示下线但保留历史版本。 */
export const SKILL_STATUSES = ["active", "archived"] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/** skill 版本状态。draft=编辑中(不参与解析)、active=可被 thread 选用、archived=归档。 */
export const SKILL_VERSION_STATUSES = ["draft", "active", "archived"] as const;
export type SkillVersionStatus = (typeof SKILL_VERSION_STATUSES)[number];

/** skill 可见性(蓝图 )。仅存储,不做权限门禁。 */
export const SKILL_VISIBILITIES = ["public", "internal"] as const;
export type SkillVisibility = (typeof SKILL_VISIBILITIES)[number];

/** skill 审核模式(蓝图 )。仅存储,审核行为留 Phase 4。 */
export const SKILL_REVIEW_MODES = ["auto", "manual"] as const;
export type SkillReviewMode = (typeof SKILL_REVIEW_MODES)[number];

/**
 * skill 来源（02 文档 ）。
 * - local：SnowHarness 本地自建,可在 Studio 编辑/发布/回滚/归档。
 * - capability-market：从 capability-market 同步而来的镜像,运行时与 local 无差异,
 * 但在 Studio 只读,只能重新同步或取消同步。
 */
export const SKILL_SOURCES = ["local", "capability-market"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

/**
 * 同步映射状态（02 文档 ）。
 * - active：已同步且可用,进入运行候选。
 * - blocked：远端访问规则禁止同步(block_sync)。
 * - hidden：远端 hide,不应展示。
 * - not_found：远端不存在或不可见。
 * - name_conflict：本地 name 冲突,未导入。
 * - error：同步失败,保留错误。
 * 非 active 状态的映射,其本地 skill 不进入运行候选。
 */
export const SKILL_SYNC_STATES = [
  "active",
  "blocked",
  "hidden",
  "not_found",
  "name_conflict",
  "error",
] as const;
export type SkillSyncState = (typeof SKILL_SYNC_STATES)[number];

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

export const thread = mysqlTable(
  "Thread",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    createdAt: datetime("createdAt", { mode: "date" }).notNull(),
    // B-8: 最后活动时间 —— 用于会话列表按"最近活动"排序（替代 createdAt），
    // 每次 status/model/title 变更或发消息时刷新。默认取 createdAt（回填语义）。
    // :fsp=3 毫秒精度,SSE since 游标 gt(updatedAt) 不再丢同秒事件。
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 }).notNull(),
    title: text("title").notNull(),
    userId: varchar("userId", { length: 36 })
      .notNull()
      .references(() => user.id),
    // Agent 执行生命周期状态
    status: mysqlEnum("status", THREAD_STATUSES).notNull().default("idle"),
    // 当前使用的模型 ID（可选，默认见 config.aiConfig.chatModel）
    model: varchar("model", { length: 64 }),
    // 预览 URL（后端自检后填入，前端按需展示）
    previewUrl: text("previewUrl"),
    // @deprecated V8 Skill Run Resolver：不再从 thread 解析 Skill。运行时改用 ThreadRunSkill（run 级）。
    // 列保留兼容旧数据，不在运行时读取；展示口径改用最近 run 的 primary skill（lastRunSkillId）。
    activeSkillId: varchar("activeSkillId", { length: 64 }),
    // @deprecated V8 Skill Run Resolver：同上。版本固化改由 ThreadRunSkill.skillVersionId 记录。
    activeSkillVersionId: varchar("activeSkillVersionId", { length: 36 }),
    // Phase 4: 人工审核状态
    reviewState: varchar("reviewState", { length: 32 }),
    // Phase 5: 运行时类型(host / container),null → 解析优先级回退(skill → 全局默认)
    runtimeType: varchar("runtimeType", { length: 16 }),
    // E-5: 置顶时间戳。非 null = 已置顶，列表排序时置顶组在最前。
    pinnedAt: datetime("pinnedAt", { mode: "date" }),
    // P0 修复（memory/permission project scope）：thread 所属 project。
    // null 表示未关联 project（默认）。关联后：
    // - chat route retrieveMemories 增加 project scope 检索（project 级记忆生效）
    // - permission engine project scope 规则按 projectId 匹配（跨 thread 复用审批）
    // - Studio memories 列表展示 project 维度
    projectId: varchar("projectId", { length: 36 }),
    // P0 修复（03 Context pinned facts 持久化）：用户明确要求保留的事实（protected 集合数据源）。
    // 原进程内 Map 重启即失。落 DB json 列持久化。null=无 pinned facts（默认）。
    // agent/用户经 addPinnedFact/removePinnedFact 修改,chat route 加载注入 protected。
    pinnedFacts: json("pinnedFacts"),
    // C-3: 软删除时间戳。非 null = 已软删，列表/查询过滤。替代原 status=cancelled 降级方案。
    deletedAt: datetime("deletedAt", { mode: "date" }),
    // C-8: 最近一条消息的预览文本（截断 60 字）。saveMessages 时冗余更新，列表免 join。
    lastMessagePreview: text("lastMessagePreview"),
    // E-6: 最近一条消息的 id。saveMessages 时冗余更新，用于消息级未读判定
    //（seen 记录最后已读 messageId，与之比较，替代粗糙时间戳比对）。
    lastMessageId: varchar("lastMessageId", { length: 36 }),
    // E-7: token 用量累加（run 级 onFinish 累加，跨 run 持续累计）。
    // onFinish 用 totalUsage（跨 step 累加，非最后一步 usage）。
    promptTokens: int("promptTokens").notNull().default(0),
    completionTokens: int("completionTokens").notNull().default(0),
    totalTokens: int("totalTokens").notNull().default(0),
    // per-thread CI/CD API token，AES-256-GCM 加密存储（JSON: keyId + ciphertext）。
    // 链路：deployToEnvironment 工具读取 → decryptCicdToken → triggerDeploy(threadCicdToken) → CI/CD webhook。
    cicdApiToken: text("cicdApiToken"),
  },
  (t) => ({
    userCreatedIdx: index("Thread_userId_createdAt_idx").on(t.userId, t.createdAt),
    // B-8: 列表按 updatedAt desc 排序的索引
    userUpdatedIdx: index("Thread_userId_updatedAt_idx").on(t.userId, t.updatedAt),
    // P0: project 维度查询索引（同 project 下的 thread 列表 / project scope 记忆检索）
    projectIdx: index("Thread_projectId_idx").on(t.projectId),
  }),
);
export type Thread = InferSelectModel<typeof thread>;

export const message = mysqlTable(
  "Message",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // 指向所属 Thread
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
    role: varchar("role", { length: 32 }).notNull(),
    // 消息分层 type（写入时按 role 填充，见 messageTypeForRole）
    type: varchar("type", { length: 32 }),
    // AI SDK 的 UIMessage.parts，整体以 json 存储
    parts: json("parts").notNull(),
    // B-3: 标记该消息属于哪次 run（thread-runner runId）。user 消息无 run（route 层写入）故可空。
    // 用于重试时按 runId 隔离清理旧 partial（per-step upsert 同 id 覆盖解决中断丢失，
    // 但换 runId 重试时旧 partial 残留需按 run 隔离）。
    runId: varchar("runId", { length: 36 }),
    createdAt: datetime("createdAt", { mode: "date" }).notNull(),
  },
  (t) => ({
    // P0 修复（08 DB ）：message 表加 threadId+createdAt 复合索引。
    // P2-6: 补 id 列,覆盖游标分页 (createdAt, id) tie-breaker,避免深度翻页回表。
    threadCreatedIdx: index("Message_threadId_createdAt_id_idx").on(t.threadId, t.createdAt, t.id),
  }),
);
export type DBMessage = InferSelectModel<typeof message>;

// ─── Thread Event (append-only 事实流) ──────────────────────

export const threadEvent = mysqlTable(
  "ThreadEvent",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // 所属 thread
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
    // thread 内单调递增序号（单 thread/低并发语境下用简单递增）
    sequence: int("sequence").notNull(),
    // 事件类型（.1 权威表取值）
    type: varchar("type", { length: 64 }).notNull(),
    // 事件负载（JSON，具体 shape 由 type 决定）
    payload: json("payload").notNull(),
    // 归属 ThreadRun（nullable（历史事件和纯 thread 管理事件可空））。
    runId: varchar("runId", { length: 36 }),
    // :fsp=3 毫秒精度,SSE since 游标 gt(createdAt) 不再丢同秒事件。
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // (threadId, sequence) 唯一：thread 内序号不重复（应用层简单递增 + DB 兜底，真并发冲突 fail-loud 而非静默错乱）
    threadSeqUq: uniqueIndex("ThreadEvent_threadId_sequence_uq").on(t.threadId, t.sequence),
    // 时间线查询
    threadCreatedIdx: index("ThreadEvent_threadId_createdAt_idx").on(t.threadId, t.createdAt),
    // P2-4: getRunDetail 按 runId 查事件,无索引则全表扫
    runIdIdx: index("ThreadEvent_runId_idx").on(t.runId),
  }),
);
export type ThreadEvent = InferSelectModel<typeof threadEvent>;

// ─── Tool Run (结构化工具执行记录) ──────────────────────────

export const toolRun = mysqlTable(
  "ToolRun",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // 所属 thread
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
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

// ─── Skill Registry (Phase 3: 注册式、可版本化的 agent 策略) ─

/**
 * skill 稳定身份(蓝图 §9 / §12)。
 *
 * 身份层只存稳定属性;可变内容(promptTemplate / allowedTools / …)下沉到
 * `skill_versions`,改 skill = 新增一个 version 并切换 `currentVersionId`,
 * 历史 version 不可变()。
 *
 * `currentVersionId` 逻辑上指向 `skill_versions.id`,但与 skill_versions.skillId
 * 形成环引用,MySQL 迁移建 FK 顺序麻烦且无收益,故仅作逻辑外键(应用层维护一致性),
 * 不加 DB 级 FK 约束。
 */
export const skill = mysqlTable(
  "Skill",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // 唯一标识名,如 build-from-idea / refactor-ui
    name: varchar("name", { length: 64 }).notNull(),
    description: text("description"),
    // 如 fullstack / refactor / debug
    category: varchar("category", { length: 64 }),
    // public / internal(仅存储)
    visibility: varchar("visibility", { length: 32 }).notNull().default("public"),
    status: mysqlEnum("status", SKILL_STATUSES).notNull().default("active"),
    // 当前生效版本(逻辑外键 → skill_versions.id;可空,建版本后回填)
    currentVersionId: varchar("currentVersionId", { length: 36 }),
    // skill 所有者（创建者 userId），用于权限隔离（owner 可写自己的 skill）
    ownerUserId: varchar("ownerUserId", { length: 36 }),
    // 02 文档 skill 来源。local=本地自建(可编辑)，capability-market=同步镜像(只读)。
    source: mysqlEnum("source", SKILL_SOURCES).notNull().default("local"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    // 软删除（原物理删除不可恢复）
    deletedAt: datetime("deletedAt", { mode: "date" }),
  },
  (t) => ({
    nameUq: uniqueIndex("Skill_name_uq").on(t.name),
  }),
);
export type Skill = InferSelectModel<typeof skill>;

/**
 * skill 版本化内容(不可变)。
 *
 * 一行一旦创建即只读;thread 在首次执行时把所用 version 固化到
 * `thread.activeSkillVersionId`,保证历史可解释、不会因 skill 升级中途换策略(§10)。
 *
 * 字段消费边界():
 * - promptTemplate / defaultModelProfile:真实生效
 * - allowedTools:@deprecated V8 不再作为工具可见性边界，仅兼容旧数据读取
 * - requiredCapabilities:V8 能力声明，只用于 Resolver 判断和 Studio 提示
 * - completionCriteria:作为提示注入 prompt 尾部(软约束),不做硬门禁
 * - reviewMode / artifactPolicy:仅存储,行为留 Phase 4
 */
export const skillVersion = mysqlTable(
  "SkillVersion",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // 所属 skill
    skillId: varchar("skillId", { length: 36 })
      .notNull()
      .references(() => skill.id),
    // skill 内单调递增(1,2,3…)
    version: int("version").notNull(),
    // agent system prompt（保留；目录形态下新版本不再写入，留空。
    // 下一个 migration 删除本字段，内容由 skills/<name>/SKILL.md 承载）
    promptTemplate: text("promptTemplate"),
    // 该版本对应的 skills/ git repo commit sha（目录形态版本快照引用）。
    // 迁移期旧版本可能为空（仅有 promptTemplate）；新版本必填。
    commitSha: varchar("commitSha", { length: 40 }),
    // @deprecated V8 Skill Run Resolver：不再作为工具可见性边界（工具权限交给 permission policy）。
    // 保留字段仅兼容旧数据读取；chat 路径不再用于过滤 buildTools。下线清理见阶段 8。
    allowedTools: json("allowedTools"),
    // V8：能力声明（string[]），只用于 Resolver 判断和 Studio 提示，不限制工具可见性。
    // 与 allowedTools 语义不同：requiredCapabilities 是"声明需求"而非"白名单限制"。
    requiredCapabilities: json("requiredCapabilities"),
    // 默认模型 id / profile 名(可空,优先级低于请求/thread 已选 model)
    defaultModelProfile: varchar("defaultModelProfile", { length: 128 }),
    // 完成判定(软约束提示注入)
    completionCriteria: json("completionCriteria"),
    // auto / manual(仅存储,行为 Phase 4)
    reviewMode: varchar("reviewMode", { length: 32 }).notNull().default("auto"),
    // artifact 策略(仅存储,行为 Phase 4)
    artifactPolicy: json("artifactPolicy"),
    // Phase 5: skill 声明的运行时类型(host / container),null → 回退全局默认
    runtimeType: varchar("runtimeType", { length: 16 }),
    status: mysqlEnum("status", SKILL_VERSION_STATUSES).notNull().default("active"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // (skillId, version) 唯一:skill 内版本号不重复
    skillVersionUq: uniqueIndex("SkillVersion_skillId_version_uq").on(t.skillId, t.version),
    // 按 skill 取可用版本
    skillStatusIdx: index("SkillVersion_skillId_status_idx").on(t.skillId, t.status),
  }),
);
export type SkillVersion = InferSelectModel<typeof skillVersion>;

/**
 * capability-market 远端资产与本地 Skill 的同步映射（02 文档 ）。
 *
 * 连接远端 asset_id 与本地 Skill.id / SkillVersion.id。运行时只读本地 Skill,
 * 映射仅用于：判断同步 Skill 是否进入候选（syncState=active）、Studio 展示远端元数据、
 * 下次同步时按 remoteAssetId 找到本地 localName 复用（不视为 name 冲突）。
 *
 * 不用远端 asset_id 替代本地主键（02 文档 ）：本地主键已被 Studio / Resolver /
 * ThreadRunSkill / 历史快照读取共同使用。
 */
export const skillSyncMapping = mysqlTable(
  "SkillSyncMapping",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // 同步源，当前固定 capability-market；留字段便于后续多源
    source: varchar("source", { length: 32 }).notNull().default("capability-market"),
    // capability-market 的 asset_id
    remoteAssetId: varchar("remoteAssetId", { length: 128 }).notNull(),
    // 远端 Skill 原始 name
    remoteName: varchar("remoteName", { length: 64 }),
    remoteDisplayName: varchar("remoteDisplayName", { length: 128 }),
    // 远端解析后的版本号（resolved_version）
    remoteVersion: varchar("remoteVersion", { length: 64 }),
    // 远端版本 ID（resolved_version_id）
    remoteVersionId: varchar("remoteVersionId", { length: 128 }),
    // 远端内容 hash（resolved_content_hash）
    remoteContentHash: varchar("remoteContentHash", { length: 128 }),
    // 本地 Skill.id / SkillVersion.id / 本地目录名
    localSkillId: varchar("localSkillId", { length: 36 }).references(() => skill.id),
    localSkillVersionId: varchar("localSkillVersionId", { length: 36 }),
    localName: varchar("localName", { length: 64 }),
    // 当前同步状态（SKILL_SYNC_STATES）
    syncState: mysqlEnum("syncState", SKILL_SYNC_STATES).notNull().default("active"),
    lastSyncedAt: datetime("lastSyncedAt", { mode: "date" }),
    lastCheckedAt: datetime("lastCheckedAt", { mode: "date" }),
    lastError: text("lastError"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // 同一远端资产只能映射一次
    remoteAssetIdUq: uniqueIndex("SkillSyncMapping_remoteAssetId_uq").on(t.remoteAssetId),
    // 按本地 skill 反查映射
    localSkillIdx: index("SkillSyncMapping_localSkillId_idx").on(t.localSkillId),
    // 按同步状态过滤候选
    syncStateIdx: index("SkillSyncMapping_syncState_idx").on(t.syncState),
  }),
);
export type SkillSyncMapping = InferSelectModel<typeof skillSyncMapping>;

// ─── RBAC (: role → permission, user → role) ────────

/**
 * 内置角色 key（seed 灌 admin / member）。isSystem=true 的角色不可删除（保留扩展位）。
 * 权限是**固定常量集合**（见 lib/rbac.ts PERMISSIONS），不建动态权限表——避免过早抽象。
 */
export const ROLE_KEYS = ["admin", "member"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const role = mysqlTable(
  "Role",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // 稳定 key（admin / member），作查询与 seed 幂等键
    key: varchar("key", { length: 32 }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    // 系统内置角色（seed 灌入，不可删）
    isSystem: boolean("isSystem").notNull().default(false),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    keyUq: uniqueIndex("Role_key_uq").on(t.key),
  }),
);
export type Role = InferSelectModel<typeof role>;

export const rolePermission = mysqlTable(
  "RolePermission",
  {
    roleId: varchar("roleId", { length: 36 })
      .notNull()
      .references(() => role.id),
    // 权限名（取自 lib/rbac.ts PERMISSIONS 常量集合）
    permission: varchar("permission", { length: 64 }).notNull(),
  },
  (t) => ({
    rolePermUq: uniqueIndex("RolePermission_roleId_permission_uq").on(t.roleId, t.permission),
  }),
);
export type RolePermission = InferSelectModel<typeof rolePermission>;

export const userRole = mysqlTable(
  "UserRole",
  {
    userId: varchar("userId", { length: 36 })
      .notNull()
      .references(() => user.id),
    roleId: varchar("roleId", { length: 36 })
      .notNull()
      .references(() => role.id),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    userRoleUq: uniqueIndex("UserRole_userId_roleId_uq").on(t.userId, t.roleId),
  }),
);
export type UserRole = InferSelectModel<typeof userRole>;

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

// ─── Agent / Provider Profiles (: 只读档案,不接 runtime) ─

/**
 * agent 档案（蓝图 ）。
 *
 * B1 只做档案存储 + 只读展示，**不接入 lib/ai/ runtime 执行链**：
 * - model = chatModel id（来自 aiConfig.chatModel / fetchAvailableModels），仅记录，运行时仍走 env。
 * - skillId 逻辑外键 → skill.id（FK 约束；可空，表示未绑定 skill）。
 * - config 占位：subagent 模板 / 并行执行策略，**本切片不解析**，由应用插入时显式写 {}，
 * 不依赖 MySQL JSON default（/ 约束 6）。
 */
export const agent = mysqlTable("Agent", {
  id: varchar("id", { length: 36 })
    .primaryKey()
    .notNull()
    .$defaultFn(() => randomUUID()),
  name: varchar("name", { length: 64 }).notNull(),
  description: text("description"),
  // chatModel id（仅档案，不驱动 runtime）
  model: varchar("model", { length: 128 }).notNull(),
  // 绑定的 skill（可空）
  skillId: varchar("skillId", { length: 36 }).references(() => skill.id),
  // 占位 JSON：subagent 模板 / 并行策略；应用插入时显式写 {}
  config: json("config").notNull(),
  createdAt: datetime("createdAt", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: datetime("updatedAt", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  // 软删除
  deletedAt: datetime("deletedAt", { mode: "date" }),
});
export type Agent = InferSelectModel<typeof agent>;

/**
 * LLM 提供方档案（蓝图 §12 provider_profiles）。
 *
 * **不接 runtime**：runtime 仍走 env aiConfig；本表只镜像当前 env 配置供后台只读展示，
 * 不做运行时切换（/ 非目标）。apiKeyRef 存 env 引用名（如 "LLM_API_KEY"），
 * **不落明文 secret**（约束 6）。
 */
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
  // 12-P2-3：chat 示例文案管理审计
  "chat_examples.created",
  "chat_examples.updated",
  "chat_examples.deleted",
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

// ─── Agent / Provider Profiles (: 只读档案,不接 runtime) ─

export const providerProfile = mysqlTable("ProviderProfile", {
  id: varchar("id", { length: 36 })
    .primaryKey()
    .notNull()
    .$defaultFn(() => randomUUID()),
  name: varchar("name", { length: 64 }).notNull(),
  baseUrl: varchar("baseUrl", { length: 255 }).notNull(),
  // env var 引用名（如 LLM_API_KEY），不存明文
  apiKeyRef: varchar("apiKeyRef", { length: 128 }).notNull(),
  isDefault: boolean("isDefault").notNull().default(false),
  createdAt: datetime("createdAt", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: datetime("updatedAt", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type ProviderProfile = InferSelectModel<typeof providerProfile>;

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
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
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
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
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
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
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
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
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
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
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

// ─── : Background Task ──────────────────────────────────
//
// 命令治理：可恢复、可审计的后台长跑任务（蓝图 §12 ）。
// - DB 行作可审计/可列表/进程重启标记孤儿的真实来源；进程内 Map（lib/runtime/background-task-registry）
// 只缓存 pid/stop handle 供 stop 用，不持久化。
// - 日志不落 DB blob，落文件（logPath 相对路径）；按 runtimeType 分目录解析（host 平台目录 / container bind mount）。
// - 进程重启时 markOrphansOnStartup 把 starting/running 行诚实标 orphaned，不假装 reattach 死 pid。

/** 后台任务种类。 */
export const BACKGROUND_TASK_KINDS = [
  "dev-server",
  "build",
  "watcher",
  "worker",
  "custom",
] as const;
export type BackgroundTaskKind = (typeof BACKGROUND_TASK_KINDS)[number];

/** 后台任务状态。orphaned = 进程重启后旧 running 行的诚实标记。 */
export const BACKGROUND_TASK_STATUSES = [
  "starting",
  "running",
  "stopped",
  "failed",
  "cancelled",
  "orphaned",
] as const;
export type BackgroundTaskStatus = (typeof BACKGROUND_TASK_STATUSES)[number];

export const backgroundTask = mysqlTable(
  "BackgroundTask",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
    // 启动它的 ToolRun（经 executeToolRun 包裹）；可空
    toolRunId: varchar("toolRunId", { length: 36 }),
    kind: varchar("kind", { length: 32 }).notNull(),
    // 启动命令（argSummary，不存完整 env）
    command: varchar("command", { length: 1024 }).notNull(),
    // host / container
    runtimeType: varchar("runtimeType", { length: 32 }).notNull(),
    status: mysqlEnum("status", BACKGROUND_TASK_STATUSES).notNull().default("starting"),
    // host 模式的进程 pid；container 模式为 null（docker exec -d 不返回容器内 pid）
    pid: int("pid"),
    containerName: varchar("containerName", { length: 128 }),
    // 占用端口（若有，便于诊断）
    port: int("port"),
    // 日志文件相对路径 .snow/runtime/{threadId}/tasks/{taskId}.log
    logPath: varchar("logPath", { length: 512 }).notNull(),
    exitCode: int("exitCode"),
    startedAt: datetime("startedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    finishedAt: datetime("finishedAt", { mode: "date" }),
    // 日志最后写入时间，供 idle sweep
    lastActivityAt: datetime("lastActivityAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    threadStatusIdx: index("BackgroundTask_threadId_status_idx").on(t.threadId, t.status),
    statusIdx: index("BackgroundTask_status_idx").on(t.status),
    threadLastActivityIdx: index("BackgroundTask_threadId_lastActivityAt_idx").on(
      t.threadId,
      t.lastActivityAt,
    ),
  }),
);
export type BackgroundTask = InferSelectModel<typeof backgroundTask>;

// ─── : Git Checkpoint ───────────────────────────────────
//
// 一次风险前快照，关联 git tag 与 thread，供 rollback 与审计。
// tag 名 `snow-checkpoint-{shortId}`（轻量 tag），commitSha 为快照指向的 HEAD。
// restoredAt 在被 restore 时回填（一个 checkpoint 可被多次 restore，仅记最后一次）。
// 不加 DB 级 FK 到 ToolRun（createdByToolRunId 可空，且与 BackgroundTask 一致保持逻辑外键）。

export const gitCheckpoint = mysqlTable(
  "GitCheckpoint",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
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

// ─── b: Long-term Memory ────────────────────────────────
//
// MemoryEntry：一条长期记忆。五类 kind（preference/convention/decision/failure/command），
// 四类 scope（user/project/thread/skill），带 provenance/confidence/expiresAt。
// soft delete（status=revoked 保留审计行）；去重靠 textHash（规范化 text 的 sha256）。
// 不自动写入：只能经 rememberFact 工具或 Studio curate 写入，provenance 必填（蓝图 /§14）。

export const MEMORY_SCOPES = ["user", "project", "thread", "skill"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_KINDS = ["preference", "convention", "decision", "failure", "command"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_CONFIDENCE = ["low", "medium", "high"] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCE)[number];

export const MEMORY_STATUSES = ["active", "revoked"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** provenance 单条来源（必填，可审计、可追溯，防孤儿记忆）。 */
export type MemoryProvenanceEntry = {
  kind: "tool_run" | "message" | "user";
  refId: string;
  threadId?: string;
  summary?: string;
};

export const memoryEntry = mysqlTable(
  "MemoryEntry",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // user/project/thread/skill
    scope: varchar("scope", { length: 32 }).notNull(),
    // scope 绑定 id（userId/projectId/threadId/skillId）；user scope = userId
    scopeRef: varchar("scopeRef", { length: 36 }),
    // preference/convention/decision/failure/command
    kind: varchar("kind", { length: 32 }).notNull(),
    text: text("text").notNull(),
    // 规范化 text 的 sha256，去重用
    textHash: varchar("textHash", { length: 64 }).notNull(),
    // 非空 provenance 数组（MemoryProvenanceEntry[]）
    provenance: json("provenance").notNull(),
    confidence: varchar("confidence", { length: 16 }).notNull().default("medium"),
    // active/revoked（soft delete）
    status: varchar("status", { length: 16 }).notNull().default("active"),
    // null = 永不过期
    expiresAt: datetime("expiresAt", { mode: "date" }),
    // 写入它的 ToolRun（若经 agent 工具；逻辑外键，与 GitCheckpoint 一致不加 FK）
    createdByToolRunId: varchar("createdByToolRunId", { length: 36 }),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    scopeStatusIdx: index("MemoryEntry_scope_scopeRef_status_idx").on(
      t.scope,
      t.scopeRef,
      t.status,
    ),
    kindIdx: index("MemoryEntry_kind_idx").on(t.kind),
    textHashIdx: index("MemoryEntry_textHash_idx").on(t.textHash),
    scopeExpiresIdx: index("MemoryEntry_scope_scopeRef_expiresAt_idx").on(
      t.scope,
      t.scopeRef,
      t.expiresAt,
    ),
  }),
);
export type MemoryEntry = InferSelectModel<typeof memoryEntry>;

// MemoryEmbedding：一条 memory 的向量（混合检索 semantic rerank 用）。
// 一条 memory 每 provider 一向量（unique memoryId+provider）。vector 存 number[]。
// status=active/stale/error：provider disabled/stale/error 必须进入 manifest/UI 可观测，
// 不允许静默伪装成功（蓝图 + 用户指令）。
export const MEMORY_EMBEDDING_STATUSES = ["active", "stale", "error"] as const;
export type MemoryEmbeddingStatus = (typeof MEMORY_EMBEDDING_STATUSES)[number];

export const memoryEmbedding = mysqlTable(
  "MemoryEmbedding",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    memoryId: varchar("memoryId", { length: 36 })
      .notNull()
      .references(() => memoryEntry.id),
    provider: varchar("provider", { length: 64 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    // number[]，deterministic fake embedding（测试不请求真实网络）
    vector: json("vector").notNull(),
    dim: int("dim").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    errorMessage: varchar("errorMessage", { length: 512 }),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    memoryIdx: index("MemoryEmbedding_memoryId_idx").on(t.memoryId),
    providerIdx: index("MemoryEmbedding_provider_idx").on(t.provider),
    memoryProviderUniq: uniqueIndex("MemoryEmbedding_memoryId_provider_uniq").on(
      t.memoryId,
      t.provider,
    ),
  }),
);
export type MemoryEmbedding = InferSelectModel<typeof memoryEmbedding>;
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

// ─── : Subagent Definition / Run ─────────────────────────
//
// 子代理与并行工作流（蓝图 / §12 ）。
// - SubagentDefinition：一个可派生的子代理模板（角色/工具白名单/上下文策略/输出契约/默认写范围）。
// 可由 Agent/Profile config 占位（L478-492）消费，也可独立存在。
// - SubagentRun：一次子代理执行的审计/状态记录。不复用 Thread 行（避免污染用户 thread 列表）；
// transcript 落 artifact 文件（transcriptPath），不进主 Message 表。
// 子代理默认只读（无 writeScope → 不暴露写工具）；写须声明 writeScope 且同父 thread 并发互斥（§14）。

/** 子代理角色。explore/researcher/reviewer/verifier 为四默认 lane；executor 可写。 */
export const SUBAGENT_ROLES = [
  "explore",
  "researcher",
  "reviewer",
  "verifier",
  "executor",
] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

/** SubagentRun 状态机：queued→running→completed/failed/cancelled/timed_out。 */
export const SUBAGENT_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type SubagentRunStatus = (typeof SUBAGENT_RUN_STATUSES)[number];

/**
 * 子代理定义（模板）。
 *
 * allowedTools：工具名白名单（string[]），其余工具对子代理不可见。
 * contextPolicy：{ includeHistory?, includePlan?, includeToolEvidence?, maxSnippets? }，裁剪父上下文。
 * outputSchema：JSON Schema，子代理结束输出的结构化契约；null=不校验。
 * defaultWriteScope：默认写范围（路径 glob 数组）；null=只读。
 */
export const subagentDefinition = mysqlTable(
  "SubagentDefinition",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    name: varchar("name", { length: 64 }).notNull(),
    role: mysqlEnum("role", SUBAGENT_ROLES).notNull(),
    // 子代理用的模型 profile id；null=继承父
    modelProfileId: varchar("modelProfileId", { length: 36 }),
    // 工具名白名单（string[]）
    allowedTools: json("allowedTools").notNull(),
    // { includeHistory?, includePlan?, includeToolEvidence?, maxSnippets? }
    contextPolicy: json("contextPolicy").notNull(),
    // JSON Schema 输出契约；null=不校验
    outputSchema: json("outputSchema"),
    // 默认写范围（路径 glob 数组）；null=只读
    defaultWriteScope: json("defaultWriteScope"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    nameIdx: index("SubagentDefinition_name_idx").on(t.name),
    roleIdx: index("SubagentDefinition_role_idx").on(t.role),
  }),
);
export type SubagentDefinition = InferSelectModel<typeof subagentDefinition>;

/**
 * 一次子代理执行的审计/状态记录。
 *
 * transcriptPath 指向 `.snow/runtime/{parentThreadId}/subagents/{runId}/transcript.json`，
 * 完整 transcript 落文件，不进主 Message 表。joinSubagent 只回 resultSummary + outputArtifactId。
 */
export const subagentRun = mysqlTable(
  "SubagentRun",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    parentThreadId: varchar("parentThreadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
    definitionId: varchar("definitionId", { length: 36 })
      .notNull()
      .references(() => subagentDefinition.id),
    // 父给子代理的目标
    goal: text("goal").notNull(),
    // 父传给子代理的上下文提示（路径/约束/已知信息）
    contextHints: json("contextHints"),
    status: mysqlEnum("status", SUBAGENT_RUN_STATUSES).notNull().default("queued"),
    // 本次实际写范围（definition.defaultWriteScope + spawn 参数合并）；null=只读
    writeScope: json("writeScope"),
    // 结构化结果摘要（join 回传给父）
    resultSummary: text("resultSummary"),
    // 完整结果 artifact ref
    outputArtifactId: varchar("outputArtifactId", { length: 36 }),
    // transcript 文件相对路径
    transcriptPath: varchar("transcriptPath", { length: 512 }),
    // 失败原因（不含 secret）
    errorMessage: text("errorMessage"),
    startedAt: datetime("startedAt", { mode: "date" }),
    finishedAt: datetime("finishedAt", { mode: "date" }),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    parentStatusIdx: index("SubagentRun_parentThreadId_status_idx").on(t.parentThreadId, t.status),
    definitionIdx: index("SubagentRun_definitionId_idx").on(t.definitionId),
  }),
);
export type SubagentRun = InferSelectModel<typeof subagentRun>;

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
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
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

// ─── ChatExample（12-P2-3：首页示例文案 DB 化）──────────────

/**
 * 聊天首页示例文案（蓝图 §chat-examples）。
 *
 * 替代原 env SNOW_CHAT_EXAMPLES 配置——示例文案改由 DB 管理，Studio 后台 API 可增删改。
 * 默认 3 条中文示例由 seed 灌入。enabled=false 的不展示给用户。
 * sortOrder 控制展示顺序（小→大）。
 */
export const chatExample = mysqlTable(
  "ChatExample",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    content: text("content").notNull(),
    sortOrder: int("sortOrder").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    enabledOrderIdx: index("ChatExample_enabled_sortOrder_idx").on(t.enabled, t.sortOrder),
  }),
);
export type ChatExample = InferSelectModel<typeof chatExample>;

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

// ─── V7: ThreadRun（执行事实源）────────────────────────────────
//
// 一次后台执行的事实源记录。runId 由 DB 生成（不再由内存 runner 独自生成），
// 记录执行的开始、结束、状态、触发来源、模型、skill、token、错误和取消原因。
// LiveRun 是运行句柄（进程内执行/取消/SSE 广播），ThreadRun 是长期事实。

/** ThreadRun 执行状态。stale = 进程重启后失联的 running run。 */
export const THREAD_RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "stale",
] as const;

export type ThreadRunStatus = (typeof THREAD_RUN_STATUSES)[number];

/** ThreadRun 触发来源。 */
export const THREAD_RUN_TRIGGER_TYPES = [
  "user_message",
  "approval_resume",
  "retry",
  "system",
  "scheduled",
] as const;

export type ThreadRunTriggerType = (typeof THREAD_RUN_TRIGGER_TYPES)[number];

export const threadRun = mysqlTable(
  "ThreadRun",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
    status: mysqlEnum("status", THREAD_RUN_STATUSES).notNull().default("queued"),
    // 触发来源
    triggerType: varchar("triggerType", { length: 32 }).notNull().default("user_message"),
    // 触发本轮 run 的 user message（可空，如 approval_resume 时）
    triggerMessageId: varchar("triggerMessageId", { length: 36 }),
    // 本轮模型
    model: varchar("model", { length: 128 }).notNull(),
    // 本轮 skill（可空）
    skillId: varchar("skillId", { length: 36 }),
    skillVersionId: varchar("skillVersionId", { length: 36 }),
    // host / container
    runtimeType: varchar("runtimeType", { length: 32 }),
    // 真正开始执行时间
    startedAt: datetime("startedAt", { mode: "date" }),
    // 终态时间
    finishedAt: datetime("finishedAt", { mode: "date" }),
    // runner 心跳时间
    lastSeenAt: datetime("lastSeenAt", { mode: "date" }),
    // 取消原因
    cancelReason: text("cancelReason"),
    // 失败原因
    error: text("error"),
    // token 用量
    promptTokens: int("promptTokens").notNull().default(0),
    completionTokens: int("completionTokens").notNull().default(0),
    totalTokens: int("totalTokens").notNull().default(0),
    // provider、endpoint、artifact 摘要等扩展信息
    metadata: json("metadata"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // 查询 thread 最近 runs
    threadCreatedIdx: index("ThreadRun_threadId_createdAt_idx").on(t.threadId, t.createdAt),
    // 查询 active run
    threadStatusUpdatedIdx: index("ThreadRun_threadId_status_updatedAt_idx").on(
      t.threadId,
      t.status,
      t.updatedAt,
    ),
    // 扫描失联 running run
    statusLastSeenIdx: index("ThreadRun_status_lastSeenAt_idx").on(t.status, t.lastSeenAt),
    // 从用户消息追溯 run
    triggerMessageIdx: index("ThreadRun_triggerMessageId_idx").on(t.triggerMessageId),
  }),
);
export type ThreadRun = InferSelectModel<typeof threadRun>;

// ─── V7: RunTranscriptChunk（流式恢复）────────────────────────
//
// 持久化 SSE UIMessageChunk，支持刷新后从 sequence 恢复。
// 每个 chunk 分配 run 内递增 sequence，前端可从 afterSeq 后续订。

/** RunTranscriptChunk 种类。 */
export const RUN_TRANSCRIPT_CHUNK_KINDS = [
  "ui_message_chunk",
  "artifact",
  "error",
  "done",
] as const;

export type RunTranscriptChunkKind = (typeof RUN_TRANSCRIPT_CHUNK_KINDS)[number];

export const runTranscriptChunk = mysqlTable(
  "RunTranscriptChunk",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
    runId: varchar("runId", { length: 36 })
      .notNull()
      .references(() => threadRun.id),
    // run 内递增序号
    sequence: int("sequence").notNull(),
    // ui_message_chunk / artifact / error / done
    kind: varchar("kind", { length: 32 }).notNull(),
    // 原始 chunk JSON
    payload: json("payload").notNull(),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // 按 run 查询 chunk
    runSequenceIdx: index("RunTranscriptChunk_runId_sequence_idx").on(t.runId, t.sequence),
    // (runId, sequence) 唯一
    runSequenceUq: uniqueIndex("RunTranscriptChunk_runId_sequence_uq").on(t.runId, t.sequence),
  }),
);
export type RunTranscriptChunk = InferSelectModel<typeof runTranscriptChunk>;

// ─── V8: ThreadRunSkill（Run 级 Skill 使用事实表）──────────────
//
// 一个 ThreadRun 实际使用的 0..N 个 SkillVersion（方案 §五.4）。
// - 取代旧 `Thread.activeSkillId/activeSkillVersionId` 的 thread 绑定语义：
// 每个 run 独立解析并记录，thread 不保存“当前执行 Skill”。
// - 允许 0 个（基础 agent，无 ThreadRunSkill 行）；允许多个（primary + supporting）。
// - 恢复未完成 run 时直接读取原 run 的 ThreadRunSkill，沿用原版本（方案约束 6）。
// - `ThreadRun.skillId/skillVersionId` 旧单字段短期保留作兼容展示，新逻辑不依赖。

/** ThreadRunSkill 角色（第一轮只实现 primary）。 */
export const THREAD_RUN_SKILL_ROLES = ["primary", "supporting"] as const;
export type ThreadRunSkillRole = (typeof THREAD_RUN_SKILL_ROLES)[number];

/** 选择的来源：resolver（本轮决策）/ resume（沿用原 run）/ system_policy（平台策略）。 */
export const THREAD_RUN_SKILL_SOURCES = ["resolver", "resume", "system_policy"] as const;
export type ThreadRunSkillSource = (typeof THREAD_RUN_SKILL_SOURCES)[number];

export const threadRunSkill = mysqlTable(
  "ThreadRunSkill",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    // 所属 ThreadRun
    runId: varchar("runId", { length: 36 })
      .notNull()
      .references(() => threadRun.id),
    // 冗余查询字段（查 thread 下历史 Skill 使用）
    threadId: varchar("threadId", { length: 36 })
      .notNull()
      .references(() => thread.id),
    // 实际使用的 Skill（逻辑外键 → skill.id；不加 DB 级 FK，避免与 skill 软删除冲突）
    // V8 补充方案阶段 2：放宽到 128，支持企业平台 ID（sk_* / skv_*）。
    skillId: varchar("skillId", { length: 128 }).notNull(),
    // 实际使用的 SkillVersion（逻辑外键 → skill_versions.id）
    // V8 补充方案阶段 2：放宽到 128，支持企业平台版本 ID（skv_*）。
    skillVersionId: varchar("skillVersionId", { length: 128 }).notNull(),
    // primary / supporting
    role: varchar("role", { length: 16 }).notNull().default("primary"),
    // resolver / resume / system_policy
    source: varchar("source", { length: 24 }).notNull().default("resolver"),
    // 选择理由，供审计和 Studio 展示
    reason: text("reason"),
    // 版本内容 hash，便于版本可追溯。
    // V8 补充方案阶段 2：放宽到 128，支持企业平台 sha256:<64hex> 格式（总长 71）。
    contentHash: varchar("contentHash", { length: 128 }),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // 查询某次 run 的 Skill
    runIdx: index("ThreadRunSkill_runId_idx").on(t.runId),
    // 查询 thread 下历史 Skill 使用
    threadCreatedIdx: index("ThreadRunSkill_threadId_createdAt_idx").on(t.threadId, t.createdAt),
    // 统计 Skill 版本表现
    skillVersionIdx: index("ThreadRunSkill_skillId_skillVersionId_idx").on(
      t.skillId,
      t.skillVersionId,
    ),
    // P2-5: (runId, skillId, role) 唯一约束,防 saveThreadRunSkills 重试插重复行
    runSkillRoleUq: uniqueIndex("ThreadRunSkill_runId_skillId_role_uq").on(
      t.runId,
      t.skillId,
      t.role,
    ),
  }),
);
export type ThreadRunSkill = InferSelectModel<typeof threadRunSkill>;

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
