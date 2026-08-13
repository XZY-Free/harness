/**
 * Usage / Capacity / SLI 仓储（S11-W07）。
 *
 * 事实源：
 * - docs/architecture/persistence.md §11（Observability），
 * - docs/architecture/runtime-control-plane.md S11-W07。
 *
 * 职责：
 * - createUsageRecord / getUsageRecordById / listUsageRecordsByTenant (cursor 分页)
 * / 支持 dimension / scopeType / observedFrom / observedTo 过滤。
 * - createOrUpdateCostAggregate (按 UNIQUE key upsert) / getCostAggregateById
 * / listCostAggregatesByTenant (支持 dimension/scopeType/granularity/windowFrom/windowTo 过滤)。
 * - createCapacitySnapshot / getCapacitySnapshotById / listCapacitySnapshotsByTenant
 * (支持 scopeType/scopeRef 过滤, 按 snapshotAt desc)。
 * - createServiceLevelIndicator / getServiceLevelIndicatorById / listServiceLevelIndicatorsByTenant
 * (支持 scopeType/indicatorKey/breachOnly 过滤, 按 measuredAt desc)。
 * - getCapacityAlertsByTenant (返回 breach=true 的 SLI + 关联 capacity snapshot + 可跳转引用)。
 *
 * 关键约束：
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - bigint 字段（quantity / totalQuantity / totalCostMicros / unitCostMicros / limitTokensPerMinute /
 * limitCostPerHourMicros）使用 BigInt mode，路由层序列化为 string。
 * - 告警从可执行阈值产生，并能跳转相关 Invocation/Event/Trace，不建设无来源的装饰仪表盘。
 * - cursor 分页采用 limit+1 策略（与 lib/evaluation/evaluation-queries.ts 的 listEvaluationRunsByTenant 一致）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { decodeCursor, encodeCursor } from "@/lib/http";
import {
  type CapacityScopeType,
  type CapacitySnapshot,
  type CostAggregate,
  type CostGranularity,
  type ServiceLevelIndicator,
  type SliKey,
  type UsageDimension,
  type UsageRecord,
  type UsageScopeType,
  capacitySnapshotTable,
  costAggregateTable,
  serviceLevelIndicatorTable,
  usageRecordTable,
} from "@/lib/persistence/schema/usage";
import { and, desc, eq, gte, lt, lte, or, sql } from "drizzle-orm";

// ─── UsageRecord ─────────────────────────────────────────

/** createUsageRecord 入参。 */
export interface CreateUsageRecordParams {
  tenantId: string;
  dimension: UsageDimension;
  scopeType: UsageScopeType;
  scopeRef?: string | null;
  agentRevisionId?: string | null;
  modelRef?: string | null;
  toolProviderId?: string | null;
  environmentId?: string | null;
  jobId?: string | null;
  invocationId?: string | null;
  /** bigint 数值（接受 number 或 BigInt）。 */
  quantity: bigint | number;
  unitCostMicros?: bigint | number | null;
  totalCostMicros?: bigint | number | null;
  observedAt?: Date;
}

/** 把 number/bigint 统一规整为 BigInt。 */
function toBigInt(value: bigint | number): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

