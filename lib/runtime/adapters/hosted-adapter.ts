/**
 * V11 Hosted Runtime Adapter（S05-C05 参考实现）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §6（Invocation 生命周期）、§3.7-3.10（Steer/Cancel/Resume）
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §4（Runtime Protocol API）
 * - ../v11-agentkit-platform-development-plan/05-runtime-protocol-dispatch-and-agent-loop.md S05-C05
 *
 * 职责：
 * - 定义 RuntimeAdapter 接口（probeCapabilities / startInvocation / handleCancel / handleResume / handleSteer）。
 * - 定义 GatewayEndpoints / EventIngressClient / HostedAgentLoop 等共享类型与实现。
 * - createHostedAdapter：工厂函数，返回 Hosted 参考适配器。
 *   - startInvocation：生成 runtime_session_ref/runtime_execution_ref，异步启动 HostedAgentLoop。
 *   - handleCancel/handleResume/handleSteer：返回 Runtime ack，异步回传候选事件。
 * - 事件回传通过可注入的 EventBatchSink（HTTP 或直接调用 ingressEventBatch 仓储函数）。
 *
 * 关键约束：
 * - Adapter 不直读平台库和 Secret（通过 EventBatchSink 回传事件）。
 * - 正式文本必须在终态前形成 response.completed（由 HostedAgentLoop 保证）。
 * - Invocation 终态必须形成公开 Event（execution.completed/failed/cancelled）。
 * - producer_sequence 在整个 Invocation 内连续递增（Adapter 跟踪 nextSequence）。
 * - 模型声称"已完成"不等同于平台确认成功（由 ingress 映射决定终态）。
 * - Agent Loop 6 步：理解—查看索引—按需加载—行动—验证—继续/完成。
 */
import { randomUUID } from "node:crypto";
import { IngressInvocationTerminalError } from "@/lib/runtime/errors";
import type { RuntimeCandidateEvent } from "@/lib/runtime/event-ingress-queries";
import type {
  RuntimeCapabilitiesResponse,
  StartInvocationRequestBody,
} from "@/lib/runtime/runtime-client";

// ─── GatewayEndpoints 类型 ───────────────────────────────

/**
 * 平台 Gateway 端点集合（来自 startInvocation 请求体 gateway_endpoints）。
 *
 * Runtime 通过这些端点回传事件 / 发送命令。
 */
export interface GatewayEndpoints {
  /** 事件回传端点基础 URL（POST {events}/runtime/v1/invocations/{id}/events:batch）。 */
  events: string;
  /** cancel 命令端点。 */
  cancel: string;
  /** resume 命令端点。 */
  resume: string;
  /** steer 命令端点。 */
  steer: string;
}

// ─── EventIngressClient ─────────────────────────────────

/**
 * Event Ingress 客户端接口：Runtime 侧调用以回传候选事件批次。
 *
 * 两种实现：
 * - HTTP：调用平台 /runtime/v1/invocations/{id}/events:batch 路由（createHttpEventIngressClient）。
 * - 包装 EventBatchSink：测试用，绕过 HTTP 直接调用 ingressEventBatch 仓储。
 */
export interface EventIngressClient {
  /**
   * 回传候选事件批次。
   *
   * @param invocationId Invocation id
   * @param events 候选事件列表（按 producer_sequence 升序）
   * @param producerSequenceStart 本批次起始 producer_sequence（= events[0].producer_sequence）
   */
  postEventBatch(
    invocationId: string,
    events: RuntimeCandidateEvent[],
    producerSequenceStart: number,
  ): Promise<void>;
}

/**
 * 创建 HTTP Event Ingress 客户端。
 *
 * 调用平台 events:batch 路由（POST {gatewayEndpoints.events}/runtime/v1/invocations/{id}/events:batch）。
 *
 * @param params.gatewayEndpoints 平台 Gateway 端点
 * @param params.authToken 平台颁发的 Workload Token
 */
