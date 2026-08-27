/**
 * Durable Dispatch Retry 仓储（claim / schedule / lease）。
 *
 * 事实源：
 * - docs/V12/01/SnowHarness_九项问题最终代码收口方案_2026-08-27/01-DurableDispatch与RetryAuthority.md §四/§八
 *
 * 职责：
 * - claimDueInvocationAttempts / claimDueInvocationCommands：
 *   SELECT ... FOR UPDATE SKIP LOCKED 事务内领取 due work 并写 lease（网络调用在事务外）。
 * - recordAttemptDispatchTransientFailure：Attempt transient 失败 → dispatchAttemptCount+1 +
 *   backoff nextDispatchAt + 清 lease；达到 maxDispatchAttempts → Attempt failed（terminal 收口由调用方）。
 * - scheduleCommandTransientRetry：Command transient 失败 → 保持 dispatched + nextDispatchAt + 清 lease。
 * - completeCommandDispatch：acknowledged/failed 终态统一清 lease/nextDispatchAt。
 *
 * 关键约束：
 * - 绝不在持有 DB transaction 时发起 HTTP。
 * - InvocationCommand 状态机不变：queued → dispatched → acknowledged/failed（无 retry_wait 状态）。
 * - 历史行（迁移前）nextDispatchAt=null / count=0 不会被 claim（只对迁移后新 transient 激活）。
 */
import { db } from "@/lib/db/client";
import type { InvocationCommand } from "@/lib/persistence/schema/conversation";
import { invocationCommandTable } from "@/lib/persistence/schema/conversation";
import type { InvocationAttempt } from "@/lib/persistence/schema/executions";
import { invocationAttemptTable } from "@/lib/persistence/schema/executions";
import {
  type TransientDispatchErrorCode,
  backoffDelayMs,
  isRetryExhausted,
} from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 领取 due 的 queued InvocationAttempt（正式 retry work）。
 * 候选：attemptState=queued AND nextDispatchAt IS NOT NULL AND nextDispatchAt <= now
 * AND（dispatchLeaseExpiresAt IS NULL OR dispatchLeaseExpiresAt <= now）——活跃 lease 阻断领取。
 * 事务内 FOR UPDATE SKIP LOCKED + 写 lease；返回的行已持 lease（含续约时间）。
 */
export async function claimDueInvocationAttempts(params: {
  now: Date;
  leaseOwner: string;
  leaseDurationMs: number;
  limit: number;
}): Promise<InvocationAttempt[]> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.attemptState, "queued"),
          isNotNull(invocationAttemptTable.nextDispatchAt),
          lte(invocationAttemptTable.nextDispatchAt, params.now),
          // 活跃 lease 阻断领取：无 lease 或 lease 已过期才可被 claim
          or(
            isNull(invocationAttemptTable.dispatchLeaseExpiresAt),
            lte(invocationAttemptTable.dispatchLeaseExpiresAt, params.now),
          ),
        ),
      )
      .orderBy(asc(invocationAttemptTable.nextDispatchAt))
      .limit(params.limit)
      .for("update", { skipLocked: true });

    if (candidates.length === 0) return [];

    const leaseExpiresAt = new Date(params.now.getTime() + params.leaseDurationMs);
    const claimed: InvocationAttempt[] = [];
    for (const candidate of candidates) {
      await tx
        .update(invocationAttemptTable)
        .set({
          dispatchLeaseOwner: params.leaseOwner,
          dispatchLeaseExpiresAt: leaseExpiresAt,
          updatedAt: params.now,
        })
        .where(eq(invocationAttemptTable.id, candidate.id));
      claimed.push({
        ...candidate,
        dispatchLeaseOwner: params.leaseOwner,
        dispatchLeaseExpiresAt: leaseExpiresAt,
      });
    }
    return claimed;
  });
}

/**
 * 记录一次 Attempt dispatch HTTP 发起（bump-at-start）：dispatchAttemptCount+1 +
 * lastDispatchAttemptAt（调用方在发起 HTTP 前调用；count 即本次是第几次 HTTP）。
 */
