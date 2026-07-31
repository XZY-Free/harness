/**
 * S13-C03 context_plan 域迁移转换器。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §context_plan
 * - ../v11-agentkit-platform/10-core-data-model.md §5（goal/thread_item）、§7.5（context_checkpoint）
 *
 * 映射：
 * - ContextSummary → V11ContextCheckpoint
 *   - summaryText → summaryRedacted；summaryHash 由 summaryText 计算
 *   - sourceRanges 由 scope（messageIds/toolRunIds/range）派生
 *   - supersededById 保留至 sourceRanges（memory 类型 range，保证可追溯与唯一性）
 *   - originalTokenEstimate→inputTokens, tokenEstimate→retainedTokens, 差值→compressedTokens
 *   - threadId 不存在为异常
 * - ThreadPlan → V11Goal
 *   - status → goalState（active→active, completed→completed, abandoned→cancelled）
 *   - source 保留至 currentStateJson（V11Goal 无 sourceType 字段）
 *   - threadId 不存在为异常
 * - ThreadPlanItem → V11Goal + V11ThreadItem
 *   - status → itemState + goalState（双重映射）
 *   - evidence 不迁移（unmigratableFields）
 *   - planId 不存在为异常
 *
 * 迁移原则：
 * - 只迁可证明事实；threadId/planId 不存在入异常队列，不猜测。
 * - 跨表依赖按域顺序保证：ContextSummary → ThreadPlan → ThreadPlanItem。
 * - 保留源 id 作为目标 id，便于跨表关联追溯。
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import { threadPlan as threadPlanTable, thread as threadTable } from "@/lib/db/schema";
import { DEFAULT_TENANT_ID } from "@/lib/v11/identity/tenant-queries";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { v11ThreadItem as v11ThreadItemTable } from "@/lib/v11/schema/conversation";
import { eq, max } from "drizzle-orm";

// ─── 辅助函数 ──────────────────────────────────────────────

/**
 * 将 Date 值规范化（兼容 string/Date 输入）。
 *
 * 关键：迁移 runner 通过 db.execute 原始 SQL 读取源记录，drizzle mysql2 session 的 typeCast
 * 将 DATETIME/TIMESTAMP/DATE 列统一返回为字符串（见 drizzle-orm/mysql2/session.js 的 typeCast）。
 * 该字符串是 UTC 表示（drizzle mapToDriverValue 用 Date.toISOString() 写入，去 Z 后落库）。
 * 因此必须按 UTC 解析——与 drizzle mapFromDriverValue（new Date(value.replace(" ","T")+"Z")）一致；
 * 若直接 new Date(str) 会按本地时区解析，导致 8h（Asia/Shanghai）偏移，破坏时间戳保真。
 */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const str = String(value);
  // 形如 "2024-06-01 12:00:00" 或 "2024-06-01 12:00:00.000"（drizzle typeCast 返回的 DATETIME 串）
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(str)) {
    return new Date(`${str.replace(" ", "T")}Z`);
  }
  return new Date(str);
}

/** 计算 sha256 内容哈希（sha256: 前缀 + hex）。 */
function computeSha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/**
 * 旧 ContextSummary 无 Invocation 引用，迁移时使用占位值。
 * V11ContextCheckpoint.invocationId 为逻辑外键（无 DB 级 FK 约束），占位值可安全写入。
 */
const LEGACY_INVOCATION_ID = "00000000-0000-4000-8000-000000000003";

/**
 * 旧 ThreadPlanItem 无 Turn 概念，迁移时使用占位值（与 conversation 域迁移一致）。
 * V11ThreadItem.turnId 为逻辑外键（无 DB 级 FK 约束），占位值可安全写入。
 */
const LEGACY_TURN_ID = "00000000-0000-4000-8000-000000000002";

/** 迁移占位 createdBy（V11Goal.createdBy 需非空，旧数据无创建者身份）。 */
const LEGACY_CREATED_BY = "legacy-migration";

/** Checkpoint 默认过期天数（与 createContextCheckpoint 仓储一致）。 */
const CHECKPOINT_TTL_DAYS = 7;

// ─── ThreadPlan status → V11Goal goalState ───────────────

