import {
  AGENT_CALL_STATES,
  AGENT_CALL_TERMINAL_STATES,
  AGENT_CALL_TRANSITIONS,
  AgentCallStateTransitionError,
  assertAgentCallTransition,
  computeAgentCallCreationRequestDigest,
  isAgentCallTerminal,
} from "@/lib/agents/calls/domain/agent-call";
import { describe, expect, it } from "vitest";

describe("AgentCall 状态机", () => {
  it("状态集合包含 queued/running/waiting_user/completed/failed/cancelled/lost", () => {
    expect(AGENT_CALL_STATES).toEqual([
      "queued",
      "running",
      "waiting_user",
      "completed",
      "failed",
      "cancelled",
      "lost",
    ]);
  });

  it("终态为 completed/failed/cancelled/lost", () => {
    expect(AGENT_CALL_TERMINAL_STATES).toEqual(["completed", "failed", "cancelled", "lost"]);
  });

  it("isAgentCallTerminal 对四个终态返回 true", () => {
    for (const s of AGENT_CALL_TERMINAL_STATES) {
      expect(isAgentCallTerminal(s)).toBe(true);
    }
    expect(isAgentCallTerminal("queued")).toBe(false);
    expect(isAgentCallTerminal("running")).toBe(false);
    expect(isAgentCallTerminal("waiting_user")).toBe(false);
  });

  it("合法转移通过", () => {
    assertAgentCallTransition("c1", "queued", "running");
    assertAgentCallTransition("c1", "running", "waiting_user");
    assertAgentCallTransition("c1", "waiting_user", "running");
    assertAgentCallTransition("c1", "running", "completed");
    assertAgentCallTransition("c1", "waiting_user", "failed");
    assertAgentCallTransition("c1", "queued", "cancelled");
    assertAgentCallTransition("c1", "running", "lost");
  });

  it("终态不可再转移", () => {
    for (const from of AGENT_CALL_TERMINAL_STATES) {
      for (const to of AGENT_CALL_STATES) {
        expect(AGENT_CALL_TRANSITIONS[from]).toEqual([]);
        expect(() => assertAgentCallTransition("c1", from, to)).toThrow(
          AgentCallStateTransitionError,
        );
      }
    }
  });

  it("queued 直接 → completed/failed 非法（必须先 running）", () => {
    expect(() => assertAgentCallTransition("c1", "queued", "completed")).toThrow(
      AgentCallStateTransitionError,
    );
    expect(() => assertAgentCallTransition("c1", "queued", "failed")).toThrow(
      AgentCallStateTransitionError,
    );
    expect(() => assertAgentCallTransition("c1", "queued", "lost")).toThrow(
      AgentCallStateTransitionError,
    );
  });

  it("waiting_user → completed 合法（用户补充后可直接完成）", () => {
    expect(() => assertAgentCallTransition("c1", "waiting_user", "completed")).not.toThrow();
  });

  it("queued → lost 非法（未运行不可 lost）", () => {
    expect(() => assertAgentCallTransition("c1", "queued", "lost")).toThrow(
      AgentCallStateTransitionError,
    );
  });

  it("creationRequestDigest 只由 canonical 创建语义决定并对目标变化敏感", () => {
    const input = {
      tenantId: "tenant-1",
      parentInvocationId: "invocation-1",
      agentId: "agent-1",
      agentRevisionId: "agent-revision-1",
      sourceType: "user_selected" as const,
      sourceRef: "turn-1",
      logicalCallKey: "required-agent:turn-1:agent-1",
      bindingHash: `sha256:${"a".repeat(64)}`,
    };
    const digest = computeAgentCallCreationRequestDigest(input);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeAgentCallCreationRequestDigest({ ...input })).toBe(digest);
    expect(
      computeAgentCallCreationRequestDigest({
        ...input,
        agentRevisionId: "agent-revision-2",
      }),
    ).not.toBe(digest);
  });
});
