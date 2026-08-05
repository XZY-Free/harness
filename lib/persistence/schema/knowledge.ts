/**
 * Knowledge schema：knowledge_base / knowledge_document /
 * knowledge_document_revision / knowledge_chunk / knowledge_index 表。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §4.4（knowledge_base/document/revision 字段）、
 *   §7.5（knowledge_chunk / knowledge_index 索引表）。
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §12（Knowledge Base）、
 *   §13（Knowledge 加载：先目录后证据 / 数据保持最新 / 检索失败区分）、§14（与 Skill/Tool 边界）。
 * - ../v11-agentkit-platform/09-unified-domain-model.md §6（域模型边界）。
 * - ../v11-agentkit-platform-development-plan/07-context-memory-and-knowledge.md S07-W06。
 *
 * 关键不变量（§12、§13、§7.5）：
 * - Knowledge 文档采用稳定对象 + 不可变修订；索引完成后才切换 current_revision_id。
 * - 全文、向量、图谱是 KnowledgeBase 内部检索方式；Agent 只绑定 KnowledgeBase。
 * - knowledge_chunk 只属于不可变文档修订（document_revision_id 外键 ON DELETE CASCADE）。
 * - knowledge_index 可重建，权限仍来自 Knowledge 文档（不复制权限到索引）。
 * - 检索结果返回文档修订、Chunk/hash、相关性、时效信息；权限拒绝、索引不可用和确实无结果必须区分。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  datetime,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── 枚举常量 ──────────────────────────────────────────────

/**
 * Knowledge Base 生命周期状态。
 * - active：活跃，参与检索与挂载。
 * - archived：归档（不再检索，但保留历史）。
 * - deleted：软删除（数据生命周期阶段物理清理）。
 */
export const KNOWLEDGE_BASE_LIFECYCLE_STATES = ["active", "archived", "deleted"] as const;
export type KnowledgeBaseLifecycleState = (typeof KNOWLEDGE_BASE_LIFECYCLE_STATES)[number];

/**
 * Knowledge 文档生命周期状态。
 * - active：活跃，可发布新修订。
 * - archived：归档（不再发布新修订，旧修订仍可检索）。
 * - deleted：软删除。
 */
export const KNOWLEDGE_DOCUMENT_LIFECYCLE_STATES = ["active", "archived", "deleted"] as const;
export type KnowledgeDocumentLifecycleState = (typeof KNOWLEDGE_DOCUMENT_LIFECYCLE_STATES)[number];

/**
 * Knowledge 索引状态（base / document_revision 共用）。
 * - pending：待索引（新建/修订后初始状态）。
 * - indexing：索引中（异步索引任务进行中）。
 * - ready：索引就绪（可参与检索）。
 * - failed：索引失败（需要重试或人工介入）。
 * - stale：索引过期（内容已变更但索引未更新）。
 */
export const KNOWLEDGE_INDEX_STATES = ["pending", "indexing", "ready", "failed", "stale"] as const;
export type KnowledgeIndexState = (typeof KNOWLEDGE_INDEX_STATES)[number];

/**
 * Knowledge 修订状态。
 * - draft：草稿（未发布，不可检索）。
 * - published：已发布（current_revision_id 指向时参与检索）。
 * - superseded：被新修订取代（不参与检索，但保留历史）。
 * - retracted：撤回（不参与检索；紧急下线场景）。
 */
export const KNOWLEDGE_REVISION_STATES = ["draft", "published", "superseded", "retracted"] as const;
export type KnowledgeRevisionState = (typeof KNOWLEDGE_REVISION_STATES)[number];

/**
 * 知识来源类型（knowledge_document.source_type）。
 * - upload：用户上传文件（PDF/Word/Markdown 等）。
 * - external_url：外部 URL 抓取。
 * - manual：管理员手工录入。
 * - synced：外部系统同步（如 Confluence/Notion）。
 * - generated：平台生成（如知识构建 Job 产物）。
 */
export const KNOWLEDGE_SOURCE_TYPES = [
  "upload",
  "external_url",
  "manual",
  "synced",
  "generated",
] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

// ─── knowledge_base ────────────────────────────────────────

