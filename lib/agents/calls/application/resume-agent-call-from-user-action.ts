import { resumeAgentCall } from "@/lib/agents/calls/application/resume-agent-call";
import type { UserActionRequest } from "@/lib/persistence/schema/user-action-request";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";

export interface ResumeAgentCallFromUserActionParams {
  tenantId: string;
  request: UserActionRequest;
  responseRedactedJson: unknown;
  executionSubject: ExecutionSubject | null;
}

/** UserAction resolve 后恢复其冻结的 AgentCall；缺少正式关联时视为普通 Runtime UAR。 */
export async function resumeAgentCallFromUserAction(
  params: ResumeAgentCallFromUserActionParams,
): Promise<{ resumed: false } | { resumed: true; callId: string; state: string }> {
  if (params.request.requestType !== "input" || params.request.purpose !== "a2a_input_required") {
    return { resumed: false };
  }
  const prompt = asRecord(params.request.promptJson);
  const response = asRecord(params.responseRedactedJson);
  const callId = typeof prompt?.agent_call_id === "string" ? prompt.agent_call_id : null;
  const text = typeof response?.text === "string" ? response.text.trim() : "";
  if (!callId) return { resumed: false };
  if (!text) throw new Error("Agent input-required resolve 缺少非空 text");

  const call = await resumeAgentCall({
    tenantId: params.tenantId,
    callId,
    text,
    contextEnvironment: {
      tenantId: params.tenantId,
      executionSubject: params.executionSubject,
      now: new Date(),
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
    },
  });
  return { resumed: true, callId: call.id, state: call.state };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
