import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { scheduleEnvironmentLeaseCleanup } from "@/lib/environment/environment-lease-store";
import { transitionInvocation } from "@/lib/executions/application/transition-invocation";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import type { ThreadEvent, ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import {
  type InvocationExecutionState,
  type RuntimeSessionBinding,
  executionOwnershipTable,
  invocationTable,
  runtimeEventIngressTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { InvocationAlreadyTerminalError, InvocationNotFoundError } from "@/lib/runtime/errors";
import { markSessionBindingLostInSession } from "@/lib/runtime/recovery-queries";
/** Durable recovery of an Invocation whose current ExecutionOwnership expired. */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const recoverableStates: readonly InvocationExecutionState[] = [
  "queued",
  "running",
  "waiting_user",
];
const terminalTurnStates = new Set(["completed", "failed", "cancelled", "interrupted"]);

export interface FindStaleInvocationsParams {
  /** 省略 = 全租户扫描（常驻 authority recovery lane）；给出时限定单一租户。 */
  tenantId?: string;
  now?: Date;
  limit?: number;
}

export interface StaleInvocationSummary {
  invocationId: string;
  tenantId: string;
  threadId: string | null;
  turnId: string | null;
  jobId: string | null;
  executionState: InvocationExecutionState;
  lastHeartbeatAt: Date | null;
  ownershipId: string | null;
  sessionBindingId: string | null;
  /**
   * R03 §5：扫描必须把**观察到的完整 Owner tuple** 交给收口路径
   * （`markInvocationLost` 会带着它在根锁内复核；陈旧观察只丢弃）。
   */
  observedOwner: ObservedOwnerTuple | null;
}

/**
 * 发现「Current Owner 租约已到期」的 Invocation（R01 §3 `Owner expired` 的发现入口）。
 *
 * 判定依据是 **`leaseExpiresAt <= now`**，不是"心跳看起来旧了"：续租是唯一延长租约的路径，
 * 因此租约到期就是"该代际不再持有执行权"的正式事实。心跳陈旧但租约仍在有效期内**不算过期**
 * （`evaluateStaleObservation` 同样只在租约未过期时拒绝收口）；反过来，扫描因为与收口之间
 * 的竞争而多选了几行也不会误杀——收口在根锁内会带着 tuple 逐项复核，续租/换代的观察一律丢弃。
 *
 * 扫描本身只读、不加任何锁（R04 §5）：候选身份是 `(tenantId, invocationId)` 加完整
 * observed tuple，结论一律在 `markInvocationLost` 的根锁内做出。
 */
export async function findStaleInvocations(
  input: FindStaleInvocationsParams = {},
): Promise<StaleInvocationSummary[]> {
  const now = input.now ?? new Date();
  const rows = await db
    .select({
      invocationId: invocationTable.id,
      tenantId: invocationTable.tenantId,
      threadId: invocationTable.threadId,
      turnId: invocationTable.turnId,
      jobId: invocationTable.jobId,
      executionState: invocationTable.executionState,
      ownershipId: executionOwnershipTable.id,
      ownershipAttemptId: executionOwnershipTable.attemptId,
      ownershipLeaseEpoch: executionOwnershipTable.leaseEpoch,
      ownershipLeaseExpiresAt: executionOwnershipTable.leaseExpiresAt,
      lastHeartbeatAt: executionOwnershipTable.lastHeartbeatAt,
      sessionBindingId: runtimeSessionBindingTable.id,
    })
    .from(invocationTable)
    .innerJoin(
      executionOwnershipTable,
      and(
        eq(executionOwnershipTable.invocationId, invocationTable.id),
        eq(executionOwnershipTable.tenantId, invocationTable.tenantId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .leftJoin(
      runtimeSessionBindingTable,
      and(
        eq(runtimeSessionBindingTable.ownershipId, executionOwnershipTable.id),
        eq(runtimeSessionBindingTable.tenantId, executionOwnershipTable.tenantId),
      ),
    )
    .where(
      and(
        inArray(invocationTable.executionState, [...recoverableStates]),
        lte(executionOwnershipTable.leaseExpiresAt, now),
        ...(input.tenantId ? [eq(invocationTable.tenantId, input.tenantId)] : []),
      ),
    )
    .orderBy(asc(executionOwnershipTable.leaseExpiresAt))
    .limit(Math.min(input.limit ?? 100, 500));
  return rows.map((row) => ({
    invocationId: row.invocationId,
    tenantId: row.tenantId,
    threadId: row.threadId,
    turnId: row.turnId,
    jobId: row.jobId,
    executionState: row.executionState,
    lastHeartbeatAt: row.lastHeartbeatAt,
    ownershipId: row.ownershipId,
    sessionBindingId: row.sessionBindingId,
    observedOwner: {
      ownershipId: row.ownershipId,
      attemptId: row.ownershipAttemptId,
      leaseEpoch: row.ownershipLeaseEpoch,
      leaseExpiresAt: row.ownershipLeaseExpiresAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
    },
  }));
}

export interface MarkInvocationLostParams {
  tenantId: string;
  invocationId: string;
  reasonCode: string;
  /**
   * R03 §5：本次失联/失败处理所**依据的观察事实**。
   *
   * `null` 表示调用方观察到「当时没有 Current Owner」。函数会在根锁内重新读取当前状态并
   * 与该观察逐项比对：Owner 已被替换或已续租（含 lease/heartbeat 前移）→ 本次是陈旧观察，
   * 只丢弃、不改新 Owner 与 Invocation。
   */
  observedOwner: ObservedOwnerTuple | null;
  errorSummary?: string | null;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  idempotencyKey?: string | null;
}

/** 一次 Owner 观察的完整身份与到期事实（R03 §4/§5 tuple）。 */
export interface ObservedOwnerTuple {
  ownershipId: string;
  attemptId: string;
  leaseEpoch: number;
  leaseExpiresAt: Date;
  lastHeartbeatAt: Date;
}

export type MarkInvocationLostOutcome =
  | "lost"
  /** 陈旧观察：当前 Owner 与观察不符或已续租延长，本次不改任何状态。 */
  | "stale_observation";

export interface MarkInvocationLostResult {
  outcome: MarkInvocationLostOutcome;
  /** 陈旧观察时给出原因，便于调用方记录观察而非只静默丢弃。 */
  staleReason?: "owner_replaced" | "owner_renewed";
  invocation: Awaited<ReturnType<typeof transitionInvocation>>;
  invocationLostEvent: ThreadEvent | null;
  turnFailedEvent: ThreadEvent | null;
  sessionBinding: RuntimeSessionBinding | null;
}

/** 读取当前 Current Owner 的观察 tuple（异步扫描/失败路径必须携带）。 */
export async function readObservedOwner(input: {
  tenantId: string;
  invocationId: string;
  executor?: Tx;
}): Promise<ObservedOwnerTuple | null> {
  const executor = input.executor ?? db;
  const [owner] = await executor
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.invocationId, input.invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .limit(1);
  if (!owner) return null;
  return {
    ownershipId: owner.id,
    attemptId: owner.attemptId,
    leaseEpoch: owner.leaseEpoch,
    leaseExpiresAt: owner.leaseExpiresAt,
    lastHeartbeatAt: owner.lastHeartbeatAt,
  };
}

/** Close the expired authority and Invocation atomically; never infer success. */
export async function markInvocationLost(
  input: MarkInvocationLostParams,
): Promise<MarkInvocationLostResult> {
  const actorType = input.actorType ?? "system";
  const errorSummary = input.errorSummary ?? `Invocation 失联：${input.reasonCode}`;
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) throw new InvocationNotFoundError(input.invocationId);
    if (!recoverableStates.includes(current.executionState)) {
      throw new InvocationAlreadyTerminalError(
        input.invocationId,
        current.executionState,
        "mark_lost",
      );
    }

    const [owner] = await tx
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.invocationId, current.id),
          eq(executionOwnershipTable.ownershipState, "active"),
        ),
      )
      .for("update")
      .limit(1);
    const now = new Date();
    // R03 §5：在根锁内重新读当前状态，与观察逐项比对。
    const stale = evaluateStaleObservation(input.observedOwner, owner, now);
    if (stale) {
      return {
        outcome: "stale_observation" as const,
        staleReason: stale,
        invocation: current,
        invocationLostEvent: null,
        turnFailedEvent: null,
        sessionBinding: null,
      };
    }
    let sessionBinding: RuntimeSessionBinding | null = null;
    if (owner) {
      await tx
        .update(executionOwnershipTable)
        .set({
          ownershipState: "lost",
          releasedAt: now,
          reasonCode: input.reasonCode,
          versionNo: owner.versionNo + 1,
          updatedAt: now,
        })
        .where(eq(executionOwnershipTable.id, owner.id));
      sessionBinding = await markSessionBindingLostInSession(tx, {
        tenantId: input.tenantId,
        invocationId: current.id,
        ownershipId: owner.id,
      });
      // A08 8.1：Owner 丢失同样是**正式生命周期出口** —— 这里只登记该 Attempt 的真实清理工作。
      //
      // 失联收口此前完全没碰 EnvironmentLease：Owner 已 lost、Session 已收口，但真实容器
      // 既不会消失、也不会进入 `releasing` 扫描（repairs/06-environment.md §5 明确要求
      // "Owner 丢失、Invocation terminal 均生成持久清理工作"）。
      // 位置按 R04 §2 固定锁图：`… → Session → EnvironmentLease → …`。
      if (owner.environmentLeaseId) {
        await scheduleEnvironmentLeaseCleanup(
          {
            tenantId: input.tenantId,
            leaseId: owner.environmentLeaseId,
            errorCode: input.reasonCode,
            now,
            immediate: true,
          },
          tx,
        );
      }
    }

    const invocation = await transitionInvocation(tx, {
      tenantId: input.tenantId,
      invocationId: current.id,
      nextState: "lost",
      errorCode: input.reasonCode,
      errorSummary,
      now,
    });

    let turnFailedEvent: ThreadEvent | null = null;
    let invocationLostEvent: ThreadEvent | null = null;
    if (invocation.threadId) {
      const [thread] = await tx
        .select({ id: threadTable.id })
        .from(threadTable)
        .where(eq(threadTable.id, invocation.threadId))
        .for("update")
        .limit(1);
      if (!thread) throw new Error(`Invocation Thread 不存在：${invocation.threadId}`);
      let turnFailed = false;
      if (invocation.turnId) {
        const [turn] = await tx
          .select()
          .from(turnTable)
          .where(eq(turnTable.id, invocation.turnId))
          .for("update")
          .limit(1);
        if (
          turn &&
          turn.activeInvocationId === invocation.id &&
          !terminalTurnStates.has(turn.turnState)
        ) {
          await tx
            .update(turnTable)
            .set({
              turnState: "failed",
              errorCode: input.reasonCode,
              finishedAt: now,
              activeInvocationId: null,
              versionNo: turn.versionNo + 1,
            })
            .where(eq(turnTable.id, turn.id));
          turnFailed = true;
        }
      }
      const sequence = await allocateEventSequences(tx, invocation.threadId, turnFailed ? 2 : 1);
      invocationLostEvent = await insertThreadEvent(tx, invocation.threadId, sequence, {
        eventType: "invocation.lost",
        turnId: invocation.turnId ?? undefined,
        invocationId: invocation.id,
        actorType,
        actorId: input.actorId ?? undefined,
        payload: { reasonCode: input.reasonCode, errorSummary, ownershipId: owner?.id ?? null },
        correlationId: input.correlationId ?? undefined,
        idempotencyKey: input.idempotencyKey ?? undefined,
      });
      if (turnFailed) {
        turnFailedEvent = await insertThreadEvent(tx, invocation.threadId, sequence + 1, {
          eventType: "turn.failed",
          turnId: invocation.turnId ?? undefined,
          invocationId: invocation.id,
          actorType,
          actorId: input.actorId ?? undefined,
          payload: { reasonCode: input.reasonCode, errorSummary },
          correlationId: input.correlationId ?? undefined,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:turn` : undefined,
        });
      }
    }
    return {
      outcome: "lost" as const,
      invocation,
      invocationLostEvent,
      turnFailedEvent,
      sessionBinding,
    };
  });
}

/**
 * R03 §5：判断本次失联观察是否已经陈旧。
 *
 * - 观察到「没有 Current Owner」但现在有 → Owner 已被替换。
 * - 观察到的 tuple 与当前 Owner 不一致 → Owner 已被替换（只丢弃，不改新 Owner）。
 * - 同一代际但已续租（heartbeat/lease 前移）或 lease 尚未过期 → 陈旧扫描失效，不判 lost。
 */
function evaluateStaleObservation(
  observed: ObservedOwnerTuple | null,
  current: typeof executionOwnershipTable.$inferSelect | undefined,
  now: Date,
): "owner_replaced" | "owner_renewed" | null {
  if (!observed) return current ? "owner_replaced" : null;
  if (!current) return "owner_replaced";
  if (
    current.id !== observed.ownershipId ||
    current.attemptId !== observed.attemptId ||
    current.leaseEpoch !== observed.leaseEpoch
  ) {
    return "owner_replaced";
  }
  if (
    current.lastHeartbeatAt > observed.lastHeartbeatAt ||
    current.leaseExpiresAt > observed.leaseExpiresAt ||
    current.leaseExpiresAt > now
  ) {
    return "owner_renewed";
  }
  return null;
}

export async function getLatestProducerSequence(
  tenantId: string,
  invocationId: string,
): Promise<number | null> {
  const [invocation] = await db
    .select({ id: invocationTable.id })
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .limit(1);
  if (!invocation) return null;
  const [row] = await db
    .select({ maxSeq: sql<number>`COALESCE(MAX(${runtimeEventIngressTable.producerSequence}), 0)` })
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, tenantId),
        eq(runtimeEventIngressTable.invocationId, invocationId),
      ),
    );
  return row?.maxSeq ?? 0;
}

export type { Tx };
