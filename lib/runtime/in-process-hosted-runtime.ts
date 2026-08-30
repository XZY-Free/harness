import { randomUUID } from "node:crypto";
import {
  type AgentCallExecutor,
  type HostedModelContext,
  type RuntimeAdapter,
  type StartInvocationParams,
  type TransientEventBatchSink,
  createHostedAdapter,
  hostedAdapterCapabilities,
} from "@/lib/runtime/adapters/hosted-adapter";
import type { RuntimeCandidateEvent } from "@/lib/runtime/event-ingress-queries";
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

type ModelFn = (message: string, context: HostedModelContext) => Promise<string>;

interface PendingInvocation {
  readonly request: StartInvocationRequest;
  readonly response: StartInvocationResponse;
}

export interface InProcessHostedRuntimeClient extends RuntimeHttpClient {
  /**
   * 在平台已把 Invocation 持久化为 running 后启动 Agent Loop，避免终态事件抢在
   * invocation.started 之前落库。
   */
  launchAcceptedInvocation(invocationId: string, modelRef: string): Promise<void>;
  /** 最近一次启动任务，供集成测试等待异步 Agent Loop 完成。 */
  getLastLaunchPromise(): Promise<void> | null;
}

export function createInProcessHostedRuntimeClient(params: {
  modelFn: ModelFn;
  /** 平台租户 id（Harness Loop 调 AgentCall 时作用域）。 */
  tenantId?: string;
  /** Harness Loop → AgentCall 桥接器（有 required Agent 时调用）。 */
  agentCallExecutor?: AgentCallExecutor;
  ingressEventBatch: (params: {
    invocationId: string;
    events: RuntimeCandidateEvent[];
    producerSequenceStart: number;
  }) => Promise<void>;
  ingressTransientEventBatch?: TransientEventBatchSink;
}): InProcessHostedRuntimeClient {
  const pending = new Map<string, PendingInvocation>();
  let lastLaunchPromise: Promise<void> | null = null;

  function unsupported<T>(operation: string): Promise<T> {
    return Promise.reject(new Error(`InProcessHostedRuntime 不支持 ${operation}`));
  }

  return {
    async probeCapabilities(): Promise<RuntimeCapabilitiesResponse> {
      return hostedAdapterCapabilities();
    },

    async startInvocation(request: StartInvocationRequest): Promise<StartInvocationResponse> {
      const response: StartInvocationResponse = {
        invocation_id: request.requestBody.invocation_id,
        accepted: true,
        attempt_no: request.requestBody.attempt?.attempt_no ?? 1,
        runtime_session_ref: `hosted-${randomUUID()}`,
        runtime_execution_ref: `hosted-exec-${randomUUID()}`,
        capabilities: hostedAdapterCapabilities(),
      };
      pending.set(request.requestBody.invocation_id, { request, response });
      return response;
    },

    launchAcceptedInvocation(invocationId: string, modelRef: string): Promise<void> {
      lastLaunchPromise = (async () => {
        const invocation = pending.get(invocationId);
        if (!invocation) return;
        pending.delete(invocationId);

        // Hosted Runtime 只接受内部 Workload Token。
        if (invocation.request.auth.mode !== "workload_token") {
          throw new Error(
            `InProcessHostedRuntime 收到非法 auth mode（${invocation.request.auth.mode}）`,
          );
        }
        const platformAuthToken = invocation.request.auth.token;
        const adapter: RuntimeAdapter = createHostedAdapter({
          platformEndpoint: "in-process://platform",
          platformAuthToken,
          modelRef,
          modelFn: params.modelFn,
          eventBatchSink: params.ingressEventBatch,
          transientEventBatchSink: params.ingressTransientEventBatch,
        });
        const turnContext = invocation.request.requestBody.turn_context;
        const started = await adapter.startInvocation({
          invocationId,
          tenantId: params.tenantId,
          threadId: turnContext?.thread_id ?? null,
          turnId: turnContext?.turn_id ?? null,
          // Agent 与 Runtime Authority：本轮 capability requirements（required Agent）传给 Harness Loop。
          capabilityRequirements: invocation.request.requestBody.capability_requirements,
          agentCallExecutor: params.agentCallExecutor,
          inputItems: invocation.request.requestBody.input_items,
          contextHandle: invocation.request.requestBody.context_handle,
          gatewayEndpoints: invocation.request.requestBody.gateway_endpoints,
          workspace: invocation.request.requestBody.workspace ?? null,
          executionLimits: invocation.request.requestBody.execution_limits,
          traceContext: invocation.request.requestBody.trace_context,
          authToken: platformAuthToken,
        } satisfies StartInvocationParams);
        if (!started.accepted) {
          throw new Error(`InProcessHostedRuntime 拒绝 Invocation: ${invocationId}`);
        }
        await adapter.getLastLoopPromise?.();
      })();
      return lastLaunchPromise;
    },

    getLastLaunchPromise(): Promise<void> | null {
      return lastLaunchPromise;
    },

    cancelInvocation(_request: CancelInvocationRequest): Promise<CancelInvocationResponse> {
      return unsupported("取消 Invocation");
    },
    resumeInvocation(_request: ResumeInvocationRequest): Promise<ResumeInvocationResponse> {
      return unsupported("恢复 Invocation");
    },
    steerInvocation(_request: SteerInvocationRequest): Promise<SteerInvocationResponse> {
      return unsupported("引导 Invocation");
    },
  };
}
