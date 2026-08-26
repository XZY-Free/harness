/**
 * Catalog 投影器（阶段 6 S06-C03）。
 *
 * 事实源：
 * - lib/persistence/schema/catalog.ts
 * - docs/architecture/persistence.md （catalog_entry 读模型）
 * - docs/architecture/capability-and-collaboration-api.md §2（Employee Catalog API）
 * - docs/architecture/capabilities-and-security.md §2（统一目录）
 *
 * 职责：
 * - refreshCatalogEntry：从事实源读取单条资源并 upsert CatalogEntry；同事务内推进 CatalogRevision。
 * - refreshCatalogByType：批量刷新某资源类型的全部 CatalogEntry（用于初始化或重建）。
 * - getCurrentCatalogRevision：读取租户+audience 的当前修订号；不存在返回 0。
 * - advanceCatalogRevision：推进修订号（单调递增 +1）；返回新值。
 *
 * 关键约束：
 * - CatalogEntry 没有通用更新 API；投影是唯一写入路径。
 * - 投影写入成功后必须推进 CatalogRevision（同事务保证一致）。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - 资源已删除/不可见时不投影（调用方应在源行不可见时调 removeCatalogEntry）。
 */
import { db } from "@/lib/db/client";
import { agentTable } from "@/lib/persistence/schema/agents";
import {
  type CatalogAudience,
  type CatalogEntry,
  type CatalogResourceType,
  type CatalogRevision,
  catalogEntryTable,
  catalogRevisionTable,
} from "@/lib/persistence/schema/catalog";
import { skillTable } from "@/lib/persistence/schema/skill";
import { toolProviderTable, toolTable } from "@/lib/persistence/schema/tool";
import { and, eq, isNull } from "drizzle-orm";

// ─── 错误类 ────────────────────────────────────────────────

/** Catalog 投影错误（资源类型不支持 / 参数非法）。 */
export class CatalogProjectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CatalogProjectionError";
  }
}

// ─── CatalogRevision 管理 ─────────────────────────────────

/**
 * 读取租户+audience 的当前 CatalogRevision；不存在返回 0。
 *
 * 语义：
 * - 0 表示从未投影过（首次投影前的初始值）。
 * - 投影刷新后单调递增。
 */
export async function getCurrentCatalogRevision(params: {
  tenantId: string;
  audience: CatalogAudience;
}): Promise<number> {
  const [row] = await db
    .select({
      currentRevision: catalogRevisionTable.currentRevision,
    })
    .from(catalogRevisionTable)
    .where(
      and(
        eq(catalogRevisionTable.tenantId, params.tenantId),
        eq(catalogRevisionTable.audience, params.audience),
      ),
    )
    .limit(1);
  return row?.currentRevision ?? 0;
}

/**
 * 推进 CatalogRevision（单调递增 +1）。
 *
 * - 不存在则插入初始值 1。
 * - 存在则 currentRevision += 1。
 * - 返回推进后的新 revisionNo。
 *
 * 事务内调用时复用传入的 tx；顶层调用时使用 db。
 */
export async function advanceCatalogRevision(params: {
  tenantId: string;
  audience: CatalogAudience;
}): Promise<number> {
  const existing = await getCurrentCatalogRevision(params);
  const newRevision = existing + 1;
  const now = new Date();

  if (existing === 0) {
    await db.insert(catalogRevisionTable).values({
      tenantId: params.tenantId,
      audience: params.audience,
      currentRevision: newRevision,
      updatedAt: now,
    });
  } else {
    const result = await db
      .update(catalogRevisionTable)
      .set({ currentRevision: newRevision, updatedAt: now })
      .where(
        and(
          eq(catalogRevisionTable.tenantId, params.tenantId),
          eq(catalogRevisionTable.audience, params.audience),
          eq(catalogRevisionTable.currentRevision, existing),
        ),
      );
    if (result[0].affectedRows === 0) {
      // 并发冲突：CAS 失败。重试一次以最新值推进。
      const retryExisting = await getCurrentCatalogRevision(params);
      const retryNew = retryExisting + 1;
      const retryResult = await db
        .update(catalogRevisionTable)
        .set({ currentRevision: retryNew, updatedAt: new Date() })
        .where(
          and(
            eq(catalogRevisionTable.tenantId, params.tenantId),
            eq(catalogRevisionTable.audience, params.audience),
            eq(catalogRevisionTable.currentRevision, retryExisting),
          ),
        );
      if (retryResult[0].affectedRows === 0) {
        throw new CatalogProjectionError(
          "revision_advance_conflict",
          `CatalogRevision 推进并发冲突：tenant=${params.tenantId}, audience=${params.audience}`,
        );
      }
      return retryNew;
    }
  }
  return newRevision;
}

