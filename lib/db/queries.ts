import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { approvalConfig, dbConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { encryptCicdToken } from "@/lib/runtime/secret-crypto";
// P2-closeout: thread-events-bus 已删（SSE 端点 app/api/threads/** 随本地执行体系移除）。
import { escapeLikeWildcards } from "@/lib/utils";
import {
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  max,
  or,
  sql,
} from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { db } from "./client";

/**
 * 事务客户端类型(db 或 db.transaction 的 tx),供函数可选接入事务。
 * 事务外的调用方不传 tx,函数内用 db;事务内传 tx,写入加入同一原子边界。
 */
export type DbTxClient = Parameters<Parameters<typeof db.transaction>[0]>[0];
import {
  type AdminAuditAction,
  type AdminAuditLog,
  type AdminAuditOutcome,
  type ApprovalRequestStatus,
  type ApprovalScope,
  type ContextSnapshot,
  type ContextSummary,
  type ContextSummaryType,
  type CustomTool,
  type Deployment,
  type DeploymentStatus,
  type GitCheckpoint,
  type McpServerConfig,
  type MemoryConfidence,
  type MemoryEmbedding,
  type MemoryEntry,
  type MemoryKind,
  type MemoryProvenanceEntry,
  type MemoryScope,
  type MemoryStatus,
  type PermissionDecision,
  type PermissionScope,
  type SecretMount,
  type SecretMountScope,
  type SecretMountStatus,
  type ThreadPlan,
  type ThreadPlanItem,
  type ThreadPlanItemStatus,
  type ToolApprovalRequest,
  type ToolPermissionRule,
  type ToolRun,
  type ToolRunStatus,
  adminAuditLog,
  auditFailureLog,
  contextSnapshot,
  contextSummary,
  customTool,
  deployment,
  gitCheckpoint,
  mcpServerConfig,
  memoryEmbedding,
  memoryEntry,
  policyConfig,
  policyConfigHistory,
  secretMount,
  threadPlan,
  threadPlanItem,
  toolApprovalRequest,
  toolPermissionRule,
  toolRun,
  user,
} from "./schema";
import {
  contextSnapshotChecksumsSchema,
  contextSnapshotLayersSchema,
  contextSnapshotSkillLoadEvidenceSchema,
  contextSnapshotSkillResolverInputSchema,
  contextSnapshotSkillResolverOutputSchema,
  customToolExecutorConfigSchema,
  customToolInputSchemaSchema,
  memoryProvenanceSchema,
  threadPinnedFactsSchema,
  toolRunInputSchema,
  toolRunOutputSchema,
  validateJsonColumn,
} from "./schemas/json-columns";

// ─── Tool Run Queries (结构化工具执行记录) ───────────

/**
 * 创建一个 tool run 记录（默认状态 running）。
 *
 * `status` 可选，ask 暂停时传 `awaiting_approval`，以区分「被治理暂停」与「业务失败」。
 *
 * @returns 新创建的 ToolRun（含 id，用于后续 finish 调用）
 */
export async function createToolRun(params: {
  threadId: string;
  toolName: string;
  input: Record<string, unknown>;
  status?: ToolRunStatus;
  /** 归属历史 run（nullable（历史记录可空））。 */
  runId?: string | null;
}): Promise<ToolRun> {
  // json 列 zod 校验（fail-closed，脏数据抛错不落库）
  const input = validateJsonColumn(params.input, toolRunInputSchema, "input");
  // MySQL 不支持 RETURNING，自行生成主键并构造返回对象。
  const run: ToolRun = {
    id: randomUUID(),
    threadId: params.threadId,
    toolName: params.toolName,
    status: params.status ?? "running",
    input,
    output: null,
    error: null,
    startedAt: new Date(),
    finishedAt: null,
    runId: params.runId ?? null,
  };
  await db.insert(toolRun).values(run);
  return run;
}

/**
 * 标记 tool run 为成功，回填 output / finishedAt。
 */
export async function finishToolRunSuccess(
  toolRunId: string,
  output: Record<string, unknown>,
): Promise<void> {
  // json 列 zod 校验（fail-closed）
  const validatedOutput = validateJsonColumn(output, toolRunOutputSchema, "output");
  await db
    .update(toolRun)
    .set({ status: "succeeded", output: validatedOutput, finishedAt: new Date() })
    .where(and(eq(toolRun.id, toolRunId), eq(toolRun.status, "running")));
}

/**
 * 标记 tool run 为失败，回填 error / finishedAt。
 */
export async function finishToolRunFailure(toolRunId: string, error: string): Promise<void> {
  await db
    .update(toolRun)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(and(eq(toolRun.id, toolRunId), eq(toolRun.status, "running")));
}

/**
 * 审计修复：将指定 thread 所有仍处于 "running" 的 ToolRun 标记为 "failed"。
 *
 * 当 thread run 被取消或异常失败时，可能还有工具正在执行。cancelRun / markFailed
 * 更新了 thread 状态但未处理进行中的 ToolRun，导致这些行永久停留在 "running"
 * （finishedAt=null）。Studio 的 tool-trace 面板和按 status 过滤的查询会看到幽灵条目。
 */
export async function failRunningToolRunsForThread(
  threadId: string,
  reason: string,
  runId?: string,
): Promise<void> {
  // : 限定 runId 防误杀——cancel/markFailed 后用户立即发新消息触发新 run,
  // 旧批量 fail 若不带 runId 会把新 run 刚 createToolRun(status=running) 的工具也标 failed。
  const conds = [eq(toolRun.threadId, threadId), eq(toolRun.status, "running")];
  if (runId) conds.push(eq(toolRun.runId, runId));
  await db
    .update(toolRun)
    .set({ status: "failed", error: reason, finishedAt: new Date() })
    .where(and(...conds));
}

// ─── Tool Run 查询 (a 上下文压缩数据源) ──────────────────

/**
 * 列某 thread 的 toolRun（按 startedAt desc）。供上下文压缩提取 toolRun/diff/debug 摘要。
 * limit 默认 100、上限 500、下限 1。
 */
export async function listToolRunsByThread(threadId: string, limit = 100): Promise<ToolRun[]> {
  const clamped = Math.min(500, Math.max(1, Math.floor(limit)));
  return db
    .select()
    .from(toolRun)
    .where(eq(toolRun.threadId, threadId))
    .orderBy(desc(toolRun.startedAt))
    .limit(clamped);
}

/** 取 thread 最近一次失败的 toolRun（按 startedAt desc），无则 null。供 protected recentFailure。 */
export async function getRecentFailedToolRun(threadId: string): Promise<ToolRun | null> {
  const [row] = await db
    .select()
    .from(toolRun)
    .where(and(eq(toolRun.threadId, threadId), eq(toolRun.status, "failed")))
    .orderBy(desc(toolRun.startedAt))
    .limit(1);
  return row ?? null;
}

// ─── Policy Config 写入 () ──────────────────

/**
 * 整配置覆盖 PolicyConfig：事务内删掉给定 key 的旧行，再插入规范化新行。
 *
 * Policy PUT 是「整配置提交」（4 个白名单 key 全量），故用 delete+insert 覆盖语义,
 * 避免单行 upsert 留下未更新的脏行。调用方负责先用 validatePolicyRows 规范化。
 */
export async function replacePolicyConfigRows(
  rows: Array<{ key: string; value: unknown }>,
): Promise<void> {
  const keys = rows.map((r) => r.key);
  const now = new Date();
  await db.transaction(async (tx) => {
    if (keys.length > 0) {
      await tx.delete(policyConfig).where(inArray(policyConfig.key, keys));
    }
    if (rows.length > 0) {
      await tx
        .insert(policyConfig)
        .values(rows.map((r) => ({ key: r.key, value: r.value, updatedAt: now })));
    }
  });
}

/**
 * 记录 policy 配置变更历史（before/after 快照 + changedKeys）。
 * 由 PUT /studio/api/policies 在 replacePolicyConfigRows 后调用。
 */
export async function insertPolicyConfigHistory(params: {
  changedBy: string;
  beforeSnapshot: string;
  afterSnapshot: string;
  changedKeys: string | null;
}): Promise<void> {
  await db.insert(policyConfigHistory).values({
    changedBy: params.changedBy,
    beforeSnapshot: params.beforeSnapshot,
    afterSnapshot: params.afterSnapshot,
    changedKeys: params.changedKeys,
    changedAt: new Date(),
  });
}

// ─── Admin Audit Queries (切片 C: append-only 审计) ──
//
// 仅 append + list，**不提供 update/delete**（约束 7）。metadata 由调用方经
// lib/studio/admin-audit.ts#sanitizeAuditMetadata 脱敏后传入；本层不做二次脱敏。

export type AppendAdminAuditLogInput = {
  actorUserId: string;
  action: AdminAuditAction;
  targetType: string;
  targetId: string;
  outcome: AdminAuditOutcome;
  metadata: Record<string, unknown>;
};

/**
 * 追加一条审计记录。MySQL 不支持 RETURNING，自行生成主键并构造返回对象。
 * metadata 必须是可 JSON 序列化的对象（调用方负责脱敏）。
 */
export async function appendAdminAuditLog(
  input: AppendAdminAuditLogInput,
  tx?: DbTxClient,
): Promise<AdminAuditLog> {
  const row = buildAdminAuditLogRow(input);
  await (tx ?? db).insert(adminAuditLog).values(row);
  return row;
}

/** 构造一条审计行（不落库），供 appendAdminAuditLog 与事务内插入复用。 */
function buildAdminAuditLogRow(input: AppendAdminAuditLogInput): AdminAuditLog {
  return {
    id: randomUUID(),
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    outcome: input.outcome,
    metadata: input.metadata,
    createdAt: new Date(),
  };
}

/**
 * 列审计记录，按 createdAt desc。limit 默认 100、上限 200、下限 1。
 * 可按 actor / action / targetType / targetId 过滤。空入参 → 默认查询。
 */
/**
 * 审计日志行：AdminAuditLog 全字段 + 操作者可读名（供 UI 显示，避免裸 actorUserId）。
 * actor 已删档 → actorName/actorEmail=null（leftJoin）。
 */
export type AuditLogRow = AdminAuditLog & {
  actorName: string | null;
  actorEmail: string | null;
};

export async function listAdminAuditLogs(params?: {
  limit?: number;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  action?: AdminAuditAction;
}): Promise<AuditLogRow[]> {
  const rawLimit = params?.limit;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit)
      ? Math.min(200, Math.max(1, Math.floor(rawLimit)))
      : 100;
  const conds = [];
  if (params?.actorUserId) conds.push(eq(adminAuditLog.actorUserId, params.actorUserId));
  if (params?.action) conds.push(eq(adminAuditLog.action, params.action));
  if (params?.targetType) conds.push(eq(adminAuditLog.targetType, params.targetType));
  if (params?.targetId) conds.push(eq(adminAuditLog.targetId, params.targetId));
  const base = db
    .select({
      id: adminAuditLog.id,
      actorUserId: adminAuditLog.actorUserId,
      action: adminAuditLog.action,
      targetType: adminAuditLog.targetType,
      targetId: adminAuditLog.targetId,
      outcome: adminAuditLog.outcome,
      metadata: adminAuditLog.metadata,
      createdAt: adminAuditLog.createdAt,
      actorName: user.name,
      actorEmail: user.email,
    })
    .from(adminAuditLog)
    .leftJoin(user, eq(adminAuditLog.actorUserId, user.id));
  const query = conds.length > 0 ? base.where(and(...conds)) : base;
  return query.orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id)).limit(limit);
}

