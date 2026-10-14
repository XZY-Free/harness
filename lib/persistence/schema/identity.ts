/**
 * 身份 schema（消费方模型 v4：FK 目标 stub）。
 *
 * 19 张身份/授权表的 DDL 与迁移归 auth-center；本文件只保留 nexharness 侧仍被
 * 外键引用的 2 张 FK 目标定义（不参与本仓迁移生成，见 drizzle.config.ts 的
 * tablesFilter）：
 * - tenant：租户根，所有业务根对象必须校验 tenant（基线 FK 80 处）。
 * - userIdentity：租户内稳定用户 id（少量只读：绑定终稿复核 / resume 停用检查）。
 *
 * 事实源：docs/architecture/persistence.md 第 2、8 节。
 * （PrincipalBinding 等其余表定义已随第三轮消费化删除——引用面归零。）
 */
import { randomUUID } from "node:crypto";
import { json } from "@/lib/persistence/schema/json-column";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  datetime,
  index,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── Tenant ──────────────────────────────────────────────────

export const TENANT_STATUSES = ["active", "suspended"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const tenant = mysqlTable(
  "Tenant",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    /** 稳定 key（slug），例如 "default"。用于 seed 和路由查找。 */
    key: varchar("key", { length: 64 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    status: mysqlEnum("status", TENANT_STATUSES).notNull().default("active"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    keyUq: uniqueIndex("Tenant_key_uq").on(t.key),
  }),
);

export type Tenant = InferSelectModel<typeof tenant>;
export type NewTenant = InferInsertModel<typeof tenant>;

// ─── UserIdentity ────────────────────────────────────────────

export const USER_IDENTITY_STATUSES = ["active", "disabled"] as const;
export type UserIdentityStatus = (typeof USER_IDENTITY_STATUSES)[number];

export const userIdentity = mysqlTable(
  "UserIdentity",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** SSO subject / employee id（公司用户中心稳定标识）。作租户内 upsert 键。 */
    externalSubject: varchar("externalSubject", { length: 128 }).notNull(),
    /** 可信认证提供器确认的登录账号；尚未接入账号认证的历史身份允许为空。 */
    loginAccount: varchar("loginAccount", { length: 128 }),
    /** email 允许漂移更新，不再是身份主键。 */
    email: varchar("email", { length: 128 }).notNull(),
    displayName: text("displayName"),
    status: mysqlEnum("status", USER_IDENTITY_STATUSES).notNull().default("active"),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantSubjectUq: uniqueIndex("UserIdentity_tenant_subject_uq").on(
      t.tenantId,
      t.externalSubject,
    ),
    tenantEmailIdx: index("UserIdentity_tenant_email_idx").on(t.tenantId, t.email),
    tenantAccountUq: uniqueIndex("UserIdentity_tenant_account_uq").on(t.tenantId, t.loginAccount),
  }),
);

export type UserIdentity = InferSelectModel<typeof userIdentity>;
export type NewUserIdentity = InferInsertModel<typeof userIdentity>;