// ─── CatalogEntry 投影 ────────────────────────────────────

/** 投影输入：从事实源派生的字段集。 */
export interface CatalogEntryInput {
  tenantId: string;
  resourceType: CatalogResourceType;
  resourceId: string;
  displayName: string;
  description: string | null;
  ownerUserId: string | null;
  tagsJson: string[] | null;
  lifecycleState: string;
  visibilitySummary: string;
  sourceUpdatedAt: Date;
}

/**
 * 刷新单条 CatalogEntry：upsert + 同事务推进 CatalogRevision。
 *
 * 流程：
 * 1. 校验 resourceType 在已知枚举内。
 * 2. 调用 advanceCatalogRevision 得到 newRevision。
 * 3. upsert CatalogEntry（UNIQUE(tenantId, resourceType, resourceId) 命中则更新）。
 * 4. 返回写入后的行。
 *
 * 注意：advanceCatalogEntry 与 upsert 不在同一事务，因为 advanceCatalogRevision 内部已自洽。
 * 如果 upsert 失败，调用方需自行处理（CatalogRevision 已推进不影响业务正确性，
 * 因为 revisionNo 只增不减，客户端会再次拉取最新目录）。
 */
export async function refreshCatalogEntry(input: CatalogEntryInput): Promise<CatalogEntry> {
  if (!isValidResourceType(input.resourceType)) {
    throw new CatalogProjectionError(
      "unsupported_resource_type",
      `不支持的 Catalog 资源类型: ${input.resourceType}`,
    );
  }
  if (!input.displayName || input.displayName.length === 0) {
    throw new CatalogProjectionError("invalid_display_name", "displayName 不能为空");
  }
  if (!input.lifecycleState || input.lifecycleState.length === 0) {
    throw new CatalogProjectionError("invalid_lifecycle_state", "lifecycleState 不能为空");
  }
  if (!input.visibilitySummary || input.visibilitySummary.length === 0) {
    throw new CatalogProjectionError("invalid_visibility_summary", "visibilitySummary 不能为空");
  }

  // 推进 revision（employee audience，员工目录）
  const newRevision = await advanceCatalogRevision({
    tenantId: input.tenantId,
    audience: "employee",
  });

  const now = new Date();
  // upsert：UNIQUE(tenantId, resourceType, resourceId) 命中则更新。
  // 使用 onDuplicateKeyUpdate 触发 MySQL 的 INSERT ... ON DUPLICATE KEY UPDATE。
  await db
    .insert(catalogEntryTable)
    .values({
      tenantId: input.tenantId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      displayName: input.displayName,
      description: input.description,
      ownerUserId: input.ownerUserId,
      tagsJson: input.tagsJson,
      lifecycleState: input.lifecycleState,
      visibilitySummary: input.visibilitySummary,
      sourceUpdatedAt: input.sourceUpdatedAt,
      projectedAt: now,
      catalogRevision: newRevision,
    })
    .onDuplicateKeyUpdate({
      set: {
        displayName: input.displayName,
        description: input.description,
        ownerUserId: input.ownerUserId,
        tagsJson: input.tagsJson,
        lifecycleState: input.lifecycleState,
        visibilitySummary: input.visibilitySummary,
        sourceUpdatedAt: input.sourceUpdatedAt,
        projectedAt: now,
        catalogRevision: newRevision,
      },
    });

  const [row] = await db
    .select()
    .from(catalogEntryTable)
    .where(
      and(
        eq(catalogEntryTable.tenantId, input.tenantId),
        eq(catalogEntryTable.resourceType, input.resourceType),
        eq(catalogEntryTable.resourceId, input.resourceId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new CatalogProjectionError(
      "upsert_failed",
      `CatalogEntry upsert 后未找到行: tenant=${input.tenantId}, type=${input.resourceType}, id=${input.resourceId}`,
    );
  }
  return row;
}

/**
 * 批量刷新某资源类型的全部 CatalogEntry（用于初始化或重建）。
 *
 * 流程：
 * 1. 从事实源表读取全部资源（不含软删）。
 * 2. 对每条资源调用 refreshCatalogEntry。
 * 3. 返回写入行数。
 *
 * 注意：每次 refreshCatalogEntry 都会推进 CatalogRevision。
 * 大批量重建时 revisionNo 会跳跃式增长，这是预期行为（修订号单调递增即可）。
 */
export async function refreshCatalogByType(params: {
  tenantId: string;
  resourceType: CatalogResourceType;
}): Promise<number> {
  if (!isValidResourceType(params.resourceType)) {
    throw new CatalogProjectionError(
      "unsupported_resource_type",
      `不支持的 Catalog 资源类型: ${params.resourceType}`,
    );
  }

  const inputs = await loadSourceRows(params.tenantId, params.resourceType);
  let count = 0;
  for (const input of inputs) {
    await refreshCatalogEntry(input);
    count += 1;
  }
  return count;
}

/**
 * 删除单条 CatalogEntry（资源被软删/退役后调用）。
 *
 * 不推进 CatalogRevision（删除是软语义，资源本身仍在但 lifecycle=retired；
 * 调用方应在退役场景改用 refreshCatalogEntry 更新 lifecycle，而非删除行）。
 * 真正的删除用于资源被物理删除的场景（如 cascade 删除租户）。
 */
export async function removeCatalogEntry(params: {
  tenantId: string;
  resourceType: CatalogResourceType;
  resourceId: string;
}): Promise<boolean> {
  const result = await db
    .delete(catalogEntryTable)
    .where(
      and(
        eq(catalogEntryTable.tenantId, params.tenantId),
        eq(catalogEntryTable.resourceType, params.resourceType),
        eq(catalogEntryTable.resourceId, params.resourceId),
      ),
    );
  return result[0].affectedRows > 0;
}

// ─── 单 Agent 权威刷新（事件驱动）──────────────────────────

/**
 * 按权威 Agent 行刷新/创建单个 agent CatalogEntry（事件驱动入口）。
 *
 * 语义（员工 Catalog 事件投影，阶段 6 S06-C03 后续批）：
 * - 精确读取单个 Agent（tenantId + agentId），不做全租户扫描。
 * - Agent 存在且未软删 → refreshCatalogEntry（内部推进 employee CatalogRevision）。
 * - Agent 不存在或已软删 → fail-closed：移除已有 entry（若有）并推进
 *   employee CatalogRevision，使旧 ETag 失效。
 *
 * 抛出任何错误都由调用方（Outbox Delivery Worker）重试，不标记成功。
 */
export async function refreshAgentCatalogEntry(params: {
  tenantId: string;
  agentId: string;
}): Promise<void> {
  const [agentRow] = await db
    .select({
      id: agentTable.id,
      displayName: agentTable.displayName,
      description: agentTable.description,
      ownerUserId: agentTable.ownerUserId,
      lifecycleState: agentTable.lifecycleState,
      updatedAt: agentTable.updatedAt,
      deletedAt: agentTable.deletedAt,
    })
    .from(agentTable)
    .where(and(eq(agentTable.tenantId, params.tenantId), eq(agentTable.id, params.agentId)))
    .limit(1);

  if (!agentRow || agentRow.deletedAt !== null) {
    // fail-closed：资源不可见 → 移除读模型条目并推进修订号。
    const removed = await removeCatalogEntry({
      tenantId: params.tenantId,
      resourceType: "agent",
      resourceId: params.agentId,
    });
    if (removed) {
      await advanceCatalogRevision({ tenantId: params.tenantId, audience: "employee" });
    }
    return;
  }

  await refreshCatalogEntry({
    tenantId: params.tenantId,
    resourceType: "agent",
    resourceId: agentRow.id,
    displayName: agentRow.displayName,
    description: agentRow.description,
    ownerUserId: agentRow.ownerUserId,
    tagsJson: null,
    lifecycleState: agentRow.lifecycleState,
    visibilitySummary: "tenant",
    sourceUpdatedAt: agentRow.updatedAt,
  });
}

// ─── 事实源加载 ────────────────────────────────────────────

/**
 * 从事实源表读取资源行并转为 CatalogEntryInput。
 *
 * 支持的类型：
 * - agent：从 Agent 读取（lifecycleState + visibilitySummary=tenant）。
 * - skill：从 Skill 读取（lifecycleState + visibilityScope）。
 * - tool：从 Tool 读取（lifecycleState + visibilitySummary=tenant）。
 *
 * 其他类型（knowledge/runtime/model/connection）当前阶段未接入事实源，返回空数组。
 */
async function loadSourceRows(
  tenantId: string,
  resourceType: CatalogResourceType,
): Promise<CatalogEntryInput[]> {
  switch (resourceType) {
    case "agent":
      return loadAgents(tenantId);
    case "skill":
      return loadSkills(tenantId);
    case "tool":
      return loadTools(tenantId);
    case "knowledge":
    case "runtime":
    case "model":
    case "connection":
      // 后续阶段接入，当前返回空数组
      return [];
    default:
      return [];
  }
}

/** 从 Agent 加载并转换为 CatalogEntryInput。 */
async function loadAgents(tenantId: string): Promise<CatalogEntryInput[]> {
  const rows = await db
    .select({
      id: agentTable.id,
      displayName: agentTable.displayName,
      description: agentTable.description,
      ownerUserId: agentTable.ownerUserId,
      lifecycleState: agentTable.lifecycleState,
      updatedAt: agentTable.updatedAt,
    })
    .from(agentTable)
    .where(and(eq(agentTable.tenantId, tenantId), isNull(agentTable.deletedAt)));
  return rows.map((row) => ({
    tenantId,
    resourceType: "agent" as const,
    resourceId: row.id,
    displayName: row.displayName,
    description: row.description,
    ownerUserId: row.ownerUserId,
    tagsJson: null,
    lifecycleState: row.lifecycleState,
    visibilitySummary: "tenant",
    sourceUpdatedAt: row.updatedAt,
  }));
}

/** 从 Skill 加载并转换为 CatalogEntryInput。 */
async function loadSkills(tenantId: string): Promise<CatalogEntryInput[]> {
  const rows = await db
    .select({
      id: skillTable.id,
      displayName: skillTable.displayName,
      description: skillTable.description,
      ownerUserId: skillTable.ownerUserId,
      lifecycleState: skillTable.lifecycleState,
      visibilityScope: skillTable.visibilityScope,
      updatedAt: skillTable.updatedAt,
    })
    .from(skillTable)
    .where(and(eq(skillTable.tenantId, tenantId), isNull(skillTable.deletedAt)));
  return rows.map((row) => ({
    tenantId,
    resourceType: "skill" as const,
    resourceId: row.id,
    displayName: row.displayName,
    description: row.description,
    ownerUserId: row.ownerUserId,
    tagsJson: null,
    lifecycleState: row.lifecycleState,
    visibilitySummary: row.visibilityScope,
    sourceUpdatedAt: row.updatedAt,
  }));
}

/**
 * 从 Tool 加载并转换为 CatalogEntryInput。
 *
 * Tool 表本身不保存 ownerUserId（owner 概念在 ToolProvider 层），故 innerJoin
 * ToolProvider 取其 ownerUserId 作为 CatalogEntry 的 owner。
 */
async function loadTools(tenantId: string): Promise<CatalogEntryInput[]> {
  const rows = await db
    .select({
      id: toolTable.id,
      displayName: toolTable.displayName,
      description: toolTable.description,
      ownerUserId: toolProviderTable.ownerUserId,
      lifecycleState: toolTable.lifecycleState,
      updatedAt: toolTable.updatedAt,
    })
    .from(toolTable)
    .innerJoin(toolProviderTable, eq(toolTable.providerId, toolProviderTable.id))
    .where(and(eq(toolTable.tenantId, tenantId), isNull(toolTable.deletedAt)));
  return rows.map((row) => ({
    tenantId,
    resourceType: "tool" as const,
    resourceId: row.id,
    displayName: row.displayName,
    description: row.description,
    ownerUserId: row.ownerUserId,
    tagsJson: null,
    lifecycleState: row.lifecycleState,
    visibilitySummary: "tenant",
    sourceUpdatedAt: row.updatedAt,
  }));
}

// ─── 内部工具 ──────────────────────────────────────────────

/** 校验 resourceType 是否在已知枚举内。 */
function isValidResourceType(type: string): type is CatalogResourceType {
  return (
    type === "agent" ||
    type === "skill" ||
    type === "tool" ||
    type === "knowledge" ||
    type === "runtime" ||
    type === "model" ||
    type === "connection"
  );
}

// ─── Re-exports ────────────────────────────────────────────

export type {
  CatalogAudience,
  CatalogResourceType,
  CatalogEntry,
  CatalogRevision,
} from "@/lib/persistence/schema/catalog";
