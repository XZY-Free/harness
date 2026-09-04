import {
  type AgentCallTransitionInput,
  decideAgentCallTransition,
} from "@/lib/agents/calls/application/agent-call-transition";
import type { AgentCallState } from "@/lib/agents/calls/domain/agent-call";
import { describe, expect, it } from "vitest";

function decide(state: AgentCallState, input: AgentCallTransitionInput) {
  return decideAgentCallTransition({ state, input });
}

describe("AgentCall 冻结状态转换矩阵", () => {
  it.each([
    ["queued", "call.started", "running", undefined],
    ["running", "call.input_required", "waiting_user", "coordinate_user_input"],
    ["running", "call.completed", "completed", "resume_parent"],
    ["running", "call.failed", "failed", "resume_parent"],
    ["running", "call.cancelled", "cancelled", "resume_parent"],
    ["waiting_user", "user_response_accepted", "running", "resume_agent_or_parent"],
    ["waiting_user", "call.cancelled", "cancelled", "resume_parent"],
  ] as const)("允许 %s + %s", (state, input, target, continuationKind) => {
    expect(decide(state, input)).toEqual({
      outcome: "applied",
      targetState: target,
      continuationKind,
    });
  });

  it.each([
    ["queued", "call.completed"],
    ["queued", "call.failed"],
    ["queued", "call.cancelled"],
    ["waiting_user", "call.completed"],
    ["waiting_user", "call.failed"],
    ["waiting_user", "call.started"],
    ["running", "user_response_accepted"],
  ] as const)("拒绝 %s + %s", (state, input) => {
    expect(decide(state, input)).toEqual({
      outcome: "rejected",
      reasonCode: "state_transition_not_allowed",
    });
  });

  it("相同终态是幂等，冲突终态被拒绝，终态不会重新打开", () => {
    expect(decide("completed", "call.completed")).toEqual({ outcome: "idempotent" });
    expect(decide("completed", "call.failed")).toEqual({
      outcome: "rejected",
      reasonCode: "terminal_state_conflict",
    });
    expect(decide("completed", "call.started")).toEqual({
      outcome: "rejected",
      reasonCode: "terminal_state_immutable",
    });
  });

  it("running 的重复 started 是幂等 no-op", () => {
    expect(decide("running", "call.started")).toEqual({ outcome: "idempotent" });
  });
});