/** ThreadPlan.status → V11Goal.goalState 映射结果；无法映射返回 null。 */
type V11GoalState = "active" | "blocked" | "completed" | "cancelled";

/** 映射 ThreadPlan.status → V11Goal.goalState；无法映射返回 null。 */
function mapPlanStatusToGoalState(status: string): V11GoalState | null {
  switch (status) {
    case "active":
      return "active";
    case "completed":
      return "completed";
    case "abandoned":
      return "cancelled";
    default:
      return null;
  }
}

// ─── ThreadPlanItem status → V11ThreadItem itemState + V11Goal goalState ─

/** V11ThreadItem.itemState 映射结果。 */
type V11ItemState = "pending" | "completed" | "failed" | "cancelled";

/** ThreadPlanItem.status 映射结果（itemState + goalState）。 */
interface ItemStatusMapping {
  readonly itemState: V11ItemState;
  readonly goalState: V11GoalState;
}

/** 映射 ThreadPlanItem.status → itemState + goalState；无法映射返回 null。 */
function mapItemStatus(status: string): ItemStatusMapping | null {
  switch (status) {
    case "pending":
      return { itemState: "pending", goalState: "active" };
    case "in_progress":
      return { itemState: "pending", goalState: "active" };
    case "completed":
      return { itemState: "completed", goalState: "completed" };
    case "failed":
      return { itemState: "failed", goalState: "blocked" };
    case "cancelled":
      return { itemState: "cancelled", goalState: "cancelled" };
    default:
      return null;
  }
}

// ─── ContextSummary.scope → SourceRange[] 派生 ──────────

/** SourceRange 类型（与 V11ContextCheckpoint schema 一致）。 */
interface SourceRange {
  readonly type: "thread_item" | "thread_event" | "memory" | "knowledge";
  readonly fromSequence?: number | null;
  readonly toSequence?: number | null;
  readonly resourceIds?: string[];
  readonly rangeHash: string;
}

/** 从 ContextSummary.scope 派生 sourceRanges 数组（messageIds/toolRunIds/range）。 */
function deriveSourceRanges(scope: unknown): SourceRange[] {
  if (!scope || typeof scope !== "object") return [];
  const scopeObj = scope as Record<string, unknown>;
  const ranges: SourceRange[] = [];

  // messageIds → thread_item range
  const messageIds = Array.isArray(scopeObj.messageIds)
    ? (scopeObj.messageIds as string[]).filter(Boolean)
    : [];
  if (messageIds.length > 0) {
    ranges.push({
      type: "thread_item",
      resourceIds: messageIds,
      rangeHash: computeSha256(JSON.stringify(messageIds)),
    });
  }

  // toolRunIds → thread_item range（工具调用也是 thread_item）
  const toolRunIds = Array.isArray(scopeObj.toolRunIds)
    ? (scopeObj.toolRunIds as string[]).filter(Boolean)
    : [];
  if (toolRunIds.length > 0) {
    ranges.push({
      type: "thread_item",
      resourceIds: toolRunIds,
      rangeHash: computeSha256(JSON.stringify(toolRunIds)),
    });
  }

  // range { from, to } → thread_event range
  const range = scopeObj.range as { from?: number; to?: number } | undefined;
  if (range && (range.from != null || range.to != null)) {
    ranges.push({
      type: "thread_event",
      fromSequence: range.from ?? null,
      toSequence: range.to ?? null,
      rangeHash: computeSha256(JSON.stringify([range.from ?? null, range.to ?? null])),
    });
  }

  return ranges;
}

/**
 * 规范化 SourceRange（排序 resourceIds、补全 null 字段），用于稳定 hash 计算。
 * 与 checkpoint-queries.ts 的 normalizeSourceRange 逻辑一致。
 */
function normalizeSourceRange(range: SourceRange): SourceRange {
  return {
    type: range.type,
    fromSequence: range.fromSequence ?? null,
    toSequence: range.toSequence ?? null,
    resourceIds: range.resourceIds ? [...range.resourceIds].sort() : undefined,
    rangeHash: range.rangeHash,
  };
}

/**
 * 计算来源范围 hash（对 sourceRanges 规范化排序后 sha256，含算法前缀）。
 * 与 checkpoint-queries.ts 的 computeSourceRangesHash 逻辑一致。
 */
