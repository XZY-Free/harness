import {
  AgentCallLogicalKeyError,
  buildAgentCallLogicalKey,
} from "@/lib/agents/calls/domain/agent-call";
import { describe, expect, it } from "vitest";

describe("AgentCall logical call key", () => {
  it("只由 Harness action 与 stable Agent 生成可诊断的规范键", () => {
    expect(buildAgentCallLogicalKey("action-17", "agent-9")).toBe(
      "harness-action:action-17:agent:agent-9",
    );
  });

  it.each(["", "   "])("拒绝空 actionId: %j", (actionId) => {
    expect(() => buildAgentCallLogicalKey(actionId, "agent-9")).toThrow(AgentCallLogicalKeyError);
  });

  it.each(["", "   "])("拒绝空 stable Agent ID: %j", (agentId) => {
    expect(() => buildAgentCallLogicalKey("action-17", agentId)).toThrow(AgentCallLogicalKeyError);
  });
});
