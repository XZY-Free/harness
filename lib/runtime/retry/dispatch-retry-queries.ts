/** Durable dispatch retry state.
 *
 * Attempt preparation is an execution fact. Dispatch retry state belongs to
 * RuntimeSessionBinding (the stable start/resume intent), while control
 * command retry state belongs to InvocationCommand.
 *
 * R04 §5：**领取的工作身份是 Session**（不是一个 Attempt ID）。一个 Attempt 可以有多个
 * Resume generation，因此
 * - 扫描只取候选 ID（不加锁、不 join 锁 Session/Attempt）；
 * - 领取时按对象自身根重新验证 due / state / lease，并锁定 Session 行；
 * - 所有完成确认（计数、失败排定、attempt 置终态）都带 **Session + Ownership +
 *   claim token** 条件，过期 Worker 不能改新 claim 的结果。
 */
import { db } from "@/lib/db/client";
import {
  getAuthorityDatabaseTime,
  lockInvocationRootIfExists,
} from "@/lib/executions/persistence/execution-ownership-store";
import type { InvocationAttempt, InvocationCommand } from "@/lib/persistence/schema/executions";
import {
  executionOwnershipTable,
  invocationAttemptTable,
  invocationCommandTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import {
  claimRuntimeSessionDispatchInTransaction,
  recordRuntimeSessionDispatchInTransaction,
  rescheduleRuntimeSessionDispatchInTransaction,
} from "@/lib/runtime/persistence/runtime-session-store";
import {
  type TransientDispatchErrorCode,
  backoffDelayMs,
  isRetryExhausted,
} from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 领取身份与持久行不一致（新 claim 已接管，或代际已变化）。 */
export class SessionDispatchClaimSupersededError extends Error {
  readonly stableCode = "SessionDispatchClaimSuperseded";
  constructor(message: string) {
    super(message);
    this.name = "SessionDispatchClaimSuperseded";
  }
}

/** 可以承载 dispatch 工作的 Session 状态（`active` 已由 Runtime 接纳，不再由本 lane 重投）。 */
const DISPATCHABLE_SESSION_STATES = ["prepared", "dispatching"] as const;

/**
 * "已持久但进程在写完 retry timestamp 前 Crash"的安全截止时间（R01 §3）。
 *
 * `nextDispatchAt IS NULL` 的 Session / `commandState='queued'` 的 InvocationCommand
 * 不能在创建/ACK 的同一瞬间被本 lane 抢走（那会和请求内联调度竞争），
 * 但也不能永久不可见：静默超过该窗口即视为到期。两类对象共用同一规则。
 */
export const DISPATCH_STUCK_GRACE_MS = 30_000;

/** 一次 Session dispatch 工作的稳定身份（扫描 → 领取 → 完成全程携带）。 */
export interface SessionDispatchIdentity {
  tenantId: string;
  sessionBindingId: string;
  attemptId: string;
  ownershipId: string;
  leaseEpoch: number | bigint;
  /**
   * 领取令牌（= `dispatchLeaseOwner`）。
   * 请求内联调度（从未领取 lease）时为 `null`，此时只按 Session 自身冻结的 tuple 复核。
   */
  claimToken: string | null;
}

/** 已领取的 dispatch 工作（`claimToken` 必为真实令牌）。 */
export interface SessionDispatchClaim extends SessionDispatchIdentity {
  invocationId: string;
  claimToken: string;
  leaseExpiresAt: Date;
  dispatchCount: number;
}

/** 扫描结果只有 ID（R04 §5：扫描不做任何写入或加锁判断）。 */
export interface SessionDispatchCandidate {
  sessionBindingId: string;
  attemptId: string;
}

/**
 * 扫描到期 dispatch 工作：只取候选 ID。
 *
 * 谓词是**廉价过滤**，不是结论：
 * - Attempt 必须仍 `queued`（工作对象自身状态）；
 * - Session 必须处于可调度状态；
 * - `nextDispatchAt` 到期，或（NULL 且已静默超过安全窗口）；
 * - 没有他人持有的有效 dispatch lease。
 * 领取事务会按 Session 自身根重新验证全部条件。
 */
export async function scanDueSessionDispatches(params: {
  now: Date;
  limit: number;
}): Promise<SessionDispatchCandidate[]> {
  const stuckBefore = new Date(params.now.getTime() - DISPATCH_STUCK_GRACE_MS);
  return db
    .select({
      sessionBindingId: runtimeSessionBindingTable.id,
      attemptId: runtimeSessionBindingTable.attemptId,
    })
    .from(runtimeSessionBindingTable)
    .innerJoin(
      invocationAttemptTable,
      eq(invocationAttemptTable.id, runtimeSessionBindingTable.attemptId),
    )
    .where(
      and(
        eq(invocationAttemptTable.attemptState, "queued"),
        inArray(runtimeSessionBindingTable.bindingState, [...DISPATCHABLE_SESSION_STATES]),
        or(
          and(
            isNotNull(runtimeSessionBindingTable.nextDispatchAt),
            lte(runtimeSessionBindingTable.nextDispatchAt, params.now),
          ),
          and(
            isNull(runtimeSessionBindingTable.nextDispatchAt),
            lte(runtimeSessionBindingTable.updatedAt, stuckBefore),
          ),
        ),
        or(
          isNull(runtimeSessionBindingTable.dispatchLeaseExpiresAt),
          lte(runtimeSessionBindingTable.dispatchLeaseExpiresAt, params.now),
        ),
      ),
    )
    .orderBy(
      asc(runtimeSessionBindingTable.nextDispatchAt),
      asc(runtimeSessionBindingTable.updatedAt),
    )
    .limit(params.limit);
}

/**
 * 领取一条 dispatch 工作（锁定 Session 行后重新验证）。
 *
 * 重新验证项：tenant / Session 自身 tuple（Attempt、Ownership、leaseEpoch）、
 * 可调度状态、due、无有效 lease，并且 Attempt 仍然 `queued`。
 * 任一不满足 → 返回 `null`（放弃该候选，不改任何行）。
 */
export async function claimSessionDispatch(params: {
  sessionBindingId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  now: Date;
  /** 扫描候选里的 Attempt，仅用于避免无谓的锁竞争；结论以行内状态为准。 */
  attemptId?: string;
}): Promise<SessionDispatchClaim | null> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(runtimeSessionBindingTable)
      .where(eq(runtimeSessionBindingTable.id, params.sessionBindingId))
      .for("update")
      .limit(1);
    if (!session) return null;
    if (params.attemptId && session.attemptId !== params.attemptId) return null;
    if (
      !DISPATCHABLE_SESSION_STATES.includes(
        session.bindingState as (typeof DISPATCHABLE_SESSION_STATES)[number],
      )
    ) {
      return null;
    }
    const due =
      session.nextDispatchAt !== null
        ? session.nextDispatchAt <= params.now
        : session.updatedAt <= new Date(params.now.getTime() - DISPATCH_STUCK_GRACE_MS);
    if (!due) return null;
    if (session.dispatchLeaseExpiresAt && session.dispatchLeaseExpiresAt > params.now) return null;
    const [attempt] = await tx
      .select({ attemptState: invocationAttemptTable.attemptState })
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.id, session.attemptId))
      .limit(1);
    if (!attempt || attempt.attemptState !== "queued") return null;
    // Session 的派发领取不能先于失权恢复 lane 把过期 Owner 的旧 Attempt 推成失败。
    // 尤其 activating 阶段还没有发出用户请求，正式恢复需要用新 Attempt 接管。
    const [owner] = await tx
      .select({
        state: executionOwnershipTable.ownershipState,
        expiresAt: executionOwnershipTable.leaseExpiresAt,
      })
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.id, session.ownershipId))
      .limit(1);
    if (
      !owner ||
      owner.state !== "active" ||
      owner.expiresAt <= (await getAuthorityDatabaseTime(tx))
    )
      return null;
    const leaseExpiresAt = new Date(params.now.getTime() + params.leaseDurationMs);
    // R02 §8：Session 写入只经仓储方法（行锁 + 版本 CAS）。
    await claimRuntimeSessionDispatchInTransaction(tx, {
      tenantId: session.tenantId,
      id: session.id,
      expectedVersionNo: session.versionNo,
      leaseOwner: params.leaseOwner,
      leaseExpiresAt,
    });
    return {
      tenantId: session.tenantId,
      sessionBindingId: session.id,
      attemptId: session.attemptId,
      ownershipId: session.ownershipId,
      leaseEpoch: session.leaseEpoch,
      claimToken: params.leaseOwner,
      invocationId: session.invocationId,
      leaseExpiresAt,
      dispatchCount: session.dispatchCount,
    };
  });
}

