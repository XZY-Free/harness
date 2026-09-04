import type { AgentCall } from "@/lib/agents/calls/domain/agent-call";
import type { ControlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import type { ToolCall } from "@/lib/persistence/schema/tool-call";

export const INVOCATION_CONTINUATION_CONSUMER = "invocation_continuation";
export const INVOCATION_CONTINUATION_MAX_ATTEMPTS = 8;
export const INVOCATION_CONTINUATION_LEASE_MS = 60_000;
export const INVOCATION_CONTINUATION_RETRY_DELAYS_MS = [
  1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000,
] as const;

export type InvocationContinuationKind =
  | "coordinate_user_input"
  | "resume_parent"
  | "resume_agent_after_user_response"
  | "resume_agent_or_parent";

export class InvocationContinuationPermanentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvocationContinuationPermanentError";
  }
}

export class InvocationContinuationRetryableError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvocationContinuationRetryableError";
  }
}

export function classifyInvocationContinuationError(error: unknown): {
  category: "permanent" | "retryable";
  code: string;
  summary: string;
} {
  if (error instanceof InvocationContinuationPermanentError) {
    return { category: "permanent", code: error.code, summary: error.message.slice(0, 500) };
  }
  if (error instanceof InvocationContinuationRetryableError) {
    return { category: "retryable", code: error.code, summary: error.message.slice(0, 500) };
  }
  if (error && typeof error === "object") {
    const named = error as { name?: unknown; code?: unknown; message?: unknown };
    const code = typeof named.code === "string" ? named.code : "CONTINUATION_PERMANENT_FAILURE";
    if (
      named.name === "AgentCallAttemptConflictError" ||
      (named.name === "AgentCallResumeError" &&
        [
          "binding_not_found",
          "state_invalid",
          "context_missing",
          "context_tenant_mismatch",
        ].includes(code))
    ) {
      return {
        category: "permanent",
        code,
        summary: typeof named.message === "string" ? named.message.slice(0, 500) : code,
      };
    }
  }
  return {
    category: "retryable",
    code: "CONTINUATION_TRANSIENT_FAILURE",
    summary: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  };
}

export interface InvocationContinuationDependencies {
  getAgentCall(params: { tenantId: string; callId: string }): Promise<AgentCall | null>;
  coordinateWaitingUser(tenantId: string, callId: string): Promise<unknown>;
  resumeParent(params: {
    tenantId: string;
    invocationId: string;
    agentCallId: string;
    sourceVersion: number;
  }): Promise<unknown>;
  /** user_response_accepted 已由 Agent resume 成功后产生；这里只负责继续父 Harness。 */
  resumeAfterAgentResponse(params: {
    tenantId: string;
    invocationId: string;
    agentCallId: string;
    sourceVersion: number;
  }): Promise<unknown>;
  resumeAgentFromUserAction(params: {
    tenantId: string;
    requestId: string;
    agentCallId: string;
    sourceVersion: number;
  }): Promise<unknown>;
  getToolCall?(params: { tenantId: string; toolCallId: string }): Promise<ToolCall | null>;
  resumeToolParent?(params: {
    tenantId: string;
    invocationId: string;
    toolCallId: string;
  }): Promise<unknown>;
}

interface ParsedContinuation {
  parentInvocationId: string;
  agentCallId: string;
  sourceVersion: number;
  kind: InvocationContinuationKind;
  userActionRequestId?: string;
}

