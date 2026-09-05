/**
 * Hosted Runtime Adapter（ 参考实现）。
 *
 * 事实源：
 * - docs/architecture/agent-control-plane.md §6（Invocation 生命周期）、-3.10（Steer/Cancel/Resume）
 * - docs/architecture/api-and-events.md §4（Runtime Protocol API）
 * - docs/architecture/runtime-control-plane.md
 *
 * 职责：
 * - 定义 RuntimeAdapter 接口（probeCapabilities / startInvocation / handleCancel / handleResume / handleSteer）。
 * - 定义 GatewayEndpoints / EventIngressClient / HostedHarnessLoop 等共享类型与实现。
 * - createHostedAdapter：工厂函数，返回 Hosted 参考适配器。
 * - startInvocation：生成 runtime_session_ref/runtime_execution_ref，异步启动 HostedHarnessLoop。
 * - handleCancel/handleResume/handleSteer：返回 Runtime ack，异步回传候选事件。
 * - 事件回传通过可注入的 EventBatchSink（HTTP 或直接调用 ingressEventBatch 仓储函数）。
 *
 * 关键约束：
 * - Adapter 不直读平台库和 Secret（通过 EventBatchSink 回传事件）。
 * - 正式文本必须在终态前形成 response.completed（由 HostedHarnessLoop 保证）。
 * - Invocation 终态必须形成公开 Event（execution.completed/failed/cancelled）。
 * - producer_sequence 在整个 Invocation 内连续递增（Adapter 跟踪 nextSequence）。
 * - 模型声称"已完成"不等同于平台确认成功（由 ingress 映射决定终态）。
 * - Agent Loop 6 步：理解—查看索引—按需加载—行动—验证—继续/完成。
 */
import { randomUUID } from "node:crypto";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import type { RuntimeCandidateEvent } from "@/lib/runtime/event-ingress-queries";
import type { CapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import {
  type HarnessActionExecutors,
  type HarnessDecisionPort,
  type HarnessFinalResponsePort,
  HarnessLoop,
  HarnessLoopError,
  type HarnessLoopRecoveryPort,
} from "@/lib/runtime/harness-loop/loop";
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
  /** 事件回传端点 URL（POST {events}）。 */
  events: string;
  /** cancel 命令端点。 */
  cancel: string;
  /** resume 命令端点。 */
  resume: string;
  /** steer 命令端点。 */
  steer: string;
  tools: string;
  tool_calls: string;
  user_action_requests: string;
  capability_actions: string;
}

// ─── EventIngressClient ─────────────────────────────────

/**
 * Event Ingress 客户端接口：Runtime 侧调用以回传候选事件批次。
 *
 * 两种实现：
 * - HTTP：调用平台 /gateway/v1/runtime-events 路由（createHttpEventIngressClient）。
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
 * 调用平台 Gateway Runtime Events 路由（POST {gatewayEndpoints.events}）。
 *
 * @param params.gatewayEndpoints 平台 Gateway 端点
 * @param params.authToken Runtime Workload Token（仅兼容旧调用方）
 * @param params.gatewayAccessToken 平台颁发的 Gateway Workload Token
 */