export function createHttpEventIngressClient(params: {
  gatewayEndpoints: GatewayEndpoints;
  authToken: string;
}): EventIngressClient {
  return {
    async postEventBatch(invocationId, events, producerSequenceStart) {
      const url = `${params.gatewayEndpoints.events}/runtime/v1/invocations/${invocationId}/events:batch`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${params.authToken}`,
        },
        body: JSON.stringify({
          events,
          producer_sequence_start: producerSequenceStart,
        }),
      });
      if (!resp.ok) {
        let message = `Event Ingress HTTP ${resp.status}`;
        try {
          const body = (await resp.json()) as { error?: { message?: string } };
          if (body?.error?.message) {
            message = body.error.message;
          }
        } catch {
          // 响应体非 JSON 或为空，使用默认 message
        }
        throw new Error(message);
      }
    },
  };
}

// ─── RuntimeAdapter 接口 ─────────────────────────────────

/**
 * Runtime Adapter 接口：Runtime 侧参考实现契约。
 *
 * HostedAdapter 和 VeADKAdapter 都实现此接口；
 * 路由层通过此接口调用 Adapter，不直接依赖具体实现。
 */
export interface RuntimeAdapter {
  /** 探测能力（对应 GET /runtime/v1/capabilities）。 */
  probeCapabilities(): Promise<RuntimeCapabilitiesResponse>;
  /** 启动 Invocation 执行 Agent Loop（对应 POST /runtime/v1/invocations）。 */
  startInvocation(params: StartInvocationParams): Promise<StartInvocationResult>;
  /** 处理 cancel 命令（对应 POST /runtime/v1/invocations/{id}:cancel）。 */
  handleCancel(params: CancelParams): Promise<CancelResult>;
  /** 处理 resume 命令（对应 POST /runtime/v1/invocations/{id}:resume）。 */
  handleResume(params: ResumeParams): Promise<ResumeResult>;
  /** 处理 steer 命令（对应 POST /runtime/v1/invocations/{id}:steer）。 */
  handleSteer(params: SteerParams): Promise<SteerResult>;
  /**
   * 获取最后一次 startInvocation 触发的 loop.run() Promise（测试用 await）。
   * 非 startInvocation 路径或未启动时返回 null。
   */
  getLastLoopPromise?(): Promise<HostedAgentLoopResult> | null;
}

// ─── 事件回传 Sink ────────────────────────────────────────

/**
 * 事件回传 Sink：把候选事件批次回传平台。
 *
 * 两种实现：
 * - HTTP：调用平台 /runtime/v1/invocations/{id}/events:batch 路由（生产默认）。
 * - 直接调用：调用 ingressEventBatch 仓储函数（测试用，绕过 HTTP）。
 */
export type EventBatchSink = (params: {
  invocationId: string;
  events: RuntimeCandidateEvent[];
  producerSequenceStart: number;
}) => Promise<void>;

/** 不持久化的 Runtime 增量事件 Sink。 */
export type TransientEventBatchSink = (params: {
  invocationId: string;
  transientSequenceStart: number;
  events: Array<{
    transient_id: string;
    transient_sequence: number;
    type: string;
    payload: Record<string, unknown>;
  }>;
}) => Promise<void>;

// ─── startInvocation 类型 ─────────────────────────────────

/** startInvocation 请求参数。 */
export interface StartInvocationParams {
  invocationId: string;
  /** 会话模式 Thread id（Job 模式为 null，不启动 Agent Loop）。 */
  threadId?: string | null;
  /** 会话模式 Turn id（Job 模式为 null）。 */
  turnId?: string | null;
  agentRevisionId: string;
  /** 输入 Item 列表（来自 startInvocation 请求体 input_items）。 */
  inputItems: unknown[];
  contextHandle?: string;
  /** 平台 Gateway 端点（HTTP sink 用）。 */
  gatewayEndpoints: GatewayEndpoints;
  workspace?: StartInvocationRequestBody["workspace"];
  executionLimits?: StartInvocationRequestBody["execution_limits"];
  traceContext?: StartInvocationRequestBody["trace_context"];
  /** 平台颁发的 Workload Token（HTTP sink 用）。 */
  authToken: string;
  /** 关联标识（X-Request-Id / traceparent）。 */
  correlationId?: string | null;
}

/** startInvocation 返回结果。 */
export interface StartInvocationResult {
  accepted: boolean;
  runtime_session_ref: string;
  runtime_execution_ref: string;
  capabilities: RuntimeCapabilitiesResponse;
}

// ─── 命令处理类型 ──────────────────────────────────────────

/** handleCancel 请求参数。 */
export interface CancelParams {
  invocationId: string;
  /** 取消原因（写入 execution.cancelled.payload.reason）。 */
  reason?: string;
  /** 取消发起者（写入 execution.cancelled.payload.cancelled_by）。 */
  cancelledBy?: string;
  /** 平台 Gateway 端点（HTTP sink 用）。 */
  gatewayEndpoints?: GatewayEndpoints;
  /** 平台颁发的 Workload Token（HTTP sink 用）。 */
  authToken?: string;
}

/** handleCancel 返回结果。 */
export interface CancelResult {
  cancel_state: "accepted";
  already_completed_effects_preserved: boolean;
}

/** handleResume 请求参数。 */
export interface ResumeParams {
  invocationId: string;
  /** resume payload（透传给 Runtime）。 */
  resumePayload?: unknown;
  /** 平台 Gateway 端点（HTTP sink 用）。 */
  gatewayEndpoints?: GatewayEndpoints;
  /** 平台颁发的 Workload Token（HTTP sink 用）。 */
  authToken?: string;
}

/** handleResume 返回结果。 */
export interface ResumeResult {
  resume_state: "accepted";
  runtime_execution_ref: string;
  requires_redispatch: boolean;
}

/** handleSteer 请求参数。 */
export interface SteerParams {
  invocationId: string;
  /** steer payload（透传给 Runtime）。 */
  steerPayload?: unknown;
  /** 平台 Gateway 端点（HTTP sink 用）。 */
  gatewayEndpoints?: GatewayEndpoints;
  /** 平台颁发的 Workload Token（HTTP sink 用）。 */
  authToken?: string;
}

/** handleSteer 返回结果。 */
export interface SteerResult {
  steer_state: "accepted";
  applies_at: "next_safe_point";
  generation_interrupted: boolean;
}

// ─── Hosted 能力声明 ──────────────────────────────────────

/**
 * Hosted Runtime 参考能力声明。
 *
 * 事实源：S05-C05 规范——Hosted Runtime 支持完整事件流 + cancel/resume/steer，
 * 不支持 dynamic_tools/user_action（本阶段），workspace_types=["cloud"]，
 * 不支持 filesystem_checkpoint。
 */
export function hostedAdapterCapabilities(): RuntimeCapabilitiesResponse {
  return {
    protocol_versions: ["1"],
    features: {
      event_stream: true,
      cancel: true,
      resume: true,
      steer: true,
      dynamic_tools: false,
      user_action: false,
      workspace_types: ["cloud"],
      filesystem_checkpoint: false,
    },
    limits: {
      max_invocation_seconds: 600,
      max_event_bytes: 1_048_576,
    },
  };
}

// ─── HostedAgentLoop ─────────────────────────────────────

/** HostedAgentLoop 参数。 */
export interface HostedAgentLoopParams {
  invocationId: string;
  threadId: string | null;
  turnId: string | null;
  agentRevisionId: string;
  inputItems: unknown[];
  contextHandle?: string;
  workspace?: StartInvocationRequestBody["workspace"];
  executionLimits?: StartInvocationRequestBody["execution_limits"];
  traceContext?: StartInvocationRequestBody["trace_context"];
  gatewayEndpoints: GatewayEndpoints;
  runtimeEndpoint: string;
  authToken: string;
  /** 可注入的 Event Ingress 客户端（测试用）；不传则用 HTTP 默认实现。 */
  ingressClient?: EventIngressClient;
  /** 模型执行器。未配置时拒绝执行，绝不生成伪造回复。 */
  modelFn?: (userMessage: string, context: HostedModelContext) => string | Promise<string>;
  /** response.delta 等短生命周期事件回传通道。 */
  transientEventBatchSink?: TransientEventBatchSink;
  /** 实际执行本轮的模型标识。 */
  modelRef?: string;
  /** 关联标识（X-Request-Id / traceparent）。 */
  correlationId?: string | null;
}

/** HostedAgentLoop 运行结果。 */
export interface HostedAgentLoopResult {
  /** 是否成功完成（execution.completed 已发送或被平台视为终态）。 */
  completed: boolean;
  /** Agent 回复文本（response.completed payload.text）。 */
  responseText: string;
  /** 失败原因（completed=false 时填）。 */
  failureReason?: string;
  /** 已发送的候选事件列表。 */
  sentEvents: RuntimeCandidateEvent[];
}

export interface HostedModelContext {
  contextHandle?: string;
  workspace?: StartInvocationRequestBody["workspace"];
  executionLimits?: StartInvocationRequestBody["execution_limits"];
  traceContext?: StartInvocationRequestBody["trace_context"];
  /** 模型每产生一段正文即调用；事件只进 transient 通道，不写持久账本。 */
  emitTextDelta?: (delta: string) => Promise<void>;
}

/**
 * 从 inputItems 中提取用户消息文本。
 *
 * inputItems 结构：[{ type: "user_message", content: { text: "..." } }]
 */
function extractUserMessage(inputItems: unknown[]): string {
  for (const item of inputItems) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "user_message") {
      const content = record.content;
      if (content && typeof content === "object") {
        const text = (content as Record<string, unknown>).text;
        if (typeof text === "string") {
          return text;
        }
      }
    }
  }
  return "";
}

/**
 * Hosted Runtime 参考 Agent Loop（简化版 6 步）。
 *
 * 6 步：理解—查看索引—按需加载—行动—验证—继续/完成。
 *
 * 简化实现：正文生成过程走 transient response.delta，完成后回传 2 个持久候选事件：
 * 1. response.completed（seq=1）：Agent 输出正式文本（model_ref 来自实际执行器配置）
 * 2. execution.completed（seq=2）：标记执行完成
 *
 * 容错：response.completed 会把 Invocation 转入 completed 终态，
 * execution.completed 会被 ingress 拒绝（IngressInvocationTerminalError）。
 * 捕获此错误视为成功（终态已达成）。
 */
export class HostedAgentLoop {
  private readonly params: HostedAgentLoopParams;
  private readonly sentEvents: RuntimeCandidateEvent[] = [];
  private nextSequence = 1;
  private nextTransientSequence = 1;

  constructor(params: HostedAgentLoopParams) {
    this.params = params;
  }

  /**
   * 执行 Agent Loop。
   *
   * @returns Loop 结果（completed/responseText/sentEvents）
   */
  async run(): Promise<HostedAgentLoopResult> {
    const ingressClient =
      this.params.ingressClient ??
      createHttpEventIngressClient({
        gatewayEndpoints: this.params.gatewayEndpoints,
        authToken: this.params.authToken,
      });
    try {
      const userMessage = extractUserMessage(this.params.inputItems);
      if (!this.params.modelFn) {
        throw new Error("Hosted Runtime 未配置模型执行器");
      }
      const responseText = await this.params.modelFn(userMessage, {
        contextHandle: this.params.contextHandle,
        workspace: this.params.workspace,
        executionLimits: this.params.executionLimits,
        traceContext: this.params.traceContext,
        emitTextDelta: this.params.transientEventBatchSink
          ? async (delta) => {
              if (!delta) return;
              const transientSequence = this.nextTransientSequence;
              this.nextTransientSequence += 1;
              await this.params.transientEventBatchSink?.({
                invocationId: this.params.invocationId,
                transientSequenceStart: transientSequence,
                events: [
                  {
                    transient_id: `hosted-response-delta-${randomUUID()}`,
                    transient_sequence: transientSequence,
                    type: "response.delta",
                    payload: { delta },
                  },
                ],
              });
            }
          : undefined,
      });
      // ─── 6 步压缩执行 ────────────────────────────────────
      // 1. 理解（模型执行器内部完成；正文增量走 transient 通道）
      // 2. 查看索引（简化：跳过）
      // 3. 按需加载（简化：跳过）
      // 4. 行动（response.completed：输出正式文本）
      // 5. 验证（简化：通过）
      // 6. 完成（execution.completed：标记终态）

      // 4. response.completed（seq=1）
      await this.sendEvent(ingressClient, "response.completed", {
        text: responseText,
        item_type: "agent_message",
        model_ref: this.params.modelRef ?? "unknown",
        finish_reason: "stop",
      });

      // 6. execution.completed（seq=2）— 容错 IngressInvocationTerminalError
      try {
        await this.sendEvent(ingressClient, "execution.completed", {
          finish_reason: "execution.completed",
        });
      } catch (err) {
        if (!(err instanceof IngressInvocationTerminalError)) {
          throw err;
        }
        // Invocation 已被 response.completed 转入 completed 终态；视为成功
      }

      return {
        completed: true,
        responseText,
        sentEvents: this.sentEvents,
      };
    } catch (err) {
      const isMissingModelExecutor = !this.params.modelFn;
      try {
        await this.sendEvent(ingressClient, "execution.failed", {
          error_code: isMissingModelExecutor
            ? "MODEL_EXECUTOR_UNAVAILABLE"
            : "MODEL_EXECUTION_FAILED",
          error_summary: isMissingModelExecutor ? "模型执行器未配置" : "模型调用失败",
        });
      } catch {
        // 失败事件的回传本身不可用时，保留原始失败结果供 Runtime 诊断。
      }
      return {
        completed: false,
        responseText: "",
        failureReason: err instanceof Error ? err.message : String(err),
        sentEvents: this.sentEvents,
      };
    }
  }

  /**
   * 发送单个候选事件（producer_sequence 自动递增）。
   */
  private async sendEvent(
    ingressClient: EventIngressClient,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const seq = this.nextSequence;
    const event: RuntimeCandidateEvent = {
      producer_event_id: `hosted-${type}-${randomUUID()}`,
      producer_sequence: seq,
      type,
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      payload,
    };
    this.sentEvents.push(event);
    this.nextSequence = seq + 1;
    await ingressClient.postEventBatch(this.params.invocationId, [event], seq);
  }
}

// ─── Adapter 内部状态 ─────────────────────────────────────

/** Adapter 实例内部状态（跟踪 producer_sequence 连续性 + loop promise）。 */
interface AdapterState {
  /** 下一个可用的 producer_sequence（整个 Invocation 内连续递增）。 */
  nextSequence: number;
  /** 最后一次 startInvocation 触发的 loop.run() Promise（测试 await）。 */
  lastLoopPromise: Promise<HostedAgentLoopResult> | null;
  /** 最后一次创建的 HostedAgentLoop 实例（诊断用）。 */
  lastLoop: HostedAgentLoop | null;
}

// ─── createHostedAdapter 工厂 ─────────────────────────────

/**
 * createHostedAdapter 工厂参数。
 */
export interface CreateHostedAdapterParams {
  /** 平台端点基础 URL（HTTP sink 用，如 https://platform.internal）。 */
  platformEndpoint: string;
  /** 平台颁发的 Workload Token（HTTP sink 用）。 */
  platformAuthToken: string;
  /** 可注入的事件回传 Sink（测试用；不传则用 HTTP 默认实现）。 */
  eventBatchSink?: EventBatchSink;
  /** 可注入的 transient 事件回传 Sink。 */
  transientEventBatchSink?: TransientEventBatchSink;
  /** 模型执行器。未配置时会拒绝生成，不允许任何伪造回复。 */
  modelFn?: (userMessage: string, context: HostedModelContext) => string | Promise<string>;
  /** 实际执行本轮的模型标识。 */
  modelRef?: string;
  /** ref 前缀（hosted / veadk-${appId}，默认 "hosted"）。 */
  refPrefix?: string;
}

/**
 * 创建 Hosted Runtime Adapter。
 *
 * - 接收平台的 dispatch（startInvocation），在内部执行简化版 Agent Loop。
 * - 通过 eventBatchSink 回传结果（HTTP 或直接调用 ingressEventBatch）。
 * - 接收并响应 cancel/resume/steer 命令。
 *
 * @param params 工厂参数
 * @returns RuntimeAdapter 实例
 */
export function createHostedAdapter(params: CreateHostedAdapterParams): RuntimeAdapter {
  const refPrefix = params.refPrefix ?? "hosted";
  const state: AdapterState = {
    nextSequence: 1,
    lastLoopPromise: null,
    lastLoop: null,
  };

  // 包装 eventBatchSink 以跟踪 producer_sequence 连续性
  const injectedSink = params.eventBatchSink;
  const trackedSink: EventBatchSink | undefined = injectedSink
    ? async (sinkParams) => {
        // 更新 nextSequence 为本批次最后一个事件的 sequence + 1
        const lastEvent = sinkParams.events[sinkParams.events.length - 1];
        if (lastEvent) {
          state.nextSequence = lastEvent.producer_sequence + 1;
        }
        await injectedSink(sinkParams);
      }
    : undefined;

  /**
   * 为 startInvocation 创建 EventIngressClient。
   * - 优先用 trackedSink（测试注入）
   * - 否则用 HTTP（从 startParams.gatewayEndpoints + authToken 构造）
   */
  function createIngressClient(
    gatewayEndpoints: GatewayEndpoints,
    authToken: string,
  ): EventIngressClient {
    if (trackedSink) {
      return {
        async postEventBatch(invocationId, events, producerSequenceStart) {
          await trackedSink({ invocationId, events, producerSequenceStart });
        },
      };
    }
    return createHttpEventIngressClient({ gatewayEndpoints, authToken });
  }

  /**
   * 发送单个候选事件（handleCancel 等命令处理用）。
   * 使用 Adapter 跟踪的 nextSequence，保证连续性。
   */
  async function sendSingleEvent(
    invocationId: string,
    type: string,
    payload: Record<string, unknown>,
    gatewayEndpoints?: GatewayEndpoints,
    authToken?: string,
  ): Promise<void> {
    const seq = state.nextSequence;
    const event: RuntimeCandidateEvent = {
      producer_event_id: `${refPrefix}-${type}-${randomUUID()}`,
      producer_sequence: seq,
      type,
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      payload,
    };
    state.nextSequence = seq + 1;

    if (trackedSink) {
      await trackedSink({
        invocationId,
        events: [event],
        producerSequenceStart: seq,
      });
      return;
    }

    // HTTP 模式：从命令参数构造 ingress client
    if (gatewayEndpoints && authToken) {
      const client = createHttpEventIngressClient({ gatewayEndpoints, authToken });
      await client.postEventBatch(invocationId, [event], seq);
      return;
    }

    // 无 sink 且无 HTTP 参数：记录错误但不抛出（命令 ack 不依赖事件回传成功）
    console.error(
      `[HostedAdapter] sendSingleEvent(${type}) 无可用 sink：invocationId=${invocationId}`,
    );
  }

  return {
    async probeCapabilities(): Promise<RuntimeCapabilitiesResponse> {
      return hostedAdapterCapabilities();
    },

    async startInvocation(startParams: StartInvocationParams): Promise<StartInvocationResult> {
      // 1. 生成 runtime_session_ref + runtime_execution_ref
      const threadSuffix = startParams.threadId ? startParams.threadId.slice(0, 8) : "noturn";
      const runtimeSessionRef = `${refPrefix}-${threadSuffix}-${randomUUID()}`;
      const runtimeExecutionRef = `${refPrefix}-exec-${randomUUID()}`;

      // 2. 异步执行 Agent Loop（仅会话模式；Job 模式不启动 Loop）
      if (startParams.threadId && startParams.turnId) {
        const ingressClient = createIngressClient(
          startParams.gatewayEndpoints,
          startParams.authToken,
        );

        const loopParams: HostedAgentLoopParams = {
          invocationId: startParams.invocationId,
          threadId: startParams.threadId,
          turnId: startParams.turnId,
          agentRevisionId: startParams.agentRevisionId,
          inputItems: startParams.inputItems,
          contextHandle: startParams.contextHandle,
          gatewayEndpoints: startParams.gatewayEndpoints,
          workspace: startParams.workspace,
          executionLimits: startParams.executionLimits,
          traceContext: startParams.traceContext,
          runtimeEndpoint: params.platformEndpoint,
          authToken: startParams.authToken,
          ingressClient,
          modelFn: params.modelFn,
          transientEventBatchSink: params.transientEventBatchSink,
          modelRef: params.modelRef,
          correlationId: startParams.correlationId,
        };

        const loop = new HostedAgentLoop(loopParams);
        state.lastLoop = loop;
        const runPromise = loop.run();
        state.lastLoopPromise = runPromise;

        // 异步触发，不阻塞调用方；错误已在 loop.run() 内捕获
        void runPromise.catch((err) => {
          console.error(
            `[HostedAdapter] loop.run() 未捕获异常：${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }

      // 3. 立即返回 accepted + refs + capabilities
      return {
        accepted: true,
        runtime_session_ref: runtimeSessionRef,
        runtime_execution_ref: runtimeExecutionRef,
        capabilities: hostedAdapterCapabilities(),
      };
    },

    async handleCancel(cancelParams: CancelParams): Promise<CancelResult> {
      // 异步发送 execution.cancelled 事件（不阻塞 ack 响应）
      void sendSingleEvent(
        cancelParams.invocationId,
        "execution.cancelled",
        {
          cancelled_by: cancelParams.cancelledBy ?? "system",
          reason: cancelParams.reason ?? "user_cancel",
        },
        cancelParams.gatewayEndpoints,
        cancelParams.authToken,
      ).catch((err) => {
        console.error(
          `[HostedAdapter] execution.cancelled 回传失败：${err instanceof Error ? err.message : String(err)}`,
        );
      });

      return {
        cancel_state: "accepted",
        already_completed_effects_preserved: true,
      };
    },

    async handleResume(): Promise<ResumeResult> {
      // Hosted 参考实现：Resume 不需要额外事件（Invocation 由平台 command-dispatcher 转回 running）
      // VeADK 映射时同样只返回 ack
      return {
        resume_state: "accepted",
        runtime_execution_ref: `${refPrefix}-exec-resume-${randomUUID()}`,
        requires_redispatch: false,
      };
    },

    async handleSteer(): Promise<SteerResult> {
      // Hosted 参考实现：Steer 在下一个安全点应用，不打断当前生成
      return {
        steer_state: "accepted",
        applies_at: "next_safe_point",
        generation_interrupted: false,
      };
    },

    getLastLoopPromise(): Promise<HostedAgentLoopResult> | null {
      return state.lastLoopPromise;
    },
  };
}

// ─── 路由层集成（模块级 Adapter 单例 + 测试覆盖） ─────────

/**
 * 模块级 Hosted Adapter 单例（路由层共享）。
 *
 * 路由 handler 通过 getRouteHostedAdapter() 获取 Adapter 实例。
 * 测试通过 setRouteHostedAdapter() 注入带 mock sink 的 Adapter。
 */
let routeAdapter: RuntimeAdapter | null = null;

/**
 * 设置路由层 Hosted Adapter（测试用）。
 *
 * 传入 null 重置为默认（下次 getRouteHostedAdapter 时重建）。
 */
export function setRouteHostedAdapter(adapter: RuntimeAdapter | null): void {
  routeAdapter = adapter;
}

/**
 * 获取路由层 Hosted Adapter。
 *
 * 未由部署配置注册模型执行器时返回 null。路由必须返回 503，
 * 不得用固定文本或回显用户输入伪造模型回复。
 */
export function getRouteHostedAdapter(): RuntimeAdapter | null {
  return routeAdapter;
}