function computeSourceRangesHash(sourceRanges: SourceRange[]): string {
  const normalized = sourceRanges.map(normalizeSourceRange).sort((a, b) => {
    const aStr = JSON.stringify(a);
    const bStr = JSON.stringify(b);
    return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
  });
  return computeSha256(JSON.stringify(normalized));
}

// ─── ContextSummary → V11ContextCheckpoint ────────────────

const contextSummaryTransformer: MigrationTransformer = async (record) => {
  const id = String(record.id ?? "");
  if (!id) {
    return { targets: [], anomalyReason: "ContextSummary.id 为空" };
  }

  const threadId = String(record.threadId ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "ContextSummary.threadId 为空" };
  }

  // 查询旧 Thread 表验证 threadId 存在（孤儿摘要入异常队列）
  const [threadRow] = await db
    .select({ id: threadTable.id })
    .from(threadTable)
    .where(eq(threadTable.id, threadId))
    .limit(1);
  if (!threadRow) {
    return { targets: [], anomalyReason: `Thread ${threadId} 不存在` };
  }

  const summaryText = String(record.summaryText ?? "");
  if (!summaryText) {
    return { targets: [], anomalyReason: "ContextSummary.summaryText 为空" };
  }

  // 派生 sourceRanges；追加 memory 类型 range 保留 source id 与 supersededById
  // （保证 sourceRangesHash 唯一性，同时保留追溯链）
  const sourceRanges = deriveSourceRanges(record.scope);
  const memoryResourceIds = [id];
  const supersededById = record.supersededById ? String(record.supersededById) : null;
  if (supersededById) {
    memoryResourceIds.push(supersededById);
  }
  sourceRanges.push({
    type: "memory",
    resourceIds: memoryResourceIds,
    rangeHash: computeSha256(JSON.stringify(memoryResourceIds)),
  });
  const sourceRangesHash = computeSourceRangesHash(sourceRanges);

  // summaryHash 由 summaryText 计算（与 checkpoint-queries.ts computeSummaryHash 一致）
  const summaryHash = computeSha256(summaryText);

  // token 账目：originalTokenEstimate→inputTokens, tokenEstimate→retainedTokens
  const originalTokenEstimate = Number(record.originalTokenEstimate ?? 0);
  const tokenEstimate = Number(record.tokenEstimate ?? 0);
  const compressedTokens = Math.max(0, originalTokenEstimate - tokenEstimate);

  const createdAt = toDate(record.createdAt);
  const expiresAt = new Date(createdAt.getTime() + CHECKPOINT_TTL_DAYS * 24 * 60 * 60 * 1000);

  return {
    targets: [
      {
        table: "V11ContextCheckpoint",
        data: {
          id,
          tenantId: DEFAULT_TENANT_ID,
          invocationId: LEGACY_INVOCATION_ID,
          checkpointType: "compression",
          sourceRangesJson: sourceRanges,
          sourceRangesHash,
          summaryRef: null,
          summaryRedacted: summaryText,
          summaryHash,
          inputTokens: originalTokenEstimate,
          retainedTokens: tokenEstimate,
          compressedTokens,
          createdAt,
          expiresAt,
        },
      },
    ],
  };
};

// ─── ThreadPlan → V11Goal ─────────────────────────────────

const threadPlanTransformer: MigrationTransformer = async (record) => {
  const id = String(record.id ?? "");
  if (!id) {
    return { targets: [], anomalyReason: "ThreadPlan.id 为空" };
  }

  const threadId = String(record.threadId ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "ThreadPlan.threadId 为空" };
  }

  // 查询旧 Thread 表验证 threadId 存在
  const [threadRow] = await db
    .select({ id: threadTable.id })
    .from(threadTable)
    .where(eq(threadTable.id, threadId))
    .limit(1);
  if (!threadRow) {
    return { targets: [], anomalyReason: `Thread ${threadId} 不存在` };
  }

  const status = String(record.status ?? "active");
  const goalState = mapPlanStatusToGoalState(status);
  if (!goalState) {
    return {
      targets: [],
      anomalyReason: `ThreadPlan status "${status}" 无对应 V11 goalState`,
    };
  }

  // source 保留至 currentStateJson（V11Goal 无 sourceType 字段）
  const source = String(record.source ?? "system");
  const currentStateJson = { legacySource: source };

  const objective = String(record.title ?? "");
  const createdAt = toDate(record.createdAt);
  const updatedAt = toDate(record.updatedAt);
  // 终态（completed/abandoned）填 completedAt
  const completedAt = goalState === "completed" || goalState === "cancelled" ? updatedAt : null;

  return {
    targets: [
      {
        table: "V11Goal",
        data: {
          id,
          threadId,
          objective,
          successCriteriaJson: [],
          constraintsJson: null,
          currentStateJson,
          goalState,
          createdBy: LEGACY_CREATED_BY,
          createdAt,
          updatedAt,
          completedAt,
        },
      },
    ],
  };
};

