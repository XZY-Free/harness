import {
  AGENT_CALL_STATES,
  AGENT_CALL_TERMINAL_STATES,
  AGENT_CALL_TRANSITIONS,
  type AgentCall,
  AgentCallDispositionEvidenceError,
  AgentCallStateTransitionError,
  assertAgentCallTransition,
  computeAgentCallCreationRequestDigest,
  isAgentCallTerminal,
  toAgentCallDisposition,
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
    assertAgentCallTransition("c1", "running", "failed");
    assertAgentCallTransition("c1", "running", "cancelled");
    assertAgentCallTransition("c1", "waiting_user", "cancelled");
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

  it("waiting_user 必须先由正式用户回答恢复，不能直接完成", () => {
    expect(() => assertAgentCallTransition("c1", "waiting_user", "completed")).toThrow(
      AgentCallStateTransitionError,
    );
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
      sourceType: "harness_planned" as const,
      sourceRef: "action-1",
      logicalCallKey: "inv-1:action-1:agent-1",
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

function callInState(state: AgentCall["state"], overrides: Partial<AgentCall> = {}): AgentCall {
  return {
    id: "call-1",
    tenantId: "tenant-1",
    parentInvocationId: "invocation-1",
    agentId: "agent-1",
    sourceType: "harness_planned",
    sourceRef: "action-1",
    state,
    agentSessionBindingId: null,
    sessionBinding: null,
    currentAttempt: null,
    resultText: null,
    resultJson: null,
    resultDigest: null,
    errorCode: null,
    errorSummary: null,
    logicalCallKey: "harness-action:action-1:agent:agent-1",
    creationRequestDigest: `sha256:${"a".repeat(64)}`,
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    startedAt: null,
    waitingAt: null,
    finishedAt: null,
    versionNo: 1,
    ...overrides,
  };
}

describe("AgentCall durable disposition", () => {
  it("queued/running 只映射 pending，不制造失败", () => {
    expect(toAgentCallDisposition(callInState("queued"))).toEqual({
      outcome: "pending",
      state: "queued",
      callId: "call-1",
    });
    expect(toAgentCallDisposition(callInState("running"))).toEqual({
      outcome: "pending",
      state: "running",
      callId: "call-1",
    });
  });

  it("completed/failed 映射真实 terminal 事实", () => {
    expect(
      toAgentCallDisposition(
        callInState("completed", { resultText: "完成", resultJson: { ok: true } }),
      ),
    ).toMatchObject({ outcome: "terminal", state: "completed", resultText: "完成" });
    expect(
      toAgentCallDisposition(
        callInState("failed", { errorCode: "REMOTE_FAILED", errorSummary: "远端失败" }),
      ),
    ).toMatchObject({ outcome: "terminal", state: "failed", errorCode: "REMOTE_FAILED" });
  });

  it("waiting_user 必须携带 task/context refs", () => {
    expect(() => toAgentCallDisposition(callInState("waiting_user"))).toThrow(
      AgentCallDispositionEvidenceError,
    );
    expect(
      toAgentCallDisposition(
        callInState("waiting_user", {
          currentAttempt: {
            id: "attempt-1",
            attemptNo: 1,
            externalTaskRef: "task-1",
            transportChannel: "hosted",
          },
          agentSessionBindingId: "session-1",
          sessionBinding: { id: "session-1", externalContextRef: "context-1" },
        }),
      ),
    ).toMatchObject({ outcome: "waiting_user", taskId: "task-1", contextId: "context-1" });
  });
});
