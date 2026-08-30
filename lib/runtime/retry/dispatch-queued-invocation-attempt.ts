import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { getTurnById } from "@/lib/conversations/turn-queries";
/**
 * dispatchQueuedInvocationAttempt：执行已有 queued InvocationAttempt 的正式 dispatch。
 *
 * 事实源：
 * - docs/architecture/runtime-control-plane.md
 *
 * 职责（唯一正式 Attempt dispatch 服务；初始调度之后的 retry 与 redispatch 共用）：
 * 1. 读取 exact queued Attempt + Invocation + immutable ExecutionBinding + RuntimeRevision。
 * 2. 重建 StartInvocationRequest（复用唯一 builder，Context 不在 retry 时丢失）。
 * 3. 使用稳定 Runtime Idempotency-Key：invocation-attempt:<attemptId>（同一 Attempt 重试不换 key）。
 * 4. 成功：Attempt → running、Invocation → running、SessionBinding、invocation.started Event。
 * 5. transient（网络/503）：Attempt 保持 queued + dispatchAttemptCount+1 + nextDispatchAt（durable retry work）。
 * 6. 耗尽：Attempt → failed + 调用唯一 Recovery Authority（markInvocationLost）收口 Invocation/Turn。
 * 7. terminal reject：Attempt → failed + markInvocationLost。
 * 8. 409 IDEMPOTENCY_CONFLICT：复用现有 SessionBinding，按成功处理。
 *
 * 关键约束：
 * - 网络调用在 DB transaction 之外。
 * - 不再调用 redispatchInvocation 创建第二个 Attempt（Worker 只领取同一 Attempt）。
 */
