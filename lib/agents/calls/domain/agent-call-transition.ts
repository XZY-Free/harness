import type { AgentCallState } from "@/lib/agents/calls/domain/agent-call";

export type AgentCallTransitionInput =
  | "call.started"
  | "call.input_required"
  | "call.completed"
  | "call.failed"
  | "call.cancelled"
  | "call.lost"
  | "user_response_accepted";

export type AgentCallContinuationKind =
  | "coordinate_user_input"
  | "resume_parent"
  | "resume_agent_or_parent";

export type AgentCallTransitionDecision =
  | {
      outcome: "applied";
      targetState: AgentCallState;
      continuationKind?: AgentCallContinuationKind;
    }
  | { outcome: "idempotent" }
  | {
      outcome: "rejected";
      reasonCode:
        | "state_transition_not_allowed"
        | "terminal_state_conflict"
        | "terminal_state_immutable";
    };

const TERMINAL_BY_INPUT: Partial<Record<AgentCallTransitionInput, AgentCallState>> = {
  "call.completed": "completed",
  "call.failed": "failed",
  "call.cancelled": "cancelled",
  "call.lost": "lost",
};

export function decideAgentCallTransition(input: {
  state: AgentCallState;
  input: AgentCallTransitionInput;
}): AgentCallTransitionDecision {
  const { state, input: transitionInput } = input;
  const terminal = TERMINAL_BY_INPUT[transitionInput];
  if (isTerminal(state)) {
    if (terminal === state) return { outcome: "idempotent" };
    return {
      outcome: "rejected",
      reasonCode: terminal ? "terminal_state_conflict" : "terminal_state_immutable",
    };
  }

  if (state === "running" && transitionInput === "call.started") {
    return { outcome: "idempotent" };
  }
  if (state === "queued" && transitionInput === "call.started") {
    return { outcome: "applied", targetState: "running" };
  }
  if (state === "running" && transitionInput === "call.input_required") {
    return {
      outcome: "applied",
      targetState: "waiting_user",
      continuationKind: "coordinate_user_input",
    };
  }
  if (state === "running" && terminal && terminal !== "lost") {
    return {
      outcome: "applied",
      targetState: terminal,
      continuationKind: "resume_parent",
    };
  }
  if (state === "waiting_user" && transitionInput === "user_response_accepted") {
    return {
      outcome: "applied",
      targetState: "running",
      continuationKind: "resume_agent_or_parent",
    };
  }
  if (state === "waiting_user" && transitionInput === "call.cancelled") {
    return {
      outcome: "applied",
      targetState: "cancelled",
      continuationKind: "resume_parent",
    };
  }
  return { outcome: "rejected", reasonCode: "state_transition_not_allowed" };
}

function isTerminal(state: AgentCallState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "lost";
}
