/**
 * 稳定 Agent Schema — 正式控制面职责命名。
 *
 * 本文件是 Agent / AgentRevision 的单一物理 Schema 权威：
 * - 本文件持有 Agent / AgentRevision 的物理 MySQL 表定义（表名即存储名）。
 * - 正式模块只使用本文件导出的职责命名，不 Import lib/persistence/schema。
 *
 * 事实源：docs/architecture/persistence.md -4.2、
 * docs/architecture/domain-model.md 、
 * docs/architecture/agent-control-plane.md 。
 *
 * Agent 是员工目录中的一种可治理能力资产，仅在 Route 绑定时参与执行；SnowHarness
 * 始终是 Harness，Agent 不是 Thread 或基础执行的前提。Agent 保存稳定身份、负责人、
 * 生命周期和当前发布摘要。
 * AgentRevision 保存 Agent 的平台认可外部合同修订：绑定的 AgentContractSnapshot、模型策略、
 * 权限要求、委派范围和 Runtime 技术接口要求。Agent 对平台是源码不可见黑盒。
 *
 * 关键约束：
 * - UNIQUE(tenantId, agentKey)：租户内稳定 key 唯一。
 * - UNIQUE(agentId, revisionNo)：Agent 内修订号单调递增。
 * - published Revision 业务内容不可修改；只能新建修订。
 * - withdrawn 只阻止新发布或路由，不删除历史引用。
 * - currentRevisionId 必须指向同一 Agent 的 published Revision（逻辑外键，应用层校验）。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  boolean,
  datetime,
  foreignKey,
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
    /**
     * 当前已发布修订的反规范化摘要（逻辑外键 → AgentRevision.id）；null 表示无当前发布。
     * 仅供管理投影与目录快速判断；执行资格由 Publication + Route + Projection + Binding 冻结。
     */
    currentRevisionId: varchar("currentRevisionId", { length: 36 }),
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
    /**
     * 绑定的不可变 AgentContractSnapshot id（逻辑外键 → AgentContractSnapshot.id）。
     * 创建 Revision 时必须精确引用一个同 tenant/Agent 的 Snapshot；发布证据从该
     * 结构化快照冻结。SnowHarness 对 Agent 一律按源码不可见黑盒处理——Revision 的
     * 唯一权威来源是 AgentContractSnapshot，创建后不可换绑（合同变化必须
     * new Snapshot → new AgentRevision）。
     */
    agentContractSnapshotId: varchar("agentContractSnapshotId", { length: 36 }).notNull(),
    /** Agent 内单调递增修订号。 */
    revisionNo: bigint("revisionNo", { mode: "number" }).notNull(),
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
  }),
);

export type AgentRevision = InferSelectModel<typeof agentRevisionTable>;
export type NewAgentRevision = InferInsertModel<typeof agentRevisionTable>;

// ─── Canonical Row 别名（领域面向的行类型名）────────────────
export type AgentRow = Agent;
export type AgentRevisionRow = AgentRevision;
export type NewAgentRow = NewAgent;
export type NewAgentRevisionRow = NewAgentRevision;

// ─── Public Agent Contract（登记的结构化合同快照）──────────

/** invocation context 必要性（与领域合同一致）。 */
const CONTRACT_CONTEXT_NECESSITIES = ["required", "preferred", "accepted"] as const;
/** 合同声明来源。 */
const CONTRACT_PROVENANCE_SOURCES = ["provider_declared", "operator_declared"] as const;

/**
 * AgentContractSnapshot：管理员登记 Public Agent Contract（agent-contract.json）产生的
 * 不可变结构化快照 header。
 *
 * 关键约束：
 * - 合同文件是 request-only 输入：每个合同事实持久化为显式列/子记录，绝不持久化整份源文件、
 *   原始合同对象或整节 JSON（无 rawContract/canonicalProviderDescriptor 类整节 payload 列）。
 * - supportedLocales / resultFields / errorCodes 是字段级数组（对应字段，非整节 payload）。
 * - protocolType / protocolContractRevision 来自登记命令的显式 protocol 字段（合同文件不含
 *   protocol，禁止硬编码默认）。
 * - 快照不可变：登记后不可 UPDATE；同一合同再次显式登记生成新快照。
 */
