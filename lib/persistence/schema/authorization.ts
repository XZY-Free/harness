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
import { datetime, index, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";

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
