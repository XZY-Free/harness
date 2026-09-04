/**
 * 单事件 AgentCall ingress 适配器。
 *
 * 事务由调用者拥有；这里只把 transport event 转成唯一状态转换命令。批次拆分必须在
 * application 层完成，避免多个事件共享第一次加载的版本。
 */
import type { AgentCallState } from "@/lib/agents/calls/domain/agent-call";
import {
  type AgentCallTransitionResult,
  applyAgentCallTransition,
} from "@/lib/agents/calls/persistence/apply-agent-call-transition";
import type { AgentCallCandidateEvent } from "@/lib/agents/calls/transport/agent-transport";
import type { DbOrTx } from "@/lib/db/client";

export interface IngestAgentCallEventsInput {
  tenantId: string;
  callId: string;
  events: AgentCallCandidateEvent[];
}

export interface IngestAgentCallEventsResult {
  applied: number;
  idempotent: number;
  rejected: number;
  failedRetryable: number;
  accepted: number;
  duplicate: number;
  finalState: AgentCallState;
  results: AgentCallTransitionResult[];
}

export async function applyAgentCallEvent(
  tx: DbOrTx,
  input: Omit<IngestAgentCallEventsInput, "events"> & { event: AgentCallCandidateEvent },
): Promise<AgentCallTransitionResult> {
  return applyAgentCallTransition(tx, {
    tenantId: input.tenantId,
    callId: input.callId,
    input: input.event.type,
    authority: "agent_event",
    event: input.event,
  });
}