/** 读取 attempt 关联的最近一个 Session generation 的稳定身份（用于请求内联路径）。 */
export async function sessionDispatchIdentityForAttempt(input: {
  tenantId: string;
  attemptId: string;
}): Promise<SessionDispatchIdentity | null> {
  const [session] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, input.tenantId),
        eq(runtimeSessionBindingTable.attemptId, input.attemptId),
        inArray(runtimeSessionBindingTable.bindingState, [...DISPATCHABLE_SESSION_STATES]),
      ),
    )
    .orderBy(asc(runtimeSessionBindingTable.createdAt))
    .limit(1);
  if (!session) return null;
  return {
    tenantId: session.tenantId,
    sessionBindingId: session.id,
    attemptId: session.attemptId,
    ownershipId: session.ownershipId,
    leaseEpoch: session.leaseEpoch,
    claimToken: null,
  };
}

/**
 * 按 claim 身份锁定 Session 并复核（R04 §5）。
 *
 * 这是所有完成确认的唯一入口：`DispatchLeaseOwner` 必须等于本次 claim 的令牌，
 * 且 Ownership / leaseEpoch / Attempt 全部一致。过期 Worker 因此不可能改到新 claim 的结果。
 * 导出版本供需要与 Session 写入同事务的调用方（`runtime-start` 的 Start 冻结）复用。
 */
