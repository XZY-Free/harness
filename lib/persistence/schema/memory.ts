/**
 * Memory schema：memory_candidate / memory_entry / memory_source 表。
 *
 * 事实源：
 * - docs/architecture/persistence.md （Memory 与知识索引表）、§2（命名与公共字段）。
 * - docs/architecture/context-memory-and-knowledge.md §8（Memory 作用域）、§9（挂载与检索）、
 * §10（写入路径）、§11（禁止内容与用户控制）。
 * - docs/architecture/domain-model.md （Memory 域模型边界）。
 * - docs/architecture/memory-and-job-api.md §2（Memory Candidate API）。
 * - docs/architecture/context-memory-and-knowledge.md 。
 *
 * 关键不变量（、§8、§10、§11）：
 * - candidate_key = sha256(invocation_id|source_type|source_id|content_hash|scope_type|scope_ref-or-empty)，
 * UNIQUE(candidate_key) 保证同 Invocation 同来源同内容同 scope 不重复落库。
 * - source_item_id / source_job_id / source_artifact_id 恰一个非空（route 层校验，DB 不强制）。
 * - Organization scope 一律 needs_review（Policy 层强制）。
 * - Secret/Token/Cookie/私钥直接 rejected，正文销毁，响应不回显（Policy 层强制）。
 * - accepted 与 MemoryEntry upsert 同事务；MemorySource 关联同事务。
 * - 管理员复核只能缩小 scope，不能扩大（route 层校验）。
 * - memory_entry 的 scopeType/scopeRef 决定挂载范围；memory_state=active 才参与检索。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import { json } from "@/lib/persistence/schema/json-column";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  check,
  datetime,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── 枚举常量 ──────────────────────────────────────────────

/**
 * Memory 作用域类型（§8）。
 * - thread：单次会话内（会话结束后清理）。
 * - workspace：工作空间内（跨会话共享）。
 * - agent：Agent 专属（仅该 Agent 可见）。
 * - user_preference：用户偏好（跨工作空间，绑定用户）。
 * - organization：组织级（全租户共享，需复核）。
 */
export const MEMORY_SCOPE_TYPES = [
  "thread",
  "workspace",
  "agent",
  "user_preference",
  "organization",
] as const;
export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];

/**
 * Memory Candidate 状态机（§10）。
 * - submitted：已提交（等待 Policy 评估；本阶段 Policy 同步评估，不持久化此状态）。
 * - accepted：已接受（MemoryEntry + MemorySource 已创建）。
 * - rejected：已拒绝（内容销毁，不创建 MemoryEntry）。
 * - needs_review：需管理员复核（Organization scope 或 restricted sensitivity）。
 * - expired：已过期（超时未复核，数据生命周期阶段处理）。
 */
export const CANDIDATE_STATES = [
  "submitted",
  "accepted",
  "rejected",
  "needs_review",
  "expired",
] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

/**
 * Memory Entry 状态（§9）。
 * - active：活跃，参与检索与挂载。
 * - archived：归档（不再检索，但保留历史）。
 * - superseded：被新版本取代（contentHash 相同的新 entry 接管）。
 */
export const MEMORY_STATES = ["active", "archived", "superseded"] as const;
export type MemoryState = (typeof MEMORY_STATES)[number];

/**
 * 敏感度分级（与 Fragment sensitivity 对齐）。
 * - public：公开。
 * - internal：内部。
 * - confidential：机密。
 * - restricted：受限（需复核）。
 */
export const SENSITIVITY_CLASSES = ["public", "internal", "confidential", "restricted"] as const;
export type SensitivityClass = (typeof SENSITIVITY_CLASSES)[number];

/**
 * 记忆来源类型（memory_source.source_type）。
 * 标识 MemoryEntry 的来源事实类型，与 candidate 的 source_item_id/source_job_id/source_artifact_id 对应。
 */
export const MEMORY_SOURCE_TYPES = ["thread_item", "job", "artifact"] as const;
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

/**
 * 记忆分类（受控值，对标 Claude Code auto memory 的四类 + 我们的 decision）。
 * - user：用户角色 / 专家领域 / 工作偏好（跨项目稳定）。
 * - feedback：用户给的纠正与确认的做法。
 * - project：在办工作 / 期限 / 无法从代码推导的决定。
 * - reference：外部信息在哪找（issue tracker / 看板 / 文档）。
 * - decision：架构 / 技术决策及其理由。
 */
