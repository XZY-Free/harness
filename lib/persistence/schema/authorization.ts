/**
 * 授权 schema（消费方模型 v4 余留面）。
 *
 * 事实源：docs/architecture/persistence.md 。
 *
 * 19 张身份/授权表的 DDL 与迁移归 auth-center（RoleActionBinding / PermissionRole /
 * PermissionRoleAssignment 已随迁移删除本仓定义）；本文件暂时保留：企业链同步所需的
 * PermissionGroup / PermissionGroupMember，与 Agent 资源注册初始化所需的
 * ResourceAccessPolicy（同库过渡态，随第三轮消费化与收尾收敛）。
 */
import { randomUUID } from "node:crypto";
import { principalBinding, tenant } from "@/lib/persistence/schema/identity";
import { json } from "@/lib/persistence/schema/json-column";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { datetime, int, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const permissionGroup = mysqlTable("PermissionGroup", {
  principalId: varchar("principalId", { length: 36 })
    .primaryKey()
    .references(() => principalBinding.id),
  tenantId: varchar("tenantId", { length: 36 })
    .notNull()
    .references(() => tenant.id),
  source: varchar("source", { length: 160 }).notNull().default("local"),
  version: int("version").notNull().default(1),
});

export const permissionGroupMember = mysqlTable(
  "PermissionGroupMember",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(randomUUID),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    groupId: varchar("groupId", { length: 36 })
      .notNull()
      .references(() => permissionGroup.principalId),
    userId: varchar("userId", { length: 36 }).notNull(),
    validUntil: datetime("validUntil", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    memberUq: uniqueIndex("PermissionGroupMember_uq").on(t.tenantId, t.groupId, t.userId),
  }),
);

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
