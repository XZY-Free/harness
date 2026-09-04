import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentCall } from "@/lib/agents/calls/domain/agent-call";
import type { ControlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { describe, expect, it, vi } from "vitest";
import { createInvocationContinuationHandler } from "./invocation-continuation";

describe("Agent waiting_user durable coordination", () => {
  it("只由持久 continuation 协调，执行器不再吞掉协调错误", async () => {
    const executorSource = readFileSync(
      resolve(process.cwd(), "lib/agents/calls/application/agent-action-executor.ts"),
      "utf8",
    );
    expect(executorSource).not.toContain("coordinateAgentInputRequired");
    expect(executorSource).not.toContain("Harness recovery 尚未完成");

    const coordinate = vi.fn(async () => undefined);
    const handler = createInvocationContinuationHandler({
      getAgentCall: async () =>
        ({
          id: "call-waiting",
          tenantId: "tenant-1",
          parentInvocationId: "invocation-1",
          state: "waiting_user",
          versionNo: 2,
        }) as AgentCall,
      coordinateWaitingUser: coordinate,
      resumeParent: vi.fn(),
      resumeAfterAgentResponse: vi.fn(),
      resumeAgentFromUserAction: vi.fn(),
    });
    const event = {
      id: "event-waiting",
      tenantId: "tenant-1",
      eventType: "agent_call.continuation.requested",
      aggregateId: "call-waiting",
      payloadJson: {
        parent_invocation_id: "invocation-1",
        agent_call_id: "call-waiting",
        source_version: 2,
        kind: "coordinate_user_input",
      },
    } as ControlPlaneOutboxEvent;

    await handler(event);

    expect(coordinate).toHaveBeenCalledOnce();
  });
});