/** 创建 UsageRecord。 */
export async function createUsageRecord(params: CreateUsageRecordParams): Promise<UsageRecord> {
  const id = randomUUID();
  const observedAt = params.observedAt ?? new Date();
  await db.insert(usageRecordTable).values({
    id,
    tenantId: params.tenantId,
    dimension: params.dimension,
    scopeType: params.scopeType,
    scopeRef: params.scopeRef ?? null,
    agentRevisionId: params.agentRevisionId ?? null,
    modelRef: params.modelRef ?? null,
    toolProviderId: params.toolProviderId ?? null,
    environmentId: params.environmentId ?? null,
    jobId: params.jobId ?? null,
    invocationId: params.invocationId ?? null,
    quantity: toBigInt(params.quantity),
    unitCostMicros: params.unitCostMicros != null ? toBigInt(params.unitCostMicros) : null,
    totalCostMicros: params.totalCostMicros != null ? toBigInt(params.totalCostMicros) : null,
    observedAt,
  });

  const [row] = await db
    .select()
    .from(usageRecordTable)
    .where(and(eq(usageRecordTable.tenantId, params.tenantId), eq(usageRecordTable.id, id)))
    .limit(1);
  if (!row) {
    throw new Error(`createUsageRecord: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 UsageRecord（跨租户隔离）。 */
export async function getUsageRecordById(
  tenantId: string,
  recordId: string,
): Promise<UsageRecord | null> {
  const [row] = await db
    .select()
    .from(usageRecordTable)
    .where(and(eq(usageRecordTable.tenantId, tenantId), eq(usageRecordTable.id, recordId)))
    .limit(1);
  return row ?? null;
}

/** listUsageRecordsByTenant 选项。 */
export interface ListUsageRecordsByTenantOptions {
  dimension?: UsageDimension;
  scopeType?: UsageScopeType;
  observedFrom?: Date;
  observedTo?: Date;
  limit?: number;
  cursor?: string | null;
}

/** 列出租户的 UsageRecord（cursor 分页，按 observed_at 降序）。 */
export async function listUsageRecordsByTenant(
  tenantId: string,
  options?: ListUsageRecordsByTenantOptions,
): Promise<{ items: UsageRecord[]; nextCursor: string | null }> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [eq(usageRecordTable.tenantId, tenantId)];
  if (options?.dimension) {
    conditions.push(eq(usageRecordTable.dimension, options.dimension));
  }
  if (options?.scopeType) {
    conditions.push(eq(usageRecordTable.scopeType, options.scopeType));
  }
  if (options?.observedFrom) {
    conditions.push(gte(usageRecordTable.observedAt, options.observedFrom));
  }
  if (options?.observedTo) {
    conditions.push(lte(usageRecordTable.observedAt, options.observedTo));
  }

  // cursor 解码：{ observed_at, id }
  let afterObservedAt: Date | undefined;
  let afterId: string | undefined;
  if (options?.cursor) {
    const decoded = decodeCursor(options.cursor) as {
      observed_at?: string;
      id?: string;
    };
    if (typeof decoded.observed_at !== "string" || typeof decoded.id !== "string") {
      throw new Error("listUsageRecordsByTenant: cursor 缺少 observed_at/id 字段");
    }
    afterObservedAt = new Date(decoded.observed_at);
    if (Number.isNaN(afterObservedAt.getTime())) {
      throw new Error("listUsageRecordsByTenant: cursor.observed_at 不是合法 ISO 时间");
    }
    afterId = decoded.id;
  }

  if (afterObservedAt && afterId) {
    // (observed_at, id) < (afterObservedAt, afterId) in DESC order：
    // 使用 Drizzle 原生操作符确保 Date 参数绑定与列类型一致
    const cursorCond = or(
      lt(usageRecordTable.observedAt, afterObservedAt),
      and(eq(usageRecordTable.observedAt, afterObservedAt), lt(usageRecordTable.id, afterId)),
    );
    if (cursorCond) conditions.push(cursorCond);
  }

  const rows = await db
    .select()
    .from(usageRecordTable)
    .where(and(...conditions))
    .orderBy(desc(usageRecordTable.observedAt), desc(usageRecordTable.id))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  let items = rows;
  if (rows.length > limit) {
    items = rows.slice(0, limit);
    const lastKept = items[items.length - 1];
    if (lastKept) {
      nextCursor = encodeCursor({
        observed_at: lastKept.observedAt.toISOString(),
        id: lastKept.id,
      });
    }
  }

  return { items, nextCursor };
}

// ─── CostAggregate ───────────────────────────────────────

/** createOrUpdateCostAggregate 入参。 */
export interface CreateOrUpdateCostAggregateParams {
  tenantId: string;
  dimension: UsageDimension;
  scopeType: UsageScopeType;
  scopeRef?: string | null;
  windowStart: Date;
  windowEnd: Date;
  granularity: CostGranularity;
  totalQuantity: bigint | number;
  totalCostMicros: bigint | number;
  recordCount: number;
}

/**
 * 创建或更新 CostAggregate（按 UNIQUE(tenant_id, dimension, scope_type, scope_ref, window_start, granularity) upsert）。
 *
 * UNIQUE key 命中时覆盖 totalQuantity/totalCostMicros/recordCount，updatedAt 自动刷新。
 */
export async function createOrUpdateCostAggregate(
  params: CreateOrUpdateCostAggregateParams,
): Promise<CostAggregate> {
  const scopeRef = params.scopeRef ?? null;

  // 先查是否存在（MySQL UNIQUE 索引将 NULL 视为不同值，onDuplicateKeyUpdate 对 scope_ref=NULL 不生效）
  const lookupConditions = [
    eq(costAggregateTable.tenantId, params.tenantId),
    eq(costAggregateTable.dimension, params.dimension),
    eq(costAggregateTable.scopeType, params.scopeType),
    eq(costAggregateTable.windowStart, params.windowStart),
    eq(costAggregateTable.granularity, params.granularity),
  ];
  if (scopeRef !== null) {
    lookupConditions.push(eq(costAggregateTable.scopeRef, scopeRef));
  } else {
    lookupConditions.push(sql`${costAggregateTable.scopeRef} IS NULL`);
  }
  const [existing] = await db
    .select()
    .from(costAggregateTable)
    .where(and(...lookupConditions))
    .limit(1);

  if (existing) {
    // UPDATE 已有记录
    await db
      .update(costAggregateTable)
      .set({
        totalQuantity: toBigInt(params.totalQuantity),
        totalCostMicros: toBigInt(params.totalCostMicros),
        recordCount: params.recordCount,
        windowEnd: params.windowEnd,
        updatedAt: new Date(),
      })
      .where(eq(costAggregateTable.id, existing.id));
    return {
      ...existing,
      totalQuantity: toBigInt(params.totalQuantity),
      totalCostMicros: toBigInt(params.totalCostMicros),
      recordCount: params.recordCount,
      windowEnd: params.windowEnd,
      updatedAt: new Date(),
    };
  }

  // INSERT 新记录
  const id = randomUUID();
  await db.insert(costAggregateTable).values({
    id,
    tenantId: params.tenantId,
    dimension: params.dimension,
    scopeType: params.scopeType,
    scopeRef,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    granularity: params.granularity,
    totalQuantity: toBigInt(params.totalQuantity),
    totalCostMicros: toBigInt(params.totalCostMicros),
    recordCount: params.recordCount,
  });

  const [row] = await db
    .select()
    .from(costAggregateTable)
    .where(eq(costAggregateTable.id, id))
    .limit(1);
  if (!row) {
    throw new Error(
      `createOrUpdateCostAggregate: 行未找到（dimension=${params.dimension}, scopeType=${params.scopeType}, scopeRef=${scopeRef ?? "null"}, windowStart=${params.windowStart.toISOString()}, granularity=${params.granularity}）`,
    );
  }
  return row;
}

/** 按 id 获取 CostAggregate（跨租户隔离）。 */
export async function getCostAggregateById(
  tenantId: string,
  aggregateId: string,
): Promise<CostAggregate | null> {
  const [row] = await db
    .select()
    .from(costAggregateTable)
    .where(and(eq(costAggregateTable.tenantId, tenantId), eq(costAggregateTable.id, aggregateId)))
    .limit(1);
  return row ?? null;
}

/** listCostAggregatesByTenant 选项。 */
export interface ListCostAggregatesByTenantOptions {
  dimension?: UsageDimension;
  scopeType?: UsageScopeType;
  granularity?: CostGranularity;
  windowFrom?: Date;
  windowTo?: Date;
  limit?: number;
  cursor?: string | null;
}

/** 列出租户的 CostAggregate（cursor 分页，按 window_start 降序）。 */
export async function listCostAggregatesByTenant(
  tenantId: string,
  options?: ListCostAggregatesByTenantOptions,
): Promise<{ items: CostAggregate[]; nextCursor: string | null }> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [eq(costAggregateTable.tenantId, tenantId)];
  if (options?.dimension) {
    conditions.push(eq(costAggregateTable.dimension, options.dimension));
  }
  if (options?.scopeType) {
    conditions.push(eq(costAggregateTable.scopeType, options.scopeType));
  }
  if (options?.granularity) {
    conditions.push(eq(costAggregateTable.granularity, options.granularity));
  }
  if (options?.windowFrom) {
    conditions.push(gte(costAggregateTable.windowStart, options.windowFrom));
  }
  if (options?.windowTo) {
    conditions.push(lte(costAggregateTable.windowStart, options.windowTo));
  }

  // cursor 解码：{ window_start, id }
  let afterWindowStart: Date | undefined;
  let afterId: string | undefined;
  if (options?.cursor) {
    const decoded = decodeCursor(options.cursor) as {
      window_start?: string;
      id?: string;
    };
    if (typeof decoded.window_start !== "string" || typeof decoded.id !== "string") {
      throw new Error("listCostAggregatesByTenant: cursor 缺少 window_start/id 字段");
    }
    afterWindowStart = new Date(decoded.window_start);
    if (Number.isNaN(afterWindowStart.getTime())) {
      throw new Error("listCostAggregatesByTenant: cursor.window_start 不是合法 ISO 时间");
    }
    afterId = decoded.id;
  }

  if (afterWindowStart && afterId) {
    const cursorCond = or(
      lt(costAggregateTable.windowStart, afterWindowStart),
      and(eq(costAggregateTable.windowStart, afterWindowStart), lt(costAggregateTable.id, afterId)),
    );
    if (cursorCond) conditions.push(cursorCond);
  }

  const rows = await db
    .select()
    .from(costAggregateTable)
    .where(and(...conditions))
    .orderBy(desc(costAggregateTable.windowStart), desc(costAggregateTable.id))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  let items = rows;
  if (rows.length > limit) {
    items = rows.slice(0, limit);
    const lastKept = items[items.length - 1];
    if (lastKept) {
      nextCursor = encodeCursor({
        window_start: lastKept.windowStart.toISOString(),
        id: lastKept.id,
      });
    }
  }

  return { items, nextCursor };
}

// ─── CapacitySnapshot ────────────────────────────────────

/** createCapacitySnapshot 入参。 */
export interface CreateCapacitySnapshotParams {
  tenantId: string;
  scopeType: CapacityScopeType;
  scopeRef?: string | null;
  activeInvocations?: number;
  queuedJobs?: number;
  coldStartsLastHour?: number;
  limitInvocationsPerMinute?: number | null;
  limitTokensPerMinute?: bigint | number | null;
  limitCostPerHourMicros?: bigint | number | null;
  failureCountLastHour?: number;
  snapshotAt?: Date;
}

/** 创建 CapacitySnapshot。 */
export async function createCapacitySnapshot(
  params: CreateCapacitySnapshotParams,
): Promise<CapacitySnapshot> {
  const id = randomUUID();
  const snapshotAt = params.snapshotAt ?? new Date();
  await db.insert(capacitySnapshotTable).values({
    id,
    tenantId: params.tenantId,
    scopeType: params.scopeType,
    scopeRef: params.scopeRef ?? null,
    activeInvocations: params.activeInvocations ?? 0,
    queuedJobs: params.queuedJobs ?? 0,
    coldStartsLastHour: params.coldStartsLastHour ?? 0,
    limitInvocationsPerMinute: params.limitInvocationsPerMinute ?? null,
    limitTokensPerMinute:
      params.limitTokensPerMinute != null ? toBigInt(params.limitTokensPerMinute) : null,
    limitCostPerHourMicros:
      params.limitCostPerHourMicros != null ? toBigInt(params.limitCostPerHourMicros) : null,
    failureCountLastHour: params.failureCountLastHour ?? 0,
    snapshotAt,
  });

  const [row] = await db
    .select()
    .from(capacitySnapshotTable)
    .where(
      and(eq(capacitySnapshotTable.tenantId, params.tenantId), eq(capacitySnapshotTable.id, id)),
    )
    .limit(1);
  if (!row) {
    throw new Error(`createCapacitySnapshot: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 CapacitySnapshot（跨租户隔离）。 */
export async function getCapacitySnapshotById(
  tenantId: string,
  snapshotId: string,
): Promise<CapacitySnapshot | null> {
  const [row] = await db
    .select()
    .from(capacitySnapshotTable)
    .where(
      and(eq(capacitySnapshotTable.tenantId, tenantId), eq(capacitySnapshotTable.id, snapshotId)),
    )
    .limit(1);
  return row ?? null;
}

/** listCapacitySnapshotsByTenant 选项。 */
export interface ListCapacitySnapshotsByTenantOptions {
  scopeType?: CapacityScopeType;
  scopeRef?: string;
  limit?: number;
  cursor?: string | null;
}

/** 列出租户的 CapacitySnapshot（cursor 分页，按 snapshot_at 降序）。 */
export async function listCapacitySnapshotsByTenant(
  tenantId: string,
  options?: ListCapacitySnapshotsByTenantOptions,
): Promise<{ items: CapacitySnapshot[]; nextCursor: string | null }> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [eq(capacitySnapshotTable.tenantId, tenantId)];
  if (options?.scopeType) {
    conditions.push(eq(capacitySnapshotTable.scopeType, options.scopeType));
  }
  if (options?.scopeRef) {
    conditions.push(eq(capacitySnapshotTable.scopeRef, options.scopeRef));
  }

  // cursor 解码：{ snapshot_at, id }
  let afterSnapshotAt: Date | undefined;
  let afterId: string | undefined;
  if (options?.cursor) {
    const decoded = decodeCursor(options.cursor) as {
      snapshot_at?: string;
      id?: string;
    };
    if (typeof decoded.snapshot_at !== "string" || typeof decoded.id !== "string") {
      throw new Error("listCapacitySnapshotsByTenant: cursor 缺少 snapshot_at/id 字段");
    }
    afterSnapshotAt = new Date(decoded.snapshot_at);
    if (Number.isNaN(afterSnapshotAt.getTime())) {
      throw new Error("listCapacitySnapshotsByTenant: cursor.snapshot_at 不是合法 ISO 时间");
    }
    afterId = decoded.id;
  }

  if (afterSnapshotAt && afterId) {
    const cursorCond = or(
      lt(capacitySnapshotTable.snapshotAt, afterSnapshotAt),
      and(
        eq(capacitySnapshotTable.snapshotAt, afterSnapshotAt),
        lt(capacitySnapshotTable.id, afterId),
      ),
    );
    if (cursorCond) conditions.push(cursorCond);
  }

  const rows = await db
    .select()
    .from(capacitySnapshotTable)
    .where(and(...conditions))
    .orderBy(desc(capacitySnapshotTable.snapshotAt), desc(capacitySnapshotTable.id))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  let items = rows;
  if (rows.length > limit) {
    items = rows.slice(0, limit);
    const lastKept = items[items.length - 1];
    if (lastKept) {
      nextCursor = encodeCursor({
        snapshot_at: lastKept.snapshotAt.toISOString(),
        id: lastKept.id,
      });
    }
  }

  return { items, nextCursor };
}

// ─── ServiceLevelIndicator ───────────────────────────────

/** createServiceLevelIndicator 入参。 */
export interface CreateServiceLevelIndicatorParams {
  tenantId: string;
  scopeType: CapacityScopeType;
  scopeRef?: string | null;
  indicatorKey: SliKey;
  /** decimal(20,6)，Drizzle 读出为 string，写入接受 string | number。 */
  indicatorValue: string | number;
  thresholdValue?: string | number | null;
  breach?: boolean;
  alertInvocationId?: string | null;
  alertTraceId?: string | null;
  /** S12-W03：告警错误码（breach=true 时填入触发的 错误码）。 */
  errorCode?: string | null;
  measuredAt?: Date;
}

/** 创建 ServiceLevelIndicator。 */
export async function createServiceLevelIndicator(
  params: CreateServiceLevelIndicatorParams,
): Promise<ServiceLevelIndicator> {
  const id = randomUUID();
  const measuredAt = params.measuredAt ?? new Date();
  await db.insert(serviceLevelIndicatorTable).values({
    id,
    tenantId: params.tenantId,
    scopeType: params.scopeType,
    scopeRef: params.scopeRef ?? null,
    indicatorKey: params.indicatorKey,
    indicatorValue: String(params.indicatorValue),
    thresholdValue: params.thresholdValue != null ? String(params.thresholdValue) : null,
    breach: params.breach ?? false,
    alertInvocationId: params.alertInvocationId ?? null,
    alertTraceId: params.alertTraceId ?? null,
    errorCode: params.errorCode ?? null,
    measuredAt,
  });

  const [row] = await db
    .select()
    .from(serviceLevelIndicatorTable)
    .where(
      and(
        eq(serviceLevelIndicatorTable.tenantId, params.tenantId),
        eq(serviceLevelIndicatorTable.id, id),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(`createServiceLevelIndicator: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 ServiceLevelIndicator（跨租户隔离）。 */
export async function getServiceLevelIndicatorById(
  tenantId: string,
  indicatorId: string,
): Promise<ServiceLevelIndicator | null> {
  const [row] = await db
    .select()
    .from(serviceLevelIndicatorTable)
    .where(
      and(
        eq(serviceLevelIndicatorTable.tenantId, tenantId),
        eq(serviceLevelIndicatorTable.id, indicatorId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** listServiceLevelIndicatorsByTenant 选项。 */
export interface ListServiceLevelIndicatorsByTenantOptions {
  scopeType?: CapacityScopeType;
  indicatorKey?: SliKey;
  /** true 时只返回 breach=true 的记录。 */
  breachOnly?: boolean;
  limit?: number;
  cursor?: string | null;
}

/** 列出租户的 ServiceLevelIndicator（cursor 分页，按 measured_at 降序）。 */
export async function listServiceLevelIndicatorsByTenant(
  tenantId: string,
  options?: ListServiceLevelIndicatorsByTenantOptions,
): Promise<{ items: ServiceLevelIndicator[]; nextCursor: string | null }> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [eq(serviceLevelIndicatorTable.tenantId, tenantId)];
  if (options?.scopeType) {
    conditions.push(eq(serviceLevelIndicatorTable.scopeType, options.scopeType));
  }
  if (options?.indicatorKey) {
    conditions.push(eq(serviceLevelIndicatorTable.indicatorKey, options.indicatorKey));
  }
  if (options?.breachOnly) {
    conditions.push(eq(serviceLevelIndicatorTable.breach, true));
  }

  // cursor 解码：{ measured_at, id }
  let afterMeasuredAt: Date | undefined;
  let afterId: string | undefined;
  if (options?.cursor) {
    const decoded = decodeCursor(options.cursor) as {
      measured_at?: string;
      id?: string;
    };
    if (typeof decoded.measured_at !== "string" || typeof decoded.id !== "string") {
      throw new Error("listServiceLevelIndicatorsByTenant: cursor 缺少 measured_at/id 字段");
    }
    afterMeasuredAt = new Date(decoded.measured_at);
    if (Number.isNaN(afterMeasuredAt.getTime())) {
      throw new Error("listServiceLevelIndicatorsByTenant: cursor.measured_at 不是合法 ISO 时间");
    }
    afterId = decoded.id;
  }

  if (afterMeasuredAt && afterId) {
    const cursorCond = or(
      lt(serviceLevelIndicatorTable.measuredAt, afterMeasuredAt),
      and(
        eq(serviceLevelIndicatorTable.measuredAt, afterMeasuredAt),
        lt(serviceLevelIndicatorTable.id, afterId),
      ),
    );
    if (cursorCond) conditions.push(cursorCond);
  }

  const rows = await db
    .select()
    .from(serviceLevelIndicatorTable)
    .where(and(...conditions))
    .orderBy(desc(serviceLevelIndicatorTable.measuredAt), desc(serviceLevelIndicatorTable.id))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  let items = rows;
  if (rows.length > limit) {
    items = rows.slice(0, limit);
    const lastKept = items[items.length - 1];
    if (lastKept) {
      nextCursor = encodeCursor({
        measured_at: lastKept.measuredAt.toISOString(),
        id: lastKept.id,
      });
    }
  }

  return { items, nextCursor };
}

// ─── Capacity Alerts（聚合查询）──────────────────────────

/**
 * 容量告警条目：breach SLI + 关联最近 CapacitySnapshot（同 scopeType/scopeRef）+ 告警跳转引用。
 *
 * 告警从可执行阈值产生，并能跳转相关 Invocation/Trace（不建设无来源的装饰仪表盘）。
 */
export interface CapacityAlertItem {
  /** breach SLI 本身。 */
  indicator: ServiceLevelIndicator;
  /** 同 scope 最近一次 snapshot（按 snapshotAt desc 取首条），无关联时为 null。 */
  latestSnapshot: CapacitySnapshot | null;
  /** 告警跳转 Invocation id（来自 SLI.alertInvocationId）。 */
  alertInvocationId: string | null;
  /** 告警跳转 Trace id（来自 SLI.alertTraceId）。 */
  alertTraceId: string | null;
}

/** getCapacityAlertsByTenant 选项。 */
export interface GetCapacityAlertsByTenantOptions {
  /** 限制 scope（可选，便于按 agent/environment 切分告警视图）。 */
  scopeType?: CapacityScopeType;
  /** 限制 scope 引用（可选）。 */
  scopeRef?: string;
  /** 返回告警上限，默认 100。 */
  limit?: number;
}

/**
 * 获取当前告警：breach=true 的 SLI + 关联最近 CapacitySnapshot + 跳转引用。
 *
 * - 只取 breach=true 的 SLI，按 measured_at 降序排列。
 * - 对每个 SLI，按 (tenantId, scopeType, scopeRef) 查最近一次 CapacitySnapshot。
 * - scopeRef 为 null 的 SLI 关联 scopeRef 为 null 的 snapshot。
 */
export async function getCapacityAlertsByTenant(
  tenantId: string,
  options?: GetCapacityAlertsByTenantOptions,
): Promise<{ items: CapacityAlertItem[] }> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [
    eq(serviceLevelIndicatorTable.tenantId, tenantId),
    eq(serviceLevelIndicatorTable.breach, true),
  ];
  if (options?.scopeType) {
    conditions.push(eq(serviceLevelIndicatorTable.scopeType, options.scopeType));
  }
  if (options?.scopeRef) {
    conditions.push(eq(serviceLevelIndicatorTable.scopeRef, options.scopeRef));
  }

  const indicators = await db
    .select()
    .from(serviceLevelIndicatorTable)
    .where(and(...conditions))
    .orderBy(desc(serviceLevelIndicatorTable.measuredAt), desc(serviceLevelIndicatorTable.id))
    .limit(limit);

  if (indicators.length === 0) {
    return { items: [] };
  }

  // 对每个 SLI 关联最近一次 snapshot：按 (tenantId, scopeType, scopeRef) 取 snapshotAt desc 首条。
  // 一次 N+1 查询在告警数量有限（limit ≤ 500）时可接受；告警高发场景应由调度侧改为按 scope 批量预取。
  const items: CapacityAlertItem[] = await Promise.all(
    indicators.map(async (indicator) => {
      const snapshotConditions = [
        eq(capacitySnapshotTable.tenantId, tenantId),
        eq(capacitySnapshotTable.scopeType, indicator.scopeType),
      ];
      if (indicator.scopeRef !== null) {
        snapshotConditions.push(eq(capacitySnapshotTable.scopeRef, indicator.scopeRef));
      } else {
        snapshotConditions.push(sql`${capacitySnapshotTable.scopeRef} IS NULL`);
      }
      const [snapshot] = await db
        .select()
        .from(capacitySnapshotTable)
        .where(and(...snapshotConditions))
        .orderBy(desc(capacitySnapshotTable.snapshotAt), desc(capacitySnapshotTable.id))
        .limit(1);
      return {
        indicator,
        latestSnapshot: snapshot ?? null,
        alertInvocationId: indicator.alertInvocationId,
        alertTraceId: indicator.alertTraceId,
      };
    }),
  );

  return { items };
}

// ─── re-export 供外部统一从本模块引入类型 ───────────────────

export type {
  CapacityScopeType,
  CostGranularity,
  SliKey,
  UsageDimension,
  UsageScopeType,
  CapacitySnapshot,
  CostAggregate,
  ServiceLevelIndicator,
  UsageRecord,
} from "@/lib/persistence/schema/usage";