import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import type { ThreadEvent, ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import { threadTable } from "@/lib/persistence/schema/conversation";
import type {
  ExecutionBinding,
  Invocation,
  InvocationAttempt,
  InvocationExecutionState,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import { invocationTable } from "@/lib/persistence/schema/executions";
import {
  buildRuntimeStartRequestForInvocation,
  invocationAttemptIdempotencyKey,
} from "@/lib/runtime/application/build-runtime-start-request";
import type { RuntimeEndpointResolution } from "@/lib/runtime/dispatcher";
import {
  InvocationNotFoundError,
  RedispatchNotAllowedError,
  RuntimeHttpClientError,
  RuntimeSessionBindingConflictError,
} from "@/lib/runtime/errors";
import { getAttemptById, updateAttemptState } from "@/lib/runtime/invocation-attempt-queries";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";
import { markInvocationLost } from "@/lib/runtime/recovery-queries";
import { getLatestProducerSequence } from "@/lib/runtime/recovery-queries";
import {
  recordAttemptDispatchAttemptStarted,
  recordAttemptDispatchTransientFailure,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import type { TransientDispatchErrorCode } from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import {
  createSessionBinding,
  getSessionBindingByExternalRef,
  markSessionBindingLost,
  updateLastUsedAt,
} from "@/lib/runtime/session-binding-queries";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { executionSubjectFromUserIdentity } from "@/lib/runtime/transport/execution-subject";
import { RuntimeTransportError } from "@/lib/runtime/transport/runtime-transport";
import { and, eq } from "drizzle-orm";

/** 允许重调度的非终态 Invocation 状态（唯一事实源；redispatch-queries 从此处 re-export）。 */
export const REDISPATCH_ALLOWED_STATES: readonly InvocationExecutionState[] = [
  "queued",
  "running",
  "waiting_user",
];

/** dispatchQueuedInvocationAttempt 入参。 */
export interface DispatchQueuedAttemptParams {
  tenantId: string;
  attemptId: string;
  /** Runtime HTTP 客户端。 */
  runtimeClient: RuntimeHttpClient;
  /** 从 ExecutionBinding 解析 runtimeEndpoint/auth/gatewayEndpoints 的解析器。 */
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<RuntimeEndpointResolution>;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  /** Runtime 调用幂等键（默认 invocation-attempt:<attemptId>，稳定不换）。 */
  runtimeIdempotencyKey?: string | null;
  /** 可信调用主体；undefined = 从 Thread owner 解析（Job 模式为 null）。 */
  executionSubject?: ExecutionSubject | null;
  /** 可注入时钟。 */
  now?: Date;
}

/** dispatch 结果（判别联合）。 */
export type DispatchQueuedAttemptResult =
  | {
      status: "started";
      invocation: Invocation;
      attempt: InvocationAttempt;
      sessionBinding?: RuntimeSessionBinding;
      sessionBindingCreated: boolean;
      previousSessionBinding: RuntimeSessionBinding | null;
      invocationStartedEvent: ThreadEvent | null;
    }
  | {
      /** transient：Attempt 保持 queued，已排定 durable retry（nextDispatchAt）。 */
      status: "transient_scheduled";
      attempt: InvocationAttempt;
      skipReason: TransientDispatchErrorCode;
      nextDispatchAt: Date;
      dispatchAttemptCount: number;
    }
  | {
      /** transient 耗尽：Attempt failed + Invocation/Turn 已由 Recovery Authority 收口。 */
      status: "transient_exhausted";
      attempt: InvocationAttempt;
      skipReason: TransientDispatchErrorCode;
    }
  | {
      /** Runtime terminal 拒绝：Attempt failed + Invocation/Turn 已收口。 */
      status: "terminal_failed";
      attempt: InvocationAttempt;
      errorCode: string;
    };

/**
 * 从持久化 Authority 解析 trusted ExecutionSubject（Thread owner；Job 模式 null）。
 * 与 command-dispatch-gateway resolveResumeExecutionSubject 同一来源语义。
 */
export async function resolveInvocationExecutionSubject(params: {
  tenantId: string;
  invocation: Invocation;
}): Promise<ExecutionSubject | null> {
  if (!params.invocation.threadId) return null;
  const [thread] = await db
    .select({ tenantId: threadTable.tenantId, ownerUserId: threadTable.ownerUserId })
    .from(threadTable)
    .where(eq(threadTable.id, params.invocation.threadId))
    .limit(1);
  if (!thread || thread.tenantId !== params.tenantId) return null;
  return executionSubjectFromUserIdentity(params.tenantId, thread.ownerUserId);
}

/**
 * 执行一个 queued InvocationAttempt 的 dispatch。
 *
 * @throws InvocationNotFoundError Invocation 不存在或跨租户不可见
 * @throws RedispatchNotAllowedError Invocation 已终态
 * @throws Error Attempt 不存在或已非 queued
 */
export async function dispatchQueuedInvocationAttempt(
  params: DispatchQueuedAttemptParams,
): Promise<DispatchQueuedAttemptResult> {
  const now = params.now ?? new Date();
  const actorType: ThreadEventActorType = params.actorType ?? "system";

  // 1. 读取 exact queued Attempt
  const attempt = await getAttemptById(params.attemptId);
  if (!attempt) {
    throw new Error(
      `dispatchQueuedInvocationAttempt: InvocationAttempt 不存在（id=${params.attemptId}）`,
    );
  }
  if (attempt.attemptState !== "queued") {
    throw new Error(
      `dispatchQueuedInvocationAttempt: Attempt 已非 queued（id=${params.attemptId}, state=${attempt.attemptState}）`,
    );
  }

  // bump-at-start：dispatchAttemptCount+1 + lastDispatchAttemptAt（本次是第几次 HTTP）。
  await recordAttemptDispatchAttemptStarted({ attemptId: attempt.id, now });

  // 2. 读取 Invocation + 校验非终态
  const invocation = await getInvocationById(params.tenantId, attempt.invocationId);
  if (!invocation) {
    throw new InvocationNotFoundError(attempt.invocationId);
  }
  if (!REDISPATCH_ALLOWED_STATES.includes(invocation.executionState)) {
    throw new RedispatchNotAllowedError(invocation.id, invocation.executionState);
  }

  // 3. 读取 immutable ExecutionBinding
  const binding = await getExecutionBindingByInvocation(params.tenantId, invocation.id);
  if (!binding) {
    throw new InvocationNotFoundError(invocation.id);
  }

  // 4. capability requirements（Agent 与 Runtime Authority 分离）：用户选择的 Agent 是能力要求约束，
  // 非执行目标。Retry 与原 Invocation 一致，从 invocation 的 Turn 读取 requestedAgentId 构建。
  let capabilityRequirements:
    | Array<{ capability_type: "agent"; capability_id: string; mode: "required" }>
    | undefined;
  if (invocation.turnId) {
    const turn = await getTurnById(params.tenantId, invocation.turnId);
    if (turn?.requestedAgentId && turn.agentSelectionMode === "required") {
      capabilityRequirements = [
        {
          capability_type: "agent",
          capability_id: turn.requestedAgentId,
          mode: "required",
        },
      ];
    }
  }

  // 5. producer_sequence_start（整个 Invocation 内连续）
  const latestSeq = await getLatestProducerSequence(params.tenantId, invocation.id);
  const producerSequenceStart = (latestSeq ?? 0) + 1;

  // 6. 解析 endpoint + 构建请求（Context 不在 retry 时丢失）
  const { runtimeEndpoint, auth, gatewayEndpoints, governanceConfig, gatewayAccess } =
    await params.runtimeEndpointResolver(binding);
  const executionSubject =
    params.executionSubject !== undefined
      ? params.executionSubject
      : await resolveInvocationExecutionSubject({ tenantId: params.tenantId, invocation });
  const { requestBody } = await buildRuntimeStartRequestForInvocation({
    tenantId: params.tenantId,
    invocation,
    binding,
    capabilityRequirements,
    runtimeRevisionId: binding.runtimeRevisionId,
    gatewayEndpoints,
    governanceConfig,
    gatewayAccess,
    executionSubject,
    correlationId: params.correlationId ?? null,
    attempt: {
      attemptNo: attempt.attemptNo,
      attemptId: attempt.id,
      retryReason: attempt.retryReasonCode,
      checkpointRef: attempt.checkpointRef,
      producerSequenceStart,
    },
    now,
  });

  const idempotencyKey =
    params.runtimeIdempotencyKey ?? invocationAttemptIdempotencyKey(attempt.id);

  // 7. 调用 Runtime（网络在事务外）
  try {
    const response = await params.runtimeClient.startInvocation({
      runtimeEndpoint,
      auth,
      idempotencyKey,
      requestBody,
    });

    // 8. 成功：创建/复用 SessionBinding + 标记旧 binding lost + 事务内推进状态 + 写 Event
    return await applyAttemptStartAccepted({
      params,
      invocation,
      attempt,
      runtimeRevisionId: binding.runtimeRevisionId,
      response: {
        runtime_session_ref: response.runtime_session_ref,
        runtime_execution_ref: response.runtime_execution_ref,
      },
      producerSequenceStart,
      actorType,
      now,
    });
  } catch (err) {
    // A2A Transport 网络不可达/503（stream_interrupted）→ 与 RuntimeHttpClientError
    // network/503 同语义：transient，进入 durable retry。
    if (err instanceof RuntimeTransportError && err.kind === "stream_interrupted") {
      const skipReason: TransientDispatchErrorCode = "runtime_network_unavailable";
      const outcome = await recordAttemptDispatchTransientFailure({
        attemptId: attempt.id,
        errorCode: skipReason,
        now,
        counted: true,
      });
      if (outcome.outcome === "exhausted") {
        await markInvocationLost({
          tenantId: params.tenantId,
          invocationId: invocation.id,
          reasonCode: "dispatch_retry_exhausted",
          errorSummary: `Attempt dispatch retry exhausted（lastTransient=${skipReason}）`,
          actorType,
          actorId: params.actorId ?? null,
          correlationId: params.correlationId ?? null,
        });
        return { status: "transient_exhausted", attempt: outcome.attempt, skipReason };
      }
      return {
        status: "transient_scheduled",
        attempt: outcome.attempt,
        skipReason,
        nextDispatchAt: outcome.nextDispatchAt,
        dispatchAttemptCount: outcome.dispatchAttemptCount,
      };
    }
    if (err instanceof RuntimeHttpClientError) {
      // transient → durable retry scheduling
      if (err.kind === "network" || (err.kind === "http" && err.httpStatus === 503)) {
        const skipReason: TransientDispatchErrorCode =
          err.kind === "network" ? "runtime_network_unavailable" : "runtime_unavailable";
        const outcome = await recordAttemptDispatchTransientFailure({
          attemptId: attempt.id,
          errorCode: skipReason,
          now,
          counted: true,
        });
        if (outcome.outcome === "exhausted") {
          // 唯一 Recovery Authority 收口 Invocation/Session/Turn/Event
          await markInvocationLost({
            tenantId: params.tenantId,
            invocationId: invocation.id,
            reasonCode: "dispatch_retry_exhausted",
            errorSummary: `Attempt dispatch retry exhausted（lastTransient=${skipReason}）`,
            actorType,
            actorId: params.actorId ?? null,
            correlationId: params.correlationId ?? null,
          });
          return { status: "transient_exhausted", attempt: outcome.attempt, skipReason };
        }
        return {
          status: "transient_scheduled",
          attempt: outcome.attempt,
          skipReason,
          nextDispatchAt: outcome.nextDispatchAt,
          dispatchAttemptCount: outcome.dispatchAttemptCount,
        };
      }
      // 409 IDEMPOTENCY_CONFLICT → 幂等复用，按成功处理
      if (
        err.kind === "http" &&
        err.httpStatus === 409 &&
        err.runtimeErrorCode === "IDEMPOTENCY_CONFLICT"
      ) {
        return await applyAttemptStartIdempotencyConflict({
          params,
          invocation,
          attempt,
          producerSequenceStart,
          actorType,
          now,
        });
      }
      // terminal reject → Attempt failed + Recovery Authority 收口
      const errorCode = err.runtimeErrorCode ?? `HTTP_${err.httpStatus ?? 0}`;
      const failedAttempt = await failAttemptAndInvokeRecoveryAuthority({
        tenantId: params.tenantId,
        attempt,
        invocation,
        errorCode,
        errorSummary: err.message,
        actorType,
        actorId: params.actorId ?? null,
        correlationId: params.correlationId ?? null,
        now,
      });
      return { status: "terminal_failed", attempt: failedAttempt, errorCode };
    }
    throw err;
  }
}

/** terminal 失败收口：Attempt failed + markInvocationLost（唯一 Recovery Authority）。返回更新后的 Attempt。 */
async function failAttemptAndInvokeRecoveryAuthority(params: {
  tenantId: string;
  attempt: InvocationAttempt;
  invocation: Invocation;
  errorCode: string;
  errorSummary: string;
  actorType: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  now: Date;
}): Promise<InvocationAttempt> {
  const failedAttempt = await db.transaction(async (tx) =>
    updateAttemptState(tx, params.attempt.id, "failed", {
      finishedAt: params.now,
      errorCode: params.errorCode,
      errorSummary: params.errorSummary,
    }),
  );
  await markInvocationLost({
    tenantId: params.tenantId,
    invocationId: params.invocation.id,
    reasonCode: params.errorCode,
    errorSummary: params.errorSummary,
    actorType: params.actorType,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  });
  return failedAttempt;
}

/** 成功路径：与原 redispatchInvocation 成功分支一致的持久化编排。 */
async function applyAttemptStartAccepted(params: {
  params: DispatchQueuedAttemptParams;
  invocation: Invocation;
  attempt: InvocationAttempt;
  runtimeRevisionId: string;
  response: { runtime_session_ref: string; runtime_execution_ref: string };
  producerSequenceStart: number;
  actorType: ThreadEventActorType;
  now: Date;
}): Promise<DispatchQueuedAttemptResult> {
  const { invocation, attempt, response, now } = params;
  const outer = params.params;

  // 创建新 SessionBinding（UNIQUE 冲突 → 复用）
  let sessionBinding: RuntimeSessionBinding | undefined;
  let sessionBindingCreated = false;
  try {
    sessionBinding = await createSessionBinding({
      tenantId: outer.tenantId,
      runtimeRevisionId: params.runtimeRevisionId,
      threadId: invocation.threadId ?? null,
      jobId: invocation.jobId ?? null,
      externalSessionRef: response.runtime_session_ref,
    });
    sessionBindingCreated = true;
  } catch (err) {
    if (err instanceof RuntimeSessionBindingConflictError) {
      const existing = await getSessionBindingByExternalRef(
        params.runtimeRevisionId,
        response.runtime_session_ref,
      );
      if (!existing) {
        throw err;
      }
      sessionBinding = existing;
      sessionBindingCreated = false;
    } else {
      throw err;
    }
  }

  // 标记旧 RuntimeSessionBinding 为 lost（如有）
  let previousSessionBinding: RuntimeSessionBinding | null = null;
  if (invocation.runtimeSessionBindingId) {
    previousSessionBinding = await markSessionBindingLost(invocation.runtimeSessionBindingId);
  }

  // 事务内：Invocation → running + Attempt → running + invocation.started Event
  let invocationStartedEvent: ThreadEvent | null = null;
  let updatedAttempt: InvocationAttempt = attempt;
  const updatedInvocation = await db.transaction(async (tx) => {
    if (invocation.threadId) {
      const [thread] = await tx
        .select({ id: threadTable.id })
        .from(threadTable)
        .where(eq(threadTable.id, invocation.threadId))
        .for("update")
        .limit(1);
      if (!thread) {
        throw new Error(
          `dispatchQueuedInvocationAttempt: Thread 不存在（id=${invocation.threadId}）`,
        );
      }
    }

    let updated: Invocation;
    if (invocation.executionState === "running") {
      const now2 = new Date();
      await tx
        .update(invocationTable)
        .set({
          runtimeExecutionRef: response.runtime_execution_ref,
          runtimeSessionBindingId: sessionBinding?.id ?? invocation.runtimeSessionBindingId,
          lastHeartbeatAt: now2,
          versionNo: invocation.versionNo + 1,
          updatedAt: now2,
        })
        .where(eq(invocationTable.id, invocation.id));
      const [refreshed] = await tx
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, invocation.id))
        .limit(1);
      if (!refreshed) {
        throw new Error(
          `dispatchQueuedInvocationAttempt: Invocation 行未找到（id=${invocation.id}）`,
        );
      }
      updated = refreshed;
    } else {
      await updateInvocationState(tx, outer.tenantId, invocation.id, "running", {
        runtimeExecutionRef: response.runtime_execution_ref,
      });
      if (sessionBinding) {
        await tx
          .update(invocationTable)
          .set({ runtimeSessionBindingId: sessionBinding.id })
          .where(eq(invocationTable.id, invocation.id));
      }
      const [refreshed] = await tx
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, invocation.id))
        .limit(1);
      if (!refreshed) {
        throw new Error(
          `dispatchQueuedInvocationAttempt: Invocation 行未找到（id=${invocation.id}）`,
        );
      }
      updated = refreshed;
    }

    updatedAttempt = await updateAttemptState(tx, attempt.id, "running", {
      runtimeExecutionRef: response.runtime_execution_ref,
      startedAt: now,
    });

    if (updated.threadId) {
      const seq = await allocateEventSequences(tx, updated.threadId, 1);
      invocationStartedEvent = await insertThreadEvent(tx, updated.threadId, seq, {
        eventType: "invocation.started",
        turnId: updated.turnId ?? undefined,
        invocationId: updated.id,
        actorType: params.actorType,
        actorId: outer.actorId ?? undefined,
        payload: {
          runtime_session_ref: response.runtime_session_ref,
          runtime_execution_ref: response.runtime_execution_ref,
          runtime_session_binding_id: sessionBinding?.id ?? null,
          attempt_no: attempt.attemptNo,
          attempt_id: attempt.id,
          retry_reason: attempt.retryReasonCode ?? null,
          checkpoint_ref: attempt.checkpointRef ?? null,
          producer_sequence_start: params.producerSequenceStart,
          ...(attempt.attemptNo > 1 ? { redispatched: true } : {}),
          previous_session_binding_id: previousSessionBinding?.id ?? null,
        },
        correlationId: outer.correlationId ?? undefined,
      });
    }

    return updated;
  });

  if (sessionBinding) {
    await updateLastUsedAt(sessionBinding.id);
  }

  return {
    status: "started",
    invocation: updatedInvocation,
    attempt: updatedAttempt,
    sessionBinding,
    sessionBindingCreated,
    previousSessionBinding,
    invocationStartedEvent,
  };
}

