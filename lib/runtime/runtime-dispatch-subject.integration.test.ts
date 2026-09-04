import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { RUNTIME_PROTOCOL_VERSION } from "@/lib/runtime/runtime-client";
import { TrustedExecutionSubjectError } from "@/lib/runtime/transport/execution-subject";
import { beforeEach } from "vitest";
import { describe, expect, it, vi } from "vitest";

describe("runtime dispatch trusted subject", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("fails before dispatch when the trusted subject is missing", async () => {
    await expect(
      (dispatchInvocationForTurn as unknown as (input: unknown) => Promise<unknown>)({
        tenantId: "tenant-a",
        turnId: "turn-a",
      }),
    ).rejects.toBeInstanceOf(TrustedExecutionSubjectError);
    expect(await db.select().from(invocationTable)).toHaveLength(0);
    expect(await db.select().from(executionBindingTable)).toHaveLength(0);
  });

  it("Hosted launch only forwards durable invocation identity to the application service", async () => {
    const start = vi.fn(async ({ invocationId }: { invocationId: string }) => ({
      status: "resumed" as const,
      invocationId,
      runtime: "hosted" as const,
    }));
    const client = createInProcessHostedRuntimeClient({
      tenantId: "tenant-a",
      applicationService: {
        start,
        resume: vi.fn(),
        cancel: vi.fn(),
        steer: vi.fn(),
      },
    });
    await client.startInvocation({
      runtimeEndpoint: "in-process://hosted",
      auth: { mode: "workload_token", token: "runtime-token" },
      idempotencyKey: "invocation-subject",
      requestBody: {
        protocol_version: RUNTIME_PROTOCOL_VERSION,
        invocation_id: "invocation-subject",
        turn_context: { thread_id: "thread-a", turn_id: "turn-a" },
        job_context: null,
        input_items: [{ type: "user_message", content: { text: "你好" } }],
        context_handle: "context-handle",
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
        governance_config: { revision_id: "gov-1", config_digest: "sha256:test", config: {} },
        gateway_access: {
          access_token: "gateway-token",
          expires_at: "2026-09-04T03:00:00.000Z",
        },
        workspace: { workspace_binding_id: null, workspace_type: "none" },
        execution_limits: { max_invocation_seconds: 60, max_event_bytes: 1024 },
        trace_context: { trace_id: "trace-a", span_id: "span-a" },
      },
    });

    await client.launchAcceptedInvocation("invocation-subject");
    expect(start).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      invocationId: "invocation-subject",
      idempotencyKey: "hosted-start:invocation-subject",
    });
  });
});