export async function lockClaimedSessionInTransaction(
  tx: Tx,
  identity: SessionDispatchIdentity,
  options?: { allowUnclaimedRead?: boolean },
): Promise<typeof runtimeSessionBindingTable.$inferSelect> {
  const [session] = await tx
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, identity.tenantId),
        eq(runtimeSessionBindingTable.id, identity.sessionBindingId),
      ),
    )
    .for("update")
    .limit(1);
  if (!session) throw new SessionDispatchClaimSupersededError("RuntimeSessionBinding 不存在");
  if (
    session.attemptId !== identity.attemptId ||
    session.ownershipId !== identity.ownershipId ||
    session.leaseEpoch !== identity.leaseEpoch
  ) {
    throw new SessionDispatchClaimSupersededError("Session dispatch 身份代际已变化");
  }
  if (identity.claimToken === null) {
    if (options?.allowUnclaimedRead === true) return session;
    throw new SessionDispatchClaimSupersededError("Session dispatch 缺少领取身份");
  }
  if (session.dispatchLeaseOwner !== identity.claimToken) {
    throw new SessionDispatchClaimSupersededError("Session dispatch claim 已被接管");
  }
  const now = await getAuthorityDatabaseTime(tx);
  if (!session.dispatchLeaseExpiresAt || session.dispatchLeaseExpiresAt <= now) {
    throw new SessionDispatchClaimSupersededError("Session dispatch claim 已过期");
  }
  return session;
}

/**
 * 只读复核：本次 claim 是否仍被该 Session 持有（R04 §5 完成确认门禁）。
 *
 * 用于"完成/失败确认"这类发生在事务之外的写之前：过期 Worker 的迟到结论必须被拒。
 */
export async function assertSessionDispatchClaimHeld(
  identity: SessionDispatchIdentity,
): Promise<void> {
  const [session] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, identity.tenantId),
        eq(runtimeSessionBindingTable.id, identity.sessionBindingId),
      ),
    )
    .limit(1);
  if (!session) throw new SessionDispatchClaimSupersededError("RuntimeSessionBinding 不存在");
  if (
    session.attemptId !== identity.attemptId ||
    session.ownershipId !== identity.ownershipId ||
    session.leaseEpoch !== identity.leaseEpoch
  ) {
    throw new SessionDispatchClaimSupersededError("Session dispatch 身份代际已变化");
  }
  if (identity.claimToken === null || session.dispatchLeaseOwner !== identity.claimToken) {
    throw new SessionDispatchClaimSupersededError("Session dispatch claim 已被接管");
  }
  const now = await getAuthorityDatabaseTime(db);
  if (!session.dispatchLeaseExpiresAt || session.dispatchLeaseExpiresAt <= now) {
    throw new SessionDispatchClaimSupersededError("Session dispatch claim 已过期");
  }
}

