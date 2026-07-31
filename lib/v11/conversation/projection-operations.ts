/**
 * V11 事件投影运维操作（S12-W01）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/14-production-operations-security-and-retention.md §2.1（投影消费协议七条规则）
 * - ../v11-agentkit-platform/10-core-data-model.md §8.1（event_delivery_failure）
 * - ../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md S12-W01
 *
 * 职责：
 * - quarantineIfExceeded：attemptCount 达到阈值时将 failure 从 retrying → quarantined
 * - resolveQuarantine：管理员处置 quarantined failure（replay 或 skip），写审计
 * - listDeliveryFailures：按 consumer/state/stream 过滤列出失败记录（管理后台 lag/quarantine 视图）
 * - getDeliveryFailureById：单条查询
 * - replayProjectionFromSequence：受控回放（从指定 sequence 重放单流）
 *
 * 关键约束：
 * - quarantined 后同流后续事件不得越序生效（§8.1 行 592）
 * - resolve 只能处置 quarantined 状态的 failure，不能处置 retrying
 * - replay 从原 event sequence 重放，skip 标记 resolved 并前移 checkpoint
 * - 所有处置操作写审计 event.quarantine.resolve
 */
import { db } from "@/lib/db/client";
import { projectThreadEvent } from "@/lib/v11/conversation/projector";
import { listThreadEvents } from "@/lib/v11/conversation/thread-queries";
import { recordAuditEvent } from "@/lib/v11/identity/audit";
import type { AuditActor } from "@/lib/v11/identity/audit";
import {
  type DeliveryFailureState,
  type StreamType,
  type V11EventDeliveryFailure,
  v11EventDeliveryFailure,
  v11EventStreamFloor,
  v11ProjectionCheckpoint,
} from "@/lib/v11/schema/projection";
import { and, desc, eq, sql } from "drizzle-orm";

/** 重试上限：达到此值后自动隔离。 */
export const QUARANTINE_THRESHOLD = 5;

/** resolve 处置方式。 */
export type QuarantineResolution = "replay" | "skip";

/** resolve 结果。 */
export interface ResolveQuarantineResult {
  failure: V11EventDeliveryFailure;
  resolution: QuarantineResolution;
  /** replay 时返回重放的 event 数量；skip 时为 0。 */
  replayedCount: number;
}

// ─── quarantineIfExceeded ─────────────────────────────────

/**
 * 检查并隔离达到重试上限的 failure。
 *
 * 在 recordDeliveryFailure 后调用：如果 attemptCount >= QUARANTINE_THRESHOLD，
 * 将 failureState 从 retrying → quarantined。
 *
 * @returns 更新后的 failure（如果被隔离）；null 表示未达到阈值
 */
export async function quarantineIfExceeded(
  failureId: string,
  threshold: number = QUARANTINE_THRESHOLD,
): Promise<V11EventDeliveryFailure | null> {
  const [current] = await db
    .select()
    .from(v11EventDeliveryFailure)
    .where(eq(v11EventDeliveryFailure.id, failureId))
    .limit(1);
  if (!current) return null;
  if (current.failureState !== "retrying") return null;
  if (current.attemptCount < threshold) return null;

  await db
    .update(v11EventDeliveryFailure)
    .set({
      failureState: "quarantined",
      nextRetryAt: null,
      updatedAt: new Date(),
    })
    .where(eq(v11EventDeliveryFailure.id, failureId));

  const [updated] = await db
    .select()
    .from(v11EventDeliveryFailure)
    .where(eq(v11EventDeliveryFailure.id, failureId))
    .limit(1);
  return updated ?? null;
}

// ─── resolveQuarantine ────────────────────────────────────

/** resolve 入参。 */
export interface ResolveQuarantineParams {
  failureId: string;
  resolution: QuarantineResolution;
  /** 审计 actor。 */
  actor: AuditActor;
  /** 审计 reason。 */
  reason?: string | null;
  requestId?: string;
}

/**
 * 管理员处置 quarantined failure。
 *
 * - replay：从失败 event 的 sequence 开始重放该流的所有事件到投影
 * - skip：标记 resolved 并前移 checkpoint 到失败 event 的 sequence（跳过该 event）
 *
 * 事实源：§2.1 规则 6-7（修复后从原 event sequence 重放）。
 *
 * @throws Error 如果 failure 不存在或非 quarantined 状态
 */
