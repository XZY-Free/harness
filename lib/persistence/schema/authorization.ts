/**
 * 授权 schema：role_action_binding。
 *
 * 事实源：docs/architecture/persistence.md 。
 *
 * role_action_binding 把 principal_binding 绑定到稳定 action_code + 类型化 resource_scope。
 * - action_code 使用固定目录（lib/identity/action-codes.ts）。
 * - 外部角色只映射到 principal_binding，不直接作为服务端权限判断。
 * - validUntil 为 null 表示长期有效；撤销通过回填 validUntil 实现（不物理删除）。
 */
import { randomUUID } from "node:crypto";
import { principalBinding, tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  datetime,
  index,
  int,
  json,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const roleActionBinding = mysqlTable(
  "RoleActionBinding",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    principalBindingId: varchar("principalBindingId", { length: 36 })
      .notNull()
      .references(() => principalBinding.id),
    /** 稳定 action code（见 ACTION_CODES 目录）。 */
    actionCode: varchar("actionCode", { length: 64 }).notNull(),
    /** 类型化 resource scope JSON（见 ResourceScope）。 */
    resourceScopeJson: text("resourceScopeJson").notNull(),
    validFrom: datetime("validFrom", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /** null 表示长期有效；撤销回填 validUntil = now。 */
    validUntil: datetime("validUntil", { mode: "date", fsp: 3 }),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantPrincipalIdx: index("RoleActionBinding_tenant_principal_idx").on(
      t.tenantId,
      t.principalBindingId,
    ),
    tenantActionIdx: index("RoleActionBinding_tenant_action_idx").on(t.tenantId, t.actionCode),
  }),
);

export type RoleActionBinding = InferSelectModel<typeof roleActionBinding>;
export type NewRoleActionBinding = InferInsertModel<typeof roleActionBinding>;

/** 自定义职责包；内置职责定义来自统一目录，不可由用户覆盖。 */
export const permissionRole = mysqlTable(
  "PermissionRole",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(randomUUID),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    name: varchar("name", { length: 128 }).notNull(),
    permissions: json("permissions").notNull(),
    version: int("version").notNull().default(1),
  },
  (t) => ({ nameUq: uniqueIndex("PermissionRole_tenant_name_uq").on(t.tenantId, t.name) }),
);

/** 明确的角色分配；角色修改不再覆盖其他来源的直接授权。 */
export const permissionRoleAssignment = mysqlTable(
  "PermissionRoleAssignment",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(randomUUID),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    principalId: varchar("principalId", { length: 36 })
      .notNull()
      .references(() => principalBinding.id),
    roleKey: varchar("roleKey", { length: 96 }).notNull(),
    source: varchar("source", { length: 128 }).notNull().default("local"),
  },
  (t) => ({
    assignmentUq: uniqueIndex("PermissionRoleAssignment_uq").on(
      t.tenantId,
      t.principalId,
      t.roleKey,
      t.source,
    ),
  }),
);

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
