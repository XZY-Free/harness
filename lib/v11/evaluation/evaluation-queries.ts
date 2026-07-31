/**
 * V11 Evaluation 仓储（S11-W06）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md（Evaluation 域），
 * - ../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W06。
 *
 * 职责：
 * - createEvaluationRun / getEvaluationRunById / listEvaluationRunsByTenant (cursor 分页)
 *   / updateEvaluationRunState / updateEvaluationRunSummary。
 * - createEvaluationCase / getEvaluationCaseById / listEvaluationCasesByRun。
 * - createEvaluationResult / listEvaluationResultsByRun / listEvaluationResultsByCase。
 *
 * 关键约束：
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - 评测对象明确绑定 AgentRevision、RuntimeRevision、Route、模型、数据集和评测策略。
 * - 结果保留案例级证据、版本引用、失败原因和可比较指标；阈值只按 Agent 风险配置，不一刀切。
 * - cursor 分页采用 limit+1 策略（与 lib/v11/observability/trace-queries.ts 的 listTracesByTenant 一致）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { decodeCursor, encodeCursor } from "@/lib/http";
import {
  type EvaluationCaseState,
  type EvaluationComparator,
  type EvaluationRunState,
  type EvaluationStrategyKey,
  type V11EvaluationCase,
  type V11EvaluationResult,
  type V11EvaluationRun,
  v11EvaluationCase,
  v11EvaluationResult,
  v11EvaluationRun,
} from "@/lib/v11/schema/evaluation";
import { and, asc, desc, eq, lt, or } from "drizzle-orm";

// ─── EvaluationRun ────────────────────────────────────────

/** createEvaluationRun 入参。 */
export interface CreateEvaluationRunParams {
  tenantId: string;
  agentRevisionId: string;
  strategyKey: EvaluationStrategyKey;
  datasetRef: string;
  jobId?: string | null;
  runtimeRevisionId?: string | null;
  routeId?: string | null;
  modelRef?: string | null;
  thresholdConfigJson?: Record<string, unknown> | null;
  createdBy?: string | null;
  startedAt?: Date | null;
}

