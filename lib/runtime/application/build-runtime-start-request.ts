/**
 * StartInvocationRequestBody 唯一正式 builder（初始 dispatch 与 retry Attempt 共用）。
 *
 * 事实源：
 * - docs/V12/01/SnowHarness_九项问题最终代码收口方案_2026-08-27/01-DurableDispatch与RetryAuthority.md §十
 *
 * 职责：
 * - 从 exact Invocation + immutable ExecutionBinding + RuntimeRevision 构建
 *   完整 StartInvocationRequestBody：capability_requirements / input_items / context_handle /
 *   invocation_context / workspace / gateway / governance / trace / execution_limits。
 * - 顶层 Invocation 恒属于 Harness（专题01 冻结架构）：不携带 Agent 执行目标，
 *   只携带 capability_requirements 表达"本轮要求使用某 Agent 能力"（由 Harness Loop 调用）。
 * - Base Harness 路径不执行 Agent Contract Context Enrichment（该职责属 AgentCall，后续批次）。
 * - Attempt 维度差异只体现在 attempt 字段（attempt_no/attempt_id/retry_reason/checkpoint_ref/
 *   producer_sequence_start），由入参 attempt 提供。
 *
 * 关键约束：
 * - 只此一份 Start request builder；dispatcher 初始调度、redispatch、Durable Retry Worker
 *   全部调用本函数。
 */
import { issueContextHandle } from "@/lib/context/context-handle";
import { getItemById } from "@/lib/conversations/thread-item-queries";
import type { ExecutionBinding, Invocation } from "@/lib/persistence/schema/executions";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import { RUNTIME_PROTOCOL_VERSION } from "@/lib/runtime/runtime-client";
import type {
  GatewayAccess,
  GatewayEndpoints,
  GovernanceConfigRef,
  StartInvocationRequestBody,
} from "@/lib/runtime/runtime-client";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";

/** builder 入参。 */
export interface BuildRuntimeStartRequestInput {
  tenantId: string;
  invocation: Invocation;
  binding: ExecutionBinding;
  /**
   * 本轮 Harness 执行约束（capability requirements，非执行目标）。
   * 由调用方从 Turn 的 requestedAgentId / selectionMode 构建；专题01 仅支持
   * capability_type=agent + mode=required。省略/空数组 = 本轮无强制能力要求。
   */
  capabilityRequirements?: Array<{
    capability_type: "agent";
    capability_id: string;
    mode: "required";
  }>;
  /** Binding 冻结的 RuntimeRevision（读取 capabilities/execution_limits）。 */
  runtimeRevisionId: string;
  gatewayEndpoints: GatewayEndpoints;
  governanceConfig: GovernanceConfigRef;
  gatewayAccess: GatewayAccess;
  /** 可信调用主体（06 §6）；null/省略 = 不发送 execution_subject context。 */
  executionSubject?: ExecutionSubject | null;
  correlationId?: string | null;
  /** Attempt 维度信息（attempt_no=1 且无 retry_reason 时即初始调度形态）。 */
  attempt: {
    attemptNo: number;
    attemptId?: string;
    retryReason?: string | null;
    checkpointRef?: string | null;
    producerSequenceStart?: number;
  };
  /** 初始调度要求 trigger Item 必须存在（缺失抛错）；retry/redispatch 容忍缺失（Job 模式）。 */
  requireTriggerItem?: boolean;
  /** 可注入时钟（current_datetime 每次 dispatch 刷新；测试用 fake clock）。 */
  now?: Date;
}

/** 构建结果。 */
export interface BuildRuntimeStartRequestResult {
  requestBody: StartInvocationRequestBody;
  /** 触发 user_message 的 Item id（无触发 Item 时为 null）。 */
  triggerItemId: string | null;
}

/**
 * 构建 StartInvocationRequestBody（唯一正式实现）。
 *
 * @throws Error requireTriggerItem=true 且触发 Item 不存在
 * @throws Error RuntimeRevision 不存在（binding 冻结的 revision 必须存在）
 */
