/**
 * 稳定 Agent Schema — 正式控制面职责命名。
 *
 * 本文件是 Agent / AgentRevision 的单一物理 Schema 权威（docs/V12/01 §20 / §29 H）：
 * - 本文件持有 Agent / AgentRevision 的物理 MySQL 表定义（表名即存储名）。
 * - 正式模块只使用本文件导出的职责命名，不 Import lib/persistence/schema。
 *
 * 事实源：docs/architecture/persistence.md -4.2、
 * docs/architecture/domain-model.md 、
 * docs/architecture/agent-control-plane.md 。
 *
 * Agent 是员工目录中的一种可治理能力资产，仅在 Route 绑定时参与执行；SnowHarness
 * 始终是 Harness，Agent 不是 Thread 或基础执行的前提。Agent 保存稳定身份、负责人、
 * 可见范围和当前发布摘要。
 * AgentRevision 保存 Agent 自身不可变的代码、指令、模型策略、权限要求、委派范围和制品摘要。
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
    /** 员工使用范围策略 id（可选逻辑外键引用）。 */
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
    /**
     * 绑定的不可变 AgentDescriptorSnapshot id（逻辑外键 → AgentDescriptorSnapshot.id）。
     * 旧 Revision 可为空；正式发布（Batch 2 强约束）必须精确引用一个 Snapshot。
     * SnowHarness 对 Agent 一律按源码不可见处理——Revision 的权威来源是 DescriptorSnapshot，
     * 不是 sourceType/sourceRevision/agentArtifactRef。
     */
    agentDescriptorSnapshotId: varchar("agentDescriptorSnapshotId", { length: 36 }),
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

// ─── AgentDescriptorSnapshot ────────────────────────────────

/**
 * AgentDescriptorSnapshot：SnowHarness 接受的 Agent 外部合同（Descriptor / Agent Card）的一次
 * 不可变快照（docs/V12/01/agent补充/00 §6.2 / 01 §2）。
 *
 * SnowHarness 对 Agent 一律按源码不可见处理；Snapshot 是唯一 Authority，回答三件事：
 * 这个 Agent 是谁（Identity）、它声明会什么（CapabilityManifest）、调用它时平台应尽量提供
 * 什么上下文（InvocationContextContract），外加 Protocol Facts（protocolType / protocolContractRevision）。
 *
 * 关键约束：
 * - 整个 Snapshot 不可修改：登记后不可 UPDATE；任何改变能力/上下文/协议合同的变更都必须
 *   生成新 Snapshot（→ 新 AgentRevision）。
 * - canonicalProviderDescriptor 是 provider 原始声明的规范化 JSON（含 provider/operator provenance）。
 * - normalizedCapabilityManifest / invocationContextContract 是结构化、可查询的规范形式
 *   （不是 digest 唯一），供 Selector / 搜索 / 管理端展示。
 * - providerDescriptorDigest / capabilityManifestDigest / invocationContextContractDigest 为
 *   sha256: 前缀的稳定 canonical digest。
 * - providerDeclaredRevisionRef 可空：provider 声明的原始修订标识，仅作参考，不作 Authority。
 * - contractSectionProvenance 显式区分 provider_declared / operator_declared，禁止伪装来源。
 */
export const agentDescriptorSnapshotTable = mysqlTable(
  "AgentDescriptorSnapshot",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 归属 Agent（逻辑外键 → Agent.id）。 */
    agentId: varchar("agentId", { length: 36 })
      .notNull()
      .references(() => agentTable.id),
    /** Descriptor 种类（如 agent_card）。varchar 存储以便扩展。 */
    descriptorKind: varchar("descriptorKind", { length: 32 }).notNull(),
    /** 协议类型（agent_runtime_protocol/a2a/...）。varchar 以便扩展。 */
    protocolType: varchar("protocolType", { length: 32 }).notNull(),
    /** Conformance 与发布共同冻结的协议契约版本。 */
    protocolContractRevision: varchar("protocolContractRevision", { length: 128 }).notNull(),
    /** provider 原始声明规范化后的 JSON（含 provenance）。 */
    canonicalProviderDescriptor: json("canonicalProviderDescriptor").notNull(),
    /** providerDescriptorDigest：sha256: 前缀的稳定 canonical digest。 */
    providerDescriptorDigest: varchar("providerDescriptorDigest", { length: 71 }).notNull(),
    /** 结构化 CapabilityManifest（可查询，非 digest 唯一）。 */
    normalizedCapabilityManifest: json("normalizedCapabilityManifest").notNull(),
    /** capabilityManifestDigest：sha256: 前缀。仅由业务能力构成，不混 Runtime interface requirements。 */
    capabilityManifestDigest: varchar("capabilityManifestDigest", { length: 71 }).notNull(),
    /** 结构化 InvocationContextContract（required/preferred/accepted）。 */
    invocationContextContract: json("invocationContextContract").notNull(),
    /** invocationContextContractDigest：sha256: 前缀。 */
    invocationContextContractDigest: varchar("invocationContextContractDigest", {
      length: 71,
    }).notNull(),
    /** provider 声明的原始修订标识（可空，仅参考，不作 Authority）。 */
    providerDeclaredRevisionRef: varchar("providerDeclaredRevisionRef", { length: 128 }),
    /** 各合同节来源：{ capability, context, ... } ∈ provider_declared | operator_declared。 */
    contractSectionProvenance: json("contractSectionProvenance").notNull(),
    /** 登记捕获时间。 */
    capturedAt: datetime("capturedAt", { mode: "date", fsp: 3 }).notNull(),
    /** 创建者 userIdentityId 或 serviceId。 */
    createdBy: varchar("createdBy", { length: 128 }).notNull(),
  },
  (t) => ({
    tenantAgentIdx: index("AgentDescriptorSnapshot_tenant_agent_idx").on(t.tenantId, t.agentId),
    agentIdx: index("AgentDescriptorSnapshot_agent_idx").on(t.agentId),
  }),
);

export type AgentDescriptorSnapshot = InferSelectModel<typeof agentDescriptorSnapshotTable>;
export type NewAgentDescriptorSnapshot = InferInsertModel<typeof agentDescriptorSnapshotTable>;

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