export const MEMORY_CATEGORIES = ["user", "feedback", "project", "reference", "decision"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/**
 * 提取触发类型（memory_extraction_run.trigger）。
 * - pre_compaction：会话接近压缩时的静默 flush（主路径，对标 OpenClaw memoryFlush）。
 * - explicit：显式"记住这个"。
 * - session_end：会话 / 任务终结收口。
 */
export const EXTRACTION_TRIGGERS = ["pre_compaction", "explicit", "session_end"] as const;
export type ExtractionTrigger = (typeof EXTRACTION_TRIGGERS)[number];

// ─── memory_candidate ──────────────────────────────────────

export const memoryCandidate = mysqlTable(
  "MemoryCandidate",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 所属 Invocation（逻辑外键 → Invocation.id；Token 绑定，不信任请求体）。 */
    invocationId: varchar("invocationId", { length: 36 }).notNull(),
    /** 来源 Thread（逻辑外键 → Thread.id；可空）。 */
    sourceThreadId: varchar("sourceThreadId", { length: 36 }),
    /** 来源 Turn（逻辑外键 → Turn.id；可空）。 */
    sourceTurnId: varchar("sourceTurnId", { length: 36 }),
    /** 来源 Thread Item（逻辑外键 → ThreadItem.id；与 sourceJobId/sourceArtifactId 恰一个非空）。 */
    sourceItemId: varchar("sourceItemId", { length: 36 }),
    /** 来源 Job（逻辑外键 → Job.id；与 sourceItemId/sourceArtifactId 恰一个非空）。 */
    sourceJobId: varchar("sourceJobId", { length: 36 }),
    /** 来源 Artifact（逻辑外键 → Artifact.id；与 sourceItemId/sourceJobId 恰一个非空）。 */
    sourceArtifactId: varchar("sourceArtifactId", { length: 36 }),
    /** 来源事实自身的 hash；必须由平台回读来源后校验，不能信任 Runtime。 */
    sourceHash: varchar("sourceHash", { length: 128 }).notNull(),
    proposedScopeType: mysqlEnum("proposedScopeType", MEMORY_SCOPE_TYPES).notNull(),
    /** proposed scope 引用（thread→threadId / workspace→workspaceId / agent→agentId / user_preference→null / organization→null）。 */
    proposedScopeRef: varchar("proposedScopeRef", { length: 128 }),
    /** Memory 类型（自由字符串：preference/fact/skill_usage/decision/feedback 等）。 */
    memoryType: varchar("memoryType", { length: 64 }).notNull(),
    /** 提交理由，供 Policy 重新判断用户授权和事实类型。 */
    rationaleCode: varchar("rationaleCode", { length: 64 }).notNull(),
    /** 内容对象存储引用（与 contentRedacted 至少一个非空）。 */
    contentRef: varchar("contentRef", { length: 512 }),
    /** 脱敏内容正文（与 contentRef 至少一个非空；rejected 时销毁）。 */
    contentRedacted: text("contentRedacted"),
    /** 内容 hash（sha256: 前缀 + 64 hex）。 */
    contentHash: varchar("contentHash", { length: 128 }).notNull(),
    /** candidate_key = sha256(invocation_id|source_type|source_id|content_hash|scope_type|scope_ref-or-empty)。 */
    candidateKey: varchar("candidateKey", { length: 128 }).notNull(),
    sensitivityClass: mysqlEnum("sensitivityClass", SENSITIVITY_CLASSES).notNull(),
    candidateState: mysqlEnum("candidateState", CANDIDATE_STATES).notNull(),
    /** 决策原因码数组（如 ["organization_scope_requires_review"] / ["sensitive_content_detected"]）。 */
    decisionReasonCodesJson: json("decisionReasonCodesJson").$type<string[]>(),
    /** accepted 时关联的 MemoryEntry id；rejected/needs_review 为 null。 */
    resolvedMemoryEntryId: varchar("resolvedMemoryEntryId", { length: 36 }),
    /** Runtime 请求的有效期；Policy 可缩短，不能延长。 */
    requestedExpiresAt: datetime("requestedExpiresAt", { mode: "date", fsp: 3 }),
    proposedAt: datetime("proposedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /** 决策时间（accepted/rejected/needs_review 设置；submitted 为 null）。 */
    resolvedAt: datetime("resolvedAt", { mode: "date", fsp: 3 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // candidate_key 全局唯一（invocation_id 全局唯一保证跨租户不冲突）。
    candidateKeyUq: uniqueIndex("MemoryCandidate_candidateKey_uq").on(t.candidateKey),
    tenantInvocationIdx: index("MemoryCandidate_tenant_invocation_idx").on(
      t.tenantId,
      t.invocationId,
    ),
    tenantStateProposedIdx: index("MemoryCandidate_tenant_state_proposed_idx").on(
      t.tenantId,
      t.candidateState,
      t.proposedAt,
    ),
    tenantScopeIdx: index("MemoryCandidate_tenant_scope_idx").on(
      t.tenantId,
      t.proposedScopeType,
      t.proposedScopeRef,
    ),
    exactlyOneSourceCk: check(
      "MemoryCandidate_exactly_one_source_ck",
      sql`((${t.sourceItemId} IS NOT NULL) + (${t.sourceJobId} IS NOT NULL) + (${t.sourceArtifactId} IS NOT NULL)) = 1`,
    ),
    acceptedEntryCk: check(
      "MemoryCandidate_accepted_entry_ck",
      sql`(${t.candidateState} <> 'accepted' OR ${t.resolvedMemoryEntryId} IS NOT NULL)`,
    ),
    rejectedEntryCk: check(
      "MemoryCandidate_rejected_entry_ck",
      sql`(${t.candidateState} NOT IN ('rejected','expired') OR ${t.resolvedMemoryEntryId} IS NULL)`,
    ),
  }),
);

// ─── memory_entry ──────────────────────────────────────────

export const memoryEntry = mysqlTable(
  "MemoryEntry",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 规范化去重键：tenant|scope|scopeRef|memoryType|contentHash。 */
    entryKey: varchar("entryKey", { length: 128 }).notNull(),
    scopeType: mysqlEnum("scopeType", MEMORY_SCOPE_TYPES).notNull(),
    /** scope 引用（与 candidate.proposedScopeRef 语义一致）。 */
    scopeRef: varchar("scopeRef", { length: 128 }),
    memoryType: varchar("memoryType", { length: 64 }).notNull(),
    /** 记忆分类（受控值；用于检索过滤与晋升策略）。 */
    memoryCategory: mysqlEnum("memoryCategory", MEMORY_CATEGORIES).notNull().default("project"),
    contentRef: varchar("contentRef", { length: 512 }),
    contentRedacted: text("contentRedacted"),
    contentHash: varchar("contentHash", { length: 128 }).notNull(),
    sensitivityClass: mysqlEnum("sensitivityClass", SENSITIVITY_CLASSES).notNull(),
    memoryState: mysqlEnum("memoryState", MEMORY_STATES).notNull().default("active"),
    validFrom: datetime("validFrom", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /**
     * 双时态 · 事件时间：事实在现实世界失效的时间（对标 Graphiti valid_at/invalid_at）。
     * 矛盾演化时置为「新事实 validFrom」；null 表示仍然为真。
     */
    invalidAt: datetime("invalidAt", { mode: "date", fsp: 3 }),
    /**
     * 双时态 · 系统时间：系统标记本条目被取代 / 失效的时间（对标 Graphiti expired_at）。
     * 与 invalidAt 的区别：条目可以「现实已失效但系统仍视为历史准确」。
     */
    expiredAt: datetime("expiredAt", { mode: "date", fsp: 3 }),
    /** 演化链：本条目取代了哪条旧条目（不物理删除，保留历史）。 */
    supersedesEntryId: varchar("supersedesEntryId", { length: 36 }),
    /** 演化链：本条目被哪条新条目取代。 */
    supersededByEntryId: varchar("supersededByEntryId", { length: 36 }),
    /** capm 侧语义索引引用（document@revision；执行检索经 capm）。 */
    indexedRevisionRef: varchar("indexedRevisionRef", { length: 512 }),
    /** 检索命中次数（用于晋升 / 降权，对标 Mem0 retrieval_count）。 */
    retrievalCount: int("retrievalCount").notNull().default(0),
    /** 最近一次被检索命中的时间。 */
    lastRetrievedAt: datetime("lastRetrievedAt", { mode: "date", fsp: 3 }),
    /** 提取批次（逻辑外键 → MemoryExtractionRun.id；直接创建的条目为 null）。 */
    extractionRunId: varchar("extractionRunId", { length: 36 }),
    /** 过期时间（TTL 到期后归档，不物理删除；null 表示不过期）。 */
    expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    entryKeyUq: uniqueIndex("MemoryEntry_entryKey_uq").on(t.entryKey),
    tenantScopeIdx: index("MemoryEntry_tenant_scope_idx").on(t.tenantId, t.scopeType, t.scopeRef),
    tenantStateUpdatedIdx: index("MemoryEntry_tenant_state_updated_idx").on(
      t.tenantId,
      t.memoryState,
      t.updatedAt,
    ),
    tenantContentHashIdx: index("MemoryEntry_tenant_contentHash_idx").on(t.tenantId, t.contentHash),
    // 时效过滤（检索时排除已失效）
    tenantStateInvalidIdx: index("MemoryEntry_tenant_state_invalid_idx").on(
      t.tenantId,
      t.memoryState,
      t.invalidAt,
    ),
    // 演化链反查
    supersededByIdx: index("MemoryEntry_supersededBy_idx").on(t.supersededByEntryId),
    // 分类检索
    tenantCategoryIdx: index("MemoryEntry_tenant_category_idx").on(
      t.tenantId,
      t.memoryCategory,
      t.memoryState,
    ),
  }),
);

// ─── memory_extraction_run ─────────────────────────────────

/**
 * 记忆提取批次（对标 Mem0 history）。
 *
 * 每次提取（压缩前 flush / 显式 / 会话终结）留一条批次记录，
 * 供审计"这批记忆从哪来、抽了多少、怎么决策的"。
 */
export const memoryExtractionRun = mysqlTable(
  "MemoryExtractionRun",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 所属 Invocation（逻辑外键 → Invocation.id）。 */
    invocationId: varchar("invocationId", { length: 36 }).notNull(),
    /** 来源 Thread（逻辑外键 → Thread.id）。 */
    threadId: varchar("threadId", { length: 36 }),
    /** 触发类型：pre_compaction / explicit / session_end。 */
    trigger: mysqlEnum("trigger", EXTRACTION_TRIGGERS).notNull(),
    /** 来源消息范围 hash（幂等：同范围不重复提取）。 */
    sourceRangesHash: varchar("sourceRangesHash", { length: 128 }).notNull(),
    /** 抽取的事实数。 */
    extractedCount: int("extractedCount").notNull().default(0),
    /** 决策明细数组（每条：fact/action/targetEntryId/reason）。 */
    decisionsJson:
      json("decisionsJson").$type<
        Array<{
          fact: string;
          action: string;
          targetEntryId?: string | null;
          reason?: string | null;
        }>
      >(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // 同 invocation + 同触发源范围幂等
    invocationRangeUq: uniqueIndex("MemoryExtractionRun_invocation_range_uq").on(
      t.invocationId,
      t.trigger,
      t.sourceRangesHash,
    ),
    tenantCreatedIdx: index("MemoryExtractionRun_tenant_created_idx").on(t.tenantId, t.createdAt),
  }),
);

