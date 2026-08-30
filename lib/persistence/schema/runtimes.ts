/**
 * 稳定 Runtime Schema — 正式控制面职责命名。
 *
 * 本文件是 Runtime / RuntimeRevision 的单一物理 Schema 权威。
 *
 * 事实源：docs/architecture/persistence.md 、
 * docs/architecture/domain-model.md 、
 *
 * Runtime 表示一种逻辑运行入口（hosted 或 external）；RuntimeRevision 固定主机/Adapter 制品、
 * 协议、网络区、身份模式、配置 hash 和真实 capabilities。
 *
 * 关键约束：
 * - UNIQUE(tenantId, runtimeKey)：租户内稳定 key 唯一。
 * - UNIQUE(runtimeId, revisionNo)：Runtime 内修订号单调递增。
 * - published Revision 业务内容不可修改；只能新建修订。
 * - withdrawn 只阻止新发布或路由，不删除历史引用。
 * - currentRevisionId 必须指向同一 Runtime 的 published Revision（逻辑外键，应用层校验）。
 * - capabilities 必须来自探测和一致性测试，管理员不能手工勾选未支持能力。
 * - endpoint_ref 只引用受管连接，不直接保存带 Secret 的 URL。
 *
 * Runtime lifecycle 与 Agent 一致（draft/enabled/disabled/retired，retired 为终态）。
 * RuntimeRevision state 与 AgentRevision 一致（draft/published/withdrawn）。
 * protocol_type/identity_mode/network_zone 使用 varchar 存储以便扩展（契约未固定枚举）。
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

// ─── Runtime Lifecycle ─────────────────────────────────────

/**
 * Runtime 生命周期状态（与 Agent 一致）。
 * - draft：刚创建，未启用。
 * - enabled：已启用，可被路由。
 * - disabled：临时停用。
 * - retired：永久退役（终态，不可恢复）。
 */
export const RUNTIME_LIFECYCLE_STATES = ["draft", "enabled", "disabled", "retired"] as const;
export type RuntimeLifecycleState = (typeof RUNTIME_LIFECYCLE_STATES)[number];

// ─── Runtime Kind ──────────────────────────────────────────

/**
 * Runtime 种类。
 * - hosted：平台托管运行时。
 * - external：外部运行时（必须声明身份、事件、取消和能力协议）。
 */
export const RUNTIME_KINDS = ["hosted", "external"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

// ─── Runtime Evidence Kind ────────────────────────────────

/**
 * RuntimeRevision 证据种类。
 * - hosted_artifact：平台托管运行时，必须携带真实 Runtime Artifact 证据。
 * - external_endpoint：外部运行时，使用 endpoint + config/protocol 证据，不得伪造 Artifact。
 *
 * 语义字段，不允许通过 nullable 组合猜测。
 */
export const RUNTIME_EVIDENCE_KINDS = ["hosted_artifact", "external_endpoint"] as const;
export type RuntimeEvidenceKind = (typeof RUNTIME_EVIDENCE_KINDS)[number];

// ─── RuntimeRevision State ─────────────────────────────────

/**
 * RuntimeRevision 状态（与 AgentRevision 一致）。
 * - draft：草稿，可编辑业务内容。
 * - published：已发布，业务内容不可修改，可被路由引用。
 * - withdrawn：已撤回，只阻止新发布或路由，不删除历史引用。
 */
export const RUNTIME_REVISION_STATES = ["draft", "published", "withdrawn"] as const;
export type RuntimeRevisionState = (typeof RUNTIME_REVISION_STATES)[number];

// ─── Protocol Type / Identity Mode / Network Zone ──────────
// 契约未固定枚举值，使用 varchar 存储以便扩展；以下为已知常量。

/** 已知协议类型 — Runtime 只表示 SnowHarness Harness Runtime。 */
export const RUNTIME_PROTOCOL_TYPES = ["harness_runtime_protocol"] as const;
export type RuntimeProtocolType = (typeof RUNTIME_PROTOCOL_TYPES)[number];

/** 已知身份模式。 */
export const RUNTIME_IDENTITY_MODES = ["workload_token", "api_key", "none"] as const;
export type RuntimeIdentityMode = (typeof RUNTIME_IDENTITY_MODES)[number];

/** 已知网络区域。 */
export const RUNTIME_NETWORK_ZONES = ["internal", "external", "dmz"] as const;
export type RuntimeNetworkZone = (typeof RUNTIME_NETWORK_ZONES)[number];

// ─── Runtime ───────────────────────────────────────────────

export const runtimeTable = mysqlTable(
  "Runtime",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 租户内稳定唯一 key（slug），例如 "doubao-hosted"。 */
    runtimeKey: varchar("runtimeKey", { length: 128 }).notNull(),
    displayName: varchar("displayName", { length: 256 }).notNull(),
    /** hosted 或 external。 */
    runtimeKind: mysqlEnum("runtimeKind", RUNTIME_KINDS).notNull(),
    /** 负责人 userIdentityId（逻辑外键 → UserIdentity.id）。 */
    ownerUserId: varchar("ownerUserId", { length: 36 }).notNull(),
    lifecycleState: mysqlEnum("lifecycleState", RUNTIME_LIFECYCLE_STATES)
      .notNull()
      .default("draft"),
    /** 当前发布修订 id（逻辑外键 → RuntimeRevision.id）；null 表示未发布。 */
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
    tenantKeyUq: uniqueIndex("Runtime_tenant_runtimeKey_uq").on(t.tenantId, t.runtimeKey),
    tenantLifecycleUpdatedIdx: index("Runtime_tenant_lifecycle_updated_idx").on(
      t.tenantId,
      t.lifecycleState,
      t.updatedAt,
    ),
  }),
);