export function createHttpEventIngressClient(params: {
  gatewayEndpoints: GatewayEndpoints;
  authToken: string;
  /** Gateway Workload Token；旧调用方未提供时仅作为兼容回退。 */
  gatewayAccessToken?: string;
}): EventIngressClient {
  return {
    async postEventBatch(invocationId, events, producerSequenceStart) {
      const url = params.gatewayEndpoints.events;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${params.gatewayAccessToken ?? params.authToken}`,
          "idempotency-key": `${invocationId}:runtime-events:${producerSequenceStart}`,
        },
        body: JSON.stringify({
          invocation_id: invocationId,
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
 * HostedAdapter 实现此接口；
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
  getLastLoopPromise?(): Promise<HostedHarnessLoopResult> | null;
}

// ─── 事件回传 Sink ────────────────────────────────────────

/**
 * 事件回传 Sink：把候选事件批次回传平台。
 *
 * 两种实现：
 * - HTTP：调用平台 /runtime/v1/invocations/{id}/events/batch 路由（生产默认）。
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
  /** 平台租户 id（Harness Loop 调 AgentCall 时作用域）。 */
  tenantId?: string;
  /** 会话模式 Thread id（Job 模式为 null，不启动 Agent Loop）。 */
  threadId?: string | null;
  /** 会话模式 Turn id（Job 模式为 null）。 */
  turnId?: string | null;
  /** 本 Turn 的能力使用提示；preferred 只供 Harness 决策。 */
  capabilityDirectives?: Array<{
    capability_type: "agent";
    capability_id: string;
    mode: "preferred";
  }>;
  capabilityCatalog?: CapabilityCatalogSnapshot;
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
  /** 平台颁发的 Gateway Workload Token（回调 Gateway 时使用）。 */
  gatewayAccessToken?: string;
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
  /** 重调度检查点引用（filesystem_checkpoint 恢复时携带，必须避开已确认副作用）。 */
  checkpointRef?: string;
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
 * 事实源： 规范——Hosted Runtime 支持完整事件流 + cancel/resume/steer，
 * 不支持 dynamic_tools/user_action（本阶段），workspace_types=["cloud"]，
 * 不支持 filesystem_checkpoint。
 */
export function hostedAdapterCapabilities(): RuntimeCapabilitiesResponse {
  return {
    protocol_versions: ["2"],
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
    harness_action_protocol: {
      version: "1",
      action_types: [
        "knowledge.search",
        "tool.call",
        "agent.call",
        "request_user_input",
        "respond",
      ],
    },
  };
}

// ─── HostedHarnessLoop ─────────────────────────────────────

/** HostedHarnessLoop 参数。 */
export interface HostedHarnessLoopParams {
  invocationId: string;
  tenantId: string;
  threadId: string | null;
  turnId: string | null;
  /** 本 Turn 的能力使用提示；preferred 只供 Harness 决策。 */
  capabilityDirectives?: Array<{
    capability_type: "agent";
    capability_id: string;
    mode: "preferred";
  }>;
  capabilityCatalog?: CapabilityCatalogSnapshot;
  inputItems: unknown[];
  contextHandle?: string;
  workspace?: StartInvocationRequestBody["workspace"];
  executionLimits?: StartInvocationRequestBody["execution_limits"];
  traceContext?: StartInvocationRequestBody["trace_context"];
  gatewayEndpoints: GatewayEndpoints;
  runtimeEndpoint: string;
  authToken: string;
  gatewayAccessToken?: string;
  /** 可注入的 Event Ingress 客户端（测试用）；不传则用 HTTP 默认实现。 */
  ingressClient?: EventIngressClient;
  /** 每步只产出一个结构化行动。 */
  decisionPort?: HarnessDecisionPort;
  /** respond 行动提交后才允许生成最终正文。 */
  finalResponsePort?: HarnessFinalResponsePort;
  /** 统一行动执行器注册表；缺失的已提交行动必须 fail closed。 */
  actionExecutors?: HarnessActionExecutors;
  /** 从持久行动事件恢复 Loop 状态。 */
  recoveryPort?: HarnessLoopRecoveryPort;
  /** response.delta 等短生命周期事件回传通道。 */
  transientEventBatchSink?: TransientEventBatchSink;
  /** 实际执行本轮的模型标识。 */
  modelRef?: string;
  /** live Hosted runner 的取消信号；durable cancel 由应用服务触发。 */
  abortSignal?: AbortSignal;
  /** 关联标识（X-Request-Id / traceparent）。 */
  correlationId?: string | null;
}

/** HostedHarnessLoop 运行结果。 */
export interface HostedHarnessLoopResult {
  /** 是否成功完成（execution.completed 已发送或被平台视为终态）。 */
  completed: boolean;
  /** 是否在安全边界收到取消。 */
  cancelled?: boolean;
  /** 已提交 action 的子调用仍在 durable 执行。 */
  pending?: boolean;
  /** Agent 回复文本（response.completed payload.text）。 */
  responseText: string;
  /** 真实失败时填写；pending/waiting_user 不伪装成失败。 */
  failureReason?: string;
  /** Loop 正在等待正式 UserActionRequest。 */
  waitingForUser?: boolean;
  /** 稳定失败码。 */
  errorCode?: string;
  /** 已发送的候选事件列表。 */
  sentEvents: RuntimeCandidateEvent[];
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
 * Hosted Runtime Harness 行动循环。
 * 决策、行动执行和最终正文生成分离；每个行动先写持久 commitment 再执行。
 */
export class HostedHarnessLoop {
  private readonly params: HostedHarnessLoopParams;
  private readonly sentEvents: RuntimeCandidateEvent[] = [];
  private nextSequence = 1;
  private nextTransientSequence = 1;

  constructor(params: HostedHarnessLoopParams) {
    this.params = params;
  }

  /**
   * 执行 Agent Loop。
   *
   * @returns Loop 结果（completed/responseText/sentEvents）
   */
  async run(): Promise<HostedHarnessLoopResult> {
    const ingressClient =
      this.params.ingressClient ??
      createHttpEventIngressClient({
        gatewayEndpoints: this.params.gatewayEndpoints,
        authToken: this.params.authToken,
        gatewayAccessToken: this.params.gatewayAccessToken,
      });
    const missingDecisionPort: HarnessDecisionPort = {
      async decideNextAction() {
        throw new HarnessLoopError(
          "MODEL_EXECUTOR_UNAVAILABLE",
          "Hosted Runtime 未配置 HarnessDecisionPort",
        );
      },
    };
    const missingFinalResponsePort: HarnessFinalResponsePort = {
      async generateFinalResponse() {
        throw new HarnessLoopError(
          "MODEL_EXECUTOR_UNAVAILABLE",
          "Hosted Runtime 未配置 HarnessFinalResponsePort",
        );
      },
    };
    const loop = new HarnessLoop({
      invocationId: this.params.invocationId,
      tenantId: this.params.tenantId,
      threadId: this.params.threadId ?? "",
      turnId: this.params.turnId ?? "",
      objective: extractUserMessage(this.params.inputItems),
      contextHandle: this.params.contextHandle,
      workspace: this.params.workspace,
      executionLimits: this.params.executionLimits,
      traceContext: this.params.traceContext,
      capabilityDirectives: this.params.capabilityDirectives,
      capabilityCatalog: this.params.capabilityCatalog,
      decisionPort: this.params.decisionPort ?? missingDecisionPort,
      finalResponsePort: this.params.finalResponsePort ?? missingFinalResponsePort,
      executors: this.params.actionExecutors ?? {},
      limits: this.params.executionLimits
        ? {
            maxLoopSteps: this.params.executionLimits.max_loop_steps,
            maxAgentCalls: this.params.executionLimits.max_agent_calls,
            maxToolCalls: this.params.executionLimits.max_tool_calls,
            maxKnowledgeSearches: this.params.executionLimits.max_knowledge_searches,
            maxConsecutiveSameAction: this.params.executionLimits.max_consecutive_same_action,
          }
        : undefined,
      recoveryPort: this.params.recoveryPort
        ? {
            load: async (invocationId) => {
              const snapshot = await this.params.recoveryPort?.load(invocationId);
              if (!snapshot) {
                throw new Error("Harness Loop recovery snapshot 缺失");
              }
              this.nextSequence = snapshot.nextProducerSequence;
              return snapshot;
            },
          }
        : undefined,
      modelRef: this.params.modelRef ?? "unknown",
      abortSignal: this.params.abortSignal,
      eventWriter: {
        write: (type, payload) => this.sendEvent(ingressClient, type, payload),
      },
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
    const result = await loop.run();
    return {
      completed: result.completed,
      cancelled: result.cancelled,
      pending: result.pending,
      waitingForUser: result.waitingForUser,
      responseText: result.responseText,
      errorCode: result.errorCode,
      failureReason: result.failureReason,
      sentEvents: this.sentEvents,
    };
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

/** Adapter 实例只保留测试可等待的 live Promise，不保存恢复 Authority。 */
interface AdapterState {
  /** 最后一次 startInvocation 触发的 loop.run() Promise（测试 await）。 */
  lastLoopPromise: Promise<HostedHarnessLoopResult> | null;
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
  /** Hosted 应用服务的租户作用域。 */
  tenantId?: string;
  /** 可注入的事件回传 Sink（测试用；不传则用 HTTP 默认实现）。 */
  eventBatchSink?: EventBatchSink;
  /** 可注入的 transient 事件回传 Sink。 */
  transientEventBatchSink?: TransientEventBatchSink;
  decisionPort?: HarnessDecisionPort;
  finalResponsePort?: HarnessFinalResponsePort;
  actionExecutors?: HarnessActionExecutors;
  recoveryPort?: HarnessLoopRecoveryPort;
  /** 实际执行本轮的模型标识。 */
  modelRef?: string;
  /** 控制命令必须进入只依赖 durable identity 的正式应用服务。 */
  applicationService?: HostedRuntimeApplicationService;
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
  const refPrefix = "hosted";
  const state: AdapterState = {
    lastLoopPromise: null,
  };

  // 包装 eventBatchSink 以跟踪 producer_sequence 连续性
  const injectedSink = params.eventBatchSink;
  const trackedSink: EventBatchSink | undefined = injectedSink
    ? async (sinkParams) => {
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
    gatewayAccessToken?: string,
  ): EventIngressClient {
    if (trackedSink) {
      return {
        async postEventBatch(invocationId, events, producerSequenceStart) {
          await trackedSink({ invocationId, events, producerSequenceStart });
        },
      };
    }
    return createHttpEventIngressClient({ gatewayEndpoints, authToken, gatewayAccessToken });
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
          startParams.gatewayAccessToken,
        );

        const loopParams: HostedHarnessLoopParams = {
          invocationId: startParams.invocationId,
          tenantId: startParams.tenantId ?? "",
          threadId: startParams.threadId,
          turnId: startParams.turnId,
          capabilityDirectives: startParams.capabilityDirectives,
          capabilityCatalog: startParams.capabilityCatalog,
          inputItems: startParams.inputItems,
          contextHandle: startParams.contextHandle,
          gatewayEndpoints: startParams.gatewayEndpoints,
          workspace: startParams.workspace,
          executionLimits: startParams.executionLimits,
          traceContext: startParams.traceContext,
          runtimeEndpoint: params.platformEndpoint,
          authToken: startParams.authToken,
          gatewayAccessToken: startParams.gatewayAccessToken,
          ingressClient,
          decisionPort: params.decisionPort,
          finalResponsePort: params.finalResponsePort,
          actionExecutors: params.actionExecutors,
          recoveryPort: params.recoveryPort,
          transientEventBatchSink: params.transientEventBatchSink,
          modelRef: params.modelRef,
          correlationId: startParams.correlationId,
        };
        const loop = new HostedHarnessLoop(loopParams);
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
      if (!params.applicationService) {
        throw new HarnessLoopError(
          "HOSTED_CONTROL_SERVICE_UNAVAILABLE",
          "Hosted cancel 未配置正式应用服务",
        );
      }
      await params.applicationService.cancel({
        tenantId: params.tenantId ?? "",
        invocationId: cancelParams.invocationId,
        idempotencyKey: `hosted-cancel:${cancelParams.invocationId}`,
        reason: cancelParams.reason,
      });

      return {
        cancel_state: "accepted",
        already_completed_effects_preserved: true,
      };
    },

    async handleResume(resumeParams): Promise<ResumeResult> {
      if (!params.applicationService) {
        throw new HarnessLoopError(
          "HOSTED_CONTROL_SERVICE_UNAVAILABLE",
          "Hosted resume 未配置正式应用服务",
        );
      }
      await params.applicationService.resume({
        tenantId: params.tenantId ?? "",
        invocationId: resumeParams.invocationId,
        idempotencyKey: `hosted-resume:${resumeParams.invocationId}`,
        resumePayload: resumeParams.resumePayload,
      });
      return {
        resume_state: "accepted",
        runtime_execution_ref: `${refPrefix}-exec-resume-${randomUUID()}`,
        requires_redispatch: false,
      };
    },

    async handleSteer(steerParams): Promise<SteerResult> {
      if (!params.applicationService) {
        throw new HarnessLoopError(
          "HOSTED_CONTROL_SERVICE_UNAVAILABLE",
          "Hosted steer 未配置正式应用服务",
        );
      }
      await params.applicationService.steer({
        tenantId: params.tenantId ?? "",
        invocationId: steerParams.invocationId,
        idempotencyKey: `hosted-steer:${steerParams.invocationId}`,
        steerPayload: steerParams.steerPayload,
      });
      return {
        steer_state: "accepted",
        applies_at: "next_safe_point",
        generation_interrupted: false,
      };
    },

    getLastLoopPromise(): Promise<HostedHarnessLoopResult> | null {
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
