/**
 * EnvironmentDefinitionRevision — 唯一不可变 Environment 执行语义 Authority。
 *
 * Authority（工程包 sections/environment-revisions.md §9 与 sections/schema-design.md）：
 * - EnvironmentDefinition 保留逻辑身份与运营元数据（tenantId + environmentKey +
 *   displayName + description + lifecycleState + currentRevisionId + management
 *   CAS/version + timestamps），执行语义全部迁入本表。
 * - 一个 Definition 可有多个 Revision；Definition.currentRevisionId 指向"下一次
 *   Invocation 默认选择"的 Revision，改变它只影响未来 Invocation，不修改已冻结的
 *   ExecutionBinding→Revision 关系（INV-07）。
 * - Revision 一经创建不可变（immutable: true）：filesystem/network/resource/secret
 *   policy、executionTarget、requiredCapabilities 与 semanticDigest 均冻结。
 * - EnvironmentLease 必须绑定具体 Revision（不是 Definition）；Lease.compliance
 *   evidence 必须证明实际 worker/device/capabilities 满足该 Revision 要求；
 *   不满足 → fail closed（EnvironmentComplianceFailed）。
 * - Redispatch 必须仍指向 Binding 冻结的原 Revision（R1），禁止重新读取
 *   Definition.currentRevision 作为 Redispatch 目标。
 * - Historical explainability（INV-08）：Invocation/Attempt 通过 Lease→Revision
 *   能够解释实际 Environment 执行语义，即使 Definition.currentRevisionId 已前进。
 *
 * Schema dictionary source: docs/V12/02/snowharness-execution-design/
 *   schema-dictionary.json tables.EnvironmentDefinitionRevision
 *   （15 fields / 9 constraints / immutable=true）
 *
 * 关键约束：
 * - PK(id)
 * - UNIQUE(tenantId, id)：租户内主键唯一（复合 FK target）
 * - FK(tenantId → Tenant.id)
 * - FK(tenantId, definitionId → EnvironmentDefinition(tenantId, id))：复合外键
 *   强制同租户，防止跨租户 Revision 引用
 * - UNIQUE(tenantId, definitionId, revisionNo)：同 Definition 下 revisionNo 唯一
 * - UNIQUE(tenantId, definitionId, id)：复合 FK target（供 EnvironmentLease 引用）
 * - INDEX(tenantId, definitionId, semanticDigest)：按语义摘要检索
 * - CHECK(environmentType IN desktop|cloud|remote|sandbox)：由 mysqlEnum 承载
 * - CHECK(revisionNo >= 1)：应用层 + DB CHECK
 * - CHECK(semanticDigest 形式合法)：应用层校验（sha256:<64 lowercase hex>）
 * - JSON 结构由服务端严格 zod schema 校验（FilesystemPolicy / NetworkPolicy /
 *   ResourceLimits / SecretPolicy / ExecutionTarget / EnvironmentCapabilities）
 *
 * 本文件在 Foundation Batch F11 中新增；聚合到 lib/persistence/schema/index.ts
 * 由 F13 完成；drizzle/0000_initial_schema.sql 的 squash 与 meta snapshot 重生
 * 由 F14 完成；对应 Fresh DB seed 与 verify-fresh-db 由 F16/F17 完成。
 */
import { randomUUID } from "node:crypto";
import {
  ENVIRONMENT_TYPES,
  environmentDefinitionTable,
} from "@/lib/persistence/schema/environment";
import { tenant } from "@/lib/persistence/schema/identity";
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  check,
  datetime,
  foreignKey,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── EnvironmentDefinitionRevision ────────────────────────

/**
 * EnvironmentDefinitionRevision 表：唯一不可变 Environment 执行语义。
 *
 * 字段语义严格对齐 schema-dictionary.json：
 * - environmentType：从 Definition 迁入的真实字段（ENUM desktop/cloud/remote/sandbox）
 * - filesystemPolicyJson / networkPolicyJson / resourceLimitsJson / secretPolicyJson：
 *   从原 Definition 迁入，不复制双 Authority
 * - executionTarget：host agent 受管版本或 container image digest；
 *   不接受 latest/tag-only 目标（应用层 zod 校验）
 * - requiredCapabilities：严格 EnvironmentCapabilities 需求，不自报为已实现
 * - semanticDigest：上述语义规范 hash；不包含 display、createdBy、revisionNo
 */
