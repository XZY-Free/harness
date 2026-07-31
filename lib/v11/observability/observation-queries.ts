/**
 * V11 Observation 仓储（S11-W05）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §11（Observability），
 * - ../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W05。
 *
 * 职责：
 * - createObservation：写入前调用 content-policy.redactContent 脱敏，containsSecret 强制 false。
 * - getObservationById / listObservationsByTrace / listObservationsBySpan / listObservationsByInvocation。
 *
 * 关键约束：
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - V11Observation.containsSecret 永远为 false：写入前由 content-policy 脱敏。
 * - 不存储原始 secret/cookie/OTP/私钥/隐藏思维链（任何模式下均不可写入）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { redactContent } from "@/lib/v11/observability/content-policy";
import { type ObservationKind, type V11Observation, v11Observation } from "@/lib/v11/schema/trace";
import { and, asc, eq } from "drizzle-orm";

/** createObservation 入参。 */
export interface CreateObservationParams {
  tenantId: string;
  traceId: string;
  spanId?: string | null;
  invocationId?: string | null;
  kind: ObservationKind;
  contentMode: "metadata" | "redacted" | "diagnostic";
  /** 原始内容，由 redactContent 脱敏后写入。 */
  content: unknown;
  observedAt?: Date;
}

/** createObservation 返回值。 */
export interface CreateObservationResult {
  observation: V11Observation;
  redactionSummary: string | null;
}

/** 创建 Observation（自动脱敏）。containsSecret 强制 false。 */
export async function createObservation(
  params: CreateObservationParams,
): Promise<CreateObservationResult> {
  const { content, containsSecret, redactionSummary } = redactContent(
    params.content,
    params.contentMode,
  );
  if (containsSecret) {
    // 不可达：redactContent 永远返回 false，但 fail-closed 防御。
    throw new Error("createObservation: containsSecret=true 已被 redactContent 阻断");
  }

  const id = randomUUID();
  const observedAt = params.observedAt ?? new Date();
  await db.insert(v11Observation).values({
    id,
    tenantId: params.tenantId,
    traceId: params.traceId,
    spanId: params.spanId ?? null,
    invocationId: params.invocationId ?? null,
    kind: params.kind,
    contentMode: params.contentMode,
    contentJson: content as Record<string, unknown> | null,
    containsSecret: false,
    redactionSummary: redactionSummary ?? null,
    observedAt,
  });

  const [row] = await db
    .select()
    .from(v11Observation)
    .where(and(eq(v11Observation.tenantId, params.tenantId), eq(v11Observation.id, id)))
    .limit(1);
  if (!row) {
    throw new Error(`createObservation: 行未找到（id=${id}）`);
  }
  return { observation: row, redactionSummary };
}

/** 按 id 获取 Observation。 */
export async function getObservationById(
  tenantId: string,
  observationId: string,
): Promise<V11Observation | null> {
  const [row] = await db
    .select()
    .from(v11Observation)
    .where(and(eq(v11Observation.tenantId, tenantId), eq(v11Observation.id, observationId)))
    .limit(1);
  return row ?? null;
}

/** listObservations 通用选项。 */
export interface ListObservationsOptions {
  kind?: ObservationKind;
  limit?: number;
}

/** 列出 Trace 下所有 Observation。 */
export async function listObservationsByTrace(
  tenantId: string,
  traceId: string,
  options?: ListObservationsOptions,
): Promise<V11Observation[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [eq(v11Observation.tenantId, tenantId), eq(v11Observation.traceId, traceId)];
  if (options?.kind) {
    conditions.push(eq(v11Observation.kind, options.kind));
  }
  return db
    .select()
    .from(v11Observation)
    .where(and(...conditions))
    .orderBy(asc(v11Observation.observedAt), asc(v11Observation.id))
    .limit(limit);
}

/** 列出 Span 下所有 Observation。 */
export async function listObservationsBySpan(
  tenantId: string,
  spanId: string,
  options?: ListObservationsOptions,
): Promise<V11Observation[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [eq(v11Observation.tenantId, tenantId), eq(v11Observation.spanId, spanId)];
  if (options?.kind) {
    conditions.push(eq(v11Observation.kind, options.kind));
  }
  return db
    .select()
    .from(v11Observation)
    .where(and(...conditions))
    .orderBy(asc(v11Observation.observedAt), asc(v11Observation.id))
    .limit(limit);
}

/** 列出 Invocation 下所有 Observation。 */
export async function listObservationsByInvocation(
  tenantId: string,
  invocationId: string,
  options?: ListObservationsOptions,
): Promise<V11Observation[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [
    eq(v11Observation.tenantId, tenantId),
    eq(v11Observation.invocationId, invocationId),
  ];
  if (options?.kind) {
    conditions.push(eq(v11Observation.kind, options.kind));
  }
  return db
    .select()
    .from(v11Observation)
    .where(and(...conditions))
    .orderBy(asc(v11Observation.observedAt), asc(v11Observation.id))
    .limit(limit);
}

// ─── re-export 供外部统一从本模块引入类型 ───────────────────

export type { ObservationKind, V11Observation } from "@/lib/v11/schema/trace";