// ─── Context Snapshot Queries (Stage C) ────────────────
//
// 每次模型调用前构建的 context manifest 落库。manifest 只记来源与摘要，调用方负责
// 不塞完整 prompt / 用户消息正文 / 完整工具输出（隐私约束）。

/** 创建一条 context snapshot（MySQL 不支持 RETURNING，自行生成主键并构造返回对象）。 */
export async function saveContextSnapshot(params: {
  threadId: string;
  trigger: string;
  model: string;
  runtimeType?: string | null;
  activeSkillVersionId?: string | null;
  toolNames: string[];
  layers: unknown;
  protectedRefs: unknown;
  excludedCandidates: unknown;
  checksums: Record<string, string>;
  estimatedTokens: number;
  /** 本轮是否压缩装配（与真实模型输入一致）。 */
  compressed?: boolean;
  /** 本轮装配后真实模型输入 token（nullable（旧快照可空））。 */
  afterTokens?: number | null;
  /** V8：本轮 Skill Resolver 输入摘要（availableSkillCount / uiSelectedSkillIds）。 */
  skillResolverInput?: unknown;
  /** V8：本轮 Skill Resolver 输出摘要。 */
  skillResolverOutput?: unknown;
  /** V8：readSkillFile 加载证据（运行结束 flush 写入；创建时省略）。 */
  skillLoadEvidence?: unknown;
  /** 归属历史 run（nullable（历史快照可空））。 */
  runId?: string | null;
}): Promise<ContextSnapshot> {
  // json 列 zod 校验（fail-closed，脏数据抛错不落库）
  const layers = validateJsonColumn(params.layers, contextSnapshotLayersSchema, "layers");
  const checksums = validateJsonColumn(
    params.checksums,
    contextSnapshotChecksumsSchema,
    "checksums",
  );
  const skillResolverInput = params.skillResolverInput
    ? validateJsonColumn(
        params.skillResolverInput,
        contextSnapshotSkillResolverInputSchema,
        "skillResolverInput",
      )
    : null;
  const skillResolverOutput = params.skillResolverOutput
    ? validateJsonColumn(
        params.skillResolverOutput,
        contextSnapshotSkillResolverOutputSchema,
        "skillResolverOutput",
      )
    : null;
  const row: ContextSnapshot = {
    id: randomUUID(),
    threadId: params.threadId,
    trigger: params.trigger,
    model: params.model,
    runtimeType: params.runtimeType ?? null,
    activeSkillVersionId: params.activeSkillVersionId ?? null,
    toolNames: params.toolNames,
    layers,
    protectedRefs: params.protectedRefs,
    excludedCandidates: params.excludedCandidates,
    checksums,
    estimatedTokens: params.estimatedTokens,
    compressed: params.compressed ?? false,
    afterTokens: params.afterTokens ?? null,
    skillResolverInput,
    skillResolverOutput,
    skillLoadEvidence: null,
    runId: params.runId ?? null,
    createdAt: new Date(),
  };
  await db.insert(contextSnapshot).values(row);
  return row;
}

/**
 * V8：把 readSkillFile 加载证据写回某 run 最近一条 ContextSnapshot（运行结束 flush 调用）。
 *
 * fail-open：找不到快照或写入失败只记 log，不抛出（证据是可观测性数据，不阻断 run 收尾）。
 * 同时支持 null evidence（清空占位，理论上不使用）。
 */
