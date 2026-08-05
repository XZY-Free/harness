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
  type EvaluationCase,
  type EvaluationCaseState,
  type EvaluationComparator,
  type EvaluationResult,
  type EvaluationRun,
  type EvaluationRunState,
  type EvaluationStrategyKey,
  evaluationCaseTable,
  evaluationResultTable,
  evaluationRunTable,
} from "@/lib/persistence/schema/evaluation";
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
): Promise<EvaluationRun> {
  const id = randomUUID();
  await db.insert(evaluationRunTable).values({
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
    .from(evaluationRunTable)
    .where(and(eq(evaluationRunTable.tenantId, params.tenantId), eq(evaluationRunTable.id, id)))
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
): Promise<EvaluationRun | null> {
  const [row] = await db
    .select()
    .from(evaluationRunTable)
    .where(and(eq(evaluationRunTable.tenantId, tenantId), eq(evaluationRunTable.id, runId)))
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
): Promise<{ items: EvaluationRun[]; nextCursor: string | null }> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [eq(evaluationRunTable.tenantId, tenantId)];
  if (options?.runState) {
    conditions.push(eq(evaluationRunTable.runState, options.runState));
  }
  if (options?.agentRevisionId) {
    conditions.push(eq(evaluationRunTable.agentRevisionId, options.agentRevisionId));
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
      lt(evaluationRunTable.createdAt, afterCreatedAt),
      and(eq(evaluationRunTable.createdAt, afterCreatedAt), lt(evaluationRunTable.id, afterId)),
    );
    if (cursorCond) conditions.push(cursorCond);
  }

  // 取 limit+1 行：第 limit+1 行存在说明有下一页
  const rows = await db
    .select()
    .from(evaluationRunTable)
    .where(and(...conditions))
    .orderBy(desc(evaluationRunTable.createdAt), desc(evaluationRunTable.id))
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
): Promise<EvaluationRun> {
  const setClause: Partial<EvaluationRun> = { updatedAt: new Date() };
  if (updates.runState) setClause.runState = updates.runState;
  if (updates.startedAt !== undefined) setClause.startedAt = updates.startedAt ?? null;
  if (updates.finishedAt !== undefined) setClause.finishedAt = updates.finishedAt ?? null;

  await db
    .update(evaluationRunTable)
    .set(setClause)
    .where(and(eq(evaluationRunTable.tenantId, tenantId), eq(evaluationRunTable.id, runId)));

  const [row] = await db
    .select()
    .from(evaluationRunTable)
    .where(and(eq(evaluationRunTable.tenantId, tenantId), eq(evaluationRunTable.id, runId)))
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
): Promise<EvaluationRun> {
  await db
    .update(evaluationRunTable)
    .set({ summaryJson, updatedAt: new Date() })
    .where(and(eq(evaluationRunTable.tenantId, tenantId), eq(evaluationRunTable.id, runId)));

  const [row] = await db
    .select()
    .from(evaluationRunTable)
    .where(and(eq(evaluationRunTable.tenantId, tenantId), eq(evaluationRunTable.id, runId)))
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
): Promise<EvaluationCase> {
  const id = randomUUID();
  await db.insert(evaluationCaseTable).values({
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
    .from(evaluationCaseTable)
    .where(and(eq(evaluationCaseTable.tenantId, params.tenantId), eq(evaluationCaseTable.id, id)))
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
): Promise<EvaluationCase | null> {
  const [row] = await db
    .select()
    .from(evaluationCaseTable)
    .where(and(eq(evaluationCaseTable.tenantId, tenantId), eq(evaluationCaseTable.id, caseId)))
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
): Promise<EvaluationCase[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [
    eq(evaluationCaseTable.tenantId, tenantId),
    eq(evaluationCaseTable.runId, runId),
  ];
  if (options?.caseState) {
    conditions.push(eq(evaluationCaseTable.caseState, options.caseState));
  }
  return db
    .select()
    .from(evaluationCaseTable)
    .where(and(...conditions))
    .orderBy(asc(evaluationCaseTable.createdAt), asc(evaluationCaseTable.id))
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
): Promise<EvaluationResult> {
  const id = randomUUID();
  await db.insert(evaluationResultTable).values({
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
    .from(evaluationResultTable)
    .where(
      and(eq(evaluationResultTable.tenantId, params.tenantId), eq(evaluationResultTable.id, id)),
    )
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
): Promise<EvaluationResult[]> {
  const limit = Math.min(options?.limit ?? 200, 1000);
  const conditions = [
    eq(evaluationResultTable.tenantId, tenantId),
    eq(evaluationResultTable.runId, runId),
  ];
  if (options?.metricKey) {
    conditions.push(eq(evaluationResultTable.metricKey, options.metricKey));
  }
  return db
    .select()
    .from(evaluationResultTable)
    .where(and(...conditions))
    .orderBy(asc(evaluationResultTable.createdAt), asc(evaluationResultTable.id))
    .limit(limit);
}

/** 列出 Case 下所有 Result（按 createdAt 升序）。 */
export async function listEvaluationResultsByCase(
  tenantId: string,
  caseId: string,
  options?: { limit?: number },
): Promise<EvaluationResult[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  return db
    .select()
    .from(evaluationResultTable)
    .where(
      and(eq(evaluationResultTable.tenantId, tenantId), eq(evaluationResultTable.caseId, caseId)),
    )
    .orderBy(asc(evaluationResultTable.createdAt), asc(evaluationResultTable.id))
    .limit(limit);
}

// ─── re-export 供外部统一从本模块引入类型 ───────────────────

export type {
  EvaluationCaseState,
  EvaluationComparator,
  EvaluationRunState,
  EvaluationStrategyKey,
  EvaluationCase,
  EvaluationResult,
  EvaluationRun,
} from "@/lib/persistence/schema/evaluation";