// ─── memory_source ─────────────────────────────────────────

export const memorySource = mysqlTable(
  "MemorySource",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    /** 所属 MemoryEntry（DB 级 FK → MemoryEntry.id ON DELETE CASCADE）。 */
    memoryEntryId: varchar("memoryEntryId", { length: 36 })
      .notNull()
      .references(() => memoryEntry.id),
    /** 来源 Candidate（逻辑外键 → MemoryCandidate.id；直接创建的 Entry 为 null）。 */
    memoryCandidateId: varchar("memoryCandidateId", { length: 36 }),
    sourceType: mysqlEnum("sourceType", MEMORY_SOURCE_TYPES).notNull(),
    /** 来源资源 id（thread_item→itemId / job→jobId / artifact→artifactId）。 */
    sourceId: varchar("sourceId", { length: 128 }).notNull(),
    /** 来源内容 hash（sha256: 前缀 + 64 hex；来源内容快照指纹）。 */
    sourceHash: varchar("sourceHash", { length: 128 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // 同一 MemoryEntry 下同来源不重复关联。
    entrySourceUq: uniqueIndex("MemorySource_entry_type_id_hash_uq").on(
      t.memoryEntryId,
      t.sourceType,
      t.sourceId,
      t.sourceHash,
    ),
    candidateIdx: index("MemorySource_candidate_idx").on(t.memoryCandidateId),
  }),
);

// ─── 类型导出 ──────────────────────────────────────────────

export type MemoryCandidate = InferSelectModel<typeof memoryCandidate>;
export type NewMemoryCandidate = InferInsertModel<typeof memoryCandidate>;
export type MemoryEntry = InferSelectModel<typeof memoryEntry>;
export type NewMemoryEntry = InferInsertModel<typeof memoryEntry>;
export type MemorySource = InferSelectModel<typeof memorySource>;
export type NewMemorySource = InferInsertModel<typeof memorySource>;
export type MemoryExtractionRun = InferSelectModel<typeof memoryExtractionRun>;
export type NewMemoryExtractionRun = InferInsertModel<typeof memoryExtractionRun>;
