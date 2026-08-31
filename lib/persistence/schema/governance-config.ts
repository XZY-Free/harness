/**
 * 治理配置 schema：GovernanceConfigSet + GovernanceConfigRevision（关口02 02-6）。
 *
 * 事实源：02-6 冻结实施方案 §5 / §54-P0
 * （docs/V12/01/SnowHarness_专题01_关口02_02-6_Policy_Permission_最终冻结实施方案.md）。
 *
 * 关键不变量：
 * - UNIQUE(tenantId, configSetKey)：租户内稳定 key 唯一；正式 key = "runtime-execution"。
 * - currentRevisionId 必须指向同一 GovernanceConfigSet 的 published
 *   GovernanceConfigRevision（逻辑外键）。
 * - published Revision 业务内容不可修改；只能新建版本。
 * - configJson 保存治理配置全量快照（protectedPaths / commandDenyList /
 *   formatOnWrite / verifyBeforeDelivery）。
 * - configDigest 必须以 `sha256:` 前缀存储（canonical(configJson) 后 SHA-256）。
 * - 术语：Governance 用 configDigest（不叫 rulesHash，它不是 Permission Rules）。
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
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── GovernanceConfig（configJson 结构）───────────────────────

/**
 * 治理配置内容（configJson 全量快照，§5.2）。
 *
 * - protectedPaths：受保护路径列表，禁止写入/删除。
 * - commandDenyList：禁止执行的命令模式列表。
 * - formatOnWrite：写入前是否自动格式化。
 * - verifyBeforeDelivery：交付前是否校验（如测试通过 / lint 通过）。
 */
export interface GovernanceConfig {
  protectedPaths: string[];
  commandDenyList: string[];
  formatOnWrite: boolean;
  verifyBeforeDelivery: boolean;
  /** Harness 行动循环预算；省略时由 Runtime 使用统一默认值。 */
  harnessLoopLimits?: {
    maxLoopSteps?: number;
    maxAgentCalls?: number;
    maxToolCalls?: number;
    maxKnowledgeSearches?: number;
    maxConsecutiveSameAction?: number;
  };
}

// ─── LifecycleState ──────────────────────────────────────────

/**
 * GovernanceConfigSet 生命周期状态（与 PolicySet / Agent 对齐，§5.1）。
 * - draft：刚创建，未启用。
 * - enabled：已启用，可被引用。
 * - disabled：临时停用。
 * - retired：永久退役（终态，不可恢复）。
 *
 * Tenant 初始化后 = enabled。
 */
export const GOVERNANCE_CONFIG_LIFECYCLE_STATES = [
  "draft",
  "enabled",
  "disabled",
  "retired",
] as const;
export type GovernanceConfigLifecycleState = (typeof GOVERNANCE_CONFIG_LIFECYCLE_STATES)[number];

// ─── RevisionState ───────────────────────────────────────────

/**
 * GovernanceConfigRevision 修订状态（§5.2）。
 * - draft：草稿，可编辑。
 * - published：已发布，业务内容不可修改，可被引用。
 * - withdrawn：已撤回，只阻止新引用，不删除历史引用。
 */
export const GOVERNANCE_CONFIG_REVISION_STATES = ["draft", "published", "withdrawn"] as const;
export type GovernanceConfigRevisionState = (typeof GOVERNANCE_CONFIG_REVISION_STATES)[number];

// ─── GovernanceConfigSet ─────────────────────────────────────

/**
 * GovernanceConfigSet 表：稳定治理配置身份（§5.1）。
 *
 * 关键约束：
 * - UNIQUE(tenantId, configSetKey)：租户内稳定 key 唯一；正式 key = "runtime-execution"。
 * - currentRevisionId 必须指向同一 set 的 published GovernanceConfigRevision（逻辑外键）。
 * - published Revision 业务内容不可修改；只能新建版本。
 */
export const governanceConfigSetTable = mysqlTable(
  "GovernanceConfigSet",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 租户内稳定唯一 key（slug），正式 = "runtime-execution"。 */
    configSetKey: varchar("configSetKey", { length: 128 }).notNull(),
    /** 负责人 userIdentityId（逻辑外键 → UserIdentity.id）；null 表示系统配置。 */
    ownerUserId: varchar("ownerUserId", { length: 36 }),
    /** 当前生效修订 id（逻辑外键 → GovernanceConfigRevision.id）；null 表示未发布。 */
    currentRevisionId: varchar("currentRevisionId", { length: 36 }),
    lifecycleState: mysqlEnum("lifecycleState", GOVERNANCE_CONFIG_LIFECYCLE_STATES)
      .notNull()
      .default("draft"),
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
    tenantKeyUq: uniqueIndex("GovernanceConfigSet_tenant_configSetKey_uq").on(
      t.tenantId,
      t.configSetKey,
    ),
    tenantLifecycleUpdatedIdx: index("GovernanceConfigSet_tenant_lifecycle_updated_idx").on(
      t.tenantId,
      t.lifecycleState,
      t.updatedAt,
    ),
  }),
);

export type GovernanceConfigSet = InferSelectModel<typeof governanceConfigSetTable>;
export type NewGovernanceConfigSet = InferInsertModel<typeof governanceConfigSetTable>;

// ─── GovernanceConfigRevision ────────────────────────────────

/**
 * GovernanceConfigRevision 表：不可变治理配置修订（§5.2）。
 *
 * 关键约束：
 * - UNIQUE(configSetId, revisionNo)：set 内修订号单调递增。
 * - published Revision 业务内容不可修改；只能新建版本。
 * - configJson 保存治理配置全量快照（protectedPaths / commandDenyList /
 *   formatOnWrite / verifyBeforeDelivery）。
 * - configDigest 必须以 `sha256:` 前缀存储（应用层校验）。
 * - 无 rulesHash 列（Governance 配置不是 Permission Rules，用 configDigest）。
 */
export const governanceConfigRevisionTable = mysqlTable(
  "GovernanceConfigRevision",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    configSetId: varchar("configSetId", { length: 36 })
      .notNull()
      .references(() => governanceConfigSetTable.id),
    /** set 内单调递增修订号。 */
    revisionNo: bigint("revisionNo", { mode: "number" }).notNull(),
    /** 治理配置全量 JSON 快照。 */
    configJson: json("configJson").$type<GovernanceConfig>().notNull(),
    /** 配置内容 digest（sha256: 前缀 + hex）。 */
    configDigest: varchar("configDigest", { length: 71 }).notNull(),
    revisionState: mysqlEnum("revisionState", GOVERNANCE_CONFIG_REVISION_STATES)
      .notNull()
      .default("draft"),
    /** 创建者 userIdentityId 或 serviceId。 */
    createdBy: varchar("createdBy", { length: 128 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    publishedAt: datetime("publishedAt", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    setRevisionNoUq: uniqueIndex("GovernanceConfigRevision_set_revisionNo_uq").on(
      t.configSetId,
      t.revisionNo,
    ),
    setStateIdx: index("GovernanceConfigRevision_set_state_idx").on(t.configSetId, t.revisionState),
  }),
);

export type GovernanceConfigRevision = InferSelectModel<typeof governanceConfigRevisionTable>;
export type NewGovernanceConfigRevision = InferInsertModel<typeof governanceConfigRevisionTable>;