export const knowledgeBase = mysqlTable(
  "KnowledgeBase",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 租户内稳定 key（与 display_name 区分；用于 Agent 绑定引用）。 */
    knowledgeKey: varchar("knowledgeKey", { length: 128 }).notNull(),
    /** 显示名称（可变；供员工/Admin 展示）。 */
    displayName: varchar("displayName", { length: 256 }).notNull(),
    /** 描述（用途、覆盖范围、维护方等）。 */
    description: text("description"),
    /** 所有者用户 id（逻辑外键 → UserIdentity.id）。 */
    ownerUserId: varchar("ownerUserId", { length: 36 }),
    /** 可见性策略 id（逻辑外键 → PolicySet.id；null 表示租户默认策略）。 */
    visibilityPolicyId: varchar("visibilityPolicyId", { length: 36 }),
    /** 索引状态（base 级聚合；document_revision 级有独立 index_state）。 */
    indexState: mysqlEnum("indexState", KNOWLEDGE_INDEX_STATES).notNull().default("pending"),
    lifecycleState: mysqlEnum("lifecycleState", KNOWLEDGE_BASE_LIFECYCLE_STATES)
      .notNull()
      .default("active"),
    /** 并发版本号（ETag/If-Match 乐观锁）。 */
    versionNo: varchar("versionNo", { length: 64 })
      .notNull()
      .$defaultFn(() => randomUUID()),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /** 软删除时间（deleted 状态设置）。 */
    deletedAt: datetime("deletedAt", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    // 租户内 knowledgeKey 唯一（Agent 绑定引用稳定身份）。
    tenantKeyUq: uniqueIndex("KnowledgeBase_tenant_key_uq").on(t.tenantId, t.knowledgeKey),
    tenantLifecycleIdx: index("KnowledgeBase_tenant_lifecycle_idx").on(
      t.tenantId,
      t.lifecycleState,
    ),
    tenantOwnerIdx: index("KnowledgeBase_tenant_owner_idx").on(t.tenantId, t.ownerUserId),
  }),
);

// ─── knowledge_document ────────────────────────────────────

export const knowledgeDocument = mysqlTable(
  "KnowledgeDocument",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 所属 KnowledgeBase（DB 级 FK → KnowledgeBase.id ON DELETE CASCADE）。 */
    knowledgeBaseId: varchar("knowledgeBaseId", { length: 36 })
      .notNull()
      .references(() => knowledgeBase.id),
    /** 稳定文档 key（KnowledgeBase 内唯一；用于跨修订引用）。 */
    documentKey: varchar("documentKey", { length: 128 }).notNull(),
    /** 显示标题（可变）。 */
    title: varchar("title", { length: 512 }).notNull(),
    /** 来源类型（upload/external_url/manual/synced/generated）。 */
    sourceType: mysqlEnum("sourceType", KNOWLEDGE_SOURCE_TYPES).notNull(),
    /** 来源引用（upload→对象存储 key / external_url→URL / synced→外部系统 id）。 */
    sourceRef: varchar("sourceRef", { length: 512 }),
    /** 当前发布修订 id（逻辑外键 → KnowledgeDocumentRevision.id；null 表示未发布）。 */
    currentRevisionId: varchar("currentRevisionId", { length: 36 }),
    lifecycleState: mysqlEnum("lifecycleState", KNOWLEDGE_DOCUMENT_LIFECYCLE_STATES)
      .notNull()
      .default("active"),
    /** 并发版本号（ETag/If-Match 乐观锁）。 */
    versionNo: varchar("versionNo", { length: 64 })
      .notNull()
      .$defaultFn(() => randomUUID()),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    deletedAt: datetime("deletedAt", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    // KnowledgeBase 内 documentKey 唯一。
    baseKeyUq: uniqueIndex("KnowledgeDocument_base_key_uq").on(t.knowledgeBaseId, t.documentKey),
    tenantBaseIdx: index("KnowledgeDocument_tenant_base_idx").on(t.tenantId, t.knowledgeBaseId),
    tenantLifecycleIdx: index("KnowledgeDocument_tenant_lifecycle_idx").on(
      t.tenantId,
      t.lifecycleState,
    ),
  }),
);

// ─── knowledge_document_revision ───────────────────────────

