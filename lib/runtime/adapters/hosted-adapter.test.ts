import {
  createHostedAdapter,
  hostedAdapterCapabilities,
} from "@/lib/runtime/adapters/hosted-adapter";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";
import { describe, expect, it, vi } from "vitest";

const authority: AuthorityIdentity = {
  invocationId: "00000000-0000-4000-8000-000000000001",
  runtimeRevisionId: "00000000-0000-4000-8000-000000000002",
  attemptId: "00000000-0000-4000-8000-000000000003",
  ownershipId: "00000000-0000-4000-8000-000000000004",
  leaseEpoch: "1",
  sessionBindingId: "00000000-0000-4000-8000-000000000005",
};

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

describe("Hosted Runtime adapter", () => {
  it("声明唯一 RuntimeProtocol 所要求的能力，且不虚报 checkpoint-restorable", async () => {
    const capabilities = hostedAdapterCapabilities();
    expect(capabilities.protocolVersion).toBe(3);
    expect(capabilities.features).toMatchObject({
      heartbeat: true,
      durableStartIdempotency: true,
      startedEvent: true,
      exactReplay: true,
      cancel: true,
      resume: true,
      steer: true,
    });
    expect(capabilities.features.workspaceModes).not.toContain("CHECKPOINT_RESTORABLE");
    await expect(
      createHostedAdapter({
        platformEndpoint: "in-process://platform",
        platformAuthToken: "token",
      }).probeCapabilities(),
    ).resolves.toEqual(capabilities);
  });

  it("Job start 返回绑定同一 Authority 的运输接纳，不在 Adapter 内伪造用户执行", async () => {
    const adapter = createHostedAdapter({
      platformEndpoint: "in-process://platform",
      platformAuthToken: "token",
    });
    const result = await adapter.startInvocation({
      invocationId: authority.invocationId,
      authority,
      tenantId: "tenant",
      threadId: null,
      turnId: null,
      inputItems: [{ type: "user_message", content: { text: "job input" } }],
      gatewayEndpoints: {
        events: "https://platform.example/events",
        heartbeat: "https://platform.example/heartbeat",
        context: "https://platform.example/context",
        capabilityActions: "https://platform.example/capability-actions",
        toolCalls: "https://platform.example/tool-calls",
        userActions: "https://platform.example/user-actions",
      },
      authToken: "runtime-token",
    });

    expect(result.response).toMatchObject({ protocolVersion: 3, authority, accepted: true });
    expect(result.response.remoteSessionRef).toBeTruthy();
    expect(result.response.remoteExecutionRef).toBeTruthy();
    expect(adapter.getLastLoopPromise?.()).toBeNull();
  });

  it("cancel、resume 和 steer 只调用正式应用服务，并携带 durable Invocation identity", async () => {
    const service = applicationService();
    const adapter = createHostedAdapter({
      platformEndpoint: "in-process://platform",
      platformAuthToken: "token",
      tenantId: "tenant",
      applicationService: service,
    });

    await adapter.handleCancel({
      invocationId: authority.invocationId,
      authority,
      reason: "user_cancel",
    });
    const resumed = await adapter.handleResume({
      invocationId: authority.invocationId,
      authority,
      resumePayload: { requestId: "input" },
    });
    const steered = await adapter.handleSteer({
      invocationId: authority.invocationId,
      authority,
      steerPayload: { inputRef: "input:1" },
    });

    expect(service.cancel).toHaveBeenCalledWith({
      tenantId: "tenant",
      invocationId: authority.invocationId,
      idempotencyKey: `hosted-cancel:${authority.invocationId}`,
      reason: "user_cancel",
    });
    expect(service.resume).toHaveBeenCalledWith({
      tenantId: "tenant",
      invocationId: authority.invocationId,
      idempotencyKey: `hosted-resume:${authority.invocationId}`,
      resumePayload: { requestId: "input" },
    });
    expect(service.steer).toHaveBeenCalledWith({
      tenantId: "tenant",
      invocationId: authority.invocationId,
      idempotencyKey: `hosted-steer:${authority.invocationId}`,
      steerPayload: { inputRef: "input:1" },
    });
    expect(resumed.response.authority).toEqual(authority);
    expect(steered.response.targetAuthority).toEqual(authority);
  });
});
