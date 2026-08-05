/**
 * 运行产物 schema：Artifact（阶段 8 S08-C06）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §7.4（artifact）、§5.4（Item 多态 artifact）、
 *   §6.6（tool_call.result_artifact_id 反向引用）。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §5.3（Artifact 上传 API）。
 * - ../v11-agentkit-platform/09-unified-domain-model.md §7（运行产物边界）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W06。
 *
 * 与 lib/persistence/schema/artifact.ts（ArtifactAttestation 控制面供应链证明）是不同概念：
 * - ArtifactAttestation：对 AgentRevision/RuntimeRevision/Skill/Tool/Policy 等制品做签名/SBOM 验证。
 * - Artifact（本表）：运行时产物（ToolCall/Job 生成的 Excel、报告、图片等）。
 *
 * 关键不变量：
 * - 大内容进入对象存储或原 Workspace，表中只保存受控引用（contentRef）和 hash（contentHash）。
 * - contentRef 必须是受管对象引用（s3:// / oci:// / gs:// / file://internal/...），
 *   不接受公网 http(s):// URL。
 * - contentHash 必须是 sha256:<64-hex> 格式（不接受可变 tag）。
 * - 非空 itemId 必须唯一（员工可见 Artifact Item 一对一）。
 * - 会话产物（threadId/turnId 非空）与 Job 产物（jobId 非空）互斥，不可同时填写。
 * - Job Artifact 不得直接改挂到 Thread；进入会话需走 job_result_projection（§7.4）。
 * - 写入后不可变（无状态机、无 versionNo 乐观锁）；expiresAt 用于清理但不更新状态字段。
 * - 跨租户隔离：所有查询按 tenantId 过滤；tenantId 外键 → Tenant(id) ON DELETE CASCADE。
 * - invocationId / threadId / turnId / jobId / itemId 均为逻辑外键（不加 DB FK 避免跨阶段耦合）。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { bigint, datetime, index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

// ─── RuntimeArtifactType ─────────────────────────────────

/**
 * 运行产物类型（应用层枚举，文档未限定穷尽值）。
 * - file：普通文件。
 * - image：图片。
 * - archive：压缩包。
 * - report：报告（如 Excel/PDF）。
 * - dataset：数据集。
 * - log：日志文件。
 *
 * 文档允许其他类型；新类型需通过 schema 修订引入并同步应用层校验。
 */
export const RUNTIME_ARTIFACT_TYPES = [
  "file",
  "image",
  "archive",
  "report",
  "dataset",
  "log",
] as const;
export type RuntimeArtifactType = (typeof RUNTIME_ARTIFACT_TYPES)[number];

// ─── VisibilityScope ─────────────────────────────────────

/**
 * Artifact 访问范围。
 * - thread：会话产物（threadId 非空时默认）。
 * - workspace：Workspace 范围可见。
 * - owner：仅创建者可见。
 * - organization：组织范围可见（预留）。
 */
export const VISIBILITY_SCOPES = ["thread", "workspace", "owner", "organization"] as const;
export type VisibilityScope = (typeof VISIBILITY_SCOPES)[number];

// ─── Artifact 表 ──────────────────────────────────────

/**
 * Artifact 表：运行时产物引用（§7.4）。
 *
 * 关键约束：
 * - UNIQUE(itemId)：非空 itemId 必须唯一（员工可见 Artifact Item 一对一）。
 * - tenantId 冗余字段（与 invocationId 隐含的 tenantId 一致；由调用方保证）。
 * - 会话产物（threadId/turnId 非空）与 Job 产物（jobId 非空）互斥。
 * - contentRef / contentHash / artifactType / displayName 写入后不可修改（不可变事实）。
 * - expiresAt 可在清理任务中用作筛选条件，但不更新状态字段。
 */
export const artifactTable = mysqlTable(
  "Artifact",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 所属 Invocation id（逻辑外键 → Invocation.id；必填）。 */
    invocationId: varchar("invocationId", { length: 36 }).notNull(),
    /** 所属 Thread id（会话产物时填；Job 产物为 null）。 */
    threadId: varchar("threadId", { length: 36 }),
    /** 所属 Turn id（会话产物时填；Job 产物为 null）。 */
    turnId: varchar("turnId", { length: 36 }),
    /** 所属 Job id（Job 产物时填；会话产物为 null）。 */
    jobId: varchar("jobId", { length: 36 }),
    /** 员工可见 Artifact Item id（逻辑外键 → ThreadItem.id；非空时唯一）。 */
    itemId: varchar("itemId", { length: 36 }),
    /** 产物类型（应用层枚举）。 */
    artifactType: varchar("artifactType", { length: 32 }).notNull(),
    /** 员工可见文件名。 */
    displayName: varchar("displayName", { length: 256 }).notNull(),
    /** 受管对象存储引用（s3:// / oci:// / gs:// / file://internal/...；不接受公网 URL）。 */
    contentRef: varchar("contentRef", { length: 512 }).notNull(),
    /** MIME type。 */
    mediaType: varchar("mediaType", { length: 128 }).notNull(),
    /** 内容字节大小。 */
    byteSize: bigint("byteSize", { mode: "number" }).notNull(),
    /** 内容摘要（sha256: 前缀 + 64 hex；不接受可变 tag）。 */
    contentHash: varchar("contentHash", { length: 128 }).notNull(),
    /** 访问范围（thread / workspace / owner / organization）。 */
    visibilityScope: varchar("visibilityScope", { length: 32 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /** 过期时间（用于临时产物清理；null 表示不过期）。 */
    expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    itemIdUq: uniqueIndex("Artifact_itemId_uq").on(t.itemId),
    tenantInvocationIdx: index("Artifact_tenant_invocation_idx").on(t.tenantId, t.invocationId),
    tenantThreadIdx: index("Artifact_tenant_thread_idx").on(t.tenantId, t.threadId),
    tenantJobIdx: index("Artifact_tenant_job_idx").on(t.tenantId, t.jobId),
    tenantExpiresIdx: index("Artifact_tenant_expires_idx").on(t.tenantId, t.expiresAt),
  }),
);

export type Artifact = InferSelectModel<typeof artifactTable>;
export type NewArtifact = InferInsertModel<typeof artifactTable>;
