import { randomUUID } from "node:crypto";
import { hostedAdapterCapabilities } from "@/lib/runtime/adapters/hosted-adapter";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import type {
  CancelInvocationRequest,
  CancelInvocationResponse,
  ResumeInvocationRequest,
  ResumeInvocationResponse,
  RuntimeCapabilitiesResponse,
  RuntimeHttpClient,
  StartInvocationRequest,
  StartInvocationResponse,
  SteerInvocationRequest,
  SteerInvocationResponse,
} from "@/lib/runtime/runtime-client";

export interface InProcessHostedRuntimeClient extends RuntimeHttpClient {
  /** 平台已把 Invocation 持久化为 running 后，仅凭 id 从 DB 重建并启动。 */
  launchAcceptedInvocation(invocationId: string): Promise<void>;
  /** 最近一次启动任务，供集成测试等待异步 Agent Loop 完成。 */
  getLastLaunchPromise(): Promise<void> | null;
}

/** Hosted local transport。请求内容不作为 restart/recovery Authority。 */
export function createInProcessHostedRuntimeClient(params: {
  tenantId: string;
  applicationService: HostedRuntimeApplicationService;
}): InProcessHostedRuntimeClient {
  let lastLaunchPromise: Promise<void> | null = null;

  return {
    async probeCapabilities(): Promise<RuntimeCapabilitiesResponse> {
      return hostedAdapterCapabilities();
    },

    async startInvocation(request: StartInvocationRequest): Promise<StartInvocationResponse> {
      if (request.auth.mode !== "workload_token") {
        throw new Error(`InProcessHostedRuntime 收到非法 auth mode（${request.auth.mode}）`);
      }
      return {
        invocation_id: request.requestBody.invocation_id,
        accepted: true,
        attempt_no: request.requestBody.attempt?.attempt_no ?? 1,
        runtime_session_ref: `hosted-${randomUUID()}`,
        runtime_execution_ref: `hosted-exec-${randomUUID()}`,
        capabilities: hostedAdapterCapabilities(),
      };
    },

    launchAcceptedInvocation(invocationId: string): Promise<void> {
      lastLaunchPromise = params.applicationService
        .start({
          tenantId: params.tenantId,
          invocationId,
          idempotencyKey: `hosted-start:${invocationId}`,
        })
        .then(() => undefined);
      return lastLaunchPromise;
    },

    getLastLaunchPromise(): Promise<void> | null {
      return lastLaunchPromise;
    },

    async cancelInvocation(request: CancelInvocationRequest): Promise<CancelInvocationResponse> {
      await params.applicationService.cancel({
        tenantId: params.tenantId,
        invocationId: request.invocationId,
        idempotencyKey: request.idempotencyKey,
        reason: request.requestBody.reason,
      });
      return {
        invocation_id: request.invocationId,
        cancelled: true,
        attempt_no: 1,
      };
    },

    async resumeInvocation(request: ResumeInvocationRequest): Promise<ResumeInvocationResponse> {
      const result = await params.applicationService.resume({
        tenantId: params.tenantId,
        invocationId: request.invocationId,
        idempotencyKey: request.idempotencyKey,
        resumePayload: request.requestBody.resume_payload,
      });
      return {
        invocation_id: request.invocationId,
        resumed: result.status !== "handled_noop",
        attempt_no: 1,
        requires_redispatch: false,
      };
    },

    async steerInvocation(request: SteerInvocationRequest): Promise<SteerInvocationResponse> {
      await params.applicationService.steer({
        tenantId: params.tenantId,
        invocationId: request.invocationId,
        idempotencyKey: request.idempotencyKey,
        steerPayload: request.requestBody.steer_payload,
      });
      return {
        invocation_id: request.invocationId,
        steered: true,
        attempt_no: 1,
      };
    },
  };
}
