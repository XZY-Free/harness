import { buildAgentInputRequiredRuntimePayload } from "@/lib/runtime/harness-loop/coordinate-agent-input-required";
import { describe, expect, it } from "vitest";

describe("coordinateAgentInputRequired", () => {
  const base = {
    callId: "call-1",
    sourceRef: "parent-harness-action",
    externalTaskRef: "task-1",
    externalContextRef: "context-1",
    agentDisplayName: "外部助手",
    prompt: "请补充请假日期",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    },
  };

  it("同一 AgentCall 的不同 input-required 事件各自得到稳定 UAR 幂等键", () => {
    const first = buildAgentInputRequiredRuntimePayload({
      ...base,
      inputEventId: "agent-event-1",
      confirmation: null,
      now: new Date("2026-09-06T00:00:00.000Z"),
    });
    const firstReplay = buildAgentInputRequiredRuntimePayload({
      ...base,
      inputEventId: "agent-event-1",
      confirmation: null,
      now: new Date("2026-09-06T00:00:00.000Z"),
    });
    const second = buildAgentInputRequiredRuntimePayload({
      ...base,
      inputEventId: "agent-event-2",
      confirmation: null,
      now: new Date("2026-09-06T00:00:00.000Z"),
    });

    expect(first.action_id).toBe(firstReplay.action_id);
    expect(second.action_id).not.toBe(first.action_id);
    expect(first.action_id).not.toBe(base.sourceRef);
    expect(first.harness_action_id).toBe(base.sourceRef);
  });

  it("确认提议用 AgentCall/task/context/proposal 的稳定幂等键，且由平台写入不可为空的过期时间", () => {
    const first = buildAgentInputRequiredRuntimePayload({
      ...base,
      inputEventId: "agent-event-confirm-1",
      confirmation: {
        proposal_id: "proposal-1",
        action_key: "hr.leave.submit",
        title: "提交请假申请",
        summary: "提交三天年假",
        impact: "会创建一条请假记录",
        preview: { leave_type: "年假", days: 3 },
      },
      now: new Date("2026-09-06T00:00:00.000Z"),
      confirmationTtlMs: 15 * 60 * 1000,
    });
    const second = buildAgentInputRequiredRuntimePayload({
      ...base,
      inputEventId: "agent-event-confirm-2",
      confirmation: {
        proposal_id: "proposal-1",
        action_key: "hr.leave.submit",
        title: "提交请假申请",
        summary: "提交三天年假",
        impact: "会创建一条请假记录",
        preview: { leave_type: "年假", days: 3 },
      },
      now: new Date("2026-09-06T00:00:00.000Z"),
      confirmationTtlMs: 15 * 60 * 1000,
    });

    expect(first).toMatchObject({
      request_type: "confirmation",
      purpose: "a2a_confirmation",
      proposal_id: "proposal-1",
      harness_action_id: base.sourceRef,
      expires_at: "2026-09-06T00:15:00.000Z",
    });
    expect(first.action_id).not.toBe(base.sourceRef);
    expect(second.action_id).toBe(first.action_id);
    expect(second.action_id).toMatch(/^a2a-confirm:v1:[a-z0-9_-]+$/);
  });
});
