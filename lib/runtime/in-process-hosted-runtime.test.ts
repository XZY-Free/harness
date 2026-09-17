import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import type {
  AuthorityIdentity,
  CancelRequest,
  ExecutionBinding,
  RuntimeStartRequest,
  SteerRequest,
} from "@/lib/runtime/runtime-protocol";
import { describe, expect, it, vi } from "vitest";

const authority: AuthorityIdentity = {
  invocationId: "00000000-0000-4000-8000-000000000001",
  runtimeRevisionId: "00000000-0000-4000-8000-000000000002",
  attemptId: "00000000-0000-4000-8000-000000000003",
  ownershipId: "00000000-0000-4000-8000-000000000004",
  leaseEpoch: "1",
  sessionBindingId: "00000000-0000-4000-8000-000000000005",
};
const digest = `sha256:${"0".repeat(64)}`;

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

function startRequest(): RuntimeStartRequest {
  const now = Date.now();
  const context = {
    common: {
      contractVersion: 1 as const,
      tenantId: authority.invocationId,
      invocationId: authority.invocationId,
      bindingDigest: digest,
      initialCompression: null,
      principal: { type: "service" as const, id: "test", source: "trusted_service" as const },
      runtimeRevisionId: authority.runtimeRevisionId,
      policy: { revisionId: authority.runtimeRevisionId, digest },
      workspace: { bindingId: authority.attemptId, contractDigest: digest },
      environment: { mode: "NO_PLATFORM_ENVIRONMENT" as const },
      contextSourceDigest: digest,
      issuedAt: now,
      expiresAt: now + 60_000,
      jti: authority.sessionBindingId,
    },
    subject: {
      type: "job" as const,
      jobId: authority.invocationId,
      inputKind: "inline" as const,
      inputHash: digest,
      triggerRef: "test",
    },
  };
  return {
    protocolVersion: 3,
    authority,
    intentType: "start",
    semanticRequestDigest: digest,
    executionBinding: {
      bindingDigest: digest,
      runtimeRevisionId: authority.runtimeRevisionId,
      policyRefs: [authority.runtimeRevisionId],
      governanceRefs: [authority.runtimeRevisionId],
      capabilityRefs: [authority.runtimeRevisionId],
      modelRefs: [],
      allowedEgress: [],
    } satisfies ExecutionBinding,
    context,
    inputs: [{ kind: "inline", digest }],
    environment: { mode: "NO_PLATFORM_ENVIRONMENT" },
    workspace: { mode: "NONE" },
    activationDigest: digest,
    recovery: { kind: "initial" },
    producerSequenceStart: "1",
    callbackEndpoints: {
      events: "https://test.invalid/events",
      heartbeat: "https://test.invalid/heartbeat",
      context: "https://test.invalid/context",
      capabilityActions: "https://test.invalid/capability-actions",
      toolCalls: "https://test.invalid/tool-calls",
      userActions: "https://test.invalid/user-actions",
    },
    credentials: {
      runtimeToken: "runtime-token",
      gatewayToken: "gateway-token",
      expiresAt: now + 60_000,
    },
    executionLimits: {
      maxEventBytes: 1024,
      maxBatchEvents: 10,
      maxBatchBytes: 8192,
      dispatchDeadlineMs: 60_000,
      executionTimeoutMs: 60_000,
    },
  };
}

function cancelRequest(): CancelRequest {
  return {
    protocolVersion: 3,
    commandId: "00000000-0000-4000-8000-000000000006",
    targetAuthority: authority,
    reasonCode: "user_cancel",
  };
}

function steerRequest(): SteerRequest {
  return {
    protocolVersion: 3,
    commandId: "00000000-0000-4000-8000-000000000007",
    targetAuthority: authority,
    inputRef: "input:test-guidance",
    inputDigest: digest,
  };
}

const commonAuth = {
  runtimeEndpoint: "in-process://hosted",
  auth: { mode: "workload_token" as const, token: "runtime-token" },
};

describe("InProcessHostedRuntimeClient", () => {
  it("start 只向 application service 交付 durable invocation identity", async () => {
    const service = applicationService();
    const first = createInProcessHostedRuntimeClient({
      tenantId: authority.invocationId,
      applicationService: service,
    });
    const response = await first.startInvocation({
      ...commonAuth,
      idempotencyKey: `start:${authority.ownershipId}`,
      request: startRequest(),
    });
    expect(response.accepted).toBe(true);
    expect(service.start).toHaveBeenCalledWith({
      tenantId: authority.invocationId,
      invocationId: authority.invocationId,
      idempotencyKey: `start:${authority.ownershipId}`,
    });
  });

  it("cancel/resume/steer 全部进入正式应用服务", async () => {
    const service = applicationService();
    const client = createInProcessHostedRuntimeClient({
      tenantId: authority.invocationId,
      applicationService: service,
    });
    const cancel = {
      ...commonAuth,
      invocationId: authority.invocationId,
      idempotencyKey: "command-1",
    };
    const resume = { ...commonAuth, idempotencyKey: "command-1" };
    await client.cancelInvocation({ ...cancel, request: cancelRequest() });
    await client.resumeInvocation({
      ...resume,
      request: { ...startRequest(), intentType: "resume", inputs: [{ kind: "inline", digest }] },
    });
    await client.steerInvocation({ ...cancel, request: steerRequest() });

    expect(service.cancel).toHaveBeenCalledOnce();
    expect(service.resume).toHaveBeenCalledOnce();
    expect(service.steer).toHaveBeenCalledOnce();
  });

  it("resume 先确认恢复，再由后台继续同一 Invocation", async () => {
    let finishResume: (() => void) | undefined;
    const service = applicationService();
    type ResumeResult = Awaited<ReturnType<HostedRuntimeApplicationService["resume"]>>;
    service.resume = vi.fn(
      async ({ invocationId }): Promise<ResumeResult> =>
        await new Promise<ResumeResult>((resolve) => {
          finishResume = () => resolve({ status: "resumed", invocationId, runtime: "hosted" });
        }),
    );
    const client = createInProcessHostedRuntimeClient({
      tenantId: authority.invocationId,
      applicationService: service,
    });

    const response = await client.resumeInvocation({
      ...commonAuth,
      idempotencyKey: "resume-1",
      request: { ...startRequest(), intentType: "resume", inputs: [{ kind: "inline", digest }] },
    });
    expect(response.authority).toEqual(authority);
    expect(response.accepted).toBe(true);
    expect(service.resume).toHaveBeenCalledOnce();
    expect(client.getLastLaunchPromise()).not.toBeNull();

    finishResume?.();
    await client.getLastLaunchPromise();
  });

  it("尚未启动时不暴露 Agent Loop Promise", () => {
    const client = createInProcessHostedRuntimeClient({
      tenantId: authority.invocationId,
      applicationService: applicationService(),
    });
    expect(client.getLastLaunchPromise()).toBeNull();
  });
});