export const environmentDefinitionRevisionTable = mysqlTable(
  "EnvironmentDefinitionRevision",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    /** 可信身份解析的租户；不可由模型覆写。 */
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 逻辑定义（EnvironmentDefinition.id）。 */
    definitionId: varchar("definitionId", { length: 36 }).notNull(),
    /**
     * Definition 锁下递增，1 开始。
     * BIGINT UNSIGNED 存储为字符串以避免 JS Number 精度损失。
     */
    revisionNo: bigint("revisionNo", { mode: "bigint" }).notNull(),
    /** 从 Definition 迁入的真实字段（ENUM desktop/cloud/remote/sandbox）。 */
    environmentType: mysqlEnum("environmentType", ENVIRONMENT_TYPES).notNull(),
    /** 严格 FilesystemPolicy；从原 Definition 迁入，不复制双 Authority。 */
    filesystemPolicyJson: json("filesystemPolicyJson").notNull(),
    /** 严格 NetworkPolicy；从原 Definition 迁入，不复制双 Authority。 */
    networkPolicyJson: json("networkPolicyJson").notNull(),
    /** 严格 ResourceLimits；从原 Definition 迁入，不复制双 Authority。 */
    resourceLimitsJson: json("resourceLimitsJson").notNull(),
    /** 严格 SecretPolicy；从原 Definition 迁入，不复制双 Authority。 */
    secretPolicyJson: json("secretPolicyJson").notNull(),
    /**
     * 严格 ExecutionTarget：host agent 受管版本或 container image digest；
     * 不接受 latest/tag-only 目标。应用层 zod 校验。
     */
    executionTarget: json("executionTarget").notNull(),
    /**
     * 严格 EnvironmentCapabilities 需求，不自报为已实现。
     * 与 EnvironmentLease.capabilitiesJson 由 EnvironmentCompliance 校验对齐。
     */
    requiredCapabilities: json("requiredCapabilities").notNull(),
    /**
     * 上述语义规范 hash；不包含 display、createdBy、revisionNo。
     * 格式 `sha256:<64 lowercase hex>` (VARCHAR(71) ascii_bin)。
     */
    semanticDigest: varchar("semanticDigest", { length: 71 }).notNull(),
    /** user/service（创建主体类型）。 */
    createdByType: varchar("createdByType", { length: 16 }).notNull(),
    /** 可信编辑主体 ID。 */
    createdById: varchar("createdById", { length: 128 }).notNull(),
    /** 创建事实时间（DB CURRENT_TIMESTAMP(6)）。 */
    createdAt: datetime("createdAt", { mode: "date", fsp: 6 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (t) => ({
    // UNIQUE(tenantId, id)：复合 FK target for cross-table 租户一致性
    tenantIdUq: uniqueIndex("EnvironmentDefinitionRevision_tenant_id_uq").on(t.tenantId, t.id),
    // UNIQUE(tenantId, definitionId, revisionNo)：同 Definition 下 revisionNo 唯一
    tenantDefinitionRevisionUq: uniqueIndex(
      "EnvironmentDefinitionRevision_tenant_definition_revision_uq",
    ).on(t.tenantId, t.definitionId, t.revisionNo),
    // UNIQUE(tenantId, definitionId, id)：复合 FK target for EnvironmentLease
    tenantDefinitionIdUq: uniqueIndex("EnvironmentDefinitionRevision_tenant_definition_id_uq").on(
      t.tenantId,
      t.definitionId,
      t.id,
    ),
    // INDEX(tenantId, definitionId, semanticDigest)：按语义摘要检索
    tenantDefinitionDigestIdx: index(
      "EnvironmentDefinitionRevision_tenant_definition_digest_idx",
    ).on(t.tenantId, t.definitionId, t.semanticDigest),
    // FK(tenantId, definitionId → EnvironmentDefinition(tenantId, id))
    // 复合外键强制同租户，防止跨租户 Revision 引用
    definitionFk: foreignKey({
      name: "EnvironmentDefinitionRevision_tenantId_definitionId_fk",
      columns: [t.tenantId, t.definitionId],
      foreignColumns: [environmentDefinitionTable.tenantId, environmentDefinitionTable.id],
    }),
    // CHECK(revisionNo >= 1)
    revisionNoPositive: check(
      "EnvironmentDefinitionRevision_revisionNo_positive",
      sql`\`revisionNo\` >= 1`,
    ),
    // CHECK(createdByType IN ('user','service'))
    createdByTypeAllowed: check(
      "EnvironmentDefinitionRevision_createdByType_allowed",
      sql`\`createdByType\` IN ('user', 'service')`,
    ),
    // CHECK(semanticDigest 形式合法：'sha256:' + 64 lowercase hex)
    semanticDigestFormat: check(
      "EnvironmentDefinitionRevision_semanticDigest_format",
      sql`\`semanticDigest\` REGEXP '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);

export type EnvironmentDefinitionRevision = InferSelectModel<
  typeof environmentDefinitionRevisionTable
>;
export type EnvironmentDefinitionRevisionInsert = InferInsertModel<
  typeof environmentDefinitionRevisionTable
>;