/**
 * Count a dispatch attempt on the stable session intent before transport.
 *
 * R02 §8：Session 计数走仓储方法（行锁 + 版本 CAS）；本函数是薄包装，
 * 需要与其它 Session 写入合并到一个事务的调用方用 `...InTransaction`。
 */
export async function recordSessionDispatchAttemptStartedInTransaction(
  tx: Tx,
  identity: SessionDispatchIdentity,
  now: Date,
): Promise<{
  attempt: InvocationAttempt;
  session: typeof runtimeSessionBindingTable.$inferSelect;
}> {
  const [attempt] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, identity.tenantId),
        eq(invocationAttemptTable.id, identity.attemptId),
      ),
    )
    .for("update")
    .limit(1);
  if (!attempt) throw new Error(`InvocationAttempt 不存在（id=${identity.attemptId}）`);
  const [ownership] = await tx
    .select({ id: executionOwnershipTable.id })
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, identity.tenantId),
        eq(executionOwnershipTable.id, identity.ownershipId),
        eq(executionOwnershipTable.attemptId, identity.attemptId),
        eq(executionOwnershipTable.leaseEpoch, BigInt(identity.leaseEpoch)),
      ),
    )
    .for("update")
    .limit(1);
  if (!ownership) throw new SessionDispatchClaimSupersededError("ExecutionOwnership 已变化");
  const session = await lockClaimedSessionInTransaction(tx, identity);
  const updated = await recordRuntimeSessionDispatchInTransaction(tx, {
    tenantId: session.tenantId,
    id: session.id,
    expectedVersionNo: session.versionNo,
    now,
  });
  return { attempt, session: updated };
}

export async function recordSessionDispatchAttemptStarted(
  identity: SessionDispatchIdentity,
  now: Date,
): Promise<InvocationAttempt> {
  const [locator] = await db
    .select({ invocationId: invocationAttemptTable.invocationId })
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, identity.tenantId),
        eq(invocationAttemptTable.id, identity.attemptId),
      ),
    )
    .limit(1);
  if (!locator) throw new Error(`InvocationAttempt 不存在（id=${identity.attemptId}）`);
  const result = await db.transaction(async (tx) => {
    if (!(await lockInvocationRootIfExists(tx, identity.tenantId, locator.invocationId))) {
      throw new Error(`Invocation 不存在（id=${locator.invocationId}）`);
    }
    return recordSessionDispatchAttemptStartedInTransaction(tx, identity, now);
  });
  return result.attempt;
}

/** 已领取的 Command dispatch 工作（带 claim 身份）。 */
export interface CommandDispatchClaim {
  tenantId: string;
  command: InvocationCommand;
  claimToken: string;
  leaseExpiresAt: Date;
}

/** 扫描到期 Command dispatch：只取候选 ID（R04 §5）。 */
export async function scanDueInvocationCommandDispatches(params: {
  now: Date;
  limit: number;
}): Promise<string[]> {
  const stuckBefore = new Date(params.now.getTime() - DISPATCH_STUCK_GRACE_MS);
  const rows = await db
    .select({ id: invocationCommandTable.id })
    .from(invocationCommandTable)
    .where(
      or(
        // 已进入交付状态：租约空缺/过期，且已到 nextDispatchAt（缺失时按 updatedAt 兜底）。
        and(
          eq(invocationCommandTable.commandState, "dispatched"),
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
              isNull(invocationCommandTable.nextDispatchAt),
              lte(invocationCommandTable.updatedAt, params.now),
            ),
          ),
        ),
        // 已持久但**首次交付从未发生**（进程在请求内联派发前 Crash）：`queued` 不能
        // 永久不可见——静默超过安全窗口即视为到期，否则用户的停止/引导命令会被静默丢弃。
        and(
          eq(invocationCommandTable.commandState, "queued"),
          lte(invocationCommandTable.updatedAt, stuckBefore),
        ),
      ),
    )
    .orderBy(asc(invocationCommandTable.nextDispatchAt), asc(invocationCommandTable.updatedAt))
    .limit(params.limit);
  return rows.map((row) => row.id);
}

/**
 * 领取一条 Command dispatch（锁行后按对象自身根重新验证 state/lease/due）。
 *
 * 见 `scanDueInvocationCommandDispatches`：`queued`（首次交付从未发生）与
 * `dispatched`（交付已发起）都可由本 lane 领取；领取即进入 `dispatched`，
 * 使后续 `markDispatched` / 收口语义与既有路径完全一致。
 */
