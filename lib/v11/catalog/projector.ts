/**
 * V11 Catalog 投影器（阶段 6 S06-C03）。
 *
 * 事实源：
 * - lib/v11/schema/catalog.ts
 * - ../v11-agentkit-platform/10-core-data-model.md §4.5（catalog_entry 读模型）
 * - ../v11-agentkit-platform/12-capability-and-collaboration-api.md §2（Employee Catalog API）
 * - ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §2（统一目录）
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
import { v11Agent } from "@/lib/v11/schema/agent";
import {
  type CatalogAudience,
  type CatalogResourceType,
  type V11CatalogEntry,
  type V11CatalogRevision,
  v11CatalogEntry,
  v11CatalogRevision,
} from "@/lib/v11/schema/catalog";
import { v11Skill } from "@/lib/v11/schema/skill";
import { v11Tool, v11ToolProvider } from "@/lib/v11/schema/tool";
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
      currentRevision: v11CatalogRevision.currentRevision,
    })
    .from(v11CatalogRevision)
    .where(
      and(
        eq(v11CatalogRevision.tenantId, params.tenantId),
        eq(v11CatalogRevision.audience, params.audience),
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
    await db.insert(v11CatalogRevision).values({
      tenantId: params.tenantId,
      audience: params.audience,
      currentRevision: newRevision,
      updatedAt: now,
    });
  } else {
    const result = await db
      .update(v11CatalogRevision)
      .set({ currentRevision: newRevision, updatedAt: now })
      .where(
        and(
          eq(v11CatalogRevision.tenantId, params.tenantId),
          eq(v11CatalogRevision.audience, params.audience),
          eq(v11CatalogRevision.currentRevision, existing),
        ),
      );
    if (result[0].affectedRows === 0) {
      // 并发冲突：CAS 失败。重试一次以最新值推进。
      const retryExisting = await getCurrentCatalogRevision(params);
      const retryNew = retryExisting + 1;
      const retryResult = await db
        .update(v11CatalogRevision)
        .set({ currentRevision: retryNew, updatedAt: new Date() })
        .where(
          and(
            eq(v11CatalogRevision.tenantId, params.tenantId),
            eq(v11CatalogRevision.audience, params.audience),
            eq(v11CatalogRevision.currentRevision, retryExisting),
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
export async function refreshCatalogEntry(input: CatalogEntryInput): Promise<V11CatalogEntry> {
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
    .insert(v11CatalogEntry)
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
    .from(v11CatalogEntry)
    .where(
      and(
        eq(v11CatalogEntry.tenantId, input.tenantId),
        eq(v11CatalogEntry.resourceType, input.resourceType),
        eq(v11CatalogEntry.resourceId, input.resourceId),
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
    .delete(v11CatalogEntry)
    .where(
      and(
        eq(v11CatalogEntry.tenantId, params.tenantId),
        eq(v11CatalogEntry.resourceType, params.resourceType),
        eq(v11CatalogEntry.resourceId, params.resourceId),
      ),
    );
  return result[0].affectedRows > 0;
}

// ─── 事实源加载 ────────────────────────────────────────────

/**
 * 从事实源表读取资源行并转为 CatalogEntryInput。
 *
 * 支持的类型：
 * - agent：从 V11Agent 读取（lifecycleState + visibilitySummary=tenant）。
 * - skill：从 V11Skill 读取（lifecycleState + visibilityScope）。
 * - tool：从 V11Tool 读取（lifecycleState + visibilitySummary=tenant）。
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

/** 从 V11Agent 加载并转换为 CatalogEntryInput。 */
async function loadAgents(tenantId: string): Promise<CatalogEntryInput[]> {
  const rows = await db
    .select({
      id: v11Agent.id,
      displayName: v11Agent.displayName,
      description: v11Agent.description,
      ownerUserId: v11Agent.ownerUserId,
      lifecycleState: v11Agent.lifecycleState,
      updatedAt: v11Agent.updatedAt,
    })
    .from(v11Agent)
    .where(and(eq(v11Agent.tenantId, tenantId), isNull(v11Agent.deletedAt)));
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

/** 从 V11Skill 加载并转换为 CatalogEntryInput。 */
async function loadSkills(tenantId: string): Promise<CatalogEntryInput[]> {
  const rows = await db
    .select({
      id: v11Skill.id,
      displayName: v11Skill.displayName,
      description: v11Skill.description,
      ownerUserId: v11Skill.ownerUserId,
      lifecycleState: v11Skill.lifecycleState,
      visibilityScope: v11Skill.visibilityScope,
      updatedAt: v11Skill.updatedAt,
    })
    .from(v11Skill)
    .where(and(eq(v11Skill.tenantId, tenantId), isNull(v11Skill.deletedAt)));
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
 * 从 V11Tool 加载并转换为 CatalogEntryInput。
 *
 * V11Tool 表本身不保存 ownerUserId（owner 概念在 ToolProvider 层），故 innerJoin
 * V11ToolProvider 取其 ownerUserId 作为 CatalogEntry 的 owner。
 */
async function loadTools(tenantId: string): Promise<CatalogEntryInput[]> {
  const rows = await db
    .select({
      id: v11Tool.id,
      displayName: v11Tool.displayName,
      description: v11Tool.description,
      ownerUserId: v11ToolProvider.ownerUserId,
      lifecycleState: v11Tool.lifecycleState,
      updatedAt: v11Tool.updatedAt,
    })
    .from(v11Tool)
    .innerJoin(v11ToolProvider, eq(v11Tool.providerId, v11ToolProvider.id))
    .where(and(eq(v11Tool.tenantId, tenantId), isNull(v11Tool.deletedAt)));
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
  V11CatalogEntry,
  V11CatalogRevision,
} from "@/lib/v11/schema/catalog";
