/**
 * 身份 schema：租户、用户身份、主体绑定。
 *
 * 建立四类 API 共用的可信身份与租户边界。
 * - tenant：租户根，所有业务根对象必须校验 tenant。
 * - userIdentity：租户内稳定用户 id，externalSubject 作 SSO 映射键，email/displayName 允许漂移。
 * - principalBinding：外部主体（user/group/role/department）到内部 userIdentity 的映射，不复制组织树。
 *
 * 事实源：docs/architecture/persistence.md 第 2、8 节。
 * `UserIdentity` 是唯一用户身份事实源；旧 `User` 表已删除。
 */
import { randomUUID } from "node:crypto";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  datetime,
  decimal,
  index,
  json,
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

// ─── Enterprise user profile facts ───────────────────────────

export const ENTERPRISE_ATTRIBUTE_VALUE_TYPES = ["string", "number", "boolean", "json"] as const;
export type EnterpriseAttributeValueType = (typeof ENTERPRISE_ATTRIBUTE_VALUE_TYPES)[number];

/**
 * 企业用户当前扩展属性 Authority。
 *
 * 一项属性一行，唯一键锁定在 (userIdentityId, attributeKey)。四个值槽仅能由
 * valueType 对应的一个槽承载；应用层在写入前强制校验，避免 JSON 成为自由字段袋。
 */
export const userExtensionAttribute = mysqlTable(
  "UserExtensionAttribute",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    userIdentityId: varchar("userIdentityId", { length: 36 })
      .notNull()
      .references(() => userIdentity.id),
    attributeKey: varchar("attributeKey", { length: 96 }).notNull(),
    valueType: mysqlEnum("valueType", ENTERPRISE_ATTRIBUTE_VALUE_TYPES).notNull(),
    stringValue: text("stringValue"),
    numberValue: decimal("numberValue", { precision: 30, scale: 10 }),
    booleanValue: boolean("booleanValue"),
    jsonValue: json("jsonValue"),
    sourceSystem: varchar("sourceSystem", { length: 128 }).notNull(),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    userAttributeUq: uniqueIndex("UserExtensionAttribute_user_key_uq").on(
      t.userIdentityId,
      t.attributeKey,
    ),
    userAttributeIdx: index("UserExtensionAttribute_user_idx").on(t.userIdentityId),
    valueSlotCheck: check(
      "UserExtensionAttribute_value_slot_ck",
      sql`(
        (valueType = 'string' AND stringValue IS NOT NULL AND numberValue IS NULL AND booleanValue IS NULL AND jsonValue IS NULL)
        OR (valueType = 'number' AND stringValue IS NULL AND numberValue IS NOT NULL AND booleanValue IS NULL AND jsonValue IS NULL)
        OR (valueType = 'boolean' AND stringValue IS NULL AND numberValue IS NULL AND booleanValue IS NOT NULL AND jsonValue IS NULL)
        OR (valueType = 'json' AND stringValue IS NULL AND numberValue IS NULL AND booleanValue IS NULL AND jsonValue IS NOT NULL)
      `,
    ),
  }),
);

export type UserExtensionAttribute = InferSelectModel<typeof userExtensionAttribute>;
export type NewUserExtensionAttribute = InferInsertModel<typeof userExtensionAttribute>;

/**
 * 每位用户唯一一份企业资料同步元数据。它不是第二身份或资料版本表，只保存当前
 * 资料的新鲜度、指纹和脱敏错误分类。
 */
export const enterpriseProfileSyncState = mysqlTable(
  "EnterpriseProfileSyncState",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    userIdentityId: varchar("userIdentityId", { length: 36 })
      .notNull()
      .references(() => userIdentity.id),
    profileFingerprint: varchar("profileFingerprint", { length: 72 }).notNull(),
    lastVerifiedAt: datetime("lastVerifiedAt", { mode: "date", fsp: 3 }).notNull(),
    stale: boolean("stale").notNull().default(false),
    /** 仅稳定分类；不得保存上游错误消息或响应。 */
    lastSyncErrorCode: varchar("lastSyncErrorCode", { length: 96 }),
    sourceSystem: varchar("sourceSystem", { length: 128 }).notNull(),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    userUq: uniqueIndex("EnterpriseProfileSyncState_user_uq").on(t.userIdentityId),
  }),
);

export type EnterpriseProfileSyncState = InferSelectModel<typeof enterpriseProfileSyncState>;
export type NewEnterpriseProfileSyncState = InferInsertModel<typeof enterpriseProfileSyncState>;

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