export function createInvocationContinuationHandler(
  dependencies: InvocationContinuationDependencies,
) {
  return async (event: ControlPlaneOutboxEvent): Promise<void> => {
    if (event.eventType === "tool_call.continuation.requested") {
      const payload = asRecord(event.payloadJson);
      const invocationId = payload?.parent_invocation_id;
      const toolCallId = payload?.tool_call_id;
      if (
        typeof invocationId !== "string" ||
        typeof toolCallId !== "string" ||
        payload?.kind !== "resume_parent" ||
        event.aggregateId !== toolCallId ||
        !dependencies.getToolCall ||
        !dependencies.resumeToolParent
      ) {
        throw new InvocationContinuationPermanentError(
          "CONTINUATION_EVENT_INVALID",
          "Tool continuation payload 无效",
        );
      }
      const toolCall = await dependencies.getToolCall({ tenantId: event.tenantId, toolCallId });
      if (
        !toolCall ||
        toolCall.invocationId !== invocationId ||
        !["succeeded", "failed", "cancelled", "unknown_effect"].includes(toolCall.callState)
      ) {
        throw new InvocationContinuationPermanentError(
          "CONTINUATION_AUTHORITY_MISMATCH",
          "Tool continuation 无法恢复同一父 Invocation",
        );
      }
      await dependencies.resumeToolParent({
        tenantId: event.tenantId,
        invocationId,
        toolCallId,
      });
      return;
    }
    if (event.eventType !== "agent_call.continuation.requested") {
      throw new InvocationContinuationPermanentError(
        "CONTINUATION_EVENT_UNSUPPORTED",
        `Continuation consumer 不支持事件 ${event.eventType}`,
      );
    }
    const parsed = parseContinuation(event.payloadJson);
    if (event.tenantId.length === 0 || event.aggregateId !== parsed.agentCallId) {
      throw new InvocationContinuationPermanentError(
        "CONTINUATION_AUTHORITY_MISMATCH",
        "Continuation tenant/aggregate Authority 不一致",
      );
    }
    const call = await dependencies.getAgentCall({
      tenantId: event.tenantId,
      callId: parsed.agentCallId,
    });
    if (
      !call ||
      call.tenantId !== event.tenantId ||
      call.parentInvocationId !== parsed.parentInvocationId
    ) {
      throw new InvocationContinuationPermanentError(
        "CONTINUATION_AUTHORITY_MISMATCH",
        "Continuation 无法恢复同租户 AgentCall 与父 Invocation",
      );
    }
    if (call.versionNo < parsed.sourceVersion) {
      throw new InvocationContinuationRetryableError(
        "CONTINUATION_SOURCE_VERSION_NOT_VISIBLE",
        "AgentCall source version 尚不可见",
      );
    }
    // 后续版本已经推进时，旧 continuation 的效果已被新事实覆盖，安全 no-op。
    if (call.versionNo > parsed.sourceVersion) return;

    if (parsed.kind === "coordinate_user_input") {
      if (call.state !== "waiting_user") return;
      await dependencies.coordinateWaitingUser(event.tenantId, call.id);
      return;
    }
    if (parsed.kind === "resume_parent") {
      if (!isTerminal(call.state)) {
        throw new InvocationContinuationPermanentError(
          "CONTINUATION_ILLEGAL_STATE",
          `resume_parent 要求 AgentCall 终态，当前为 ${call.state}`,
        );
      }
      await dependencies.resumeParent({
        tenantId: event.tenantId,
        invocationId: call.parentInvocationId,
        agentCallId: call.id,
        sourceVersion: parsed.sourceVersion,
      });
      return;
    }
    if (parsed.kind === "resume_agent_after_user_response") {
      if (call.state !== "waiting_user") return;
      if (!parsed.userActionRequestId) {
        throw new InvocationContinuationPermanentError(
          "CONTINUATION_EVENT_INVALID",
          "Agent resume continuation 缺少 UserActionRequest 引用",
        );
      }
      await dependencies.resumeAgentFromUserAction({
        tenantId: event.tenantId,
        requestId: parsed.userActionRequestId,
        agentCallId: call.id,
        sourceVersion: parsed.sourceVersion,
      });
      return;
    }
    if (call.state !== "running" && !isTerminal(call.state)) {
      throw new InvocationContinuationPermanentError(
        "CONTINUATION_ILLEGAL_STATE",
        `resume_agent_or_parent 要求 running/终态，当前为 ${call.state}`,
      );
    }
    await dependencies.resumeAfterAgentResponse({
      tenantId: event.tenantId,
      invocationId: call.parentInvocationId,
      agentCallId: call.id,
      sourceVersion: parsed.sourceVersion,
    });
  };
}

function parseContinuation(value: unknown): ParsedContinuation {
  const payload = asRecord(value);
  const kind = payload?.kind;
  if (
    typeof payload?.parent_invocation_id !== "string" ||
    typeof payload.agent_call_id !== "string" ||
    !Number.isInteger(payload.source_version) ||
    (kind !== "coordinate_user_input" &&
      kind !== "resume_parent" &&
      kind !== "resume_agent_after_user_response" &&
      kind !== "resume_agent_or_parent")
  ) {
    throw new InvocationContinuationPermanentError(
      "CONTINUATION_EVENT_INVALID",
      "Continuation payload 无效",
    );
  }
  return {
    parentInvocationId: payload.parent_invocation_id,
    agentCallId: payload.agent_call_id,
    sourceVersion: payload.source_version as number,
    kind,
    ...(typeof payload.user_action_request_id === "string"
      ? { userActionRequestId: payload.user_action_request_id }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTerminal(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "lost";
}