export const agentContractSnapshotTable = mysqlTable(
  "AgentContractSnapshot",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    agentId: varchar("agentId", { length: 36 })
      .notNull()
      .references(() => agentTable.id),
    /** 合同 contract_version。 */
    contractVersion: varchar("contractVersion", { length: 64 }).notNull(),
    /** 合同 agent.id（登记时必须等于目标 Agent.agentKey）。 */
    publicAgentId: varchar("publicAgentId", { length: 128 }).notNull(),
    /** 合同 agent.version。 */
    publicAgentVersion: varchar("publicAgentVersion", { length: 64 }).notNull(),
    agentNameZhCn: varchar("agentNameZhCn", { length: 256 }).notNull(),
    agentNameEn: varchar("agentNameEn", { length: 256 }),
    /** 登记命令显式提供的协议事实（不来自合同文件）。 */
    protocolType: varchar("protocolType", { length: 32 }).notNull(),
    protocolContractRevision: varchar("protocolContractRevision", { length: 128 }).notNull(),
    streamingTransport: boolean("streamingTransport").notNull(),
    incrementalContent: boolean("incrementalContent").notNull(),
    inputRequired: boolean("inputRequired").notNull(),
    resume: boolean("resume").notNull(),
    cancel: boolean("cancel").notNull(),
    durableTaskRecovery: boolean("durableTaskRecovery").notNull(),
    /** 字段级数组：interaction.supported_locales。 */
    supportedLocales: json("supportedLocales").notNull(),
    /** 字段级数组：result_contract.fields。 */
    resultFields: json("resultFields").notNull(),
    /** 字段级数组：result_contract.error_codes。 */
    errorCodes: json("errorCodes").notNull(),
    resultNotesZhCn: text("resultNotesZhCn"),
    resultNotesEn: text("resultNotesEn"),
    /** 稳定 canonical digest（sha256: 前缀）。 */
    contractDigest: varchar("contractDigest", { length: 71 }).notNull(),
    capabilityDigest: varchar("capabilityDigest", { length: 71 }).notNull(),
    contextDigest: varchar("contextDigest", { length: 71 }).notNull(),
    /** 登记捕获时间。 */
    capturedAt: datetime("capturedAt", { mode: "date", fsp: 3 }).notNull(),
    /** 创建者 userIdentityId 或 serviceId。 */
    createdBy: varchar("createdBy", { length: 128 }).notNull(),
  },
  (t) => ({
    tenantAgentIdx: index("AgentContractSnapshot_tenant_agent_idx").on(t.tenantId, t.agentId),
    agentIdx: index("AgentContractSnapshot_agent_idx").on(t.agentId),
  }),
);

export type AgentContractSnapshot = InferSelectModel<typeof agentContractSnapshotTable>;
export type NewAgentContractSnapshot = InferInsertModel<typeof agentContractSnapshotTable>;

/**
 * AgentContractCapability：合同 capabilities 的有序独立子记录（position 即合同声明顺序）。
 * tags/examples/inputModes/outputModes 为字段级数组（对应字段，非整节 payload）。
 */
export const agentContractCapabilityTable = mysqlTable(
  "AgentContractCapability",
  {
    /** 行 id（登记时由注入的 newId 生成）。 */
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    snapshotId: varchar("snapshotId", { length: 36 }).notNull(),
    /** 合同声明顺序（0 起）。 */
    position: bigint("position", { mode: "number" }).notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    nameZhCn: varchar("nameZhCn", { length: 256 }).notNull(),
    nameEn: varchar("nameEn", { length: 256 }),
    descriptionZhCn: text("descriptionZhCn"),
    descriptionEn: text("descriptionEn"),
    tags: json("tags").notNull(),
    examples: json("examples").notNull(),
    inputModes: json("inputModes").notNull(),
    outputModes: json("outputModes").notNull(),
  },
  (t) => ({
    snapshotFk: foreignKey({
      name: "AgentContractCapability_snapshot_fk",
      columns: [t.snapshotId],
      foreignColumns: [agentContractSnapshotTable.id],
    }).onDelete("cascade"),
    snapshotPositionUq: uniqueIndex("AgentContractCapability_snapshot_position_uq").on(
      t.snapshotId,
      t.position,
    ),
    snapshotKeyUq: uniqueIndex("AgentContractCapability_snapshot_key_uq").on(t.snapshotId, t.key),
  }),
);

export type AgentContractCapabilityRow = InferSelectModel<typeof agentContractCapabilityTable>;
export type NewAgentContractCapabilityRow = InferInsertModel<typeof agentContractCapabilityTable>;

/**
 * AgentContractInvocationContext：合同 invocation_context 的有序独立子记录。
 * 登记侧系统 provenance（provider_declared）为权威来源列；appliesTo 为字段级数组。
 */
export const agentContractInvocationContextTable = mysqlTable(
  "AgentContractInvocationContext",
  {
    /** 行 id（登记时由注入的 newId 生成）。 */
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    snapshotId: varchar("snapshotId", { length: 36 }).notNull(),
    position: bigint("position", { mode: "number" }).notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    nameZhCn: varchar("nameZhCn", { length: 256 }).notNull(),
    nameEn: varchar("nameEn", { length: 256 }),
    descriptionZhCn: text("descriptionZhCn"),
    descriptionEn: text("descriptionEn"),
    necessity: mysqlEnum("necessity", CONTRACT_CONTEXT_NECESSITIES).notNull(),
    /** 字段级数组：applies_to（wire 缺席为 null）。 */
    appliesTo: json("appliesTo"),
    /** wire 缺席为 null。 */
    trustRequirement: varchar("trustRequirement", { length: 64 }),
    /** 登记侧系统 provenance：合同由 provider 供给，登记即为 provider_declared。 */
    declarationSource: mysqlEnum("declarationSource", CONTRACT_PROVENANCE_SOURCES).notNull(),
  },
  (t) => ({
    snapshotFk: foreignKey({
      name: "AgentContractInvocationContext_snapshot_fk",
      columns: [t.snapshotId],
      foreignColumns: [agentContractSnapshotTable.id],
    }).onDelete("cascade"),
    snapshotPositionUq: uniqueIndex("AgentContractInvocationContext_snapshot_position_uq").on(
      t.snapshotId,
      t.position,
    ),
    snapshotKeyUq: uniqueIndex("AgentContractInvocationContext_snapshot_key_uq").on(
      t.snapshotId,
      t.key,
    ),
  }),
);

export type AgentContractInvocationContextRow = InferSelectModel<
  typeof agentContractInvocationContextTable
>;
export type NewAgentContractInvocationContextRow = InferInsertModel<
  typeof agentContractInvocationContextTable
>;
