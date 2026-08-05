/**
 * 身份 schema：租户、用户身份、主体绑定。
 *
 * 阶段 2（S02-W01）：建立四类 API 共用的可信身份与租户边界。
 * - tenant：租户根，所有业务根对象必须校验 tenant。
 * - userIdentity：租户内稳定用户 id，externalSubject 作 SSO 映射键，email/displayName 允许漂移。
 * - principalBinding：外部主体（user/group/role/department）到内部 userIdentity 的映射，不复制组织树。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md 第 2、8 节。
 * 旧 `User` 表保持只读兼容，最终删除安排在阶段 13。
 */
import { randomUUID } from "node:crypto";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
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
  }),
);

export type UserIdentity = InferSelectModel<typeof userIdentity>;
export type NewUserIdentity = InferInsertModel<typeof userIdentity>;

// ─── PrincipalBinding ────────────────────────────────────────

export const PRINCIPAL_SUBJECT_TYPES = ["user", "group", "role", "department"] as const;
export type PrincipalSubjectType = (typeof PRINCIPAL_SUBJECT_TYPES)[number];

export const principalBinding = mysqlTable(
  "PrincipalBinding",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    subjectType: mysqlEnum("subjectType", PRINCIPAL_SUBJECT_TYPES).notNull(),
    /** 外部系统 id（公司用户中心 / 组织系统中的稳定标识）。 */
    externalId: varchar("externalId", { length: 128 }).notNull(),
    displayName: text("displayName"),
    /**
     * 当 subjectType=user 时指向内部 UserIdentity；其他类型为 null。
     * group/role/department 不直接绑定单个用户，由授权层展开。
     */
    userIdentityId: varchar("userIdentityId", { length: 36 }).references(() => userIdentity.id),
    createdAt: datetime("createdAt", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantTypeExternalUq: uniqueIndex("PrincipalBinding_tenant_type_external_uq").on(
      t.tenantId,
      t.subjectType,
      t.externalId,
    ),
    tenantUserIdx: index("PrincipalBinding_tenant_user_idx").on(t.tenantId, t.userIdentityId),
  }),
);

export type PrincipalBinding = InferSelectModel<typeof principalBinding>;
export type NewPrincipalBinding = InferInsertModel<typeof principalBinding>;
