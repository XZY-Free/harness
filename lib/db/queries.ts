import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { dbConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { encryptCicdToken } from "@/lib/runtime/secret-crypto";
// P2-closeout: thread-events-bus 已删（SSE 端点 app/api/threads/** 随本地执行体系移除）。
import { escapeLikeWildcards } from "@/lib/utils";
import { and, asc, desc, eq, isNotNull, isNull, lt, max } from "drizzle-orm";
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
  type ContextSnapshot,
  type ContextSummary,
  type ContextSummaryType,
  type CustomTool,
  type Deployment,
  type DeploymentStatus,
  type GitCheckpoint,
  type McpServerConfig,
  type SecretMount,
  type SecretMountScope,
  type SecretMountStatus,
  type ThreadPlan,
  type ThreadPlanItem,
  type ThreadPlanItemStatus,
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
  secretMount,
  threadPlan,
  threadPlanItem,
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

// ─── MCP Server Config Queries () ───────────────────────
//
// McpServerConfig CRUD。env 字段含 secret，调用方（Studio API / registry）负责脱敏后返回，
// 调用时注入真实 env——本层只做纯 DB 操作，不做脱敏。权限走正式 Policy Revision（mcp.<name>.<tool>）。

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
// 权限走正式 Policy Revision（custom.<name>）。

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
