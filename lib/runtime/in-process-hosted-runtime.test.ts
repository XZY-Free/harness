import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { RUNTIME_PROTOCOL_VERSION } from "@/lib/runtime/runtime-client";
import { describe, expect, it, vi } from "vitest";

function applicationService(): HostedRuntimeApplicationService {
  return {
    start: vi.fn(async ({ invocationId }) => ({
      status: "resumed" as const,
      invocationId,
      runtime: "hosted" as const,
    })),
    resume: vi.fn(async ({ invocationId }) => ({
      status: "resumed" as const,
      invocationId,
      runtime: "hosted" as const,
    })),
    cancel: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
  };
}

function startRequest(invocationId: string) {
  return {
    runtimeEndpoint: "in-process://hosted",
    auth: { mode: "workload_token" as const, token: "runtime-token" },
    idempotencyKey: `start:${invocationId}`,
    requestBody: {
      protocol_version: RUNTIME_PROTOCOL_VERSION,
      invocation_id: invocationId,
      turn_context: { thread_id: "thread-1", turn_id: "turn-1" },
      job_context: null,
      input_items: [],
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
      governance_config: { revision_id: "gov-1", config_digest: "sha256:test", config: {} },
      gateway_access: {
        access_token: "gateway-token",
        expires_at: "2026-09-05T00:00:00.000Z",
      },
      execution_limits: { max_invocation_seconds: 60, max_event_bytes: 1024 },
      trace_context: { trace_id: "trace-1", span_id: "span-1" },
    },
  };
}

describe("InProcessHostedRuntimeClient", () => {
  it("start 不保存请求，新实例仍可只凭 invocationId 启动 durable application service", async () => {
    const service = applicationService();
    const first = createInProcessHostedRuntimeClient({
      tenantId: "tenant-1",
      applicationService: service,
    });
    const response = await first.startInvocation(startRequest("invocation-1"));
    expect(response.accepted).toBe(true);
    expect(service.start).not.toHaveBeenCalled();

    const fresh = createInProcessHostedRuntimeClient({
      tenantId: "tenant-1",
      applicationService: service,
    });
    await fresh.launchAcceptedInvocation("invocation-1");
    expect(service.start).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      invocationId: "invocation-1",
      idempotencyKey: "hosted-start:invocation-1",
    });
  });

  it("cancel/resume/steer 全部进入正式应用服务", async () => {
    const service = applicationService();
    const client = createInProcessHostedRuntimeClient({
      tenantId: "tenant-1",
      applicationService: service,
    });
    const common = {
      runtimeEndpoint: "in-process://hosted",
      auth: { mode: "workload_token" as const, token: "runtime-token" },
      invocationId: "invocation-1",
      idempotencyKey: "command-1",
    };
    await client.cancelInvocation({ ...common, requestBody: { reason: "user_cancel" } });
    await client.resumeInvocation({
      ...common,
      requestBody: {
        resume_payload: { request_id: "uar-1" },
        gateway_access: { access_token: "gw", expires_at: "2026-09-05T00:00:00.000Z" },
      },
    });
    await client.steerInvocation({ ...common, requestBody: { steer_payload: { text: "继续" } } });

    expect(service.cancel).toHaveBeenCalledOnce();
    expect(service.resume).toHaveBeenCalledOnce();
    expect(service.steer).toHaveBeenCalledOnce();
  });

  it("尚未启动时不暴露 Agent Loop Promise", () => {
    const client = createInProcessHostedRuntimeClient({
      tenantId: "tenant-1",
      applicationService: applicationService(),
    });
    expect(client.getLastLaunchPromise()).toBeNull();
  });
});