/** 创建 EvaluationRun。 */
export async function createEvaluationRun(
  params: CreateEvaluationRunParams,
): Promise<V11EvaluationRun> {
  const id = randomUUID();
  await db.insert(v11EvaluationRun).values({
    id,
    tenantId: params.tenantId,
    jobId: params.jobId ?? null,
    agentRevisionId: params.agentRevisionId,
    runtimeRevisionId: params.runtimeRevisionId ?? null,
    routeId: params.routeId ?? null,
    modelRef: params.modelRef ?? null,
    datasetRef: params.datasetRef,
    strategyKey: params.strategyKey,
    runState: "queued",
    thresholdConfigJson: params.thresholdConfigJson ?? null,
    summaryJson: null,
    startedAt: params.startedAt ?? null,
    finishedAt: null,
    createdBy: params.createdBy ?? null,
    versionNo: "1",
  });

  const [row] = await db
    .select()
    .from(v11EvaluationRun)
    .where(and(eq(v11EvaluationRun.tenantId, params.tenantId), eq(v11EvaluationRun.id, id)))
    .limit(1);
  if (!row) {
    throw new Error(`createEvaluationRun: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 EvaluationRun（跨租户隔离）。 */
export async function getEvaluationRunById(
  tenantId: string,
  runId: string,
): Promise<V11EvaluationRun | null> {
  const [row] = await db
    .select()
    .from(v11EvaluationRun)
    .where(and(eq(v11EvaluationRun.tenantId, tenantId), eq(v11EvaluationRun.id, runId)))
    .limit(1);
  return row ?? null;
}

/** listEvaluationRunsByTenant 选项。 */
export interface ListEvaluationRunsByTenantOptions {
  runState?: EvaluationRunState;
  agentRevisionId?: string;
  limit?: number;
  cursor?: string | null;
}

/** 列出租户的 EvaluationRun（cursor 分页，按 created_at 降序）。 */
export async function listEvaluationRunsByTenant(
  tenantId: string,
  options?: ListEvaluationRunsByTenantOptions,
): Promise<{ items: V11EvaluationRun[]; nextCursor: string | null }> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [eq(v11EvaluationRun.tenantId, tenantId)];
  if (options?.runState) {
    conditions.push(eq(v11EvaluationRun.runState, options.runState));
  }
  if (options?.agentRevisionId) {
    conditions.push(eq(v11EvaluationRun.agentRevisionId, options.agentRevisionId));
  }

  // cursor 解码：{ created_at, id }
  let afterCreatedAt: Date | undefined;
  let afterId: string | undefined;
  if (options?.cursor) {
    const decoded = decodeCursor(options.cursor) as {
      created_at?: string;
      id?: string;
    };
    if (typeof decoded.created_at !== "string" || typeof decoded.id !== "string") {
      throw new Error("listEvaluationRunsByTenant: cursor 缺少 created_at/id 字段");
    }
    afterCreatedAt = new Date(decoded.created_at);
    if (Number.isNaN(afterCreatedAt.getTime())) {
      throw new Error("listEvaluationRunsByTenant: cursor.created_at 不是合法 ISO 时间");
    }
    afterId = decoded.id;
  }

  if (afterCreatedAt && afterId) {
    // (created_at, id) < (afterCreatedAt, afterId) in DESC order：
    // 使用 Drizzle 原生操作符确保 Date 参数绑定与列类型一致
    const cursorCond = or(
      lt(v11EvaluationRun.createdAt, afterCreatedAt),
      and(eq(v11EvaluationRun.createdAt, afterCreatedAt), lt(v11EvaluationRun.id, afterId)),
    );
    if (cursorCond) conditions.push(cursorCond);
  }

  // 取 limit+1 行：第 limit+1 行存在说明有下一页
  const rows = await db
    .select()
    .from(v11EvaluationRun)
    .where(and(...conditions))
    .orderBy(desc(v11EvaluationRun.createdAt), desc(v11EvaluationRun.id))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  let items = rows;
  if (rows.length > limit) {
    items = rows.slice(0, limit);
    const lastKept = items[items.length - 1];
    if (lastKept) {
      nextCursor = encodeCursor({
        created_at: lastKept.createdAt.toISOString(),
        id: lastKept.id,
      });
    }
  }

  return { items, nextCursor };
}

/** updateEvaluationRunState 入参。 */
export interface UpdateEvaluationRunStateParams {
  runState?: EvaluationRunState;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

/** 更新 EvaluationRun 状态。 */
export async function updateEvaluationRunState(
  tenantId: string,
  runId: string,
  updates: UpdateEvaluationRunStateParams,
): Promise<V11EvaluationRun> {
  const setClause: Partial<V11EvaluationRun> = { updatedAt: new Date() };
  if (updates.runState) setClause.runState = updates.runState;
  if (updates.startedAt !== undefined) setClause.startedAt = updates.startedAt ?? null;
  if (updates.finishedAt !== undefined) setClause.finishedAt = updates.finishedAt ?? null;

  await db
    .update(v11EvaluationRun)
    .set(setClause)
    .where(and(eq(v11EvaluationRun.tenantId, tenantId), eq(v11EvaluationRun.id, runId)));

  const [row] = await db
    .select()
    .from(v11EvaluationRun)
    .where(and(eq(v11EvaluationRun.tenantId, tenantId), eq(v11EvaluationRun.id, runId)))
    .limit(1);
  if (!row) {
    throw new Error(`updateEvaluationRunState: EvaluationRun 行未找到（id=${runId}）`);
  }
  return row;
}

/** 更新 EvaluationRun Summary 投影（可比较指标）。 */
export async function updateEvaluationRunSummary(
  tenantId: string,
  runId: string,
  summaryJson: Record<string, unknown> | null,
): Promise<V11EvaluationRun> {
  await db
    .update(v11EvaluationRun)
    .set({ summaryJson, updatedAt: new Date() })
    .where(and(eq(v11EvaluationRun.tenantId, tenantId), eq(v11EvaluationRun.id, runId)));

  const [row] = await db
    .select()
    .from(v11EvaluationRun)
    .where(and(eq(v11EvaluationRun.tenantId, tenantId), eq(v11EvaluationRun.id, runId)))
    .limit(1);
  if (!row) {
    throw new Error(`updateEvaluationRunSummary: EvaluationRun 行未找到（id=${runId}）`);
  }
  return row;
}

// ─── EvaluationCase ───────────────────────────────────────

/** createEvaluationCase 入参。 */
export interface CreateEvaluationCaseParams {
  tenantId: string;
  runId: string;
  caseKey: string;
  scenarioRef?: string | null;
  inputRedactedJson: Record<string, unknown>;
  expectedJson?: Record<string, unknown> | null;
  actualRedactedJson?: Record<string, unknown> | null;
  caseState?: EvaluationCaseState;
  failureReason?: string | null;
  evidenceJson?: Record<string, unknown> | null;
}

/** 创建 EvaluationCase。 */
export async function createEvaluationCase(
  params: CreateEvaluationCaseParams,
): Promise<V11EvaluationCase> {
  const id = randomUUID();
  await db.insert(v11EvaluationCase).values({
    id,
    tenantId: params.tenantId,
    runId: params.runId,
    caseKey: params.caseKey,
    scenarioRef: params.scenarioRef ?? null,
    inputRedactedJson: params.inputRedactedJson,
    expectedJson: params.expectedJson ?? null,
    actualRedactedJson: params.actualRedactedJson ?? null,
    caseState: params.caseState ?? "pending",
    failureReason: params.failureReason ?? null,
    evidenceJson: params.evidenceJson ?? null,
  });

  const [row] = await db
    .select()
    .from(v11EvaluationCase)
    .where(and(eq(v11EvaluationCase.tenantId, params.tenantId), eq(v11EvaluationCase.id, id)))
    .limit(1);
  if (!row) {
    throw new Error(`createEvaluationCase: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 EvaluationCase（跨租户隔离）。 */
export async function getEvaluationCaseById(
  tenantId: string,
  caseId: string,
): Promise<V11EvaluationCase | null> {
  const [row] = await db
    .select()
    .from(v11EvaluationCase)
    .where(and(eq(v11EvaluationCase.tenantId, tenantId), eq(v11EvaluationCase.id, caseId)))
    .limit(1);
  return row ?? null;
}

/** listEvaluationCasesByRun 选项。 */
export interface ListEvaluationCasesByRunOptions {
  caseState?: EvaluationCaseState;
  limit?: number;
}

/** 列出 Run 下所有 Case（按 createdAt 升序）。 */
export async function listEvaluationCasesByRun(
  tenantId: string,
  runId: string,
  options?: ListEvaluationCasesByRunOptions,
): Promise<V11EvaluationCase[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [eq(v11EvaluationCase.tenantId, tenantId), eq(v11EvaluationCase.runId, runId)];
  if (options?.caseState) {
    conditions.push(eq(v11EvaluationCase.caseState, options.caseState));
  }
  return db
    .select()
    .from(v11EvaluationCase)
    .where(and(...conditions))
    .orderBy(asc(v11EvaluationCase.createdAt), asc(v11EvaluationCase.id))
    .limit(limit);
}

// ─── EvaluationResult ─────────────────────────────────────

/** createEvaluationResult 入参。 */
export interface CreateEvaluationResultParams {
  tenantId: string;
  runId: string;
  metricKey: string;
  metricValue: string | number;
  comparator?: EvaluationComparator;
  thresholdValue?: string | number | null;
  passed: boolean;
  caseId?: string | null;
}

/** 创建 EvaluationResult。 */
export async function createEvaluationResult(
  params: CreateEvaluationResultParams,
): Promise<V11EvaluationResult> {
  const id = randomUUID();
  await db.insert(v11EvaluationResult).values({
    id,
    tenantId: params.tenantId,
    runId: params.runId,
    caseId: params.caseId ?? null,
    metricKey: params.metricKey,
    metricValue: String(params.metricValue),
    comparator: params.comparator ?? "higher_better",
    thresholdValue: params.thresholdValue != null ? String(params.thresholdValue) : null,
    passed: params.passed,
  });

  const [row] = await db
    .select()
    .from(v11EvaluationResult)
    .where(and(eq(v11EvaluationResult.tenantId, params.tenantId), eq(v11EvaluationResult.id, id)))
    .limit(1);
  if (!row) {
    throw new Error(`createEvaluationResult: 行未找到（id=${id}）`);
  }
  return row;
}

/** listEvaluationResultsByRun 选项。 */
export interface ListEvaluationResultsByRunOptions {
  metricKey?: string;
  limit?: number;
}

/** 列出 Run 下所有 Result（按 createdAt 升序）。 */
export async function listEvaluationResultsByRun(
  tenantId: string,
  runId: string,
  options?: ListEvaluationResultsByRunOptions,
): Promise<V11EvaluationResult[]> {
  const limit = Math.min(options?.limit ?? 200, 1000);
  const conditions = [
    eq(v11EvaluationResult.tenantId, tenantId),
    eq(v11EvaluationResult.runId, runId),
  ];
  if (options?.metricKey) {
    conditions.push(eq(v11EvaluationResult.metricKey, options.metricKey));
  }
  return db
    .select()
    .from(v11EvaluationResult)
    .where(and(...conditions))
    .orderBy(asc(v11EvaluationResult.createdAt), asc(v11EvaluationResult.id))
    .limit(limit);
}

/** 列出 Case 下所有 Result（按 createdAt 升序）。 */
export async function listEvaluationResultsByCase(
  tenantId: string,
  caseId: string,
  options?: { limit?: number },
): Promise<V11EvaluationResult[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  return db
    .select()
    .from(v11EvaluationResult)
    .where(and(eq(v11EvaluationResult.tenantId, tenantId), eq(v11EvaluationResult.caseId, caseId)))
    .orderBy(asc(v11EvaluationResult.createdAt), asc(v11EvaluationResult.id))
    .limit(limit);
}

// ─── re-export 供外部统一从本模块引入类型 ───────────────────

export type {
  EvaluationCaseState,
  EvaluationComparator,
  EvaluationRunState,
  EvaluationStrategyKey,
  V11EvaluationCase,
  V11EvaluationResult,
  V11EvaluationRun,
} from "@/lib/v11/schema/evaluation";
