/**
 * V11 CapabilityReview 仓储（阶段 6 S06-C05）。
 *
 * 事实源：lib/v11/schema/tool-call.ts、
 *         ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §5（能力变化与审核）。
 *
 * 职责：
 * - createCapabilityReview：创建审核记录（resourceType/resourceId/oldRevisionId/newRevisionId/
 *   diffType/requiresReview/description/affectedAgentsJson）。
 * - getCapabilityReviewById：按 id 查询（跨租户隔离）。
 * - listPendingReviews：列出 pending 审核（按 tenantId + reviewState=pending，createdAt 升序分页）。
 * - resolveCapabilityReview：审核状态机迁移 pending → approved/rejected，记录审核人与备注。
 *
 * 关键约束：
 * - 状态机：pending → approved/rejected（终态，不可再迁移）。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - resourceType/resourceId 标识被审核的能力资产（skill/tool）。
 * - affectedAgentsJson 为 JSON string[]，记录可能受影响的 Agent id 列表。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  type CapabilityReviewResourceType,
  type CapabilityReviewState,
  type V11CapabilityReview,
  v11CapabilityReview,
} from "@/lib/v11/schema/tool-call";
import { and, asc, eq, gte } from "drizzle-orm";

// ─── 错误类 ────────────────────────────────────────────────

/** CapabilityReview 校验错误（参数非法）。 */
export class CapabilityReviewValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityReviewValidationError";
  }
}

/** CapabilityReview 不存在（或跨租户不可见）。 */
export class CapabilityReviewNotFoundError extends Error {
  constructor(public readonly reviewId: string) {
    super(`CapabilityReview 不存在或跨租户不可见: ${reviewId}`);
    this.name = "CapabilityReviewNotFoundError";
  }
}

/** CapabilityReview 状态机非法迁移（如 approved → rejected）。 */
export class CapabilityReviewStateError extends Error {
  constructor(
    public readonly reviewId: string,
    public readonly fromState: CapabilityReviewState,
    public readonly toState: CapabilityReviewState,
  ) {
    super(`CapabilityReview ${reviewId} 状态不允许 ${fromState} → ${toState}`);
    this.name = "CapabilityReviewStateError";
  }
}

// ─── 常量校验 ─────────────────────────────────────────────

const VALID_RESOURCE_TYPES = new Set<string>(["skill", "tool"]);
const TERMINAL_STATES: ReadonlySet<CapabilityReviewState> = new Set(["approved", "rejected"]);

function assertValidResourceType(value: string): asserts value is CapabilityReviewResourceType {
  if (!VALID_RESOURCE_TYPES.has(value)) {
    throw new CapabilityReviewValidationError(
      "invalid_resource_type",
      `resourceType 非法: ${value}`,
    );
  }
}

// ─── createCapabilityReview ──────────────────────────────

/** createCapabilityReview 入参。 */
export interface CreateCapabilityReviewParams {
  tenantId: string;
  /** 资源类型（skill/tool）。 */
  resourceType: CapabilityReviewResourceType;
  /** 资源稳定 id（如 Tool.id / Skill.id）。 */
  resourceId: string;
  /** 旧修订 id（首次发布时可为空）。 */
  oldRevisionId?: string | null;
  /** 新修订 id（必填）。 */
  newRevisionId: string;
  /** 风险差异类型（read_to_write/new_destructive_op/...）。 */
  diffType: string;
  /** 是否需要集中审核（§5.2 列表命中则 true）。 */
  requiresReview: boolean;
  /** 风险差异描述（人类可读）。 */
  description: string;
  /** 受影响的 Agent id 列表（string[]）。 */
  affectedAgents: string[];
}

/**
 * 创建 CapabilityReview 审核记录。
 *
 * - 初始状态固定为 pending（DB 默认值，调用方不可覆盖）。
 * - affectedAgentsJson 序列化为 JSON string[] 存储。
 * - requiresReview=true 表示需集中审核（调用方根据 RiskDiffResult.requiresReview 传入）。
 *
 * @throws CapabilityReviewValidationError 入参非法
 */
