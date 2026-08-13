/**
 * Trace 仓储（S11-W05）。
 *
 * 事实源：
 * - docs/architecture/persistence.md §11（Observability），
 * - docs/architecture/runtime-control-plane.md S11-W05。
 *
 * 职责：
 * - createTrace / getTraceById / getTraceByRoot / listTracesByTenant / updateTraceState。
 * - createSpan / getSpanById / listSpansByTrace / listChildSpans / updateSpanState。
 *
 * 关键约束：
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - 不扩展 Runtime ingress 协议；Trace 由 admin API 或未来 runtime 适配器写入。
 * - cursor 分页采用 limit+1 策略（与 lib/job/job-queries.ts 的 listJobsByTenant 一致）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { decodeCursor, encodeCursor } from "@/lib/http";
import {
  type Span,
  type SpanKind,
  type SpanState,
  type Trace,
  type TraceContentMode,
  type TraceRootType,
  type TraceSamplingPolicy,
  type TraceState,
  spanTable,
  traceTable,
} from "@/lib/persistence/schema/trace";
import { and, asc, desc, eq, lt, or } from "drizzle-orm";

// ─── Trace ─────────────────────────────────────────────────

/** createTrace 入参。 */
export interface CreateTraceParams {
  tenantId: string;
  rootType: TraceRootType;
  rootId: string;
  traceKey: string;
  contentMode?: TraceContentMode;
  samplingPolicy?: TraceSamplingPolicy;
  samplingRate?: number | null;
  startedAt?: Date;
  attributesJson?: Record<string, unknown> | null;
}

