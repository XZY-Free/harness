/**
 * 重调度编排（组合函数：创建 queued Attempt + 交由 dispatchQueuedInvocationAttempt 执行）。
 *
 * 事实源：
 * - docs/V12/01/SnowHarness_九项问题最终代码收口方案_2026-08-27/01-DurableDispatch与RetryAuthority.md §六
 * - docs/architecture/persistence.md / conversations.md / api-and-events.md
 *
 * 职责：
 * - redispatchInvocation：为同一 Invocation 创建新 queued Attempt，然后调用唯一正式
 *   Attempt dispatch 服务（dispatchQueuedInvocationAttempt）。网络/503 时同一 Attempt 已具备
 *   nextDispatchAt（durable retry work），后续 Worker 只领取该 Attempt，禁止再次创建下一个。
 * - createQueuedRedispatchAttempt：事务内创建 queued Attempt（SELECT FOR UPDATE Invocation）。
 *
 * 关键约束：
 * - 不新建 continuation Invocation（同一 invocationId 重调度）。
 * - 不更换 ExecutionBinding（binding 不可变，1:1）。
 * - 终态 Invocation 不可重调度（completed/failed/cancelled/lost）。
 * - 旧 RuntimeSessionBinding 在新调度被接受后标记 lost。
 * - 不伪造完成：Runtime 未接受时不能将 Invocation 转为 completed。
 * - Start request 由唯一 builder 构建（Context 不在 retry 时丢失）。
 */
import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import type { AgentRevision } from "@/lib/persistence/schema/agents";
import type { ThreadEvent, ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import type {
  ExecutionBinding,
  Invocation,
  InvocationAttempt,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import { invocationTable } from "@/lib/persistence/schema/executions";
import type { RuntimeEndpointResolution } from "@/lib/runtime/dispatcher";
import { InvocationNotFoundError, RedispatchNotAllowedError } from "@/lib/runtime/errors";
import { createAttemptInternal } from "@/lib/runtime/invocation-attempt-queries";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import {
  type DispatchQueuedAttemptResult,
  REDISPATCH_ALLOWED_STATES,
  dispatchQueuedInvocationAttempt,
} from "@/lib/runtime/retry/dispatch-queued-invocation-attempt";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import { and, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** redispatchInvocation 入参。 */
export interface RedispatchInvocationParams {
  tenantId: string;
  invocationId: string;
  /** 重调度原因码（如 requires_redispatch / runtime_lost / infra_error）。 */
  retryReasonCode: string;
  /** 重调度检查点引用（必须避开已确认副作用，事实源 L755）。 */
  checkpointRef?: string | null;
  /** Runtime HTTP 客户端。 */
  runtimeClient: RuntimeHttpClient;
  /** 从 ExecutionBinding 解析 runtimeEndpoint/auth/gatewayEndpoints 的解析器。 */
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<RuntimeEndpointResolution>;
  /** RuntimeRevision id（兼容入参；实际以 ExecutionBinding.runtimeRevisionId 为权威）。 */
  runtimeRevisionId: string;
  /**
   * AgentRevision（可选已加载对象；以 ExecutionBinding.agentRevisionId 为权威）。
   * 基础 Harness Route 为 null。
   */
  agentRevision: AgentRevision | null;
  /** 触发事件的 actor 类型（默认 system）。 */
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  /** 关联标识（X-Request-Id / traceparent）。 */
  correlationId?: string | null;
  /** Runtime 调用幂等键（默认 invocation-attempt:<attemptId>，稳定不换）。 */
  runtimeIdempotencyKey?: string | null;
}

/** redispatchInvocation 返回结果。 */
export interface RedispatchResult {
  /** 是否实际完成了重调度（false = transient 未完成，Attempt 保持 queued 并已排定 durable retry）。 */
  redispatched: boolean;
  /** 未完成原因（redispatched=false 且 transient 时填）。 */
  skipReason?: "runtime_network_unavailable" | "runtime_unavailable";
  /** 更新后的 Invocation（executionState=running）。 */
  invocation?: Invocation;
  /** Attempt（started 时为 running；transient 时为 queued/failed）。 */
  attempt?: InvocationAttempt;
  /** 旧 RuntimeSessionBinding（标记为 lost）。无旧绑定时为 null。 */
  previousSessionBinding?: RuntimeSessionBinding | null;
  /** 新 RuntimeSessionBinding。 */
  sessionBinding?: RuntimeSessionBinding;
  /** 是否新建了 SessionBinding（false 表示复用已存在）。 */
  sessionBindingCreated?: boolean;
  /** 写入的 invocation.started ThreadEvent（仅 Turn 模式）。 */
  invocationStartedEvent?: ThreadEvent | null;
  /** Runtime 响应。 */
  response?: unknown;
  /** terminal 拒绝错误码（Attempt/Invocation 已失败收口时填）。 */
  failureErrorCode?: string;
}

/**
 * 事务内创建 queued Attempt（SELECT FOR UPDATE Invocation 防并发重调度）。
 * Attempt 行先持久化为 queued；执行交由 dispatchQueuedInvocationAttempt。
 */
export async function createQueuedRedispatchAttempt(params: {
  tenantId: string;
  invocationId: string;
  retryReasonCode: string;
  checkpointRef?: string | null;
}): Promise<InvocationAttempt> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, params.tenantId),
          eq(invocationTable.id, params.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) {
      throw new InvocationNotFoundError(params.invocationId);
    }
    if (!REDISPATCH_ALLOWED_STATES.includes(current.executionState)) {
      throw new RedispatchNotAllowedError(params.invocationId, current.executionState);
    }

    return createAttemptInternal(tx, {
      invocationId: params.invocationId,
      retryReasonCode: params.retryReasonCode,
      checkpointRef: params.checkpointRef ?? null,
    });
  });
}

