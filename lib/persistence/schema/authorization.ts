/**
 * 授权 schema（消费方模型 v4 余留面）。
 *
 * 事实源：docs/architecture/persistence.md 。
 *
 * 19 张身份/授权表的 DDL 与迁移归 auth-center；本文件仅保留 Agent 资源注册
 * 初始化所需的 ResourceAccessPolicy（同库过渡态——写入初始化移交 auth-center
 * 资源注册接口后随收尾轮退役）。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import { json } from "@/lib/persistence/schema/json-column";
import { int, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

/** 稳定资产上的使用和协作范围，不随 Agent revision 重置。 */
export const resourceAccessPolicy = mysqlTable(
  "ResourceAccessPolicy",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(randomUUID),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    resourceType: varchar("resourceType", { length: 64 }).notNull(),
    resourceId: varchar("resourceId", { length: 36 }).notNull(),
    mode: varchar("mode", { length: 16 }).notNull().default("inherit"),
    principals: json("principals").notNull(),
    collaborators: json("collaborators").notNull(),
    version: int("version").notNull().default(1),
  },
  (t) => ({
    resourceUq: uniqueIndex("ResourceAccessPolicy_resource_uq").on(
      t.tenantId,
      t.resourceType,
      t.resourceId,
    ),
  }),
);