export async function buildRuntimeStartRequestForInvocation(
  input: BuildRuntimeStartRequestInput,
): Promise<BuildRuntimeStartRequestResult> {
  const { invocation, binding } = input;
  const now = input.now ?? new Date();

  // 读取 RuntimeRevision capabilities（execution_limits）
  const runtimeRevision = await getRuntimeRevisionById(input.runtimeRevisionId);
  if (!runtimeRevision) {
    throw new Error(
      `buildRuntimeStartRequestForInvocation: RuntimeRevision 不存在（id=${input.runtimeRevisionId}）`,
    );
  }
  const caps = runtimeRevision.runtimeCapabilitiesJson as {
    limits?: { max_invocation_seconds?: number; max_event_bytes?: number };
  } | null;
  const maxInvocationSeconds = caps?.limits?.max_invocation_seconds ?? 600;
  const maxEventBytes = caps?.limits?.max_event_bytes ?? 1_048_576;

  // context_handle（每次 dispatch 重新签发）
  const contextHandle = await issueContextHandle({
    tenantId: input.tenantId,
    invocationId: invocation.id,
  });

  // input_items：platform_rule + user_message（如有）+ resource_index
  const inputItems: unknown[] = [
    {
      type: "platform_rule",
      content: "仅使用当前 Invocation 授权的 Context Gateway 与 Workspace 资源。",
    },
  ];
  let triggerItemId: string | null = null;
  if (invocation.triggerItemId) {
    const triggerItem = await getItemById(input.tenantId, invocation.triggerItemId);
    if (triggerItem) {
      triggerItemId = triggerItem.id;
      inputItems.push({
        type: "user_message",
        item_id: triggerItem.id,
        content: triggerItem.contentJson,
      });
    } else if (input.requireTriggerItem) {
      throw new Error(
        `buildRuntimeStartRequestForInvocation: 当前输入 Item 不存在（invocationId=${invocation.id}）`,
      );
    }
  } else if (input.requireTriggerItem) {
    throw new Error(
      `buildRuntimeStartRequestForInvocation: Invocation 缺少 triggerItemId（invocationId=${invocation.id}）`,
    );
  }
  inputItems.push({
    type: "resource_index",
    sources: ["recent_items", "skill", "workspace_map", "memory", "knowledge"],
  });

  const requestBody: StartInvocationRequestBody = {
    protocol_version: RUNTIME_PROTOCOL_VERSION,
    invocation_id: invocation.id,
    turn_context: invocation.threadId
      ? {
          thread_id: invocation.threadId,
          turn_id: invocation.turnId ?? "",
          trigger_item_id: invocation.triggerItemId ?? null,
        }
      : null,
    job_context: invocation.jobId
      ? {
          job_id: invocation.jobId,
          trigger_item_id: invocation.triggerItemId ?? null,
        }
      : null,
    ...(input.capabilityRequirements && input.capabilityRequirements.length > 0
      ? { capability_requirements: input.capabilityRequirements }
      : {}),
    input_items: inputItems,
    context_handle: contextHandle,
    gateway_endpoints: input.gatewayEndpoints,
    governance_config: input.governanceConfig,
    gateway_access: input.gatewayAccess,
    workspace: {
      workspace_binding_id: binding.workspaceBindingId,
      workspace_type: binding.workspaceBindingId ? "managed" : "none",
    },
    execution_limits: {
      max_invocation_seconds: maxInvocationSeconds,
      max_event_bytes: maxEventBytes,
    },
    trace_context: {
      trace_id: input.correlationId ?? invocation.id,
      span_id: invocation.id,
    },
    attempt: {
      attempt_no: input.attempt.attemptNo,
      ...(input.attempt.attemptId !== undefined ? { attempt_id: input.attempt.attemptId } : {}),
      ...(input.attempt.retryReason ? { retry_reason: input.attempt.retryReason } : {}),
      ...(input.attempt.checkpointRef !== null && input.attempt.checkpointRef !== undefined
        ? { checkpoint_ref: input.attempt.checkpointRef }
        : {}),
      ...(input.attempt.producerSequenceStart !== undefined
        ? { producer_sequence_start: input.attempt.producerSequenceStart }
        : {}),
    },
  };

  // 专题01 冻结架构：Base Harness 路径不执行 Agent Contract Context Enrichment。
  // invocation_context（Allowed Bundle）构建属于 AgentCall 专属（后续批次），
  // 顶层 Harness Start Request 不再携带 Agent Contract Context。

  return { requestBody, triggerItemId };
}

/**
 * 稳定 Runtime Idempotency Key：同一个 Attempt 的所有 retry 不得换 key。
 * 固定格式 invocation-attempt:<attemptId>。
 */
export function invocationAttemptIdempotencyKey(attemptId: string): string {
  return `invocation-attempt:${attemptId}`;
}