export async function recordAttemptDispatchAttemptStarted(params: {
  attemptId: string;
  now: Date;
}): Promise<InvocationAttempt> {
  await db
    .update(invocationAttemptTable)
    .set({
      dispatchAttemptCount: sql`${invocationAttemptTable.dispatchAttemptCount} + 1`,
      lastDispatchAttemptAt: params.now,
      updatedAt: params.now,
    })
    .where(eq(invocationAttemptTable.id, params.attemptId));
  const [row] = await db
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, params.attemptId))
    .limit(1);
  if (!row) {
    throw new Error(
      `recordAttemptDispatchAttemptStarted: InvocationAttempt 不存在（id=${params.attemptId}）`,
    );
  }
  return row;
}

/**
 * 领取 due 的 dispatched InvocationCommand。
 * 候选：commandState=dispatched AND（无 lease OR lease 已过期）AND (
 *   nextDispatchAt IS NOT NULL AND nextDispatchAt <= now   -- 正式 transient retry work
 *   OR dispatchLeaseExpiresAt IS NOT NULL AND dispatchLeaseExpiresAt <= now  -- dispatcher 崩溃接管
 * )。活跃 lease 始终阻断领取（即使 nextDispatchAt 已 due）。
 */
export async function claimDueInvocationCommands(params: {
  now: Date;
  leaseOwner: string;
  leaseDurationMs: number;
  limit: number;
}): Promise<InvocationCommand[]> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.commandState, "dispatched"),
          // 活跃 lease 始终阻断领取（即使 nextDispatchAt 已 due）
          or(
            isNull(invocationCommandTable.dispatchLeaseExpiresAt),
            lte(invocationCommandTable.dispatchLeaseExpiresAt, params.now),
          ),
          or(
            and(
              isNotNull(invocationCommandTable.nextDispatchAt),
              lte(invocationCommandTable.nextDispatchAt, params.now),
            ),
            and(
              isNotNull(invocationCommandTable.dispatchLeaseExpiresAt),
              lte(invocationCommandTable.dispatchLeaseExpiresAt, params.now),
            ),
          ),
        ),
      )
      .orderBy(asc(invocationCommandTable.nextDispatchAt))
      .limit(params.limit)
      .for("update", { skipLocked: true });

    if (candidates.length === 0) return [];

    const leaseExpiresAt = new Date(params.now.getTime() + params.leaseDurationMs);
    const claimed: InvocationCommand[] = [];
    for (const candidate of candidates) {
      await tx
        .update(invocationCommandTable)
        .set({
          dispatchLeaseOwner: params.leaseOwner,
          dispatchLeaseExpiresAt: leaseExpiresAt,
          updatedAt: params.now,
        })
        .where(eq(invocationCommandTable.id, candidate.id));
      claimed.push({
        ...candidate,
        dispatchLeaseOwner: params.leaseOwner,
        dispatchLeaseExpiresAt: leaseExpiresAt,
      });
    }
    return claimed;
  });
}

/** Attempt transient 失败记录结果。 */
export type AttemptTransientFailureOutcome =
  | {
      outcome: "scheduled";
      dispatchAttemptCount: number;
      nextDispatchAt: Date;
      attempt: InvocationAttempt;
    }
  | { outcome: "exhausted"; dispatchAttemptCount: number; attempt: InvocationAttempt };

/**
 * 记录一次 Attempt dispatch transient 失败：
 * - 未耗尽：dispatchAttemptCount+1、lastDispatchAttemptAt、lastTransientErrorCode、
 *   nextDispatchAt = now + backoff、清 lease（Attempt 保持 queued，等 Worker 领取）。
 * - 已耗尽（count >= maxDispatchAttempts）：Attempt → failed（errorCode=dispatch_retry_exhausted），
 *   清 lease/nextDispatchAt。Invocation/Turn 的正式失败收口由调用方（唯一 Recovery Authority）执行。
 *
 * 返回更新后的 Attempt 行。
 */