export type Runtime = InferSelectModel<typeof runtimeTable>;
export type NewRuntime = InferInsertModel<typeof runtimeTable>;

// ─── RuntimeRevision ───────────────────────────────────────

export const runtimeRevisionTable = mysqlTable(
  "RuntimeRevision",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    runtimeId: varchar("runtimeId", { length: 36 })
      .notNull()
      .references(() => runtimeTable.id),
    /** Runtime 内单调递增修订号。 */
    revisionNo: bigint("revisionNo", { mode: "number" }).notNull(),
    /** 协议类型（harness_runtime_protocol/...）；varchar 以便扩展。 */
    protocolType: varchar("protocolType", { length: 32 }).notNull(),
    /**
     * Conformance 与发布共同冻结的协议契约版本（显式传入，禁止默认值污染全部协议）。
     */
    protocolContractRevision: varchar("protocolContractRevision", { length: 128 }).notNull(),
    /** 证据种类：hosted_artifact | external_endpoint（语义字段）。 */
    runtimeEvidenceKind: mysqlEnum("runtimeEvidenceKind", RUNTIME_EVIDENCE_KINDS).notNull(),
    /** 被测对象统一 digest（canonical 计算自证据事实）。 */
    runtimeTargetDigest: varchar("runtimeTargetDigest", { length: 71 }).notNull(),
    /** 受管连接引用，不保存带 Secret 的 URL。 */
    endpointRef: varchar("endpointRef", { length: 512 }).notNull(),
    /**
     * Runtime 主机/Adapter 制品引用（仅 hosted_artifact 非空；external_endpoint 为 null，
     * 不作为通用必填字段 — ）。
     */
    runtimeArtifactRef: varchar("runtimeArtifactRef", { length: 512 }),
    /** 权威控制面 Artifact；旧 Revision 可为空。 */
    artifactId: varchar("artifactId", { length: 36 }),
    /** 与 artifactId 同时冻结的内容摘要。 */
    artifactDigest: varchar("artifactDigest", { length: 71 }),
    /** 实际能力（来自探测和一致性测试，非手工勾选）。 */
    runtimeCapabilitiesJson: json("runtimeCapabilitiesJson").notNull(),
    /** 身份模式（workload_token/api_key/none/...）；varchar 以便扩展。 */
    identityMode: varchar("identityMode", { length: 32 }).notNull(),
    /** 网络区域（internal/external/dmz/...）；varchar 以便扩展。 */
    networkZone: varchar("networkZone", { length: 32 }).notNull(),
    /** 配置 hash（带算法前缀，如 sha256:...）。 */
    configHash: varchar("configHash", { length: 128 }).notNull(),
    /** 绑定的同租户 CredentialRef（bearer 模式）；none 模式与旧行为 null。不存 secret。 */
    credentialRefId: varchar("credentialRefId", { length: 36 }),
    revisionState: mysqlEnum("revisionState", RUNTIME_REVISION_STATES).notNull().default("draft"),
    /** 创建者 userIdentityId 或 serviceId。 */
    createdBy: varchar("createdBy", { length: 128 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    publishedAt: datetime("publishedAt", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    runtimeRevisionNoUq: uniqueIndex("RuntimeRevision_runtime_revisionNo_uq").on(
      t.runtimeId,
      t.revisionNo,
    ),
    runtimeStateIdx: index("RuntimeRevision_runtime_state_idx").on(t.runtimeId, t.revisionState),
    artifactIdx: index("RuntimeRevision_artifact_idx").on(t.artifactId),
  }),
);

export type RuntimeRevision = InferSelectModel<typeof runtimeRevisionTable>;
export type NewRuntimeRevision = InferInsertModel<typeof runtimeRevisionTable>;

// ─── Canonical Row 别名（领域面向的行类型名）────────────────
export type RuntimeRow = Runtime;
export type RuntimeRevisionRow = RuntimeRevision;
export type NewRuntimeRow = NewRuntime;
export type NewRuntimeRevisionRow = NewRuntimeRevision;
