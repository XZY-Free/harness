import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import {
  type RuntimeCancelTransportRequest,
  type RuntimeEventTransportRequest,
  type RuntimeHeartbeatTransportRequest,
  type RuntimeHttpClient,
  type RuntimeSafePointReleaseTransportRequest,
  type RuntimeSafePointTransportRequest,
  type RuntimeStartTransportRequest,
  type RuntimeSteerTransportRequest,
  defaultRuntimeCapabilities,
} from "@/lib/runtime/runtime-client";
import type {
  CancelResponse,
  HeartbeatResponse,
  RuntimeCapabilities,
  RuntimeStartResponse,
  SteerResponse,
} from "@/lib/runtime/runtime-protocol";

export interface InProcessHostedRuntimeClient extends RuntimeHttpClient {
  launchAcceptedInvocation(invocationId: string): Promise<void>;
  getLastLaunchPromise(): Promise<void> | null;
}

/** Hosted Runtime adapter. It receives only durable invocation identity and immutable request facts. */
export function createInProcessHostedRuntimeClient(params: {
  tenantId: string;
  applicationService: HostedRuntimeApplicationService;
  eventSink?: (request: RuntimeEventTransportRequest) => Promise<unknown>;
}): InProcessHostedRuntimeClient {
  let lastLaunchPromise: Promise<void> | null = null;
  const defaults = defaultRuntimeCapabilities();
  const capabilities: RuntimeCapabilities = {
    ...defaults,
    features: {
      ...defaults.features,
      // The in-process reference does not implement a managed WorkspaceHost
      // safe-point handshake, so it must not advertise checkpoint recovery.
      workspaceModes: ["NO_PLATFORM_WORKSPACE"],
    },
  };

  function assertWorkloadAuth(request: { auth: { mode: string } }): void {
    if (request.auth.mode !== "workload_token")
      throw new Error("InProcessHostedRuntime 只接受 workload_token");
  }

  function startResult(request: RuntimeStartTransportRequest): RuntimeStartResponse {
    return {
      protocolVersion: 3,
      authority: request.request.authority,
      semanticRequestDigest: request.request.semanticRequestDigest,
      accepted: true,
      remoteSessionRef: `hosted-session:${request.request.authority.sessionBindingId}`,
      remoteExecutionRef: `hosted-execution:${request.request.authority.invocationId}:${request.request.authority.ownershipId}`,
      capabilitiesDigest: capabilities.contractDigest,
      acceptedAt: Date.now(),
    };
  }

  function launch(input: {
    invocationId: string;
    idempotencyKey: string;
    mode: "start" | "resume";
    resumePayload?: unknown;
  }): Promise<void> {
    const operation =
      input.mode === "start"
        ? params.applicationService.start({
            tenantId: params.tenantId,
            invocationId: input.invocationId,
            idempotencyKey: input.idempotencyKey,
          })
        : params.applicationService.resume({
            tenantId: params.tenantId,
            invocationId: input.invocationId,
            idempotencyKey: input.idempotencyKey,
            resumePayload: input.resumePayload,
          });
    lastLaunchPromise = operation.then(() => undefined);
    return lastLaunchPromise;
  }

  return {
    async probeCapabilities(): Promise<RuntimeCapabilities> {
      return capabilities;
    },
    async startInvocation(request) {
      assertWorkloadAuth(request);
      const result = startResult(request);
      void launch({
        invocationId: request.request.authority.invocationId,
        idempotencyKey: request.idempotencyKey,
        mode: "start",
      });
      return result;
    },
    async resumeInvocation(request) {
      assertWorkloadAuth(request);
      const result = startResult(request);
      void launch({
        invocationId: request.request.authority.invocationId,
        idempotencyKey: request.idempotencyKey,
        mode: "resume",
        resumePayload: request.request.inputs,
      });
      return result;
    },
    async postEventBatch(request) {
      assertWorkloadAuth(request);
      if (!params.eventSink)
        throw new RuntimeHttpClientError("protocol", "Hosted Runtime 未配置 RuntimeEvent sink");
      return params.eventSink(request);
    },
    async heartbeat(_request: RuntimeHeartbeatTransportRequest): Promise<HeartbeatResponse> {
      throw new RuntimeHttpClientError(
        "protocol",
        "Hosted Runtime heartbeat 由平台 Runtime Ingress 处理",
      );
    },
    async cancelInvocation(request: RuntimeCancelTransportRequest): Promise<CancelResponse> {
      assertWorkloadAuth(request);
      await params.applicationService.cancel({
        tenantId: params.tenantId,
        invocationId: request.invocationId,
        idempotencyKey: request.idempotencyKey,
        reason: request.request.reasonCode,
      });
      return {
        accepted: true,
        targetAuthority: request.request.targetAuthority,
        stopState: "requested",
      };
    },
    async steerInvocation(request: RuntimeSteerTransportRequest): Promise<SteerResponse> {
      assertWorkloadAuth(request);
      await params.applicationService.steer({
        tenantId: params.tenantId,
        invocationId: request.invocationId,
        idempotencyKey: request.idempotencyKey,
        steerPayload: {
          inputRef: request.request.inputRef,
          inputDigest: request.request.inputDigest,
        },
      });
      return {
        accepted: true,
        commandId: request.request.commandId,
        targetAuthority: request.request.targetAuthority,
        inputDigest: request.request.inputDigest,
      };
    },
    async requestSafePoint(_request: RuntimeSafePointTransportRequest) {
      throw new RuntimeHttpClientError(
        "protocol",
        "Hosted Runtime 未声明 Checkpoint capability",
        undefined,
        undefined,
        {
          stableCode: "RUNTIME_CAPABILITY_MISMATCH",
          retryable: false,
        },
      );
    },
    async releaseSafePoint(_request: RuntimeSafePointReleaseTransportRequest): Promise<void> {
      throw new RuntimeHttpClientError(
        "protocol",
        "Hosted Runtime 未声明 Checkpoint capability",
        undefined,
        undefined,
        {
          stableCode: "RUNTIME_CAPABILITY_MISMATCH",
          retryable: false,
        },
      );
    },
    launchAcceptedInvocation(invocationId) {
      return launch({ invocationId, idempotencyKey: `start:${invocationId}`, mode: "start" });
    },
    getLastLaunchPromise() {
      return lastLaunchPromise;
    },
  };
}