export async function attachSkillLoadEvidence(runId: string, evidence: unknown): Promise<void> {
  try {
    const validated = validateJsonColumn(
      evidence,
      contextSnapshotSkillLoadEvidenceSchema,
      "skillLoadEvidence",
    );
    // 取该 run 最近一条快照（run 维度，通常只有一条 chat.user_message 触发）
    const [latest] = await db
      .select({ id: contextSnapshot.id })
      .from(contextSnapshot)
      .where(eq(contextSnapshot.runId, runId))
      .orderBy(desc(contextSnapshot.createdAt), desc(contextSnapshot.id))
      .limit(1);
    if (!latest) return;
    await db
      .update(contextSnapshot)
      .set({ skillLoadEvidence: validated })
      .where(eq(contextSnapshot.id, latest.id));
  } catch (error) {
    logger.warn("[attachSkillLoadEvidence] 写入失败（fail-open）", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 取某 thread 最近的 context snapshot（按 createdAt desc）。limit 默认 20、上限 100、下限 1。
 */
export async function listContextSnapshotsForThread(
  threadId: string,
  limit = 20,
): Promise<ContextSnapshot[]> {
  const clamped = Math.min(100, Math.max(1, Math.floor(limit)));
  return db
    .select()
    .from(contextSnapshot)
    .where(eq(contextSnapshot.threadId, threadId))
    .orderBy(desc(contextSnapshot.createdAt), desc(contextSnapshot.id))
    .limit(clamped);
}

// ─── Context Summary Queries (a) ────────────────────────
//
// 压缩派生视图的 CRUD。一行 = 一个被摘要的消息区段或工具证据区段。
// supersede 链：区段扩展被重新摘要时，旧 summary.supersededById 指向新 summary；
// 查询只取未 supersede 的（supersededById IS NULL）。

/** 创建一条 ContextSummary。 */
export async function createContextSummary(params: {
  threadId: string;
  type: ContextSummaryType;
  scope: unknown;
  summaryText: string;
  checksum: string;
  tokenEstimate: number;
  originalTokenEstimate: number;
  protectedRefs: unknown;
}): Promise<ContextSummary> {
  const row: ContextSummary = {
    id: randomUUID(),
    threadId: params.threadId,
    type: params.type,
    scope: params.scope,
    summaryText: params.summaryText,
    checksum: params.checksum,
    tokenEstimate: params.tokenEstimate,
    originalTokenEstimate: params.originalTokenEstimate,
    protectedRefs: params.protectedRefs,
    supersededById: null,
    createdAt: new Date(),
  };
  await db.insert(contextSummary).values(row);
  return row;
}

/**
 * 按 checksum 查活跃 summary（未 supersede）。命中则复用，不重算。
 * 返回 null 表示无可用复用。
 */
export async function getActiveSummaryByChecksum(
  threadId: string,
  checksum: string,
): Promise<ContextSummary | null> {
  const [row] = await db
    .select()
    .from(contextSummary)
    .where(
      and(
        eq(contextSummary.threadId, threadId),
        eq(contextSummary.checksum, checksum),
        isNull(contextSummary.supersededById),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 列某 thread 的全部 summary（按 createdAt desc）。默认只取未 supersede 的活跃摘要；
 * includeSuperseded=true 时返回全部（含历史链）。
 */
export async function listSummariesByThread(
  threadId: string,
  options?: { limit?: number; includeSuperseded?: boolean },
): Promise<ContextSummary[]> {
  const limit = Math.min(200, Math.max(1, Math.floor(options?.limit ?? 50)));
  const conditions = [eq(contextSummary.threadId, threadId)];
  if (!options?.includeSuperseded) {
    conditions.push(isNull(contextSummary.supersededById));
  }
  return db
    .select()
    .from(contextSummary)
    .where(and(...conditions))
    .orderBy(desc(contextSummary.createdAt), desc(contextSummary.id))
    .limit(limit);
}

/**
 * Supersede：把旧 summary 标记为被新 summary 取代。
 * 旧 summary.supersededById 指向新 summary id；之后查询不再返回旧 summary。
 */
export async function supersedeSummary(params: {
  oldSummaryId: string;
  newSummaryId: string;
}): Promise<void> {
  await db
    .update(contextSummary)
    .set({ supersededById: params.newSummaryId })
    .where(eq(contextSummary.id, params.oldSummaryId));
}

/**
 * supersede 链 GC。
 *
 * supersedeSummary 只标记 supersededById 不删除，长期会话累积大量已 supersede 的旧 summary。
 * 本函数物理删除 `supersededById IS NOT NULL AND createdAt < now - retainDays` 的旧 summary，
 * 保留近期（默认 7 天）供审计/回看。由 retention 定时任务调用。
 * @returns 删除条数
 */
export async function cleanupSupersededSummaries(retainDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(contextSummary)
    .where(and(isNotNull(contextSummary.supersededById), lt(contextSummary.createdAt, cutoff)));
  // drizzle mysql delete 返回affected rows在result[0].affectedRows
  const affected = (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
  return affected;
}

// ─── Thread Plan / Todo Queries (Stage D) ──────────────
//
// thread 级计划容器与条目。不要求 agent 自动写计划，仅提供数据层与查询接口，
// 供后续 todoWrite / subagent / 状态恢复与 Studio 只读展示复用。所有查询带 threadId
// 过滤，不提供跨 thread 裸查。

/** 创建一个 thread plan（状态默认 active）。同时追加 plan.created 事件。 */
export async function createThreadPlan(params: {
  threadId: string;
  title: string;
  source?: string;
}): Promise<ThreadPlan> {
  const now = new Date();
  const row: ThreadPlan = {
    id: randomUUID(),
    threadId: params.threadId,
    title: params.title,
    status: "active",
    source: params.source ?? "system",
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(threadPlan).values(row);
  return row;
}

/** 取 thread 当前 active plan（最近创建的一条 active）。无则 null。 */
export async function getActiveThreadPlan(threadId: string): Promise<ThreadPlan | null> {
  const [row] = await db
    .select()
    .from(threadPlan)
    .where(and(eq(threadPlan.threadId, threadId), eq(threadPlan.status, "active")))
    .orderBy(desc(threadPlan.createdAt), desc(threadPlan.id))
    .limit(1);
  return row ?? null;
}

/** 列 thread 全部 plan（按 createdAt desc）。 */
export async function listThreadPlans(threadId: string): Promise<ThreadPlan[]> {
  return db
    .select()
    .from(threadPlan)
    .where(eq(threadPlan.threadId, threadId))
    .orderBy(desc(threadPlan.createdAt), desc(threadPlan.id));
}

/**
 * 新增或更新一个 plan item。传入 id 已存在则更新（title/position/status/evidence/parentId
 * 任一非 undefined 字段），否则插入。返回最终行（MySQL 无 RETURNING，按入参构造）。
 */
export async function upsertThreadPlanItem(params: {
  id: string;
  planId: string;
  threadId: string;
  title?: string;
  position?: number;
  status?: ThreadPlanItemStatus;
  evidence?: unknown;
  parentId?: string | null;
}): Promise<ThreadPlanItem> {
  // 先探存在性
  const [existing] = await db
    .select()
    .from(threadPlanItem)
    .where(eq(threadPlanItem.id, params.id))
    .limit(1);
  const now = new Date();
  if (existing) {
    const sets: Record<string, unknown> = { updatedAt: now };
    if (params.title !== undefined) sets.title = params.title;
    if (params.position !== undefined) sets.position = params.position;
    if (params.status !== undefined) sets.status = params.status;
    if (params.evidence !== undefined) sets.evidence = params.evidence;
    if (params.parentId !== undefined) sets.parentId = params.parentId;
    await db.update(threadPlanItem).set(sets).where(eq(threadPlanItem.id, params.id));
    return { ...existing, ...sets } as ThreadPlanItem;
  }
  const row: ThreadPlanItem = {
    id: params.id,
    planId: params.planId,
    threadId: params.threadId,
    parentId: params.parentId ?? null,
    position: params.position ?? 0,
    title: params.title ?? "",
    status: params.status ?? "pending",
    evidence: params.evidence ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(threadPlanItem).values(row);
  return row;
}

/** 列 plan items（按 position asc）。planId 省略时取该 thread 全部 items。 */
export async function listThreadPlanItems(
  threadId: string,
  planId?: string,
): Promise<ThreadPlanItem[]> {
  const conds = [eq(threadPlanItem.threadId, threadId)];
  if (planId) conds.push(eq(threadPlanItem.planId, planId));
  return db
    .select()
    .from(threadPlanItem)
    .where(and(...conds))
    .orderBy(asc(threadPlanItem.position));
}

/**
 * 更新 item 状态，并写 plan.item_updated 事件。返回更新后的行（按入参 + existing 合并）。
 */
export async function updateThreadPlanItemStatus(params: {
  id: string;
  status: ThreadPlanItemStatus;
}): Promise<ThreadPlanItem | null> {
  const [existing] = await db
    .select()
    .from(threadPlanItem)
    .where(eq(threadPlanItem.id, params.id))
    .limit(1);
  if (!existing) return null;
  const now = new Date();
  await db
    .update(threadPlanItem)
    .set({ status: params.status, updatedAt: now })
    .where(eq(threadPlanItem.id, params.id));
  return { ...existing, status: params.status, updatedAt: now };
}

/** 放弃 plan（status → abandoned），并写 plan.updated 事件。 */
export async function abandonThreadPlan(planId: string): Promise<void> {
  const now = new Date();
  await db
    .update(threadPlan)
    .set({ status: "abandoned", updatedAt: now })
    .where(eq(threadPlan.id, planId));
}

// ─── Tool Permission Rule / Approval Request Queries () ──
//
// ask/deny/ask 权限引擎的数据层。规则默认从 PolicyConfig 派生（lib/permission/rules.ts），
// DB 行作覆盖；approval 记录 ask 暂停产生的待审批请求，批准复用语义由
// status=approved + approvedScope + argFingerprint 表达（不单建 ToolApproval 表）。

/** 列全部持久化权限规则（默认规则的 DB 覆盖）。按 priority 降序。 */
export async function listPermissionRules(): Promise<ToolPermissionRule[]> {
  return db.select().from(toolPermissionRule).orderBy(desc(toolPermissionRule.priority));
}

/**
 * 创建一条持久化权限规则（DB 覆盖默认规则）。无 UI 编辑入口，供 seed/测试用。
 *
 * actorUserId 非空时同事务落 permission_rule.created 审计行（input 经脱敏）。
 * seed 等无 actor 场景不传 actorUserId，不写审计（seed 行为可由 git 历史/部署日志追溯）。
 */
export async function createPermissionRule(params: {
  scope?: PermissionScope;
  scopeRef?: string | null;
  toolPattern: string;
  argMatcher?: Record<string, unknown> | null;
  decision: PermissionDecision;
  reason?: string | null;
  priority?: number;
  /** 操作者用户 id（非空时落审计）。 */
  actorUserId?: string | null;
}): Promise<ToolPermissionRule> {
  const now = new Date();
  const row: ToolPermissionRule = {
    id: randomUUID(),
    scope: params.scope ?? "global",
    scopeRef: params.scopeRef ?? null,
    toolPattern: params.toolPattern,
    argMatcher: params.argMatcher ?? null,
    decision: params.decision,
    reason: params.reason ?? null,
    priority: params.priority ?? 0,
    createdAt: now,
    updatedAt: now,
  };
  const auditRow =
    params.actorUserId != null
      ? buildAdminAuditLogRow({
          actorUserId: params.actorUserId,
          action: "permission_rule.created",
          targetType: "permission_rule",
          targetId: row.id,
          outcome: "succeeded",
          metadata: {
            scope: row.scope,
            scopeRef: row.scopeRef,
            toolPattern: row.toolPattern,
            decision: row.decision,
            priority: row.priority,
          },
        })
      : null;
  await db.transaction(async (tx) => {
    await tx.insert(toolPermissionRule).values(row);
    if (auditRow) await tx.insert(adminAuditLog).values(auditRow);
  });
  return row;
}

/**
 * 更新一条持久化权限规则。
 *
 * 字段全可选，仅更新传入字段。actorUserId 非空时落 permission_rule.updated 审计。
 * 规则不存在 → 返回 null（调用方据此 404）。
 */
export async function updatePermissionRule(
  id: string,
  patch: {
    scope?: PermissionScope;
    scopeRef?: string | null;
    toolPattern?: string;
    argMatcher?: Record<string, unknown> | null;
    decision?: PermissionDecision;
    reason?: string | null;
    priority?: number;
  },
  actorUserId?: string | null,
): Promise<ToolPermissionRule | null> {
  const [existing] = await db
    .select()
    .from(toolPermissionRule)
    .where(eq(toolPermissionRule.id, id))
    .limit(1);
  if (!existing) return null;
  const sets: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) sets[k] = v;
  }
  const auditRow =
    actorUserId != null
      ? buildAdminAuditLogRow({
          actorUserId,
          action: "permission_rule.updated",
          targetType: "permission_rule",
          targetId: id,
          outcome: "succeeded",
          metadata: {
            before: {
              scope: existing.scope,
              toolPattern: existing.toolPattern,
              decision: existing.decision,
              priority: existing.priority,
            },
            after: sets,
          },
        })
      : null;
  await db.transaction(async (tx) => {
    await tx.update(toolPermissionRule).set(sets).where(eq(toolPermissionRule.id, id));
    if (auditRow) await tx.insert(adminAuditLog).values(auditRow);
  });
  return { ...existing, ...sets } as ToolPermissionRule;
}

/**
 * 删除一条持久化权限规则。
 * actorUserId 非空时落 permission_rule.deleted 审计。规则不存在 → 返回 false（调用方据此 404）。
 */
export async function deletePermissionRule(
  id: string,
  actorUserId?: string | null,
): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(toolPermissionRule)
    .where(eq(toolPermissionRule.id, id))
    .limit(1);
  if (!existing) return false;
  const auditRow =
    actorUserId != null
      ? buildAdminAuditLogRow({
          actorUserId,
          action: "permission_rule.deleted",
          targetType: "permission_rule",
          targetId: id,
          outcome: "succeeded",
          metadata: {
            scope: existing.scope,
            toolPattern: existing.toolPattern,
            decision: existing.decision,
          },
        })
      : null;
  await db.transaction(async (tx) => {
    await tx.delete(toolPermissionRule).where(eq(toolPermissionRule.id, id));
    if (auditRow) await tx.insert(adminAuditLog).values(auditRow);
  });
  return true;
}

/**
 * 创建一条审批请求（pending）。ask 暂停时由 executeToolRun 调用。
 * expiresAt 缺省时按 24h 过期设置（）。
 */
export async function createApprovalRequest(params: {
  threadId: string;
  toolRunId: string;
  toolName: string;
  permissionKey: string;
  argFingerprint: string;
  argSummary: string;
  expiresAt?: Date | null;
  projectId?: string | null;
}): Promise<ToolApprovalRequest> {
  const now = new Date();
  const row: ToolApprovalRequest = {
    id: randomUUID(),
    threadId: params.threadId,
    toolRunId: params.toolRunId,
    toolName: params.toolName,
    permissionKey: params.permissionKey,
    argFingerprint: params.argFingerprint,
    argSummary: params.argSummary,
    status: "pending",
    approvedScope: null,
    projectId: params.projectId ?? null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: now,
    expiresAt: params.expiresAt ?? new Date(now.getTime() + 24 * 60 * 60 * 1000),
  };
  await db.insert(toolApprovalRequest).values(row);
  return row;
}

/**
 * 审批多步操作事务化。
 *
 * 原实现 createToolRun + createApprovalRequest + updateThreadStatus 分散调用，部分成功会留 thread
 * 卡在 executing。本函数在单事务内完成三步，保证原子性。事件追加在事务外（append-only best-effort）。
 */
export async function requestApprovalAtomic(params: {
  threadId: string;
  toolName: string;
  input: Record<string, unknown>;
  permissionKey: string;
  argFingerprint: string;
  argSummary: string;
  projectId?: string | null;
  /** 归属历史 run（nullable（历史记录可空））。 */
  runId?: string | null;
}): Promise<{ run: ToolRun; approval: ToolApprovalRequest }> {
  // 与 createToolRun 同构：json 列 zod 校验（fail-closed，脏数据抛错不落库）。
  const input = validateJsonColumn(params.input, toolRunInputSchema, "input");
  return db.transaction(async (tx) => {
    const now = new Date();
    const run: ToolRun = {
      id: randomUUID(),
      threadId: params.threadId,
      toolName: params.toolName,
      status: "awaiting_approval",
      input,
      output: null,
      error: null,
      startedAt: now,
      finishedAt: null,
      runId: params.runId ?? null,
    };
    await tx.insert(toolRun).values(run);

    const approval: ToolApprovalRequest = {
      id: randomUUID(),
      threadId: params.threadId,
      toolRunId: run.id,
      toolName: params.toolName,
      permissionKey: params.permissionKey,
      argFingerprint: params.argFingerprint,
      argSummary: params.argSummary,
      status: "pending",
      approvedScope: null,
      // 审批请求记录 projectId，供 project scope 跨 thread 匹配
      projectId: params.projectId ?? null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    };
    await tx.insert(toolApprovalRequest).values(approval);

    return { run, approval };
  });
}

/** 按 id 取审批请求。 */
export async function getApprovalRequest(id: string): Promise<ToolApprovalRequest | null> {
  const [row] = await db
    .select()
    .from(toolApprovalRequest)
    .where(eq(toolApprovalRequest.id, id))
    .limit(1);
  return row ?? null;
}

/** 列 thread 的 pending 审批请求（按 createdAt asc）。 */
export async function getPendingApprovalsByThread(
  threadId: string,
): Promise<ToolApprovalRequest[]> {
  return db
    .select()
    .from(toolApprovalRequest)
    .where(
      and(eq(toolApprovalRequest.threadId, threadId), eq(toolApprovalRequest.status, "pending")),
    )
    .orderBy(asc(toolApprovalRequest.createdAt));
}

/** 列 thread 最近已决议的审批请求（approved/denied，按 createdAt desc，限 50）。 */
export async function getResolvedApprovalsByThread(
  threadId: string,
  limit = 50,
): Promise<ToolApprovalRequest[]> {
  const clamped = Math.min(200, Math.max(1, Math.floor(limit)));
  return db
    .select()
    .from(toolApprovalRequest)
    .where(
      and(
        eq(toolApprovalRequest.threadId, threadId),
        inArray(toolApprovalRequest.status, ["approved", "denied"]),
      ),
    )
    .orderBy(desc(toolApprovalRequest.createdAt), desc(toolApprovalRequest.id))
    .limit(clamped);
}

/**
 * 决议一条审批请求：仅 status=pending 可被决议，否则返回 null（调用方据此返回 409）。
 * 写 tool.approval_resolved 事件由调用方（API 层）负责，本函数只更新请求行。
 */
export async function resolveApprovalRequest(params: {
  id: string;
  decision: "approved" | "denied";
  scope: ApprovalScope;
  resolvedBy: string;
}): Promise<ToolApprovalRequest | null> {
  const existing = await getApprovalRequest(params.id);
  if (!existing || existing.status !== "pending") return null;
  const now = new Date();
  const patch: Partial<ToolApprovalRequest> = {
    status: params.decision as ApprovalRequestStatus,
    approvedScope: params.scope,
    resolvedBy: params.resolvedBy,
    resolvedAt: now,
  };
  // session scope（07-）：决议时把 expiresAt 收紧到短 TTL，
  // 区别于 thread/always 的 24h。过期后引擎 isApprovalExpired 与 findMatchingApprovals
  // 同步失效，实现"同 thread 短期复用"语义。denied 不必调整 TTL（已拒绝不再复用）。
  if (params.decision === "approved" && params.scope === "session") {
    patch.expiresAt = new Date(now.getTime() + approvalConfig.sessionTtlMs);
  }
  // 审计修复(TOCTOU)：WHERE 加 status='pending' 守卫，affectedRows=0 说明已被并发决议
  const result = await db
    .update(toolApprovalRequest)
    .set(patch)
    .where(and(eq(toolApprovalRequest.id, params.id), eq(toolApprovalRequest.status, "pending")));
  if (affectedRowsOf(result) === 0) return null;
  return { ...existing, ...patch };
}

/**
 * 查找匹配的已批准审批请求（用于 ask→allow 升级）。
 * 匹配维度：permissionKey + argFingerprint + status=approved + 未过期。
 * 若传入 threadId，仅返回 always 或同 thread 候选；最终 scope 仍由引擎纯函数复核。
 * scope 适用性（thread/project/always）由引擎纯函数判断；本查询返回候选集。
 */
export async function findMatchingApprovals(params: {
  permissionKey: string;
  argFingerprint: string;
  threadId?: string;
  projectId?: string | null;
}): Promise<ToolApprovalRequest[]> {
  // scopeFilter 增加 project scope 跨 thread 匹配
  const threadFilter = params.threadId
    ? eq(toolApprovalRequest.threadId, params.threadId)
    : undefined;
  const projectFilter = params.projectId
    ? and(
        eq(toolApprovalRequest.approvedScope, "project"),
        eq(toolApprovalRequest.projectId, params.projectId),
      )
    : undefined;
  const scopeFilter =
    threadFilter || projectFilter
      ? or(eq(toolApprovalRequest.approvedScope, "always"), threadFilter, projectFilter)
      : undefined;
  return db
    .select()
    .from(toolApprovalRequest)
    .where(
      and(
        eq(toolApprovalRequest.permissionKey, params.permissionKey),
        eq(toolApprovalRequest.argFingerprint, params.argFingerprint),
        eq(toolApprovalRequest.status, "approved"),
        or(isNull(toolApprovalRequest.expiresAt), gt(toolApprovalRequest.expiresAt, new Date())),
        scopeFilter,
      ),
    )
    .orderBy(desc(toolApprovalRequest.resolvedAt));
}

/** 从不同 drizzle/mysql adapter 的 update 结果里提取 affectedRows。 */
function affectedRowsOf(result: unknown): number {
  const candidate = Array.isArray(result) ? result[0] : result;
  if (
    candidate &&
    typeof candidate === "object" &&
    "affectedRows" in candidate &&
    typeof (candidate as { affectedRows: unknown }).affectedRows === "number"
  ) {
    return (candidate as { affectedRows: number }).affectedRows;
  }
  return 0;
}

/** 原子消费一次性 approval，抢到消费权才返回 true。 */
export async function consumeOnceApproval(id: string): Promise<boolean> {
  const result = await db
    .update(toolApprovalRequest)
    .set({ status: "superseded" })
    .where(
      and(
        eq(toolApprovalRequest.id, id),
        eq(toolApprovalRequest.status, "approved"),
        eq(toolApprovalRequest.approvedScope, "once"),
      ),
    );
  return affectedRowsOf(result) === 1;
}

/**
 * 取 thread 最近一条已决议的审批请求（approved/denied，按 resolvedAt desc）。
 * 供 chat route 恢复路径判断：thread 处于 awaiting_approval 时，最近决议决定恢复语义。
 */
export async function getLatestResolvedApprovalByThread(
  threadId: string,
): Promise<ToolApprovalRequest | null> {
  const [row] = await db
    .select()
    .from(toolApprovalRequest)
    .where(
      and(
        eq(toolApprovalRequest.threadId, threadId),
        inArray(toolApprovalRequest.status, ["approved", "denied"]),
      ),
    )
    .orderBy(desc(toolApprovalRequest.resolvedAt))
    .limit(1);
  return row ?? null;
}

// ─── Git Checkpoint Queries () ──────────────────────────
//
// 风险前快照的数据层。tag 名 + commitSha 由 lib/git/checkpoint.ts 经 ops.gitTag 产出；
// 本层只做 CRUD，事件追加（git.checkpoint_created/restored）由 checkpoint.ts 编排。

/** 创建一条 checkpoint 记录。MySQL 无 RETURNING，自行生成主键并构造返回对象。 */
export async function createCheckpointRow(params: {
  threadId: string;
  tag: string;
  commitSha: string;
  reason: string;
  createdByToolRunId?: string | null;
  filesChanged?: string | null;
}): Promise<GitCheckpoint> {
  const row: GitCheckpoint = {
    id: randomUUID(),
    threadId: params.threadId,
    tag: params.tag,
    commitSha: params.commitSha,
    reason: params.reason,
    createdByToolRunId: params.createdByToolRunId ?? null,
    restoredAt: null,
    filesChanged: params.filesChanged ?? null,
    createdAt: new Date(),
  };
  await db.insert(gitCheckpoint).values(row);
  return row;
}

/** 按 id 取 checkpoint。 */
export async function getCheckpoint(id: string): Promise<GitCheckpoint | null> {
  const [row] = await db.select().from(gitCheckpoint).where(eq(gitCheckpoint.id, id)).limit(1);
  return row ?? null;
}

/** 列 thread 的全部 checkpoint（按 createdAt desc，最近在前）。 */
export async function listCheckpointsByThread(threadId: string): Promise<GitCheckpoint[]> {
  return db
    .select()
    .from(gitCheckpoint)
    .where(eq(gitCheckpoint.threadId, threadId))
    .orderBy(desc(gitCheckpoint.createdAt), desc(gitCheckpoint.id));
}

/** 标记 checkpoint 已被 restore（回填 restoredAt）。返回更新后的行（按 existing 合并）。 */
export async function markCheckpointRestored(id: string): Promise<GitCheckpoint | null> {
  const [existing] = await db.select().from(gitCheckpoint).where(eq(gitCheckpoint.id, id)).limit(1);
  if (!existing) return null;
  const now = new Date();
  await db.update(gitCheckpoint).set({ restoredAt: now }).where(eq(gitCheckpoint.id, id));
  return { ...existing, restoredAt: now };
}

// ─── Memory Queries (b) ─────────────────────────────────
//
// MemoryEntry CRUD。store.ts 做去重/provenance 校验/soft delete/事件，这里只做纯 DB 操作。

export async function createMemoryRow(params: {
  scope: MemoryScope;
  scopeRef: string | null;
  kind: MemoryKind;
  text: string;
  textHash: string;
  provenance: MemoryProvenanceEntry[];
  confidence: MemoryConfidence;
  expiresAt: Date | null;
  createdByToolRunId: string | null;
}): Promise<MemoryEntry> {
  // json 列 zod 校验（fail-closed，provenance 必须非空防孤儿记忆）
  const provenance = validateJsonColumn(params.provenance, memoryProvenanceSchema, "provenance");
  const row: MemoryEntry = {
    id: randomUUID(),
    scope: params.scope,
    scopeRef: params.scopeRef,
    kind: params.kind,
    text: params.text,
    textHash: params.textHash,
    provenance,
    confidence: params.confidence,
    status: "active",
    expiresAt: params.expiresAt,
    createdByToolRunId: params.createdByToolRunId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(memoryEntry).values(row);
  return row;
}

export async function getMemoryRow(id: string): Promise<MemoryEntry | null> {
  const [row] = await db.select().from(memoryEntry).where(eq(memoryEntry.id, id)).limit(1);
  return row ?? null;
}

export async function listMemoryRows(filter: {
  scope: MemoryScope;
  scopeRef: string | null;
  kind?: MemoryKind;
  status?: "active" | "revoked";
}): Promise<MemoryEntry[]> {
  const conds = [eq(memoryEntry.scope, filter.scope)];
  if (filter.scopeRef !== null) conds.push(eq(memoryEntry.scopeRef, filter.scopeRef));
  else conds.push(isNull(memoryEntry.scopeRef));
  if (filter.kind) conds.push(eq(memoryEntry.kind, filter.kind));
  conds.push(eq(memoryEntry.status, filter.status ?? "active"));
  return db
    .select()
    .from(memoryEntry)
    .where(and(...conds))
    .orderBy(desc(memoryEntry.updatedAt), desc(memoryEntry.id));
}

export async function findDuplicateMemory(params: {
  scope: MemoryScope;
  scopeRef: string | null;
  kind: MemoryKind;
  textHash: string;
}): Promise<MemoryEntry | null> {
  const conds = [
    eq(memoryEntry.scope, params.scope),
    eq(memoryEntry.kind, params.kind),
    eq(memoryEntry.textHash, params.textHash),
    eq(memoryEntry.status, "active"),
  ];
  if (params.scopeRef !== null) conds.push(eq(memoryEntry.scopeRef, params.scopeRef));
  else conds.push(isNull(memoryEntry.scopeRef));
  const [row] = await db
    .select()
    .from(memoryEntry)
    .where(and(...conds))
    .limit(1);
  return row ?? null;
}

export async function updateMemoryRow(
  id: string,
  patch: {
    status?: "active" | "revoked";
    confidence?: MemoryConfidence;
    provenance?: MemoryProvenanceEntry[];
    expiresAt?: Date | null;
    /** text 更新（同步 textHash）。 */
    text?: string;
    textHash?: string;
  },
): Promise<MemoryEntry | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.confidence !== undefined) set.confidence = patch.confidence;
  if (patch.provenance !== undefined) set.provenance = patch.provenance;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
  if (patch.text !== undefined) set.text = patch.text;
  if (patch.textHash !== undefined) set.textHash = patch.textHash;
  await db.update(memoryEntry).set(set).where(eq(memoryEntry.id, id));
  const [row] = await db.select().from(memoryEntry).where(eq(memoryEntry.id, id)).limit(1);
  return row ?? null;
}

// ─── Memory Embedding Queries () ──────────────
//
// 一条 memory 每 provider 一向量（unique memoryId+provider）。upsertEmbeddingRow 查+插/改。
// getActiveEmbeddingRow 供 retrieveMemories semantic rerank：只取 status=active 的向量。

export async function upsertEmbeddingRow(params: {
  memoryId: string;
  provider: string;
  model: string;
  vector: number[];
  dim: number;
  status: "active" | "stale" | "error";
  errorMessage?: string | null;
}): Promise<MemoryEmbedding> {
  // : 改 INSERT ... ON DUPLICATE KEY UPDATE(依赖 memoryId+provider 唯一索引),
  // 消除原 SELECT-then-INSERT 竞态:并发双方都 select 空 → 都 INSERT → 一方撞唯一约束失败。
  const now = new Date();
  const row = {
    id: randomUUID(),
    memoryId: params.memoryId,
    provider: params.provider,
    model: params.model,
    vector: params.vector,
    dim: params.dim,
    status: params.status,
    errorMessage: params.errorMessage ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .insert(memoryEmbedding)
    .values(row)
    .onDuplicateKeyUpdate({
      set: {
        model: sql`VALUES(model)`,
        vector: sql`VALUES(vector)`,
        dim: sql`VALUES(dim)`,
        status: sql`VALUES(status)`,
        errorMessage: sql`VALUES(errorMessage)`,
        updatedAt: sql`VALUES(updatedAt)`,
      },
    });
  return row;
}

export async function getActiveEmbeddingRow(
  memoryId: string,
  provider: string,
): Promise<MemoryEmbedding | null> {
  const [row] = await db
    .select()
    .from(memoryEmbedding)
    .where(
      and(
        eq(memoryEmbedding.memoryId, memoryId),
        eq(memoryEmbedding.provider, provider),
        eq(memoryEmbedding.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 批量取多条 memory 的 active embedding（单查询替代 N+1）。
 * 返回 Map<memoryId, MemoryEmbedding>（仅当前 provider 的 active 行）。
 */
export async function listActiveEmbeddingRows(
  memoryIds: string[],
  provider: string,
): Promise<Map<string, MemoryEmbedding>> {
  const out = new Map<string, MemoryEmbedding>();
  if (memoryIds.length === 0) return out;
  const rows = await db
    .select()
    .from(memoryEmbedding)
    .where(
      and(
        inArray(memoryEmbedding.memoryId, memoryIds),
        eq(memoryEmbedding.provider, provider),
        eq(memoryEmbedding.status, "active"),
      ),
    );
  for (const r of rows) out.set(r.memoryId, r);
  return out;
}

/**
 * provider 切换后老 embedding fallback。
 * 当前 provider 无 active embedding 时，取任意 provider 的 active embedding（老 provider 的），
 * 供 cosine 粗排（维度可能不匹配 → 调用方需校验 dim）。无则 null。
 */
export async function getActiveEmbeddingRowAnyProvider(
  memoryId: string,
): Promise<MemoryEmbedding | null> {
  const [row] = await db
    .select()
    .from(memoryEmbedding)
    .where(and(eq(memoryEmbedding.memoryId, memoryId), eq(memoryEmbedding.status, "active")))
    .limit(1);
  return row ?? null;
}

/**
 * 批量取任意 provider 的 active embedding（替代 N+1 循环调用 getActiveEmbeddingRowAnyProvider）。
 * 单查询 IN(...) 取所有 memoryId 的 active embedding 行，每个 memoryId 至多取一条。
 */
export async function listActiveEmbeddingRowsAnyProvider(
  memoryIds: string[],
): Promise<Map<string, MemoryEmbedding>> {
  const out = new Map<string, MemoryEmbedding>();
  if (memoryIds.length === 0) return out;
  const rows = await db
    .select()
    .from(memoryEmbedding)
    .where(and(inArray(memoryEmbedding.memoryId, memoryIds), eq(memoryEmbedding.status, "active")));
  // 同一 memoryId 可能有多条（不同 provider），取第一条（任意 provider）
  for (const row of rows) {
    if (!out.has(row.memoryId)) {
      out.set(row.memoryId, row);
    }
  }
  return out;
}

/**
 * 清理过期记忆。物理删除 expiresAt < now 的 active 记忆（含其 embedding 行）。
 * 由 retention 定时任务调用。@returns 删除条数
 */
export async function cleanupExpiredMemories(): Promise<number> {
  const now = new Date();
  const expired = await db
    .select({ id: memoryEntry.id })
    .from(memoryEntry)
    .where(and(lt(memoryEntry.expiresAt, now), eq(memoryEntry.status, "active")));
  if (expired.length === 0) return 0;
  const ids = expired.map((r) => r.id);
  // 事务化删除：embeddings + entries 要么一起成功要么一起回滚，防半删导致语义搜索失效
  return db.transaction(async (tx) => {
    await tx.delete(memoryEmbedding).where(inArray(memoryEmbedding.memoryId, ids));
    const result = await tx.delete(memoryEntry).where(inArray(memoryEntry.id, ids));
    return (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
  });
}

/**
 * 清理超期 ContextSnapshot（全 thread，不限终态）。
 * 原仅 retention 清终态 thread 的 snapshot；活跃 thread 的旧 snapshot 无限累积。
 * 本函数删 createdAt < cutoff 的 snapshot，由 retention 定时任务调用。
 *
 * 默认 retainDays 取自 dbConfig.snapshotRetentionDays（独立短保留期，默认 7 天），
 * 区别于全局 retentionDays（90 天）。其他表仍用全局保留期。
 */
export async function cleanupOldSnapshots(retainDays?: number): Promise<number> {
  const days = retainDays ?? dbConfig.snapshotRetentionDays;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await db.delete(contextSnapshot).where(lt(contextSnapshot.createdAt, cutoff));
  return (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
}

/**
 * seed 版本追踪（幂等标记）。
 * 用 policyConfig 表 key="seed_version" 存储，避免新表。seed.ts 执行前检查版本，已执行则跳过。
 */
export async function getSeedVersion(): Promise<string | null> {
  const [row] = await db
    .select()
    .from(policyConfig)
    .where(eq(policyConfig.key, "seed_version"))
    .limit(1);
  return (row?.value as string) ?? null;
}

export async function setSeedVersion(version: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(policyConfig)
    .where(eq(policyConfig.key, "seed_version"))
    .limit(1);
  if (existing) {
    await db
      .update(policyConfig)
      .set({ value: version })
      .where(eq(policyConfig.key, "seed_version"));
  } else {
    await db.insert(policyConfig).values({ key: "seed_version", value: version });
  }
}

/**
 * 列某 memory 的全部 embedding 行（不分 provider/status）。
 * 供 markEmbeddingStale（标 stale 需先读现有行）与 Studio 诊断。
 */
export async function listEmbeddingRowsByMemory(memoryId: string): Promise<MemoryEmbedding[]> {
  return db.select().from(memoryEmbedding).where(eq(memoryEmbedding.memoryId, memoryId));
}

// ─── MCP Server Config Queries () ───────────────────────
//
// McpServerConfig CRUD。env 字段含 secret，调用方（Studio API / registry）负责脱敏后返回，
// 调用时注入真实 env——本层只做纯 DB 操作，不做脱敏。权限走 ToolPermissionRule（mcp.<name>.<tool>）。

export async function createMcpServerConfig(params: {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  env?: Record<string, string> | null;
  allowedTools?: string[] | null;
  enabled?: boolean;
}): Promise<McpServerConfig> {
  const row: McpServerConfig = {
    id: randomUUID(),
    name: params.name,
    transport: params.transport,
    command: params.command ?? null,
    args: params.args ?? null,
    url: params.url ?? null,
    env: params.env ?? null,
    allowedTools: params.allowedTools ?? null,
    enabled: params.enabled ?? true,
    // 协商字段建时为 null,连接成功后 recordMcpServerHandshake 回写
    lastServerVersion: null,
    lastCapabilities: null,
    lastConnectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(mcpServerConfig).values(row);
  return row;
}

export async function getMcpServerConfig(id: string): Promise<McpServerConfig | null> {
  const [row] = await db.select().from(mcpServerConfig).where(eq(mcpServerConfig.id, id)).limit(1);
  return row ?? null;
}

export async function getMcpServerConfigByName(name: string): Promise<McpServerConfig | null> {
  const [row] = await db
    .select()
    .from(mcpServerConfig)
    .where(eq(mcpServerConfig.name, name))
    .limit(1);
  return row ?? null;
}

export async function listMcpServerConfigs(): Promise<McpServerConfig[]> {
  return db.select().from(mcpServerConfig).orderBy(asc(mcpServerConfig.createdAt));
}

export async function listEnabledMcpServerConfigs(): Promise<McpServerConfig[]> {
  return db
    .select()
    .from(mcpServerConfig)
    .where(eq(mcpServerConfig.enabled, true))
    .orderBy(asc(mcpServerConfig.createdAt));
}

export async function updateMcpServerConfig(
  id: string,
  patch: {
    name?: string;
    transport?: "stdio" | "http" | "sse";
    command?: string | null;
    args?: string[] | null;
    url?: string | null;
    env?: Record<string, string> | null;
    allowedTools?: string[] | null;
    enabled?: boolean;
  },
): Promise<McpServerConfig | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) set[k] = v;
  }
  await db.update(mcpServerConfig).set(set).where(eq(mcpServerConfig.id, id));
  const [row] = await db.select().from(mcpServerConfig).where(eq(mcpServerConfig.id, id)).limit(1);
  return row ?? null;
}

export async function deleteMcpServerConfig(id: string): Promise<void> {
  await db.delete(mcpServerConfig).where(eq(mcpServerConfig.id, id));
}

/**
 * 记录 MCP server 连接协商结果(server 版本 + 能力)到 DB。
 *
 * 连接成功后 best-effort 回写 lastServerVersion/lastCapabilities/lastConnectedAt,
 * 供审计 server 兼容性(原仅落日志,日志轮转丢失不可追溯)。
 * 按 name 定位(server name 唯一);best-effort——失败仅记日志不阻断连接。
 */
export async function recordMcpServerHandshake(
  serverName: string,
  info: { serverVersion?: string | null; capabilities?: Record<string, unknown> | null },
): Promise<void> {
  await db
    .update(mcpServerConfig)
    .set({
      lastServerVersion: info.serverVersion ?? null,
      lastCapabilities: info.capabilities ?? null,
      lastConnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mcpServerConfig.name, serverName));
}

// ─── Custom Tool Queries () ──────────────────────────────
//
// CustomTool CRUD。executorConfig.webhook 走域名 allowlist（SSRF 防护在 registry 层）；
// executorConfig.script.scriptId 必须在平台预置白名单（registry 层校验，DB 不校验）。
// 权限走 ToolPermissionRule（custom.<name>，默认 ask）。

export async function createCustomTool(params: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  executorType: "webhook" | "script";
  executorConfig: Record<string, unknown>;
  enabled?: boolean;
}): Promise<CustomTool> {
  // json 列 zod 校验（fail-closed，脏数据抛错不落库）
  const inputSchema = validateJsonColumn(
    params.inputSchema,
    customToolInputSchemaSchema,
    "inputSchema",
  );
  const executorConfig = validateJsonColumn(
    params.executorConfig,
    customToolExecutorConfigSchema,
    "executorConfig",
  );
  const row: CustomTool = {
    id: randomUUID(),
    name: params.name,
    description: params.description,
    inputSchema,
    executorType: params.executorType,
    executorConfig,
    enabled: params.enabled ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(customTool).values(row);
  return row;
}

export async function getCustomTool(id: string): Promise<CustomTool | null> {
  const [row] = await db.select().from(customTool).where(eq(customTool.id, id)).limit(1);
  return row ?? null;
}

export async function getCustomToolByName(name: string): Promise<CustomTool | null> {
  const [row] = await db.select().from(customTool).where(eq(customTool.name, name)).limit(1);
  return row ?? null;
}

export async function listCustomTools(): Promise<CustomTool[]> {
  return db.select().from(customTool).orderBy(asc(customTool.createdAt));
}

export async function listEnabledCustomTools(): Promise<CustomTool[]> {
  return db
    .select()
    .from(customTool)
    .where(eq(customTool.enabled, true))
    .orderBy(asc(customTool.createdAt));
}

export async function updateCustomTool(
  id: string,
  patch: {
    name?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    executorType?: "webhook" | "script";
    executorConfig?: Record<string, unknown>;
    enabled?: boolean;
  },
): Promise<CustomTool | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) set[k] = v;
  }
  await db.update(customTool).set(set).where(eq(customTool.id, id));
  const [row] = await db.select().from(customTool).where(eq(customTool.id, id)).limit(1);
  return row ?? null;
}

export async function deleteCustomTool(id: string): Promise<void> {
  await db.delete(customTool).where(eq(customTool.id, id));
}

// ─── : SecretMount Queries ──────────────────────────────

/** 创建 secret mount（加密存储）。 */
export async function createSecretMount(params: {
  name: string;
  scope: SecretMountScope;
  scopeRef?: string | null;
  keyId: string;
  ciphertext: string;
}): Promise<SecretMount> {
  const now = new Date();
  const row: SecretMount = {
    id: randomUUID(),
    name: params.name,
    scope: params.scope,
    scopeRef: params.scopeRef ?? null,
    keyId: params.keyId,
    ciphertext: params.ciphertext,
    status: "active",
    createdAt: now,
    updatedAt: now,
    rotatedAt: null,
  };
  await db.insert(secretMount).values(row);
  return row;
}

/** 按 id 取 secret mount。 */
export async function getSecretMount(id: string): Promise<SecretMount | null> {
  const [row] = await db.select().from(secretMount).where(eq(secretMount.id, id)).limit(1);
  return row ?? null;
}

/** 列 scope 内 active 的 secret mount（按 name）。 */
export async function listActiveSecretsByScope(
  scope: SecretMountScope,
  scopeRef: string | null,
): Promise<SecretMount[]> {
  const conditions = [eq(secretMount.scope, scope), eq(secretMount.status, "active")];
  if (scopeRef !== null) {
    conditions.push(eq(secretMount.scopeRef, scopeRef));
  } else {
    conditions.push(isNull(secretMount.scopeRef));
  }
  return db
    .select()
    .from(secretMount)
    .where(and(...conditions))
    .orderBy(asc(secretMount.name));
}

/** 列 scope 内全部 secret mount（含 revoked，admin 管理用）。 */
export async function listSecretsByScope(
  scope: SecretMountScope,
  scopeRef: string | null,
): Promise<SecretMount[]> {
  const conditions = [eq(secretMount.scope, scope)];
  if (scopeRef !== null) {
    conditions.push(eq(secretMount.scopeRef, scopeRef));
  } else {
    conditions.push(isNull(secretMount.scopeRef));
  }
  return db
    .select()
    .from(secretMount)
    .where(and(...conditions))
    .orderBy(desc(secretMount.createdAt), desc(secretMount.id));
}

/** 轮换 secret：新密文覆盖 + rotatedAt 更新。 */
export async function rotateSecretMount(
  id: string,
  newCiphertext: string,
  keyId: string,
): Promise<SecretMount | null> {
  const now = new Date();
  await db
    .update(secretMount)
    .set({ ciphertext: newCiphertext, keyId, rotatedAt: now, updatedAt: now, status: "active" })
    .where(eq(secretMount.id, id));
  return getSecretMount(id);
}

/** 撤销 secret：status=revoked，停止注入。 */
export async function revokeSecretMount(id: string): Promise<SecretMount | null> {
  const now = new Date();
  await db
    .update(secretMount)
    .set({ status: "revoked", updatedAt: now })
    .where(eq(secretMount.id, id));
  return getSecretMount(id);
}

/** 删除 secret mount（物理删除，admin 操作）。 */
export async function deleteSecretMount(id: string): Promise<void> {
  await db.delete(secretMount).where(eq(secretMount.id, id));
}

// ─── : Deployment Queries ───────────────────────────────

/** 创建部署记录。 */
export async function createDeployment(params: {
  threadId: string;
  environment: string;
  commitSha?: string | null;
  imageTag?: string | null;
  artifactRef?: string | null;
  cicdJobId?: string | null;
  cicdJobUrl?: string | null;
  previousDeploymentId?: string | null;
}): Promise<Deployment> {
  const row: Deployment = {
    id: randomUUID(),
    threadId: params.threadId,
    environment: params.environment,
    commitSha: params.commitSha ?? null,
    imageTag: params.imageTag ?? null,
    artifactRef: params.artifactRef ?? null,
    cicdJobId: params.cicdJobId ?? null,
    cicdJobUrl: params.cicdJobUrl ?? null,
    status: "pending",
    previousDeploymentId: params.previousDeploymentId ?? null,
    deployedAt: null,
    rolledBackAt: null,
    errorMessage: null,
    createdAt: new Date(),
  };
  await db.insert(deployment).values(row);
  return row;
}

/** 按 id 取部署记录。 */
export async function getDeployment(id: string): Promise<Deployment | null> {
  const [row] = await db.select().from(deployment).where(eq(deployment.id, id)).limit(1);
  return row ?? null;
}

/** 列 thread 的部署记录（按 createdAt desc）。 */
export async function listDeploymentsByThread(threadId: string): Promise<Deployment[]> {
  return db
    .select()
    .from(deployment)
    .where(eq(deployment.threadId, threadId))
    .orderBy(desc(deployment.createdAt));
}

/** 取 thread 最新一次成功部署。 */
export async function getLatestDeployedByThread(threadId: string): Promise<Deployment | null> {
  const [row] = await db
    .select()
    .from(deployment)
    .where(and(eq(deployment.threadId, threadId), eq(deployment.status, "deployed")))
    .orderBy(desc(deployment.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * 列所有 deploying 状态的 deployment（跨 thread，供后台轮询）。
 */
export async function listDeployingDeployments(): Promise<Deployment[]> {
  return db.select().from(deployment).where(eq(deployment.status, "deploying"));
}

/** 更新部署状态与终态字段。 */
export async function updateDeployment(
  id: string,
  patch: {
    status?: DeploymentStatus;
    cicdJobId?: string | null;
    cicdJobUrl?: string | null;
    deployedAt?: Date | null;
    rolledBackAt?: Date | null;
    errorMessage?: string | null;
    artifactRef?: string | null;
  },
): Promise<Deployment | null> {
  const [existing] = await db.select().from(deployment).where(eq(deployment.id, id)).limit(1);
  if (!existing) return null;
  const sets: Record<string, unknown> = {};
  if (patch.status !== undefined) sets.status = patch.status;
  if (patch.cicdJobId !== undefined) sets.cicdJobId = patch.cicdJobId;
  if (patch.cicdJobUrl !== undefined) sets.cicdJobUrl = patch.cicdJobUrl;
  if (patch.deployedAt !== undefined) sets.deployedAt = patch.deployedAt;
  if (patch.rolledBackAt !== undefined) sets.rolledBackAt = patch.rolledBackAt;
  if (patch.errorMessage !== undefined) sets.errorMessage = patch.errorMessage;
  if (patch.artifactRef !== undefined) sets.artifactRef = patch.artifactRef;
  if (Object.keys(sets).length === 0) return existing;
  await db.update(deployment).set(sets).where(eq(deployment.id, id));
  return { ...existing, ...sets } as Deployment;
}
