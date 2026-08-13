/**
 * 控制面 schema：Agent 与 AgentRevision。
 *
 * 事实源：docs/architecture/persistence.md -4.2、
 * docs/architecture/domain-model.md 、
 * docs/architecture/agent-control-plane.md 。
 *
 * Agent 是员工目录中唯一可运行资产，保存稳定身份、负责人、可见范围和当前发布摘要。
 * AgentRevision 保存 Agent 自身不可变的代码、指令、模型策略、权限要求、委派范围和制品摘要。
 *
 * 关键约束：
 * - UNIQUE(tenantId, agentKey)：租户内稳定 key 唯一。
 * - UNIQUE(agentId, revisionNo)：Agent 内修订号单调递增。
 * - published Revision 业务内容不可修改；只能新建修订。
 * - withdrawn 只阻止新发布或路由，不删除历史引用。
 * - currentRevisionId 必须指向同一 Agent 的 published Revision（逻辑外键，应用层校验）。
 *
 * 旧 `Agent` 表（B1 只读档案）保持兼容，最终迁移安排在阶段 13。
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

// ─── Agent Lifecycle ────────────────────────────────────────

/**
 * Agent 生命周期状态。
 * - draft：刚创建，未启用。
 * - enabled：已启用，可被路由。
 * - disabled：临时停用。
 * - retired：永久退役（终态，不可恢复）。
 */
export const AGENT_LIFECYCLE_STATES = ["draft", "enabled", "disabled", "retired"] as const;
export type AgentLifecycleState = (typeof AGENT_LIFECYCLE_STATES)[number];

// ─── AgentRevision State ────────────────────────────────────

/**
 * AgentRevision 状态。
 * - draft：草稿，可编辑业务内容。
 * - published：已发布，业务内容不可修改，可被路由引用。
 * - withdrawn：已撤回，只阻止新发布或路由，不删除历史引用。
 */
export const AGENT_REVISION_STATES = ["draft", "published", "withdrawn"] as const;
export type AgentRevisionState = (typeof AGENT_REVISION_STATES)[number];

// ─── Agent Revision Source Type ─────────────────────────────

/**
 * Revision 来源类型（varchar 存储以便扩展，不使用 enum 约束）。
 * - code：源代码直接构建。
 * - agent_yaml：agent.yaml 声明式配置。
 * - veadk：veadk 制品。
 */
export const AGENT_REVISION_SOURCE_TYPES = ["code", "agent_yaml", "veadk"] as const;
export type AgentRevisionSourceType = (typeof AGENT_REVISION_SOURCE_TYPES)[number];

// ─── Agent ──────────────────────────────────────────────────

export const agentTable = mysqlTable(
  "Agent",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 租户内稳定唯一 key（slug），例如 "finance"。 */
    agentKey: varchar("agentKey", { length: 128 }).notNull(),
    displayName: varchar("displayName", { length: 256 }).notNull(),
    /** 介绍，不存系统指令。 */
    description: text("description"),
    /** 负责人 userIdentityId（逻辑外键 → UserIdentity.id）。 */
    ownerUserId: varchar("ownerUserId", { length: 36 }).notNull(),
    lifecycleState: mysqlEnum("lifecycleState", AGENT_LIFECYCLE_STATES).notNull().default("draft"),
    /** 当前发布修订 id（逻辑外键 → AgentRevision.id）；null 表示未发布。 */
    currentRevisionId: varchar("currentRevisionId", { length: 36 }),
    /** 员工使用范围策略 id（逻辑外键，后续阶段接入）。 */
    visibilityPolicyId: varchar("visibilityPolicyId", { length: 36 }),
    /** 乐观并发版本号。 */
    versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    deletedAt: datetime("deletedAt", { mode: "date" }),
  },
  (t) => ({
    tenantKeyUq: uniqueIndex("Agent_tenant_agentKey_uq").on(t.tenantId, t.agentKey),
    tenantLifecycleUpdatedIdx: index("Agent_tenant_lifecycle_updated_idx").on(
      t.tenantId,
      t.lifecycleState,
      t.updatedAt,
    ),
  }),
);

export type Agent = InferSelectModel<typeof agentTable>;
export type NewAgent = InferInsertModel<typeof agentTable>;

// ─── AgentRevision ──────────────────────────────────────────

export const agentRevisionTable = mysqlTable(
  "AgentRevision",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    agentId: varchar("agentId", { length: 36 })
      .notNull()
      .references(() => agentTable.id),
    /** Agent 内单调递增修订号。 */
    revisionNo: bigint("revisionNo", { mode: "number" }).notNull(),
    /** 来源类型（code/agent_yaml/veadk）。varchar 存储以便扩展。 */
    sourceType: varchar("sourceType", { length: 32 }).notNull(),
    /** Git commit 或制品修订标识。 */
    sourceRevision: varchar("sourceRevision", { length: 128 }).notNull(),
    /** 指令内容 hash。 */
    instructionHash: varchar("instructionHash", { length: 128 }).notNull(),
    /** Agent 代码/agent.yaml 制品引用；由 Runtime 加载，不是 Runtime 主机镜像。 */
    agentArtifactRef: varchar("agentArtifactRef", { length: 512 }).notNull(),
    /** 权威控制面 Artifact；旧 Revision 可为空。 */
    artifactId: varchar("artifactId", { length: 36 }),
    /** 与 artifactId 同时冻结的内容摘要。 */
    artifactDigest: varchar("artifactDigest", { length: 71 }),
    /** 默认模型策略。 */
    modelPolicyJson: json("modelPolicyJson").notNull(),
    /** 权限要求。 */
    permissionRequirementsJson: json("permissionRequirementsJson").notNull(),
    /** 委派范围。 */
    delegationPolicyJson: json("delegationPolicyJson").notNull(),
    /** required 与 optional 注入接口分开记录；不代表 Runtime 实际能力。 */
    agentInterfaceRequirementsJson: json("agentInterfaceRequirementsJson").notNull(),
    revisionState: mysqlEnum("revisionState", AGENT_REVISION_STATES).notNull().default("draft"),
    /** 创建者 userIdentityId 或 serviceId。 */
    createdBy: varchar("createdBy", { length: 128 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    publishedAt: datetime("publishedAt", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    agentRevisionNoUq: uniqueIndex("AgentRevision_agent_revisionNo_uq").on(t.agentId, t.revisionNo),
    agentStateIdx: index("AgentRevision_agent_state_idx").on(t.agentId, t.revisionState),
    artifactIdx: index("AgentRevision_artifact_idx").on(t.artifactId),
  }),
);

export type AgentRevision = InferSelectModel<typeof agentRevisionTable>;
export type NewAgentRevision = InferInsertModel<typeof agentRevisionTable>;