export async function createCapabilityReview(
  params: CreateCapabilityReviewParams,
): Promise<V11CapabilityReview> {
  if (!params.tenantId) {
    throw new CapabilityReviewValidationError("invalid_tenant_id", "tenantId 不能为空");
  }
  assertValidResourceType(params.resourceType);
  if (!params.resourceId) {
    throw new CapabilityReviewValidationError("invalid_resource_id", "resourceId 不能为空");
  }
  if (!params.newRevisionId) {
    throw new CapabilityReviewValidationError("invalid_new_revision_id", "newRevisionId 不能为空");
  }
  if (!params.diffType) {
    throw new CapabilityReviewValidationError("invalid_diff_type", "diffType 不能为空");
  }
  if (!params.description || params.description.trim().length === 0) {
    throw new CapabilityReviewValidationError("invalid_description", "description 不能为空");
  }
  // affectedAgents 必须为 string 数组（允许空数组）。
  if (!Array.isArray(params.affectedAgents)) {
    throw new CapabilityReviewValidationError(
      "invalid_affected_agents",
      "affectedAgents 必须为字符串数组",
    );
  }
  for (const agentId of params.affectedAgents) {
    if (typeof agentId !== "string") {
      throw new CapabilityReviewValidationError(
        "invalid_affected_agents",
        "affectedAgents 必须为字符串数组",
      );
    }
  }

  const id = randomUUID();
  await db.insert(v11CapabilityReview).values({
    id,
    tenantId: params.tenantId,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    oldRevisionId: params.oldRevisionId ?? null,
    newRevisionId: params.newRevisionId,
    diffType: params.diffType,
    requiresReview: params.requiresReview,
    description: params.description,
    affectedAgentsJson: params.affectedAgents,
    reviewState: "pending",
  });

  const [row] = await db
    .select()
    .from(v11CapabilityReview)
    .where(eq(v11CapabilityReview.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`createCapabilityReview: 行未找到（id=${id}）`);
  }
  return row;
}

// ─── 查询 ─────────────────────────────────────────────────