/**
 * 为同一 Invocation 创建新 Attempt 并调用唯一正式 Attempt dispatch 服务重调度。
 *
 * transient（网络/503）：返回 redispatched=false，但同一 Attempt 已具备 nextDispatchAt；
 * 后续由 Runtime Dispatch Retry Worker 领取，不创建下一个 Attempt。
 *
 * @throws InvocationNotFoundError Invocation 不存在或跨租户不可见
 * @throws RedispatchNotAllowedError Invocation 已终态或不允许重调度
 */
export async function redispatchInvocation(
  params: RedispatchInvocationParams,
): Promise<RedispatchResult> {
  // 前置校验（dispatch 服务内部会再次校验）
  const invocation = await getInvocationById(params.tenantId, params.invocationId);
  if (!invocation) {
    throw new InvocationNotFoundError(params.invocationId);
  }
  if (!REDISPATCH_ALLOWED_STATES.includes(invocation.executionState)) {
    throw new RedispatchNotAllowedError(params.invocationId, invocation.executionState);
  }
  const binding = await getExecutionBindingByInvocation(params.tenantId, params.invocationId);
  if (!binding) {
    throw new InvocationNotFoundError(params.invocationId);
  }

  // 创建 queued Attempt（不再立即打网络后重复创建）
  const newAttempt = await createQueuedRedispatchAttempt({
    tenantId: params.tenantId,
    invocationId: params.invocationId,
    retryReasonCode: params.retryReasonCode,
    checkpointRef: params.checkpointRef ?? null,
  });

  // 执行 dispatch（唯一正式 Attempt dispatch 服务）
  const result = await dispatchQueuedInvocationAttempt({
    tenantId: params.tenantId,
    attemptId: newAttempt.id,
    runtimeClient: params.runtimeClient,
    runtimeEndpointResolver: params.runtimeEndpointResolver,
    agentRevision: params.agentRevision,
    actorType: params.actorType,
    actorId: params.actorId,
    correlationId: params.correlationId,
    runtimeIdempotencyKey: params.runtimeIdempotencyKey ?? null,
  });

  return mapDispatchResult(result);
}

/** 将 DispatchQueuedAttemptResult 映射为 RedispatchResult（保持既有调用方形状）。 */
function mapDispatchResult(result: DispatchQueuedAttemptResult): RedispatchResult {
  switch (result.status) {
    case "started":
      return {
        redispatched: true,
        invocation: result.invocation,
        attempt: result.attempt,
        previousSessionBinding: result.previousSessionBinding,
        sessionBinding: result.sessionBinding,
        sessionBindingCreated: result.sessionBindingCreated,
        invocationStartedEvent: result.invocationStartedEvent,
      };
    case "transient_scheduled":
      return {
        redispatched: false,
        skipReason: result.skipReason,
        attempt: result.attempt,
      };
    case "transient_exhausted":
      return {
        redispatched: false,
        skipReason: result.skipReason,
        attempt: result.attempt,
      };
    case "terminal_failed":
      return {
        redispatched: false,
        attempt: result.attempt,
        failureErrorCode: result.errorCode,
      };
  }
}

/** 导出事务句柄类型与常量供外部组合事务使用。 */
export type { Tx };
export { REDISPATCH_ALLOWED_STATES };
