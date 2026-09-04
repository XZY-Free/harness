import { describe, expect, it } from "vitest";
import { type EventBatchSink, createHostedAdapter } from "./hosted-adapter";

describe("Hosted Adapter durable resume", () => {
  it("handleResume 重建并实际运行同一个 Harness Loop", async () => {
    const events: string[] = [];
    const sink: EventBatchSink = async ({ events: batch }) => {
      events.push(...batch.map((event) => event.type));
    };
    let waiting = true;
    const adapter = createHostedAdapter({
      platformEndpoint: "in-process://platform",
      platformAuthToken: "test-token",
      eventBatchSink: sink,
      recoveryPort: {
        async load() {
          return {
            invocationState: waiting ? "waiting_user" : "running",
            nextProducerSequence: 1,
            observations: [],
            actionHistory: [],
          };
        },
      },
      decisionPort: {
        async decideNextAction() {
          return {
            actionId: "respond-after-resume",
            stepNo: 1,
            actionType: "respond",
            purposeCode: "answer_user",
            shortPurpose: "回答用户",
            payload: {},
          };
        },
      },
      finalResponsePort: {
        async generateFinalResponse() {
          return "已恢复执行";
        },
      },
    });

    await adapter.startInvocation({
      invocationId: "inv-resume-real-loop",
      tenantId: "tenant-1",
      threadId: "thread-1",
      turnId: "turn-1",
      inputItems: [{ type: "user_message", content: { text: "继续" } }],
      gatewayEndpoints: {
        events: "in-process://events",
        cancel: "in-process://cancel",
        resume: "in-process://resume",
        steer: "in-process://steer",
        tools: "in-process://tools",
        tool_calls: "in-process://tool-calls",
        user_action_requests: "in-process://user-actions",
        capability_actions: "in-process://capability-actions",
      },
      authToken: "runtime-token",
    });
    expect((await adapter.getLastLoopPromise?.())?.waitingForUser).toBe(true);

    waiting = false;
    const result = await adapter.handleResume({
      invocationId: "inv-resume-real-loop",
      resumePayload: { source: "continuation" },
    });
    const resumed = await adapter.getLastLoopPromise?.();

    expect(result.resume_state).toBe("accepted");
    expect(resumed?.completed).toBe(true);
    expect(resumed?.responseText).toBe("已恢复执行");
    expect(events).toContain("execution.completed");
  });
});