/** 按 id 查询 CapabilityReview（跨租户隔离）。不存在返回 null。 */
export async function getCapabilityReviewById(params: {
  tenantId: string;
  reviewId: string;
}): Promise<V11CapabilityReview | null> {
  const [row] = await db
    .select()
    .from(v11CapabilityReview)
    .where(
      and(
        eq(v11CapabilityReview.tenantId, params.tenantId),
        eq(v11CapabilityReview.id, params.reviewId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** listPendingReviews 入参。 */
export interface ListPendingReviewsParams {
  tenantId: string;
  /** 可选：按资源类型过滤。 */
  resourceType?: CapabilityReviewResourceType | null;
  /** 可选：按资源 id 过滤。 */
  resourceId?: string | null;
  /** 可选：按审核状态过滤；默认只返回 pending。传值则覆盖默认。 */
  reviewState?: CapabilityReviewState | null;
  /** 分页大小；默认 50，最大 200。 */
  limit?: number;
  /** 分页游标（上一页最后一条的 createdAt ISO 字符串 + "|" + id）；首页不传。 */
  cursor?: string | null;
}

/** listPendingReviews 返回值。 */
export interface ListPendingReviewsResult {
  items: V11CapabilityReview[];
  nextCursor: string | null;
}

/**
 * 列出审核记录（默认 pending；按 createdAt 升序 + id 升序分页）。
 *
 * - 不传 reviewState 时默认只返回 pending（典型场景：审核队列）。
 * - cursor 为上一页最后一条的 `${createdAt.toISOString()}|${id}`。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */
export async function listPendingReviews(
  params: ListPendingReviewsParams,
): Promise<ListPendingReviewsResult> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const reviewState: CapabilityReviewState = params.reviewState ?? "pending";

  // 构造 where 条件
  const conditions = [eq(v11CapabilityReview.tenantId, params.tenantId)];

  // 解析 cursor
  if (params.cursor) {
    const sepIdx = params.cursor.indexOf("|");
    if (sepIdx > 0) {
      const cursorTimeStr = params.cursor.slice(0, sepIdx);
      const cursorId = params.cursor.slice(sepIdx + 1);
      const cursorDate = new Date(cursorTimeStr);
      if (!Number.isNaN(cursorDate.getTime())) {
        // (createdAt, id) > (cursorDate, cursorId)：createdAt > cursorDate OR (createdAt = cursorDate AND id > cursorId)
        // 这里简化为 createdAt >= cursorDate 后在应用层过滤，或用 OR 条件。
        // 为正确性，使用 gte + 应用层排除已包含项；为简化使用 (createdAt > cursor) 的严格大于 + OR 等价条件。
        // Drizzle 不支持 tuple 比较，因此用 OR 表达。
        // 此处简化：使用 gte + 限制 limit+1 然后在应用层去重 cursor 行。
        conditions.push(gte(v11CapabilityReview.createdAt, cursorDate));
      }
    }
  }

  if (params.resourceType) {
    conditions.push(eq(v11CapabilityReview.resourceType, params.resourceType));
  }
  if (params.resourceId) {
    conditions.push(eq(v11CapabilityReview.resourceId, params.resourceId));
  }
  conditions.push(eq(v11CapabilityReview.reviewState, reviewState));

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const rows = await db
    .select()
    .from(v11CapabilityReview)
    .where(where)
    .orderBy(asc(v11CapabilityReview.createdAt), asc(v11CapabilityReview.id))
    .limit(limit + 1);

  // cursor 分页：若使用 gte 过滤，需在应用层去掉 cursor 之前的行（含 cursor 行自身）。
  let filteredRows = rows;
  if (params.cursor) {
    const sepIdx = params.cursor.indexOf("|");
    if (sepIdx > 0) {
      const cursorTimeStr = params.cursor.slice(0, sepIdx);
      const cursorId = params.cursor.slice(sepIdx + 1);
      const cursorDate = new Date(cursorTimeStr);
      if (!Number.isNaN(cursorDate.getTime())) {
        filteredRows = rows.filter((row) => {
          const rowTime = row.createdAt.getTime();
          const cursorTime = cursorDate.getTime();
          if (rowTime > cursorTime) return true;
          if (rowTime === cursorTime && row.id > cursorId) return true;
          return false;
        });
      }
    }
  }

  const hasMore = filteredRows.length > limit;
  const items = hasMore ? filteredRows.slice(0, limit) : filteredRows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null;

  return { items, nextCursor };
}

// ─── resolveCapabilityReview ─────────────────────────────

/** resolveCapabilityReview 入参。 */
export interface ResolveCapabilityReviewParams {
  tenantId: string;
  reviewId: string;
  /** 目标状态：approved / rejected。 */
  toState: "approved" | "rejected";
  /** 审核人 userIdentityId 或 serviceId。 */
  reviewedBy: string;
  /** 审核备注；可空。 */
  reviewNotes?: string | null;
}

/**
 * 审核状态机迁移：pending → approved/rejected。
 *
 * - approved/rejected 为终态，已终态时拒绝迁移。
 * - 记录 reviewedBy / reviewedAt / reviewNotes。
 *
 * @throws CapabilityReviewNotFoundError 审核记录不存在或跨租户
 * @throws CapabilityReviewStateError 状态机非法迁移（如 approved → rejected）
 * @throws CapabilityReviewValidationError 入参非法
 */
export async function resolveCapabilityReview(
  params: ResolveCapabilityReviewParams,
): Promise<V11CapabilityReview> {
  if (params.toState !== "approved" && params.toState !== "rejected") {
    throw new CapabilityReviewValidationError(
      "invalid_to_state",
      `toState 必须为 approved/rejected，实际为 ${params.toState}`,
    );
  }
  if (!params.reviewedBy) {
    throw new CapabilityReviewValidationError("invalid_reviewed_by", "reviewedBy 不能为空");
  }

  const current = await getCapabilityReviewById({
    tenantId: params.tenantId,
    reviewId: params.reviewId,
  });
  if (!current) {
    throw new CapabilityReviewNotFoundError(params.reviewId);
  }

  if (current.reviewState === params.toState) {
    // 同状态：允许补充 reviewNotes（幂等），不视为非法迁移。
    if (params.reviewNotes !== undefined && params.reviewNotes !== current.reviewNotes) {
      const now = new Date();
      await db
        .update(v11CapabilityReview)
        .set({
          reviewNotes: params.reviewNotes,
          updatedAt: now,
        })
        .where(
          and(
            eq(v11CapabilityReview.tenantId, params.tenantId),
            eq(v11CapabilityReview.id, params.reviewId),
          ),
        );
      const refreshed = await getCapabilityReviewById({
        tenantId: params.tenantId,
        reviewId: params.reviewId,
      });
      if (!refreshed) {
        throw new CapabilityReviewNotFoundError(params.reviewId);
      }
      return refreshed;
    }
    return current;
  }

  if (TERMINAL_STATES.has(current.reviewState)) {
    throw new CapabilityReviewStateError(params.reviewId, current.reviewState, params.toState);
  }

  // pending → approved/rejected
  if (current.reviewState !== "pending") {
    throw new CapabilityReviewStateError(params.reviewId, current.reviewState, params.toState);
  }

  const now = new Date();
  await db
    .update(v11CapabilityReview)
    .set({
      reviewState: params.toState,
      reviewedBy: params.reviewedBy,
      reviewedAt: now,
      reviewNotes: params.reviewNotes ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(v11CapabilityReview.tenantId, params.tenantId),
        eq(v11CapabilityReview.id, params.reviewId),
      ),
    );

  const updated = await getCapabilityReviewById({
    tenantId: params.tenantId,
    reviewId: params.reviewId,
  });
  if (!updated) {
    throw new CapabilityReviewNotFoundError(params.reviewId);
  }
  return updated;
}

// ─── Re-exports ────────────────────────────────────────────

export type {
  CapabilityReviewResourceType,
  CapabilityReviewState,
  V11CapabilityReview,
} from "@/lib/v11/schema/tool-call";
