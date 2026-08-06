/**
 * 控制面 schema：Skill 与 SkillVersion（阶段 6 S06-C01）。
 *
 * 事实源：阶段 6 Skill/Capability 模型（参考 Agent / AgentRevision 结构）。
 *
 * Skill 是租户内可复用能力资产，保存稳定身份、负责人、可见范围、生命周期和当前生效版本。
 * SkillVersion 是不可变的内容版本，承载内容引用（git commitSha 或制品引用）、内容 hash、
 * Skill frontmatter 序列化（manifestJson），以及来源类型与引用。
 *
 * 关键约束：
 * - UNIQUE(tenantId, skillKey)：租户内稳定 key 唯一。
 * - UNIQUE(skillId, versionNo)：Skill 内版本号单调递增。
 * - published SkillVersion 业务内容不可修改；只能新建版本。
 * - withdrawn 只阻止新发布或路由，不删除历史引用。
 * - currentVersionId 必须指向同一 Skill 的 published SkillVersion（逻辑外键，应用层校验）。
 * - skillKey 正则 `^[a-z0-9]+(-[a-z0-9]+)*$`，1-64 字符（应用层校验）。
 * - contentHash 必须以 `sha256:` 前缀存储（应用层校验）。
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

// ─── Skill Lifecycle ───────────────────────────────────────

/**
 * Skill 生命周期状态。
 * - draft：刚创建，未启用。
 * - enabled：已启用，可被引用。
 * - disabled：临时停用。
 * - retired：永久退役（终态，不可恢复）。
 */
export const SKILL_LIFECYCLE_STATES = ["draft", "enabled", "disabled", "retired"] as const;
export type SkillLifecycleState = (typeof SKILL_LIFECYCLE_STATES)[number];

// ─── SkillVersion Revision State ───────────────────────────

/**
 * SkillVersion 状态。
 * - draft：草稿，可编辑。
 * - published：已发布，业务内容不可修改，可被路由引用。
 * - withdrawn：已撤回，只阻止新发布或路由，不删除历史引用。
 */
export const SKILL_REVISION_STATES = ["draft", "published", "withdrawn"] as const;
export type SkillRevisionState = (typeof SKILL_REVISION_STATES)[number];

// ─── Skill Visibility Scope ────────────────────────────────

/**
 * Skill 可见范围。
 * - tenant：租户内可见。
 * - internal：内部可见（员工可调用）。
 * - owner：仅负责人可见。
 */
export const SKILL_VISIBILITY_SCOPES = ["tenant", "internal", "owner"] as const;
export type SkillVisibilityScope = (typeof SKILL_VISIBILITY_SCOPES)[number];

// ─── Skill Source Type ─────────────────────────────────────

/**
 * Skill / SkillVersion 来源类型（varchar 存储以便扩展，不使用 enum 约束）。
 * - local：本地构建。
 * - capability_market：能力市场下发。
 * - external：外部来源。
 */
export const SKILL_SOURCE_TYPES = ["local", "capability_market", "external"] as const;
export type SkillSourceType = (typeof SKILL_SOURCE_TYPES)[number];

// ─── Skill ─────────────────────────────────────────────────

export const skillTable = mysqlTable(
 "Skill",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 租户内稳定唯一 key（slug），正则 `^[a-z0-9]+(-[a-z0-9]+)*$`，1-64 字符（应用层校验）。 */
 skillKey: varchar("skillKey", { length: 128 }).notNull(),
 displayName: varchar("displayName", { length: 256 }).notNull(),
 description: text("description"),
 /** 负责人 userIdentityId（逻辑外键 → UserIdentity.id）。 */
 ownerUserId: varchar("ownerUserId", { length: 36 }).notNull(),
 lifecycleState: mysqlEnum("lifecycleState", SKILL_LIFECYCLE_STATES).notNull().default("draft"),
 /** 当前生效 SkillVersion id（逻辑外键 → SkillVersion.id）；null 表示未发布。 */
 currentVersionId: varchar("currentVersionId", { length: 36 }),
 visibilityScope: varchar("visibilityScope", { length: 32 }).notNull().default("tenant"),
 sourceType: varchar("sourceType", { length: 32 }).notNull().default("local"),
 /** 乐观并发版本号。 */
 versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 deletedAt: datetime("deletedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 tenantKeyUq: uniqueIndex("Skill_tenant_skillKey_uq").on(t.tenantId, t.skillKey),
 tenantLifecycleUpdatedIdx: index("Skill_tenant_lifecycle_updated_idx").on(
 t.tenantId,
 t.lifecycleState,
 t.updatedAt,
 ),
 }),
);

export type Skill = InferSelectModel<typeof skillTable>;
export type NewSkill = InferInsertModel<typeof skillTable>;

// ─── SkillVersion ──────────────────────────────────────────

export const skillVersionTable = mysqlTable(
 "SkillVersion",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 skillId: varchar("skillId", { length: 36 })
 .notNull()
 .references(() => skillTable.id),
 /** Skill 内单调递增版本号。 */
 versionNo: bigint("versionNo", { mode: "number" }).notNull(),
 /** 内容引用（git commitSha 或制品引用）。 */
 contentRef: varchar("contentRef", { length: 512 }).notNull(),
 /** 内容 hash（sha256: 前缀）。 */
 contentHash: varchar("contentHash", { length: 128 }).notNull(),
 /** Skill frontmatter 序列化（name/description/tools/model/runtime）。 */
 manifestJson: json("manifestJson"),
 revisionState: mysqlEnum("revisionState", SKILL_REVISION_STATES).notNull().default("draft"),
 sourceType: varchar("sourceType", { length: 32 }).notNull().default("local"),
 /** 来源引用（capability-market 远端 id 等）。 */
 sourceRef: varchar("sourceRef", { length: 256 }),
 /** 创建者 userIdentityId 或 serviceId。 */
 createdBy: varchar("createdBy", { length: 128 }).notNull(),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 publishedAt: datetime("publishedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 skillVersionNoUq: uniqueIndex("SkillVersion_skill_versionNo_uq").on(t.skillId, t.versionNo),
 skillStateIdx: index("SkillVersion_skill_state_idx").on(t.skillId, t.revisionState),
 }),
);

export type SkillVersion = InferSelectModel<typeof skillVersionTable>;
export type NewSkillVersion = InferInsertModel<typeof skillVersionTable>;