// ─── ThreadPlanItem → V11Goal + V11ThreadItem ─────────────

const threadPlanItemTransformer: MigrationTransformer = async (record) => {
  const id = String(record.id ?? "");
  if (!id) {
    return { targets: [], anomalyReason: "ThreadPlanItem.id 为空" };
  }

  const planId = String(record.planId ?? "");
  if (!planId) {
    return { targets: [], anomalyReason: "ThreadPlanItem.planId 为空" };
  }

  // 查询旧 ThreadPlan 表验证 planId 存在（孤儿条目入异常队列）
  const [planRow] = await db
    .select({ id: threadPlanTable.id })
    .from(threadPlanTable)
    .where(eq(threadPlanTable.id, planId))
    .limit(1);
  if (!planRow) {
    return { targets: [], anomalyReason: `ThreadPlan ${planId} 不存在` };
  }

  const status = String(record.status ?? "pending");
  const mapping = mapItemStatus(status);
  if (!mapping) {
    return {
      targets: [],
      anomalyReason: `ThreadPlanItem status "${status}" 无对应 V11 itemState`,
    };
  }

  const threadId = String(record.threadId ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "ThreadPlanItem.threadId 为空" };
  }

  const objective = String(record.title ?? "");
  const createdAt = toDate(record.createdAt);
  const updatedAt = toDate(record.updatedAt);
  // 终态填 completedAt
  const isTerminal = mapping.itemState !== "pending";
  const completedAt = isTerminal ? updatedAt : null;

  // contentJson：保留 title/planId/position/parentId（evidence 不迁移）
  const contentJson = {
    title: objective,
    planId,
    position: Number(record.position ?? 0),
    parentId: record.parentId ? String(record.parentId) : null,
  };
  const contentHash = computeSha256(JSON.stringify(contentJson));

  // itemSequence：查询当前 Thread 内最大值 + 1（保证唯一，与 conversation 域一致）
  const [seqRow] = await db
    .select({ maxSeq: max(v11ThreadItemTable.itemSequence) })
    .from(v11ThreadItemTable)
    .where(eq(v11ThreadItemTable.threadId, threadId));
  const itemSequence = Number(seqRow?.maxSeq ?? 0) + 1;

  return {
    targets: [
      {
        table: "V11Goal",
        data: {
          id,
          threadId,
          objective,
          successCriteriaJson: [],
          constraintsJson: null,
          currentStateJson: null,
          goalState: mapping.goalState,
          createdBy: LEGACY_CREATED_BY,
          createdAt,
          updatedAt,
          completedAt,
        },
      },
      {
        table: "V11ThreadItem",
        data: {
          id,
          threadId,
          turnId: LEGACY_TURN_ID,
          itemSequence,
          itemType: "user_guidance",
          itemState: mapping.itemState,
          authorType: "system",
          authorId: null,
          contentJson,
          contentHash,
          contextPolicy: "include",
          invocationId: null,
          supersededByItemId: null,
          createdAt,
          updatedAt,
        },
      },
    ],
  };
};

// ─── 导出 context_plan 域转换器注册表 ──────────────────────

/** 创建 context_plan 域的全部转换器（key = 物理表名）。 */
export function createContextPlanTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ["ContextSummary", contextSummaryTransformer],
    ["ThreadPlan", threadPlanTransformer],
    ["ThreadPlanItem", threadPlanItemTransformer],
  ]);
}