export async function resolveQuarantine(
  params: ResolveQuarantineParams,
): Promise<ResolveQuarantineResult> {
  const [failure] = await db
    .select()
    .from(v11EventDeliveryFailure)
    .where(eq(v11EventDeliveryFailure.id, params.failureId))
    .limit(1);

  if (!failure) {
    throw new Error(`resolveQuarantine: failure 不存在（id=${params.failureId}）`);
  }
  if (failure.failureState !== "quarantined") {
    throw new Error(
      `resolveQuarantine: failure 状态非 quarantined（当前 ${failure.failureState}），拒绝处置`,
    );
  }

  let replayedCount = 0;

  if (params.resolution === "replay") {
    // 从失败 event 的 sequence 开始重放该流的所有事件到投影
    // 事实源：§2.1 规则 7（修复后从原 event sequence 重放）
    if (failure.streamType === "thread_event") {
      // 从 event_stream_floor 获取 tenantId（failure 表无 tenantId 字段）
      const [floor] = await db
        .select()
        .from(v11EventStreamFloor)
        .where(
          and(
            eq(v11EventStreamFloor.streamType, failure.streamType),
            eq(v11EventStreamFloor.streamId, failure.streamId),
          ),
        )
        .limit(1);

      if (floor) {
        const events = await listThreadEvents(floor.tenantId, failure.streamId, {
          afterSequence: failure.eventSequence - 1,
          limit: 10000,
        });
        for (const event of events) {
          await projectThreadEvent(event);
          replayedCount++;
        }
      }
    }
  } else if (params.resolution === "skip") {
    // skip：前移 checkpoint 到失败 event 的 sequence，使后续 event 可以继续消费
    // versionNo 递增保持 CAS 单调性（不重置为 1）
    await db
      .update(v11ProjectionCheckpoint)
      .set({
        lastSequence: failure.eventSequence,
        lastEventId: failure.eventId,
        updatedAt: new Date(),
        versionNo: sql`${v11ProjectionCheckpoint.versionNo} + 1`,
      })
      .where(
        and(
          eq(v11ProjectionCheckpoint.consumerName, failure.consumerName),
          eq(v11ProjectionCheckpoint.streamType, failure.streamType),
          eq(v11ProjectionCheckpoint.shardKey, failure.streamId),
        ),
      );
  }

  // 标记 resolved
  await db
    .update(v11EventDeliveryFailure)
    .set({
      failureState: "resolved",
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(v11EventDeliveryFailure.id, params.failureId));

  const [resolved] = await db
    .select()
    .from(v11EventDeliveryFailure)
    .where(eq(v11EventDeliveryFailure.id, params.failureId))
    .limit(1);

  if (!resolved) {
    throw new Error(`resolveQuarantine: resolved 行未找到（id=${params.failureId}）`);
  }

  // 写审计 event.quarantine.resolve
  await recordAuditEvent({
    actor: params.actor,
    actionType: "event.quarantine.resolve",
    targetType: "projection",
    targetId: params.failureId,
    after: {
      resolution: params.resolution,
      consumer_name: failure.consumerName,
      stream_type: failure.streamType,
      stream_id: failure.streamId,
      event_id: failure.eventId,
      event_sequence: failure.eventSequence,
      replayed_count: replayedCount,
    },
    reason: params.reason ?? null,
    requestId: params.requestId,
  });

  return {
    failure: resolved,
    resolution: params.resolution,
    replayedCount,
  };
}

// ─── listDeliveryFailures ─────────────────────────────────

/** listDeliveryFailures 过滤选项。 */
export interface ListDeliveryFailuresOptions {
  consumerName?: string;
  failureState?: DeliveryFailureState;
  streamType?: StreamType;
  streamId?: string;
  limit?: number;
}

/**
 * 列出交付失败记录（按 updated_at 降序，支持多维过滤）。
 *
 * 租户隔离：通过 inner join v11EventStreamFloor 过滤出 tenantId 名下的流。
 * event_delivery_failure 表无 tenantId 列，租户归属由 event_stream_floor 提供。
 */
export async function listDeliveryFailures(
  tenantId: string,
  options?: ListDeliveryFailuresOptions,
): Promise<V11EventDeliveryFailure[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions: ReturnType<typeof eq>[] = [eq(v11EventStreamFloor.tenantId, tenantId)];
  if (options?.consumerName) {
    conditions.push(eq(v11EventDeliveryFailure.consumerName, options.consumerName));
  }
  if (options?.failureState) {
    conditions.push(eq(v11EventDeliveryFailure.failureState, options.failureState));
  }
  if (options?.streamType) {
    conditions.push(eq(v11EventDeliveryFailure.streamType, options.streamType));
  }
  if (options?.streamId) {
    conditions.push(eq(v11EventDeliveryFailure.streamId, options.streamId));
  }

  const rows = await db
    .select({ failure: v11EventDeliveryFailure })
    .from(v11EventDeliveryFailure)
    .innerJoin(
      v11EventStreamFloor,
      and(
        eq(v11EventStreamFloor.streamType, v11EventDeliveryFailure.streamType),
        eq(v11EventStreamFloor.streamId, v11EventDeliveryFailure.streamId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(v11EventDeliveryFailure.updatedAt))
    .limit(limit);

  return rows.map((r) => r.failure);
}

/**
 * 按 id 获取交付失败记录（租户隔离，跨租户返回 null）。
 *
 * 通过 inner join v11EventStreamFloor 确保失败记录属于该租户的流。
 */
export async function getDeliveryFailureById(
  tenantId: string,
  failureId: string,
): Promise<V11EventDeliveryFailure | null> {
  const [row] = await db
    .select({ failure: v11EventDeliveryFailure })
    .from(v11EventDeliveryFailure)
    .innerJoin(
      v11EventStreamFloor,
      and(
        eq(v11EventStreamFloor.streamType, v11EventDeliveryFailure.streamType),
        eq(v11EventStreamFloor.streamId, v11EventDeliveryFailure.streamId),
      ),
    )
    .where(
      and(eq(v11EventDeliveryFailure.id, failureId), eq(v11EventStreamFloor.tenantId, tenantId)),
    )
    .limit(1);
  return row?.failure ?? null;
}

// ─── 投影 lag 查询 ─────────────────────────────────────────

/** 投影 lag 信息。 */
export interface ProjectionLagInfo {
  consumerName: string;
  streamType: StreamType;
  shardKey: string;
  /** checkpoint 已消费到的 sequence。 */
  lastSequence: number;
  /** 流最新 sequence（从 event_stream_floor 获取）。 */
  latestSequence: number;
  /** lag = latestSequence - lastSequence。 */
  lag: number;
  /** 该流是否有 quarantined failure。 */
  hasQuarantine: boolean;
  updatedAt: Date;
}

/**
 * 查询指定流的投影 lag（所有 consumer）。
 *
 * 管理后台 dashboard 使用：展示每个流每个 consumer 的消费延迟和 quarantine 状态。
 * 租户隔离：通过 v11EventStreamFloor.tenantId 验证流归属，跨租户返回空数组。
 */
export async function getProjectionLagForStream(
  tenantId: string,
  streamType: StreamType,
  streamId: string,
): Promise<ProjectionLagInfo[]> {
  // 获取流最新 sequence（同时验证租户归属）
  const [floor] = await db
    .select()
    .from(v11EventStreamFloor)
    .where(
      and(
        eq(v11EventStreamFloor.streamType, streamType),
        eq(v11EventStreamFloor.streamId, streamId),
        eq(v11EventStreamFloor.tenantId, tenantId),
      ),
    )
    .limit(1);

  // 流不属于该租户或不存在 → 空数组
  if (!floor) return [];

  const latestSequence = floor.latestSequence;

  // 获取该流所有 consumer 的 checkpoint
  const checkpoints = await db
    .select()
    .from(v11ProjectionCheckpoint)
    .where(
      and(
        eq(v11ProjectionCheckpoint.streamType, streamType),
        eq(v11ProjectionCheckpoint.shardKey, streamId),
      ),
    );

  // 获取该流的 quarantined failures
  const quarantinedFailures = await db
    .select()
    .from(v11EventDeliveryFailure)
    .where(
      and(
        eq(v11EventDeliveryFailure.streamType, streamType),
        eq(v11EventDeliveryFailure.streamId, streamId),
        eq(v11EventDeliveryFailure.failureState, "quarantined"),
      ),
    );

  // 按 consumer 分组 quarantine
  const quarantineConsumers = new Set(quarantinedFailures.map((f) => f.consumerName));

  return checkpoints.map((cp) => ({
    consumerName: cp.consumerName,
    streamType: cp.streamType,
    shardKey: cp.shardKey,
    lastSequence: cp.lastSequence,
    latestSequence,
    lag: Math.max(0, latestSequence - cp.lastSequence),
    hasQuarantine: quarantineConsumers.has(cp.consumerName),
    updatedAt: cp.updatedAt,
  }));
}

/**
 * 列出租户内所有 quarantined failure（管理后台 quarantine 视图）。
 *
 * 按 created_at 降序返回所有 quarantined 状态的 failure。
 * 租户隔离：通过 inner join v11EventStreamFloor 过滤。
 */
export async function listQuarantinedFailures(
  tenantId: string,
  limit = 100,
): Promise<V11EventDeliveryFailure[]> {
  const rows = await db
    .select({ failure: v11EventDeliveryFailure })
    .from(v11EventDeliveryFailure)
    .innerJoin(
      v11EventStreamFloor,
      and(
        eq(v11EventStreamFloor.streamType, v11EventDeliveryFailure.streamType),
        eq(v11EventStreamFloor.streamId, v11EventDeliveryFailure.streamId),
      ),
    )
    .where(
      and(
        eq(v11EventDeliveryFailure.failureState, "quarantined"),
        eq(v11EventStreamFloor.tenantId, tenantId),
      ),
    )
    .orderBy(desc(v11EventDeliveryFailure.createdAt))
    .limit(Math.min(limit, 500));
  return rows.map((r) => r.failure);
}