export const knowledgeDocumentRevision = mysqlTable(
  "KnowledgeDocumentRevision",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 所属文档（DB 级 FK → KnowledgeDocument.id ON DELETE CASCADE）。 */
    documentId: varchar("documentId", { length: 36 })
      .notNull()
      .references(() => knowledgeDocument.id),
    /** 修订号（同一文档内单调递增；从 1 开始）。 */
    revisionNo: varchar("revisionNo", { length: 32 }).notNull(),
    /** 内容对象存储引用（不可变；与 contentRedacted 至少一个非空）。 */
    contentRef: varchar("contentRef", { length: 512 }),
    /** 脱敏内容正文（不可变；小文档可内联；大文档用 contentRef）。 */
    contentRedacted: text("contentRedacted"),
    /** 内容 hash（sha256: 前缀 + 64 hex；不可变）。 */
    contentHash: varchar("contentHash", { length: 128 }).notNull(),
    /** ACL 快照 hash（发布时冻结的可见性策略指纹；用于检索时一致性校验）。 */
    aclSnapshotHash: varchar("aclSnapshotHash", { length: 128 }),
    /** ACL 快照 JSON（发布时冻结；检索时按此校验访问权限）。 */
    aclSnapshotJson: json("aclSnapshotJson").$type<Record<string, unknown>>(),
    /** 索引状态（修订级；ready 才参与检索）。 */
    indexState: mysqlEnum("indexState", KNOWLEDGE_INDEX_STATES).notNull().default("pending"),
    revisionState: mysqlEnum("revisionState", KNOWLEDGE_REVISION_STATES).notNull().default("draft"),
    /** 创建者（用户 id 或 service identity）。 */
    createdBy: varchar("createdBy", { length: 128 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /** 发布时间（published 状态设置；draft/superseded/retracted 为 null）。 */
    publishedAt: datetime("publishedAt", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    // 同一文档内 revisionNo 唯一。
    documentRevisionUq: uniqueIndex("KnowledgeDocumentRevision_doc_rev_uq").on(
      t.documentId,
      t.revisionNo,
    ),
    tenantDocumentIdx: index("KnowledgeDocumentRevision_tenant_doc_idx").on(
      t.tenantId,
      t.documentId,
    ),
    tenantStateIdx: index("KnowledgeDocumentRevision_tenant_state_idx").on(
      t.tenantId,
      t.revisionState,
    ),
  }),
);

// ─── knowledge_chunk ───────────────────────────────────────

export const knowledgeChunk = mysqlTable(
  "KnowledgeChunk",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 所属文档修订（DB 级 FK → KnowledgeDocumentRevision.id ON DELETE CASCADE）。 */
    documentRevisionId: varchar("documentRevisionId", { length: 36 })
      .notNull()
      .references(() => knowledgeDocumentRevision.id),
    /** Chunk 序号（修订内单调递增；从 1 开始）。 */
    chunkNo: varchar("chunkNo", { length: 32 }).notNull(),
    /** Chunk 内容对象存储引用（不可变；大 Chunk 用引用）。 */
    contentRef: varchar("contentRef", { length: 512 }),
    /** Chunk 脱敏正文（不可变；小 Chunk 可内联）。 */
    contentRedacted: text("contentRedacted"),
    /** Chunk 内容 hash（sha256: 前缀 + 64 hex；不可变）。 */
    contentHash: varchar("contentHash", { length: 128 }).notNull(),
    /** Chunk 元数据（如页码、章节、token 数、位置等稀疏字段）。 */
    metadataJson: json("metadataJson").$type<Record<string, unknown>>(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // 同一修订内 chunkNo 唯一。
    revisionChunkUq: uniqueIndex("KnowledgeChunk_revision_chunk_uq").on(
      t.documentRevisionId,
      t.chunkNo,
    ),
    tenantRevisionIdx: index("KnowledgeChunk_tenant_revision_idx").on(
      t.tenantId,
      t.documentRevisionId,
    ),
  }),
);

// ─── knowledge_index ───────────────────────────────────────

export const knowledgeIndex = mysqlTable(
  "KnowledgeIndex",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 所属 Chunk（DB 级 FK → KnowledgeChunk.id ON DELETE CASCADE）。 */
    chunkId: varchar("chunkId", { length: 36 })
      .notNull()
      .references(() => knowledgeChunk.id),
    /** 索引提供方（如 "internal_fulltext" / "internal_vector" / "external_pinecone"）。 */
    indexProvider: varchar("indexProvider", { length: 64 }).notNull(),
    /** 索引引用（全文 doc id / 向量 id / 外部索引 ref）。 */
    indexRef: varchar("indexRef", { length: 512 }).notNull(),
    /** 嵌入模型引用（向量索引专用；全文索引为 null）。 */
    embeddingModelRef: varchar("embeddingModelRef", { length: 128 }),
    /** 被索引内容 hash（与 knowledge_chunk.contentHash 一致；一致性校验）。 */
    contentHash: varchar("contentHash", { length: 128 }).notNull(),
    indexedAt: datetime("indexedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // 同一 Chunk 同一 indexProvider 只有一条索引记录。
    chunkProviderUq: uniqueIndex("KnowledgeIndex_chunk_provider_uq").on(t.chunkId, t.indexProvider),
    tenantProviderIdx: index("KnowledgeIndex_tenant_provider_idx").on(t.tenantId, t.indexProvider),
  }),
);

// ─── 类型导出 ──────────────────────────────────────────────

export type KnowledgeBase = InferSelectModel<typeof knowledgeBase>;
export type KnowledgeBaseInsert = InferInsertModel<typeof knowledgeBase>;

export type KnowledgeDocument = InferSelectModel<typeof knowledgeDocument>;
export type KnowledgeDocumentInsert = InferInsertModel<typeof knowledgeDocument>;

export type KnowledgeDocumentRevision = InferSelectModel<typeof knowledgeDocumentRevision>;
export type KnowledgeDocumentRevisionInsert = InferInsertModel<typeof knowledgeDocumentRevision>;

export type KnowledgeChunk = InferSelectModel<typeof knowledgeChunk>;
export type KnowledgeChunkInsert = InferInsertModel<typeof knowledgeChunk>;

export type KnowledgeIndex = InferSelectModel<typeof knowledgeIndex>;
export type KnowledgeIndexInsert = InferInsertModel<typeof knowledgeIndex>;

/** 校验 content hash 格式（sha256: 前缀 + 64 hex）。 */
export function isValidKnowledgeContentHash(hash: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(hash);
}

/** 索引就绪检查辅助：base.indexState=ready 且 document 有 current_revision_id。 */
export const KNOWLEDGE_BASE_QUERYABLE_INDEX_STATES: ReadonlySet<KnowledgeIndexState> = new Set([
  "ready",
]);
