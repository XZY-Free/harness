/**
 * 控制面 schema：CatalogEntry 与 CatalogRevision（阶段 6 S06-C03）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §4.5（catalog_entry 读模型）
 * - ../v11-agentkit-platform/12-capability-and-collaboration-api.md §2（Employee Catalog API）、§3.1（CatalogSearchItem）
 * - ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §2（统一目录）
 *
 * CatalogEntry 是只读投影读模型，由投影器从 Agent / Skill / Tool / Connection 等事实源派生；
 * 没有 Admin API 可直接写 CatalogEntry，所有变更通过 refreshCatalogEntry / refreshCatalogByType 触发。
 *
 * CatalogRevision 是租户级目录修订游标，配合 ETag/If-None-Match 实现短路径 304：
 * - 客户端首次请求无 If-None-Match，服务端返回最新目录 + ETag（catalog-{tenantId}-{audience}-{revisionNo}）。
 * - 客户端再次请求带上 If-None-Match，服务端比较 revisionNo，未变化返回 304 Not Modified。
 * - 任意资源投影刷新 → advanceCatalogRevision 推进 currentRevision。
 *
 * 关键约束：
 * - UNIQUE(tenantId, resourceType, resourceId)：资源在租户内目录唯一。
 * - UNIQUE(tenantId, audience)：每个租户每个 audience 一条修订游标。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - 投影幂等：同一资源重复刷新不会产生新行，只更新内容并推进 catalogRevision。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  datetime,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── Catalog Resource Type ────────────────────────────────

/**
 * Catalog 资源类型。
 * - agent：Agent 资产（员工目录中唯一可运行资产）。
 * - skill：Skill 能力资产。
 * - tool：Tool 能力资产。
 * - knowledge：知识资产（后续阶段接入）。
 * - runtime：Runtime 资产（后续阶段接入）。
 * - model：模型资产（后续阶段接入）。
 * - connection：Connection 资产（后续阶段接入）。
 */
export const CATALOG_RESOURCE_TYPES = [
  "agent",
  "skill",
  "tool",
  "knowledge",
  "runtime",
  "model",
  "connection",
] as const;
export type CatalogResourceType = (typeof CATALOG_RESOURCE_TYPES)[number];

// ─── Catalog Audience ─────────────────────────────────────

/**
 * Catalog 受众类型。
 * - employee：员工目录（/api/v1/catalog/options）。
 * - runtime：Runtime 内部目录（后续阶段接入 /runtime/v1/catalog/*）。
 */
export const CATALOG_AUDIENCES = ["employee", "runtime"] as const;
export type CatalogAudience = (typeof CATALOG_AUDIENCES)[number];

// ─── CatalogEntry ─────────────────────────────────────────

export const catalogEntryTable = mysqlTable(
  "CatalogEntry",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 资源类型（agent/skill/tool/knowledge/runtime/model/connection）。 */
    resourceType: varchar("resourceType", { length: 32 }).notNull(),
    /** 资源 id（对应事实源表的主键）。 */
    resourceId: varchar("resourceId", { length: 36 }).notNull(),
    /** 显示名（人类可读）。 */
    displayName: varchar("displayName", { length: 256 }).notNull(),
    /** 描述（来自事实源；可为空）。 */
    description: text("description"),
    /** 负责人 userIdentityId（逻辑外键 → UserIdentity.id）；可为空。 */
    ownerUserId: varchar("ownerUserId", { length: 36 }),
    /** 标签数组（JSON string[]），用于 searchCatalog 过滤；可为空。 */
    tagsJson: json("tagsJson"),
    /** 事实源 lifecycle 状态镜像（如 draft/enabled/disabled/retired）。 */
    lifecycleState: varchar("lifecycleState", { length: 32 }).notNull(),
    /** 可见性摘要（如 tenant/internal/owner）；用于客户端展示。 */
    visibilitySummary: varchar("visibilitySummary", { length: 64 }).notNull(),
    /** 事实源最近 updatedAt（投影时镜像，便于增量判断）。 */
    sourceUpdatedAt: datetime("sourceUpdatedAt", { mode: "date", fsp: 3 }).notNull(),
    /** 本次投影写入时间。 */
    projectedAt: datetime("projectedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /** 当前所属租户目录的修订号（与 CatalogRevision.currentRevision 对齐）。 */
    catalogRevision: bigint("catalogRevision", { mode: "number" }).notNull(),
  },
  (t) => ({
    tenantResourceUq: uniqueIndex("CatalogEntry_tenant_resourceType_resourceId_uq").on(
      t.tenantId,
      t.resourceType,
      t.resourceId,
    ),
    tenantTypeLifecycleIdx: index("CatalogEntry_tenant_resourceType_lifecycle_idx").on(
      t.tenantId,
      t.resourceType,
      t.lifecycleState,
    ),
    tenantRevisionIdx: index("CatalogEntry_tenant_catalogRevision_idx").on(
      t.tenantId,
      t.catalogRevision,
    ),
  }),
);

export type CatalogEntry = InferSelectModel<typeof catalogEntryTable>;
export type NewCatalogEntry = InferInsertModel<typeof catalogEntryTable>;

// ─── CatalogRevision ──────────────────────────────────────

export const catalogRevisionTable = mysqlTable(
  "CatalogRevision",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 受众（employee/runtime）。 */
    audience: mysqlEnum("audience", CATALOG_AUDIENCES).notNull(),
    /** 当前修订号（任意资源投影刷新后单调递增）。 */
    currentRevision: bigint("currentRevision", { mode: "number" }).notNull().default(0),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantAudienceUq: uniqueIndex("CatalogRevision_tenant_audience_uq").on(t.tenantId, t.audience),
  }),
);

export type CatalogRevision = InferSelectModel<typeof catalogRevisionTable>;
export type NewCatalogRevision = InferInsertModel<typeof catalogRevisionTable>;
