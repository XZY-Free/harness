import type { RuntimeCandidateEvent } from "@/lib/runtime/event-ingress-queries";
import {
  type InProcessHostedRuntimeClient,
  createInProcessHostedRuntimeClient,
} from "@/lib/runtime/in-process-hosted-runtime";
import { describe, expect, it } from "vitest";

describe("InProcessHostedRuntimeClient", () => {
  it("只在 Invocation 已进入 running 后才调用模型并回传正式回复", async () => {
    const events: RuntimeCandidateEvent[] = [];
    let modelCalls = 0;
    const client = createInProcessHostedRuntimeClient({
      modelRef: "configured-model",
      modelFn: async (message) => {
        modelCalls += 1;
        return `模型回复：${message}`;
      },
      ingressEventBatch: async ({ events: batch }) => {
        events.push(...batch);
      },
    });

    const response = await client.startInvocation({
      runtimeEndpoint: "in-process://hosted",
      authToken: "runtime-token",
      idempotencyKey: "invoke-1",
      requestBody: {
        invocation_id: "invocation-1",
        turn_context: { thread_id: "thread-1", turn_id: "turn-1" },
        job_context: null,
        agent: {
          agent_revision_id: "agent-revision-1",
          instruction_hash: "sha256:instruction",
          artifact_ref: "builtin://agent",
          model_policy: {},
          permission_requirements: {},
          interface_requirements: {},
        },
        input_items: [{ type: "user_message", content: { text: "你好" } }],
        context_handle: "context-1",
        gateway_endpoints: {
          events: "in-process://events",
          cancel: "in-process://cancel",
          resume: "in-process://resume",
          steer: "in-process://steer",
        },
        execution_limits: { max_invocation_seconds: 600, max_event_bytes: 1_048_576 },
        trace_context: { trace_id: "trace-1", span_id: "span-1" },
      },
    });

    expect(response.accepted).toBe(true);
    expect(modelCalls).toBe(0);
    expect(events).toEqual([]);

    await (client as InProcessHostedRuntimeClient).launchAcceptedInvocation("invocation-1");

    expect(modelCalls).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "response.completed",
      "execution.completed",
    ]);
    expect(events[0]?.payload).toMatchObject({
      text: "模型回复：你好",
      model_ref: "configured-model",
    });
  });

  it("尚未启动时不暴露 Agent Loop Promise", () => {
    const client = createInProcessHostedRuntimeClient({
      modelRef: "configured-model",
      modelFn: async () => "已完成",
      ingressEventBatch: async () => {},
    });

    expect((client as InProcessHostedRuntimeClient).getLastLaunchPromise()).toBeNull();
  });
});
