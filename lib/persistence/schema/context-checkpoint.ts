/**
 * Context Checkpoint schema：context_checkpoint 表。
 *
 * 事实源：
 * - docs/architecture/persistence.md （Memory 与知识索引表）、§2（命名与公共字段）。
 * - docs/architecture/context-memory-and-knowledge.md §6（压缩）、§7（Trace 记录）、§15（失败与恢复）。
 * - docs/architecture/memory-and-job-api.md §3（Context Checkpoint API）。
 * - docs/architecture/context-memory-and-knowledge.md 。
 *
 * 关键不变量（、§6、§15）：
 * - Checkpoint 只保存可恢复的组装/压缩位置，不删除原始 Item/Event。
 * - Checkpoint 不冒充 FilesystemCheckpoint（文件恢复走 filesystem_checkpoint 表）。
 * - Checkpoint 不写 Memory，不保存 Credential 或隐藏思维链。
 * - summary_redacted 存脱敏摘要；summary_ref 存对象存储引用（两者至少一个非空）。
 * - source_ranges_hash 保证来源范围可追溯；Runtime 恢复时重新校验引用仍可访问。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
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
 * Checkpoint 类型。
 * - assembly：组装位置（Context View 入口快照）。
 * - compression：压缩点（保留目标/约束/决定/状态，去除重复日志与无意义进度）。
 * - resume：恢复点（Runtime 恢复时引用，重新校验来源仍可访问）。
 */
export const CHECKPOINT_TYPES = ["assembly", "compression", "resume"] as const;
export type CheckpointType = (typeof CHECKPOINT_TYPES)[number];

/**
 * source_ranges 数组元素结构。
 *
 * 描述 Checkpoint 引用的来源范围（Thread Item/Event、Memory、Knowledge），
 * 每个范围含类型、起止 sequence 与范围 hash，保证来源可追溯与可重校验。
 */
export interface SourceRange {
  /** 范围类型：thread_item / thread_event / memory / knowledge。 */
  type: "thread_item" | "thread_event" | "memory" | "knowledge";
  /** 范围起始 sequence（thread_item/thread_event 用）；memory/knowledge 为 null。 */
  fromSequence?: number | null;
  /** 范围结束 sequence（thread_item/thread_event 用）；memory/knowledge 为 null。 */
  toSequence?: number | null;
  /** 范围内资源 id 列表（memory/knowledge 用）；thread_item/thread_event 可选。 */
  resourceIds?: string[];
  /** 范围内容 hash（sha256: 前缀 + 64 hex）。 */
  rangeHash: string;
}

/**
 * token_accounting 结构。
 *
 * 记录组装/压缩前后的 Token 账目，用于观测与连续压缩监控。
 */
export interface TokenAccounting {
  /** 输入 Token 数（组装时的原始输入）。 */
  input: number;
  /** 保留 Token 数（压缩后保留的原始内容 Token）。 */
  retained: number;
  /** 压缩 Token 数（被压缩为摘要的 Token 数）。 */
  compressed: number;
}

export const contextCheckpoint = mysqlTable(
  "ContextCheckpoint",
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
    checkpointType: mysqlEnum("checkpointType", CHECKPOINT_TYPES).notNull(),
    /** 来源范围数组（SourceRange[]）；含 Thread Item/Event、Memory、Knowledge 的 id 与 hash 范围。 */
    sourceRangesJson: json("sourceRangesJson").notNull().$type<SourceRange[]>(),
    /** 来源范围 hash（对 sourceRangesJson 规范化后 sha256，含算法前缀）。 */
    sourceRangesHash: varchar("sourceRangesHash", { length: 128 }).notNull(),
    /** 摘要对象存储引用（与 summaryRedacted 至少一个非空）。 */
    summaryRef: varchar("summaryRef", { length: 512 }),
    /** 脱敏摘要正文（不含隐藏思维链；与 summaryRef 至少一个非空）。 */
    summaryRedacted: text("summaryRedacted"),
    /** 摘要 hash（sha256: 前缀 + 64 hex）。 */
    summaryHash: varchar("summaryHash", { length: 128 }).notNull(),
    /** 输入 Token 数。 */
    inputTokens: int("inputTokens").notNull(),
    /** 保留 Token 数。 */
    retainedTokens: int("retainedTokens").notNull(),
    /** 压缩 Token 数。 */
    compressedTokens: int("compressedTokens").notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /** 过期时间；过期后可被清理（数据生命周期阶段处理）。 */
    expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }).notNull(),
  },
  (t) => ({
    // 同一 Invocation 同一 checkpoint_type 下 source_ranges_hash 唯一
    // （同次压缩结果可重放，不同压缩结果不重复落库）。
    tenantInvocationTypeRangesUq: uniqueIndex(
      "ContextCheckpoint_tenant_invocation_type_ranges_uq",
    ).on(t.tenantId, t.invocationId, t.checkpointType, t.sourceRangesHash),
    tenantInvocationCreatedIdx: index("ContextCheckpoint_tenant_invocation_created_idx").on(
      t.tenantId,
      t.invocationId,
      t.createdAt,
    ),
    tenantExpiresIdx: index("ContextCheckpoint_tenant_expires_idx").on(t.tenantId, t.expiresAt),
  }),
);

export type ContextCheckpoint = InferSelectModel<typeof contextCheckpoint>;
export type NewContextCheckpoint = InferInsertModel<typeof contextCheckpoint>;