export async function recordAttemptDispatchTransientFailure(params: {
  attemptId: string;
  errorCode: TransientDispatchErrorCode;
  now: Date;
  /** 排定 retry 时若 Attempt.retryReasonCode 为空则写入（如 initial_dispatch_unavailable）。 */
  retryReasonCode?: string | null;
  /**
   * true = dispatchAttemptCount 已在本次 HTTP 发起时递增（dispatchQueuedInvocationAttempt
   * bump-at-start 语义）；false = 首次失败时在此递增（初始 dispatcher 语义）。
   */
  counted?: boolean;
}): Promise<AttemptTransientFailureOutcome> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.id, params.attemptId))
      .for("update")
      .limit(1);
    if (!current) {
      throw new Error(
        `recordAttemptDispatchTransientFailure: InvocationAttempt 不存在（id=${params.attemptId}）`,
      );
    }
    if (current.attemptState !== "queued") {
      throw new Error(
        `recordAttemptDispatchTransientFailure: Attempt 已非 queued（id=${params.attemptId}, state=${current.attemptState}）`,
      );
    }

    const count = params.counted ? current.dispatchAttemptCount : current.dispatchAttemptCount + 1;
    if (count < 1) {
      throw new Error(
        `recordAttemptDispatchTransientFailure: dispatchAttemptCount 非法（id=${params.attemptId}, count=${count}）`,
      );
    }
    if (isRetryExhausted(count)) {
      await tx
        .update(invocationAttemptTable)
        .set({
          attemptState: "failed",
          finishedAt: params.now,
          errorCode: "dispatch_retry_exhausted",
          errorSummary: `Dispatch retry exhausted after ${count} attempts`,
          dispatchAttemptCount: count,
          lastDispatchAttemptAt: params.now,
          lastTransientErrorCode: params.errorCode,
          nextDispatchAt: null,
          dispatchLeaseOwner: null,
          dispatchLeaseExpiresAt: null,
          updatedAt: params.now,
        })
        .where(eq(invocationAttemptTable.id, params.attemptId));
      const [row] = await tx
        .select()
        .from(invocationAttemptTable)
        .where(eq(invocationAttemptTable.id, params.attemptId))
        .limit(1);
      return {
        outcome: "exhausted" as const,
        dispatchAttemptCount: count,
        attempt: row ?? current,
      };
    }

    const nextDispatchAt = new Date(params.now.getTime() + backoffDelayMs(count));
    await tx
      .update(invocationAttemptTable)
      .set({
        dispatchAttemptCount: count,
        lastDispatchAttemptAt: params.now,
        lastTransientErrorCode: params.errorCode,
        nextDispatchAt,
        ...(current.retryReasonCode === null && params.retryReasonCode
          ? { retryReasonCode: params.retryReasonCode }
          : {}),
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        updatedAt: params.now,
      })
      .where(eq(invocationAttemptTable.id, params.attemptId));
    const [row] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.id, params.attemptId))
      .limit(1);
    return {
      outcome: "scheduled" as const,
      dispatchAttemptCount: count,
      nextDispatchAt,
      attempt: row ?? current,
    };
  });
}

/** Command transient retry 调度结果。 */
export type CommandTransientRetryOutcome =
  | {
      outcome: "scheduled";
      dispatchAttemptCount: number;
      nextDispatchAt: Date;
      command: InvocationCommand;
    }
  | { outcome: "exhausted"; dispatchAttemptCount: number; command: InvocationCommand };

/**
 * 记录一次 Command dispatch transient 失败：
 * - 状态保持 dispatched（不新增 retry_wait 状态）。
 * - 未耗尽：nextDispatchAt = now + backoff、清 lease、lastTransientErrorCode。
 * - 已耗尽：commandState=failed、errorCode=retry_exhausted、清 lease/nextDispatchAt。
 */
