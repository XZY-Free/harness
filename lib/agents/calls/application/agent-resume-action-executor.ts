import { projectAgentHostActions } from "@/lib/agents/calls/application/project-host-actions";
import { resumeAgentCall } from "@/lib/agents/calls/application/resume-agent-call";
import { toAgentCallDisposition } from "@/lib/agents/calls/domain/agent-call";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import type { HostAction } from "@/lib/agents/calls/transport/a2a/host-control-contract";
import { getUserActionRequestsByInvocation } from "@/lib/permission/user-action-queries";
import type { HarnessActionExecutors } from "@/lib/runtime/harness-loop/loop";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { AgentActionExecutionError } from "./agent-action-executor";

export function createAgentResumeActionExecutor(params: {
  tenantId: string;
  executionSubject: ExecutionSubject;
}): NonNullable<HarnessActionExecutors["agent.resume"]> {
  return async (action, context) => {
    if (context.tenantId !== params.tenantId) {
      throw new AgentActionExecutionError(
        "AGENT_CONTEXT_REQUIREMENT_UNSATISFIED",
        "Agent resume 与执行器租户不一致",
      );
    }
    const call = await mysqlAgentCallStore.getById({
      tenantId: params.tenantId,
      callId: action.payload.agentCallId,
    });
    if (
      !call ||
      call.parentInvocationId !== context.invocationId ||
      call.sourceType !== "harness_planned"
    ) {
      throw new AgentActionExecutionError(
        "AGENT_CALL_RESUME_NOT_ALLOWED",
        "只能恢复当前 Invocation 下由 Harness 创建的 AgentCall",
      );
    }
    const text = await resolveResumeText({
      tenantId: params.tenantId,
      invocationId: context.invocationId,
      objective: context.objective,
      inputSource: action.payload.inputSource,
    });
    try {
      const current = await resumeAgentCall({
        tenantId: params.tenantId,
        callId: call.id,
        text,
        contextEnvironment: {
          tenantId: params.tenantId,
          executionSubject: params.executionSubject,
          now: new Date(),
          timezone: "Asia/Shanghai",
          locale: "zh-CN",
        },
      });
      const disposition = toAgentCallDisposition(current);
      if (disposition.outcome === "pending" || disposition.outcome === "waiting_user") {
        return {
          authorityRef: `agent-call:${disposition.callId}`,
          pending: {
            kind: "agent_call",
            callId: disposition.callId,
            state: disposition.state,
          },
        };
      }
      if (disposition.state !== "completed") {
        return {
          authorityRef: `agent-call:${disposition.callId}`,
          observation: {
            observationType: "agent",
            summary: disposition.errorSummary.slice(0, 20_000),
            sourceRefs: [`agent-call:${disposition.callId}`],
            data: {
              callId: disposition.callId,
              state: disposition.state,
              errorCode: "AGENT_CALL_FAILED",
              errorSummary: disposition.errorSummary,
            },
          },
        };
      }
      const hostActions = readHostActions(disposition.resultJson);
      if (hostActions.length > 0) {
        if (!context.threadId || !context.turnId) {
          throw new Error("Agent resume 的 host actions 需要 Thread/Turn 上下文");
        }
        await projectAgentHostActions({
          tenantId: params.tenantId,
          threadId: context.threadId,
          turnId: context.turnId,
          invocationId: context.invocationId,
          agentCallId: disposition.callId,
          actions: hostActions,
          executionSubject: params.executionSubject,
        });
      }
      return {
        authorityRef: `agent-call:${disposition.callId}`,
        observation: {
          observationType: "agent",
          summary: disposition.resultText.slice(0, 20_000),
          sourceRefs: [`agent-call:${disposition.callId}`],
          data: {
            callId: disposition.callId,
            resultText: disposition.resultText,
            resultJson: disposition.resultJson,
          },
        },
      };
    } catch (error) {
      if (error instanceof AgentActionExecutionError) throw error;
      const code = readErrorCode(error);
      throw new AgentActionExecutionError(
        code === "enterprise_context_disabled" || code === "context_tenant_mismatch"
          ? "AGENT_CONTEXT_REQUIREMENT_UNSATISFIED"
          : code === "transport"
            ? "AGENT_CALL_TRANSPORT_FAILED"
            : "AGENT_CALL_RESUME_FAILED",
        error instanceof Error ? error.message : "AgentCall 恢复失败",
      );
    }
  };
}

async function resolveResumeText(params: {
  tenantId: string;
  invocationId: string;
  objective?: string;
  inputSource: { kind: "original_objective" } | { kind: "user_input"; sourceRef: string };
}): Promise<string> {
  if (params.inputSource.kind === "original_objective") {
    const objective = params.objective?.trim() ?? "";
    if (!objective) {
      throw new AgentActionExecutionError(
        "AGENT_CALL_RESUME_INPUT_INVALID",
        "原始用户目标不存在，不能恢复 AgentCall",
      );
    }
    return objective;
  }

  const requestId = params.inputSource.sourceRef.slice("user-action:".length);
  const request = (
    await getUserActionRequestsByInvocation(params.tenantId, params.invocationId)
  ).find((candidate) => candidate.id === requestId);
  if (
    !request ||
    request.requestType !== "input" ||
    request.requestState !== "resolved" ||
    request.resolution !== "submit"
  ) {
    throw new AgentActionExecutionError(
      "AGENT_CALL_RESUME_INPUT_INVALID",
      "AgentCall 恢复引用的用户输入不存在或未提交",
    );
  }
  const response = asRecord(request.responseRedactedJson);
  const text = typeof response?.text === "string" ? response.text.trim() : "";
  const serialized = text || JSON.stringify(request.responseRedactedJson);
  if (!serialized || serialized === "null" || serialized.length > 8_000) {
    throw new AgentActionExecutionError(
      "AGENT_CALL_RESUME_INPUT_INVALID",
      "AgentCall 恢复引用的用户输入无效",
    );
  }
  return serialized;
}

function readHostActions(value: unknown): HostAction[] {
  const controls = asRecord(asRecord(value)?.host_controls);
  return Array.isArray(controls?.ui_actions) ? (controls.ui_actions as HostAction[]) : [];
}

function readErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
