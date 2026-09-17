import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import {
  type FrozenCapabilityEvidence,
  expectedCapabilityManifestDigest,
} from "@/lib/runtime/application/runtime-capability-evidence";
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
  getLastLaunchPromise(): Promise<void> | null;
}

/** Hosted Runtime adapter. It receives only durable invocation identity and immutable request facts. */
export function createInProcessHostedRuntimeClient(params: {
  tenantId: string;
  applicationService: HostedRuntimeApplicationService;
  eventSink?: (request: RuntimeEventTransportRequest) => Promise<unknown>;
  /**
   * R02 §3：该 Hosted Runtime 的**冻结发布能力证据**（来自 Binding 的 RuntimeRevision）。
   * 接纳回执的 capabilitiesDigest 必须由它计算，不能是本进程自报能力的摘要——
   * 那会形成与发布事实不同的比对源（即原先的 in-process 免校验分支）。
   */
  publishedCapabilityEvidence: FrozenCapabilityEvidence;
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

  /**
   * R02 §3：接纳回执的 capability 摘要必须等于**发布证据**的摘要。同时校验请求携带的
   * authority.runtimeRevisionId 与本适配器被装配时的冻结 Revision 一致，避免用别的
   * Revision 的摘要回答本次接纳。
   */
  function startResult(request: RuntimeStartTransportRequest): RuntimeStartResponse {
    if (
      request.request.authority.runtimeRevisionId !==
      params.publishedCapabilityEvidence.runtimeRevisionId
    ) {
      throw new RuntimeHttpClientError(
        "protocol",
        "Hosted Runtime 请求的 RuntimeRevision 与冻结发布证据不一致",
        undefined,
        undefined,
        { stableCode: "RUNTIME_CAPABILITY_MISMATCH", retryable: false },
      );
    }
    return {
      protocolVersion: 3,
      authority: request.request.authority,
      semanticRequestDigest: request.request.semanticRequestDigest,
      accepted: true,
      remoteSessionRef: `hosted-session:${request.request.authority.sessionBindingId}`,
      remoteExecutionRef: `hosted-execution:${request.request.authority.invocationId}:${request.request.authority.ownershipId}`,
      capabilitiesDigest: expectedCapabilityManifestDigest(params.publishedCapabilityEvidence),
      acceptedAt: Date.now(),
    };
  }

  function launch(input: {
    invocationId: string;
    idempotencyKey: string;
    mode: "start" | "resume";
    /** R02 §2：转交 Start/Resume 的准确 authority 与 Session 启动身份。 */
    authority: RuntimeStartTransportRequest["request"]["authority"];
    resumePayload?: unknown;
  }): Promise<void> {
    const operation =
      input.mode === "start"
        ? params.applicationService.start({
            tenantId: params.tenantId,
            invocationId: input.invocationId,
            idempotencyKey: input.idempotencyKey,
            authority: input.authority,
          })
        : params.applicationService.resume({
            tenantId: params.tenantId,
            invocationId: input.invocationId,
            idempotencyKey: input.idempotencyKey,
            authority: input.authority,
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
        authority: request.request.authority,
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
        authority: request.request.authority,
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
        // R03 §6：按请求携带的目标 Authority 关门，不按 invocationId 重新解析 Owner。
        authority: request.request.targetAuthority,
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
        // R03 §6：Steer 也必须携带目标 Authority（命令接受时已固定）。
        authority: request.request.targetAuthority,
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
    getLastLaunchPromise() {
      return lastLaunchPromise;
    },
  };
}