export async function scheduleCommandTransientRetry(params: {
  commandId: string;
  errorCode: TransientDispatchErrorCode;
  now: Date;
}): Promise<CommandTransientRetryOutcome> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, params.commandId))
      .for("update")
      .limit(1);
    if (!current) {
      throw new Error(
        `scheduleCommandTransientRetry: InvocationCommand 不存在（id=${params.commandId}）`,
      );
    }
    if (current.commandState !== "dispatched") {
      throw new Error(
        `scheduleCommandTransientRetry: Command 已非 dispatched（id=${params.commandId}, state=${current.commandState}）`,
      );
    }

    // dispatchAttemptCount 已在 HTTP 发起时递增（CAS 置 1 / worker retry bump），
    // 此处只根据已发起次数排 backoff 或判耗尽。
    const count = current.dispatchAttemptCount;
    if (isRetryExhausted(count)) {
      await tx
        .update(invocationCommandTable)
        .set({
          commandState: "failed",
          failedAt: params.now,
          errorCode: "retry_exhausted",
          errorMessage: `Dispatch retry exhausted after ${count} attempts`,
          dispatchAttemptCount: count,
          lastDispatchAttemptAt: params.now,
          lastTransientErrorCode: params.errorCode,
          nextDispatchAt: null,
          dispatchLeaseOwner: null,
          dispatchLeaseExpiresAt: null,
          updatedAt: params.now,
        })
        .where(eq(invocationCommandTable.id, params.commandId));
    } else {
      const nextDispatchAt = new Date(params.now.getTime() + backoffDelayMs(count));
      await tx
        .update(invocationCommandTable)
        .set({
          dispatchAttemptCount: count,
          lastDispatchAttemptAt: params.now,
          lastTransientErrorCode: params.errorCode,
          nextDispatchAt,
          dispatchLeaseOwner: null,
          dispatchLeaseExpiresAt: null,
          updatedAt: params.now,
        })
        .where(eq(invocationCommandTable.id, params.commandId));
    }

    const [row] = await tx
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, params.commandId))
      .limit(1);
    if (!row) {
      throw new Error(
        `scheduleCommandTransientRetry: InvocationCommand 行未找到（id=${params.commandId}）`,
      );
    }
    const nextDispatchAt =
      row.nextDispatchAt ?? new Date(params.now.getTime() + backoffDelayMs(count));
    return row.commandState === "failed"
      ? { outcome: "exhausted" as const, dispatchAttemptCount: count, command: row }
      : {
          outcome: "scheduled" as const,
          dispatchAttemptCount: count,
          nextDispatchAt,
          command: row,
        };
  });
}

/**
 * 记录一次 Command retry HTTP 发起（bump-at-start，Worker retry lane 专用）：
 * dispatchAttemptCount+1 + lastDispatchAttemptAt。
 */
export async function recordCommandRetryAttemptStarted(params: {
  commandId: string;
  now: Date;
}): Promise<void> {
  await db
    .update(invocationCommandTable)
    .set({
      dispatchAttemptCount: sql`${invocationCommandTable.dispatchAttemptCount} + 1`,
      lastDispatchAttemptAt: params.now,
      updatedAt: params.now,
    })
    .where(eq(invocationCommandTable.id, params.commandId));
}

/**
 * Command 首次 CAS queued → dispatched 时同步登记 dispatch 计数与 lease。
 * CAS 成功才写入；返回是否成功。
 */
export async function transitionCommandToDispatchedWithLease(params: {
  commandId: string;
  leaseOwner: string;
  now: Date;
  leaseDurationMs: number;
  runtimeExecutionRef?: string | null;
}): Promise<boolean> {
  const leaseExpiresAt = new Date(params.now.getTime() + params.leaseDurationMs);
  const result = await db
    .update(invocationCommandTable)
    .set({
      commandState: "dispatched",
      dispatchedAt: params.now,
      runtimeExecutionRef: params.runtimeExecutionRef ?? null,
      dispatchAttemptCount: 1,
      lastDispatchAttemptAt: params.now,
      dispatchLeaseOwner: params.leaseOwner,
      dispatchLeaseExpiresAt: leaseExpiresAt,
      nextDispatchAt: null,
      updatedAt: params.now,
    })
    .where(
      and(
        eq(invocationCommandTable.id, params.commandId),
        eq(invocationCommandTable.commandState, "queued"),
      ),
    );
  return result[0].affectedRows > 0;
}

/** 终态统一清理：acknowledged/failed 时清 lease 与 nextDispatchAt（error code 保留诊断）。 */
export async function clearCommandDispatchLease(params: {
  commandId: string;
  now: Date;
}): Promise<void> {
  await db
    .update(invocationCommandTable)
    .set({
      dispatchLeaseOwner: null,
      dispatchLeaseExpiresAt: null,
      nextDispatchAt: null,
      updatedAt: params.now,
    })
    .where(
      and(
        eq(invocationCommandTable.id, params.commandId),
        sql`${invocationCommandTable.commandState} IN ('acknowledged','failed')`,
      ),
    );
}

/** 导出事务句柄类型。 */
export type { Tx };
