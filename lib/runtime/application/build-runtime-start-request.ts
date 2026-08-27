/**
 * StartInvocationRequestBody 唯一正式 builder（初始 dispatch 与 retry Attempt 共用）。
 *
 * 事实源：
 * - docs/V12/01/SnowHarness_九项问题最终代码收口方案_2026-08-27/01-DurableDispatch与RetryAuthority.md §十
 *
 * 职责：
 * - 从 exact Invocation + immutable ExecutionBinding + AgentRevision + RuntimeRevision 构建
 *   完整 StartInvocationRequestBody：agent / input_items / context_handle / invocation_context /
 *   workspace / gateway / governance / trace / execution_limits。
 * - Context 不能在 retry 时丢失：每次构建都重新执行 Binding-frozen Context Enrichment
 *   （fresh current_datetime、当前 allowed Context），禁止调用方手写无 invocation_context 的旧 body。
 * - Attempt 维度差异只体现在 attempt 字段（attempt_no/attempt_id/retry_reason/checkpoint_ref/
 *   producer_sequence_start），由入参 attempt 提供。
 *
 * 关键约束：
 * - 只此一份 Start request builder；dispatcher 初始调度、redispatch、Durable Retry Worker
 *   全部调用本函数。
 */
import { issueContextHandle } from "@/lib/context/context-handle";
import { buildBoundAgentInvocationContext } from "@/lib/context/enrichment/build-bound-agent-invocation-context";
import { getItemById } from "@/lib/conversations/thread-item-queries";
import type { AgentRevision } from "@/lib/persistence/schema/agents";
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
  /** null = 基础 Harness Route（无 Agent 资产约束，§8.3）。 */
  agentRevision: AgentRevision | null;
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
  const { invocation, binding, agentRevision } = input;
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

  // input_items：platform_rule + agent_instruction_ref（仅 Agent Route）+ user_message（如有）+ resource_index
  const inputItems: unknown[] = [
    {
      type: "platform_rule",
      content: "仅使用当前 Invocation 授权的 Context Gateway 与 Workspace 资源。",
    },
    ...(agentRevision
      ? [
          {
            type: "agent_instruction_ref",
            agent_revision_id: agentRevision.id,
          },
        ]
      : []),
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
    agent: agentRevision
      ? {
          agent_revision_id: agentRevision.id,
          model_policy: (agentRevision.modelPolicyJson ?? {}) as Record<string, unknown>,
          permission_requirements: (agentRevision.permissionRequirementsJson ?? {}) as Record<
            string,
            unknown
          >,
          interface_requirements: (agentRevision.agentInterfaceRequirementsJson ?? {}) as Record<
            string,
            unknown
          >,
        }
      : null,
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

  // 04 §14：Binding 确定后从 exact Snapshot 构建 Allowed Bundle（Base Harness snapshot=null
  // → bundle=null 不携带；每次 dispatch 重新构建，current_datetime 刷新）。
  const contextBundle = await buildBoundAgentInvocationContext({
    tenantId: input.tenantId,
    binding: {
      agentContractSnapshotId: binding.agentContractSnapshotId,
      agentContextDigest: binding.agentContextDigest,
    },
    executionSubject: input.executionSubject ?? null,
    now,
  });
  if (contextBundle) {
    requestBody.invocation_context = contextBundle.entries
      .filter((entry) => entry.supplied)
      .map((entry) => ({ context_kind: entry.contextKind, value: entry.value }));
  }

  return { requestBody, triggerItemId };
}

/**
 * 稳定 Runtime Idempotency Key：同一个 Attempt 的所有 retry 不得换 key。
 * 固定格式 invocation-attempt:<attemptId>。
 */
export function invocationAttemptIdempotencyKey(attemptId: string): string {
  return `invocation-attempt:${attemptId}`;
}
