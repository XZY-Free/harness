/**
 * V11 控制面 schema：CapabilityUse 能力使用账本（阶段 6 S06-C04）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.5（capability_use）
 * - ../v11-agentkit-platform/12-capability-and-collaboration-api.md §3（Runtime Capability API）
 * - ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §3.3、§4.3
 *
 * CapabilityUse 记录一次 Invocation 实际使用的能力（Tool / Skill / Knowledge / Memory / Agent / Model）：
 * - 成功读取 Tool Schema / Skill Content 后幂等写入。
 * - 同一 Invocation + 同一能力 + 同一修订/内容/Schema hash 只写一次（UNIQUE(invocationId, capabilityUseKey)）。
 * - capabilityUseKey = sha256(type|id|revision-or-empty|content-hash-or-empty|schema-hash-or-empty)。
 * - 用于审计追溯：哪些能力被某次执行真正加载到了模型可用工具集 / 上下文。
 *
 * 关键约束：
 * - UNIQUE(invocationId, capabilityUseKey)：同一 Invocation 内同一能力修订不重复记录。
 * - INDEX(tenantId, invocationId)：按 Invocation 查询能力使用历史。
 * - INDEX(tenantId, capabilityType, capabilityId)：按能力维度统计使用情况。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/v11/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { datetime, index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

// ─── Capability Type ──────────────────────────────────────

/**
 * 能力类型（与 §6.5 capability_use.capability_type 对齐）。
 * - skill：Skill 能力资产。
 * - tool：Tool 能力资产。
 * - knowledge_document：知识文档。
 * - memory：长期记忆。
 * - agent：Agent 资产。
 * - model：模型资产。
 */
export const CAPABILITY_USE_TYPES = [
  "skill",
  "tool",
  "knowledge_document",
  "memory",
  "agent",
  "model",
] as const;
export type CapabilityUseType = (typeof CAPABILITY_USE_TYPES)[number];

// ─── Source Type ───────────────────────────────────────────

/**
 * 能力使用来源类型（与 §6.5 capability_use.source_type 对齐）。
 * - default：默认能力。
 * - dynamic_discovery：搜索发现后选用（默认）。
 * - user_selected：用户显式选择。
 * - policy：策略强制注入。
 */
export const CAPABILITY_USE_SOURCE_TYPES = [
  "default",
  "dynamic_discovery",
  "user_selected",
  "policy",
] as const;
export type CapabilityUseSourceType = (typeof CAPABILITY_USE_SOURCE_TYPES)[number];

// ─── CapabilityUse ────────────────────────────────────────

export const v11CapabilityUse = mysqlTable(
  "V11CapabilityUse",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 所属执行 Invocation id（逻辑外键 → Invocation；不加 DB 级 FK，避免跨阶段耦合）。 */
    invocationId: varchar("invocationId", { length: 36 }).notNull(),
    /** 能力类型（skill/tool/knowledge_document/memory/agent/model）。 */
    capabilityType: varchar("capabilityType", { length: 32 }).notNull(),
    /** 稳定资源 id（如 Tool.id / Skill.id）。 */
    capabilityId: varchar("capabilityId", { length: 36 }).notNull(),
    /** 实际修订 id（如 ToolSchemaRevision.id / SkillVersion.id）；可空。 */
    revisionId: varchar("revisionId", { length: 36 }),
    /** 实际内容 hash（sha256: 前缀，Skill 内容）；可空。 */
    contentHash: varchar("contentHash", { length: 128 }),
    /** 实际 Schema hash（sha256: 前缀，Tool Schema）；可空。 */
    schemaHash: varchar("schemaHash", { length: 128 }),
    /** 来源类型（default/dynamic_discovery/user_selected/policy）。 */
    sourceType: varchar("sourceType", { length: 32 }).notNull().default("dynamic_discovery"),
    /** 来源引用（如搜索 query / 用户选择路径）；可空。 */
    sourceRef: varchar("sourceRef", { length: 256 }),
    /** 选择理由代码（如 query_match / explicit_select / policy_required）。 */
    selectionReasonCode: varchar("selectionReasonCode", { length: 64 }),
    /**
     * 幂等键：sha256(type|id|revision-or-empty|content-hash-or-empty|schema-hash-or-empty)。
     * UNIQUE(invocationId, capabilityUseKey) 防止同 Invocation 同修订重复写。
     */
    capabilityUseKey: varchar("capabilityUseKey", { length: 128 }).notNull(),
    /** 首次记录时间（幂等：同 key 重放保留 firstUsedAt，不更新）。 */
    firstUsedAt: datetime("firstUsedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    invocationKeyUq: uniqueIndex("V11CapabilityUse_invocation_capabilityUseKey_uq").on(
      t.invocationId,
      t.capabilityUseKey,
    ),
    tenantInvocationIdx: index("V11CapabilityUse_tenant_invocation_idx").on(
      t.tenantId,
      t.invocationId,
    ),
    tenantTypeCapabilityIdx: index("V11CapabilityUse_tenant_type_capability_idx").on(
      t.tenantId,
      t.capabilityType,
      t.capabilityId,
    ),
  }),
);

export type V11CapabilityUse = InferSelectModel<typeof v11CapabilityUse>;
export type NewV11CapabilityUse = InferInsertModel<typeof v11CapabilityUse>;
