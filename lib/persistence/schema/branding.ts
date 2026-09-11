/**
 * 品牌 schema：平台品牌配置文档与变更审计。
 *
 * BrandSettings 为单行文档表（id 固定 1）：document 存 BrandContract JSON，
 * revision 单调递增，是所有热更新与缓存失效的唯一依据；updatedAt/updatedBy 记录最近一次写。
 * BrandChangeAudit 只增不改：记录每次品牌变更的 revision 前后、patch 与操作者，供审计回溯。
 *
 * 分层语义（品牌可配置定案 2026-09-11）：本表是运行时主存储；branding.json 与
 * SNOW_BRAND_* 环境变量为部署期 pin 层，不入库；被 pin 字段拒绝 API 写入。
 *
 * 事实源：docs/architecture/persistence.md。
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { bigint, datetime, index, int, json, mysqlTable, varchar } from "drizzle-orm/mysql-core";

export const brandSettings = mysqlTable("BrandSettings", {
  /** 单行文档表：固定 1。 */
  id: int("id").primaryKey().default(1),
  /** BrandContract JSON 文档（name/tagline/logo/icon/packaging/...）。 */
  document: json("document").$type<Record<string, unknown>>().notNull(),
  /** 单调递增版本号；热更新与 ETag 的唯一依据。 */
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 }).notNull(),
  updatedBy: varchar("updatedBy", { length: 128 }),
});

export const brandChangeAudit = mysqlTable(
  "BrandChangeAudit",
  {
    id: bigint("id", { mode: "number" }).primaryKey().autoincrement(),
    revisionBefore: bigint("revisionBefore", { mode: "number" }).notNull(),
    revisionAfter: bigint("revisionAfter", { mode: "number" }).notNull(),
    /** 本次写入的 partial patch（不含解析后全文）。 */
    patch: json("patch").$type<Record<string, unknown>>().notNull(),
    changedAt: datetime("changedAt", { mode: "date", fsp: 3 }).notNull(),
    changedBy: varchar("changedBy", { length: 128 }),
  },
  (table) => [index("BrandChangeAudit_revision_idx").on(table.revisionAfter)],
);

export type BrandSettingsRecord = InferSelectModel<typeof brandSettings>;
export type BrandSettingsInsert = InferInsertModel<typeof brandSettings>;
export type BrandChangeAuditRecord = InferSelectModel<typeof brandChangeAudit>;
export type BrandChangeAuditInsert = InferInsertModel<typeof brandChangeAudit>;