export async function claimInvocationCommandDispatch(params: {
  commandId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  now: Date;
  /**
   * A09：请求内联投递对**刚由本请求创建**的 `queued` 命令允许立即领取。
   *
   * 后台 lane 走 30s 静默窗口（避免与创建请求竞争），内联请求本身就是创建者，
   * 不存在"另一个进程正在写"的窗口；两侧仍使用**同一个**领取事务与同一套 claim 语义，
   * 差别只在触发资格。
   */
  allowImmediateQueued?: boolean;
}): Promise<CommandDispatchClaim | null> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, params.commandId))
      .for("update")
      .limit(1);
    if (!candidate) return null;
    if (candidate.commandState !== "queued" && candidate.commandState !== "dispatched") return null;
    if (candidate.dispatchLeaseExpiresAt && candidate.dispatchLeaseExpiresAt > params.now) {
      return null;
    }
    const due =
      candidate.commandState === "queued"
        ? params.allowImmediateQueued === true ||
          candidate.updatedAt <= new Date(params.now.getTime() - DISPATCH_STUCK_GRACE_MS)
        : candidate.nextDispatchAt !== null
          ? candidate.nextDispatchAt <= params.now
          : candidate.updatedAt <= params.now;
    if (!due) return null;
    const leaseExpiresAt = new Date(params.now.getTime() + params.leaseDurationMs);
    await tx
      .update(invocationCommandTable)
      .set({
        commandState: "dispatched",
        dispatchLeaseOwner: params.leaseOwner,
        dispatchLeaseExpiresAt: leaseExpiresAt,
        updatedAt: params.now,
        versionNo: candidate.versionNo + 1,
      })
      .where(eq(invocationCommandTable.id, candidate.id));
    return {
      tenantId: candidate.tenantId,
      command: {
        ...candidate,
        commandState: "dispatched",
        dispatchLeaseOwner: params.leaseOwner,
        dispatchLeaseExpiresAt: leaseExpiresAt,
      },
      claimToken: params.leaseOwner,
      leaseExpiresAt,
    };
  });
}

export type AttemptTransientFailureOutcome =
  | {
      outcome: "scheduled";
      dispatchCount: number;
      nextDispatchAt: Date;
      attempt: InvocationAttempt;
    }
  | {
      outcome: "exhausted";
      dispatchCount: number;
      attempt: InvocationAttempt;
      observedOwner: {
        ownershipId: string;
        attemptId: string;
        leaseEpoch: number | bigint;
        leaseExpiresAt: Date;
        lastHeartbeatAt: Date;
      };
    };

/**
 * 记录一次暂态 dispatch 失败并排定 durable retry（R04 §5：**必须**带 claim 身份）。
 *
 * 计数与排定都按 Session + Ownership + claim token 条件执行；Attempt 的状态写入也
 * 限定在本次 claim 的 Attempt 上，过期 Worker 的迟到失败不会污染新代际。
 */
