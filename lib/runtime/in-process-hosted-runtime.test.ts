import type { RuntimeCandidateEvent } from "@/lib/runtime/event-ingress-queries";
import { createDirectResponsePorts } from "@/lib/runtime/harness-loop/test-ports";
import {
  type InProcessHostedRuntimeClient,
  createInProcessHostedRuntimeClient,
} from "@/lib/runtime/in-process-hosted-runtime";
import { RUNTIME_PROTOCOL_VERSION } from "@/lib/runtime/runtime-client";
import { describe, expect, it } from "vitest";

describe("InProcessHostedRuntimeClient", () => {
  it("只在 Invocation 已进入 running 后才调用模型并回传正式回复", async () => {
    const events: RuntimeCandidateEvent[] = [];
    let modelCalls = 0;
    const client = createInProcessHostedRuntimeClient({
      ...createDirectResponsePorts(async (view) => {
        modelCalls += 1;
        return `模型回复：${view.objective}`;
      }),
      ingressEventBatch: async ({ events: batch }) => {
        events.push(...batch);
      },
    });

    const response = await client.startInvocation({
      runtimeEndpoint: "in-process://hosted",
      auth: { mode: "workload_token", token: "runtime-token" },
      idempotencyKey: "invoke-1",
      requestBody: {
        protocol_version: RUNTIME_PROTOCOL_VERSION,
        invocation_id: "invocation-1",
        turn_context: { thread_id: "thread-1", turn_id: "turn-1" },
        job_context: null,
        capability_directives: [
          {
            capability_type: "agent",
            capability_id: "agent-revision-1",
            mode: "preferred",
          },
        ],
        input_items: [{ type: "user_message", content: { text: "你好" } }],
        context_handle: "context-1",
        gateway_endpoints: {
          events: "in-process://events",
          cancel: "in-process://cancel",
          resume: "in-process://resume",
          steer: "in-process://steer",
          tools: "in-process://tools",
          tool_calls: "in-process://tool-calls",
          user_action_requests: "in-process://user-action-requests",
          capability_actions: "in-process://capability-actions",
        },
        governance_config: {
          revision_id: "gov-rev-1",
          config_digest: "sha256:test",
          config: {},
        },
        gateway_access: {
          access_token: "gw-token",
          expires_at: new Date(Date.now() + 60000).toISOString(),
        },
        execution_limits: { max_invocation_seconds: 600, max_event_bytes: 1_048_576 },
        trace_context: { trace_id: "trace-1", span_id: "span-1" },
      },
    });

    expect(response.accepted).toBe(true);
    expect(modelCalls).toBe(0);
    expect(events).toEqual([]);

    await (client as InProcessHostedRuntimeClient).launchAcceptedInvocation(
      "invocation-1",
      "configured-model",
    );

    expect(modelCalls).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "harness.action.proposed",
      "harness.action.started",
      "response.completed",
      "harness.action.completed",
      "execution.completed",
    ]);
    expect(events.find((event) => event.type === "response.completed")?.payload).toMatchObject({
      text: "模型回复：你好",
      model_ref: "configured-model",
    });
  });

  it("尚未启动时不暴露 Agent Loop Promise", () => {
    const client = createInProcessHostedRuntimeClient({
      ...createDirectResponsePorts(async () => "已完成"),
      ingressEventBatch: async () => {},
    });

    expect((client as InProcessHostedRuntimeClient).getLastLaunchPromise()).toBeNull();
  });
});