/** 创建 Trace 根。 */
export async function createTrace(params: CreateTraceParams): Promise<Trace> {
  const id = randomUUID();
  const startedAt = params.startedAt ?? new Date();
  await db.insert(traceTable).values({
    id,
    tenantId: params.tenantId,
    rootType: params.rootType,
    rootId: params.rootId,
    traceKey: params.traceKey,
    rootSpanId: null,
    contentMode: params.contentMode ?? "metadata",
    samplingPolicy: params.samplingPolicy ?? "always",
    samplingRate: params.samplingRate ?? null,
    traceState: "active",
    startedAt,
    finishedAt: null,
    attributesJson: params.attributesJson ?? null,
    versionNo: "1",
  });

  const [row] = await db
    .select()
    .from(traceTable)
    .where(and(eq(traceTable.tenantId, params.tenantId), eq(traceTable.id, id)))
    .limit(1);
  if (!row) {
    throw new Error(`createTrace: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 Trace（跨租户隔离）。 */
export async function getTraceById(tenantId: string, traceId: string): Promise<Trace | null> {
  const [row] = await db
    .select()
    .from(traceTable)
    .where(and(eq(traceTable.tenantId, tenantId), eq(traceTable.id, traceId)))
    .limit(1);
  return row ?? null;
}

/** 按 root (type+id) 获取 Trace。 */
export async function getTraceByRoot(
  tenantId: string,
  rootType: TraceRootType,
  rootId: string,
): Promise<Trace | null> {
  const [row] = await db
    .select()
    .from(traceTable)
    .where(
      and(
        eq(traceTable.tenantId, tenantId),
        eq(traceTable.rootType, rootType),
        eq(traceTable.rootId, rootId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** listTracesByTenant 选项。 */
export interface ListTracesByTenantOptions {
  rootType?: TraceRootType;
  traceState?: TraceState;
  contentMode?: TraceContentMode;
  limit?: number;
  cursor?: string | null;
}

/** 列出 tenant 的 Trace（cursor 分页，按 started_at 降序）。 */
export async function listTracesByTenant(
  tenantId: string,
  options?: ListTracesByTenantOptions,
): Promise<{ items: Trace[]; nextCursor: string | null }> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [eq(traceTable.tenantId, tenantId)];
  if (options?.rootType) {
    conditions.push(eq(traceTable.rootType, options.rootType));
  }
  if (options?.traceState) {
    conditions.push(eq(traceTable.traceState, options.traceState));
  }
  if (options?.contentMode) {
    conditions.push(eq(traceTable.contentMode, options.contentMode));
  }

  // cursor 解码：{ started_at, id }
  let afterStartedAt: Date | undefined;
  let afterId: string | undefined;
  if (options?.cursor) {
    const decoded = decodeCursor(options.cursor) as {
      started_at?: string;
      id?: string;
    };
    if (typeof decoded.started_at !== "string" || typeof decoded.id !== "string") {
      throw new Error("listTracesByTenant: cursor 缺少 started_at/id 字段");
    }
    afterStartedAt = new Date(decoded.started_at);
    if (Number.isNaN(afterStartedAt.getTime())) {
      throw new Error("listTracesByTenant: cursor.started_at 不是合法 ISO 时间");
    }
    afterId = decoded.id;
  }

  if (afterStartedAt && afterId) {
    // (started_at, id) < (afterStartedAt, afterId) in DESC order：
    // 使用 Drizzle 原生操作符确保 Date 参数绑定与列类型一致
    const cursorCond = or(
      lt(traceTable.startedAt, afterStartedAt),
      and(eq(traceTable.startedAt, afterStartedAt), lt(traceTable.id, afterId)),
    );
    if (cursorCond) conditions.push(cursorCond);
  }

  // 取 limit+1 行：第 limit+1 行存在说明有下一页
  const rows = await db
    .select()
    .from(traceTable)
    .where(and(...conditions))
    .orderBy(desc(traceTable.startedAt), desc(traceTable.id))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  let items = rows;
  if (rows.length > limit) {
    items = rows.slice(0, limit);
    const lastKept = items[items.length - 1];
    if (lastKept) {
      nextCursor = encodeCursor({
        started_at: lastKept.startedAt.toISOString(),
        id: lastKept.id,
      });
    }
  }

  return { items, nextCursor };
}

/** updateTraceState 入参。 */
export interface UpdateTraceStateParams {
  traceState?: TraceState;
  finishedAt?: Date | null;
  rootSpanId?: string | null;
}

/** 更新 Trace 状态。 */
export async function updateTraceState(
  tenantId: string,
  traceId: string,
  updates: UpdateTraceStateParams,
): Promise<Trace> {
  const setClause: Partial<Trace> = { updatedAt: new Date() };
  if (updates.traceState) setClause.traceState = updates.traceState;
  if (updates.finishedAt !== undefined) setClause.finishedAt = updates.finishedAt ?? null;
  if (updates.rootSpanId !== undefined) setClause.rootSpanId = updates.rootSpanId ?? null;

  await db
    .update(traceTable)
    .set(setClause)
    .where(and(eq(traceTable.tenantId, tenantId), eq(traceTable.id, traceId)));

  const [row] = await db
    .select()
    .from(traceTable)
    .where(and(eq(traceTable.tenantId, tenantId), eq(traceTable.id, traceId)))
    .limit(1);
  if (!row) {
    throw new Error(`updateTraceState: Trace 行未找到（id=${traceId}）`);
  }
  return row;
}

// ─── Span ──────────────────────────────────────────────────

/** createSpan 入参。 */
export interface CreateSpanParams {
  tenantId: string;
  traceId: string;
  parentSpanId?: string | null;
  spanKey: string;
  name: string;
  kind: SpanKind;
  startedAt?: Date;
  attributesJson?: Record<string, unknown> | null;
}

/** 创建 Span。 */
export async function createSpan(params: CreateSpanParams): Promise<Span> {
  const id = randomUUID();
  const startedAt = params.startedAt ?? new Date();
  await db.insert(spanTable).values({
    id,
    tenantId: params.tenantId,
    traceId: params.traceId,
    parentSpanId: params.parentSpanId ?? null,
    spanKey: params.spanKey,
    name: params.name,
    kind: params.kind,
    spanState: "active",
    startedAt,
    finishedAt: null,
    attributesJson: params.attributesJson ?? null,
    eventsJson: null,
    versionNo: "1",
  });

  const [row] = await db
    .select()
    .from(spanTable)
    .where(and(eq(spanTable.tenantId, params.tenantId), eq(spanTable.id, id)))
    .limit(1);
  if (!row) {
    throw new Error(`createSpan: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 Span。 */
export async function getSpanById(tenantId: string, spanId: string): Promise<Span | null> {
  const [row] = await db
    .select()
    .from(spanTable)
    .where(and(eq(spanTable.tenantId, tenantId), eq(spanTable.id, spanId)))
    .limit(1);
  return row ?? null;
}

/** 列出 Trace 下所有 Span（按 startedAt 升序，构建 span 树）。 */
export async function listSpansByTrace(tenantId: string, traceId: string): Promise<Span[]> {
  return db
    .select()
    .from(spanTable)
    .where(and(eq(spanTable.tenantId, tenantId), eq(spanTable.traceId, traceId)))
    .orderBy(asc(spanTable.startedAt), asc(spanTable.id));
}

/** 按 parent 列出子 Span。 */
export async function listChildSpans(tenantId: string, parentSpanId: string): Promise<Span[]> {
  return db
    .select()
    .from(spanTable)
    .where(and(eq(spanTable.tenantId, tenantId), eq(spanTable.parentSpanId, parentSpanId)))
    .orderBy(asc(spanTable.startedAt), asc(spanTable.id));
}

/** updateSpanState 入参。 */
export interface UpdateSpanStateParams {
  spanState?: SpanState;
  finishedAt?: Date | null;
  eventsJson?: Record<string, unknown>[] | null;
}

/** 更新 Span 状态。 */
export async function updateSpanState(
  tenantId: string,
  spanId: string,
  updates: UpdateSpanStateParams,
): Promise<Span> {
  const setClause: Partial<Span> = { updatedAt: new Date() };
  if (updates.spanState) setClause.spanState = updates.spanState;
  if (updates.finishedAt !== undefined) setClause.finishedAt = updates.finishedAt ?? null;
  if (updates.eventsJson !== undefined) setClause.eventsJson = updates.eventsJson ?? null;

  await db
    .update(spanTable)
    .set(setClause)
    .where(and(eq(spanTable.tenantId, tenantId), eq(spanTable.id, spanId)));

  const [row] = await db
    .select()
    .from(spanTable)
    .where(and(eq(spanTable.tenantId, tenantId), eq(spanTable.id, spanId)))
    .limit(1);
  if (!row) {
    throw new Error(`updateSpanState: Span 行未找到（id=${spanId}）`);
  }
  return row;
}

// ─── re-export 供外部统一从本模块引入类型 ───────────────────

export type {
  SpanKind,
  SpanState,
  TraceContentMode,
  TraceRootType,
  TraceSamplingPolicy,
  TraceState,
  Span,
  Trace,
} from "@/lib/persistence/schema/trace";