export async function recordAttemptDispatchTransientFailure(
  identity: SessionDispatchIdentity,
  params: {
    errorCode: TransientDispatchErrorCode;
    now: Date;
    retryReasonCode?: string | null;
    counted?: boolean;
    /** Resume Command 只排定 Session/Command 重投，不得把 suspended Attempt 当 queued 派发失败收口。 */
    updateAttempt?: boolean;
  },
): Promise<AttemptTransientFailureOutcome> {
  // 非锁定预读只用于定位执行根；事务内仍会在取得 Invocation 根锁后重新验证 Attempt。
  // 不能从 Session 开始加锁，否则会与 Start 的 I → A → O → S 顺序形成真实死锁环。
  const [attemptLocator] = await db
    .select({ invocationId: invocationAttemptTable.invocationId })
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, identity.tenantId),
        eq(invocationAttemptTable.id, identity.attemptId),
      ),
    )
    .limit(1);
  if (!attemptLocator) throw new Error(`InvocationAttempt 不存在（id=${identity.attemptId}）`);

  return db.transaction(async (tx) => {
    const invocation = await lockInvocationRootIfExists(
      tx,
      identity.tenantId,
      attemptLocator.invocationId,
    );
    if (!invocation) throw new Error(`Invocation 不存在（id=${attemptLocator.invocationId}）`);
    const [currentAttempt] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, identity.tenantId),
          eq(invocationAttemptTable.id, identity.attemptId),
        ),
      )
      .for("update")
      .limit(1);
    if (!currentAttempt) throw new Error(`InvocationAttempt 不存在（id=${identity.attemptId}）`);
    if (currentAttempt.invocationId !== invocation.id) {
      throw new SessionDispatchClaimSupersededError("Attempt 已不属于预读定位的 Invocation");
    }
    const updateAttempt = params.updateAttempt ?? true;
    if (updateAttempt && currentAttempt.attemptState !== "queued") {
      throw new SessionDispatchClaimSupersededError(
        `Attempt 已非 queued（id=${identity.attemptId}）`,
      );
    }
    const [ownership] = await tx
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, identity.tenantId),
          eq(executionOwnershipTable.id, identity.ownershipId),
          eq(executionOwnershipTable.attemptId, identity.attemptId),
          eq(executionOwnershipTable.leaseEpoch, BigInt(identity.leaseEpoch)),
        ),
      )
      .for("update")
      .limit(1);
    if (!ownership) throw new SessionDispatchClaimSupersededError("ExecutionOwnership 已变化");
    const session = await lockClaimedSessionInTransaction(tx, identity);
    const dispatchCount = params.counted ? session.dispatchCount : session.dispatchCount + 1;
    const exhausted = isRetryExhausted(dispatchCount);
    const nextDispatchAt = exhausted
      ? null
      : new Date(params.now.getTime() + backoffDelayMs(dispatchCount));
    // R02 §8：Session 写入只经仓储方法（行锁 + 版本 CAS）。
    await rescheduleRuntimeSessionDispatchInTransaction(tx, {
      tenantId: session.tenantId,
      id: session.id,
      expectedVersionNo: session.versionNo,
      dispatchCount,
      nextDispatchAt,
      lastErrorCode: params.errorCode,
    });
    if (updateAttempt && exhausted) {
      await tx
        .update(invocationAttemptTable)
        .set({
          attemptState: "failed",
          finishedAt: params.now,
          errorCode: "dispatch_retry_exhausted",
          errorSummary: `Dispatch retry exhausted after ${dispatchCount} attempts`,
          retryReasonCode: currentAttempt.retryReasonCode ?? params.retryReasonCode ?? null,
          updatedAt: params.now,
          versionNo: currentAttempt.versionNo + 1,
        })
        .where(eq(invocationAttemptTable.id, identity.attemptId));
    } else if (updateAttempt && currentAttempt.retryReasonCode === null && params.retryReasonCode) {
      await tx
        .update(invocationAttemptTable)
        .set({ retryReasonCode: params.retryReasonCode, updatedAt: params.now })
        .where(eq(invocationAttemptTable.id, identity.attemptId));
    }
    const [attempt] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.id, identity.attemptId))
      .limit(1);
    if (!attempt) throw new Error(`InvocationAttempt 更新后回查失败（id=${identity.attemptId}）`);
    return exhausted
      ? {
          outcome: "exhausted" as const,
          dispatchCount,
          attempt,
          observedOwner: {
            ownershipId: ownership.id,
            attemptId: ownership.attemptId,
            leaseEpoch: ownership.leaseEpoch,
            leaseExpiresAt: ownership.leaseExpiresAt,
            lastHeartbeatAt: ownership.lastHeartbeatAt,
          },
        }
      : {
          outcome: "scheduled" as const,
          dispatchCount,
          nextDispatchAt: nextDispatchAt as Date,
          attempt,
        };
  });
}

export type CommandTransientRetryOutcome =
  | {
      outcome: "scheduled";
      dispatchCount: number;
      nextDispatchAt: Date;
      command: InvocationCommand;
    }
  | { outcome: "exhausted"; dispatchCount: number; command: InvocationCommand };

/**
 * 排定一次 Command 暂态重试（R04 §5：带 claim 身份）。
 *
 * A09：`claimToken` **必填**，必须等于本行 `dispatchLeaseOwner` 且该领取仍未过期，
 * 否则拒绝（过期 Worker 的迟到结论不能改新 claim 的结果，内联路径同样先正式领取）。
 */