/** 409 IDEMPOTENCY_CONFLICT 幂等复用路径（无新 session ref）。 */
async function applyAttemptStartIdempotencyConflict(params: {
  params: DispatchQueuedAttemptParams;
  invocation: Invocation;
  attempt: InvocationAttempt;
  producerSequenceStart: number;
  actorType: ThreadEventActorType;
  now: Date;
}): Promise<DispatchQueuedAttemptResult> {
  const { invocation, attempt, now } = params;
  const outer = params.params;

  let invocationStartedEvent: ThreadEvent | null = null;
  let updatedAttempt: InvocationAttempt = attempt;
  const updatedInvocation = await db.transaction(async (tx) => {
    if (invocation.threadId) {
      const [thread] = await tx
        .select({ id: threadTable.id })
        .from(threadTable)
        .where(eq(threadTable.id, invocation.threadId))
        .for("update")
        .limit(1);
      if (!thread) {
        throw new Error(
          `dispatchQueuedInvocationAttempt: Thread 不存在（id=${invocation.threadId}）`,
        );
      }
    }

    let updated: Invocation;
    if (invocation.executionState === "running") {
      const now2 = new Date();
      await tx
        .update(invocationTable)
        .set({
          lastHeartbeatAt: now2,
          versionNo: invocation.versionNo + 1,
          updatedAt: now2,
        })
        .where(eq(invocationTable.id, invocation.id));
      const [refreshed] = await tx
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, invocation.id))
        .limit(1);
      if (!refreshed) {
        throw new Error(
          `dispatchQueuedInvocationAttempt: Invocation 行未找到（id=${invocation.id}）`,
        );
      }
      updated = refreshed;
    } else {
      updated = await updateInvocationState(tx, outer.tenantId, invocation.id, "running");
    }

    updatedAttempt = await updateAttemptState(tx, attempt.id, "running", {
      startedAt: now,
    });

    if (updated.threadId) {
      const seq = await allocateEventSequences(tx, updated.threadId, 1);
      invocationStartedEvent = await insertThreadEvent(tx, updated.threadId, seq, {
        eventType: "invocation.started",
        turnId: updated.turnId ?? undefined,
        invocationId: updated.id,
        actorType: params.actorType,
        actorId: outer.actorId ?? undefined,
        payload: {
          runtime_session_ref: null,
          runtime_execution_ref: null,
          runtime_session_binding_id: invocation.runtimeSessionBindingId ?? null,
          attempt_no: attempt.attemptNo,
          attempt_id: attempt.id,
          retry_reason: attempt.retryReasonCode ?? null,
          checkpoint_ref: attempt.checkpointRef ?? null,
          idempotency_conflict: true,
          ...(attempt.attemptNo > 1 ? { redispatched: true } : {}),
        },
        correlationId: outer.correlationId ?? undefined,
      });
    }

    return updated;
  });

  return {
    status: "started",
    invocation: updatedInvocation,
    attempt: updatedAttempt,
    sessionBinding: undefined,
    sessionBindingCreated: false,
    previousSessionBinding: null,
    invocationStartedEvent,
  };
}