export async function scheduleCommandTransientRetry(
  identity: { tenantId: string; commandId: string; claimToken: string },
  params: {
    errorCode: TransientDispatchErrorCode;
    now: Date;
  },
): Promise<CommandTransientRetryOutcome> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, identity.tenantId),
          eq(invocationCommandTable.id, identity.commandId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) throw new Error(`InvocationCommand 不存在（id=${identity.commandId}）`);
    if (current.commandState !== "dispatched")
      throw new Error(`Command 已非 dispatched（id=${identity.commandId}）`);
    // A09：领取凭证是**必需**的，且必须仍是当前未过期的那一次领取。
    // 过期 claim 即使尚未被别人领走也不能提交新结论（否则"过期即免检"又是一条旁路）。
    if (current.dispatchLeaseOwner !== identity.claimToken) {
      throw new SessionDispatchClaimSupersededError("Command dispatch claim 已被接管");
    }
    if (!current.dispatchLeaseExpiresAt || current.dispatchLeaseExpiresAt <= params.now) {
      throw new SessionDispatchClaimSupersededError("Command dispatch claim 已过期");
    }
    const exhausted = isRetryExhausted(current.dispatchCount);
    const nextDispatchAt = exhausted
      ? null
      : new Date(params.now.getTime() + backoffDelayMs(current.dispatchCount));
    await tx
      .update(invocationCommandTable)
      .set({
        commandState: exhausted ? "failed" : "dispatched",
        completedAt: exhausted ? params.now : null,
        lastErrorCode: params.errorCode,
        nextDispatchAt,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        updatedAt: params.now,
        versionNo: current.versionNo + 1,
      })
      .where(eq(invocationCommandTable.id, identity.commandId));
    const [command] = await tx
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, identity.commandId))
      .limit(1);
    if (!command) throw new Error(`InvocationCommand 更新后回查失败（id=${identity.commandId}）`);
    return exhausted
      ? { outcome: "exhausted" as const, dispatchCount: command.dispatchCount, command }
      : {
          outcome: "scheduled" as const,
          dispatchCount: command.dispatchCount,
          nextDispatchAt: nextDispatchAt as Date,
          command,
        };
  });
}

/**
 * R03 §6：冻结目标失效的**终态收口**。
 *
 * 目标失效（`target_superseded`）是稳定可判定结果——既不重定向新 Owner，也不该重试，
 * 因此必须落到终态。否则同一事实会留下两种未收口残留：
 * - `queued` 行：没有扫描者（本 lane 只扫 `dispatched`），永不交付也永不结束；
 * - `dispatched` 行：每次 30s 租约到期都被重新领取，形成永不排空的 durable work。
 *
 * 幂等：已在终态（`acknowledged`/`failed`）直接返回不改写；
 * A09：`claimToken` 为**必填**且必须仍是当前未过期的那一次领取；过期 Worker 的迟到结论
 * 不会覆盖被接管后的结论（R04 §5），也不能在被接管/过期后替新持有者写终态。
 */
export type SupersededCommandSettlement =
  | { settled: true }
  | { settled: false; reason: "not_found" | "already_terminal" | "claim_taken_over" };

export async function settleSupersededInvocationCommand(
  identity: {
    tenantId: string;
    commandId: string;
    claimToken: string;
  },
  now: Date = new Date(),
): Promise<SupersededCommandSettlement> {
  const claimToken = identity.claimToken;
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, identity.tenantId),
          eq(invocationCommandTable.id, identity.commandId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) return { settled: false as const, reason: "not_found" as const };
    if (current.commandState === "acknowledged" || current.commandState === "failed") {
      return { settled: false as const, reason: "already_terminal" as const };
    }
    if (current.dispatchLeaseOwner !== claimToken) {
      return { settled: false as const, reason: "claim_taken_over" as const };
    }
    if (!current.dispatchLeaseExpiresAt || current.dispatchLeaseExpiresAt <= now) {
      return { settled: false as const, reason: "claim_taken_over" as const };
    }
    await tx
      .update(invocationCommandTable)
      .set({
        commandState: "failed",
        lastErrorCode: "CommandTargetSuperseded",
        receiptJson: { code: "CommandTargetSuperseded" },
        completedAt: now,
        nextDispatchAt: null,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        updatedAt: now,
        versionNo: current.versionNo + 1,
      })
      .where(eq(invocationCommandTable.id, identity.commandId));
    return { settled: true as const };
  });
}

export type { Tx };
