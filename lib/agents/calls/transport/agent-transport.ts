/**
 * AgentTransport Port — AgentCall 的唯一外部 Agent 通信边界。
 *
 * Agent Transport 是「AgentCall → 外部 Agent」的协议抽象，不是框架抽象：
 * - A2A 0.3.0 → 外部 Agent 能力调用协议（AgentCall 子执行域）。
 *
 * 边界：
 * - A2A 绝不是 Harness Runtime Protocol；Agent Transport 不实现 RuntimeHttpClient。
 * - 正确调用链：
 *     Parent Harness Invocation → Harness Runtime → Harness Loop → AgentCall
 *     → Agent Route → Agent transport / A2A → AgentCall Result → Harness Loop。
 * - Agent transport 的事件必须先成为 AgentCall event/state（经 AgentCallEventIngress），
 *   由 Harness Loop 决定顶层 Invocation 走向。绝不能：
 *     AgentCall event → 直接写顶层 Invocation/Turn 终态。
 *
 * 冻结协议能力来自 A2A 0.3.0 公开合同，不实现 A2A 1.x 兼容层：
 * - Agent Card（/.well-known/agent-card.json）；
 * - JSON-RPC over HTTP；
 * - message/stream（SSE Task/Artifact updates）；
 * - message/send（resume）；
 * - tasks/get（诊断）；
 * - tasks/cancel；
 * - Task / Artifact / contextId / taskId 关联；
 * - input-required / resume / cancel；
 * - idempotency / correlation / dead endpoint / 401/403 / 503 transient /
 *   malformed response / stream EOF / background failure classification。
 *
 * Agent transport 只报告归一化 AgentCall 候选事件（callId 关联）到
 * eventSink → AgentCallEventIngress；绝不直接完成/失败/丢失 parent Invocation。
 */

import type { AgentCallCandidateEventType } from "@/lib/agents/calls/domain/agent-call-event-ingress";

/**
 * AgentCall 候选事件（归一化到 AgentCall 域，不直接映射 Invocation 终态）。
 *
 * 由 Agent transport Mapper 产出，经 eventSink → AgentCallEventIngress → 应用层
 * 归一化为 AgentCall state。producerSequence 在整个 AgentCall 内连续（幂等键）。
 */
export interface AgentCallCandidateEvent {
  /** Agent 稳定事件 id（幂等键 1）。 */
  producer_event_id: string;
  /** Agent 连续序号（幂等键 2，整个 AgentCall 内连续）。 */
  producer_sequence: number;
  /** AgentCall 候选事件类型（call.started / completed / input_required / failed / cancelled / lost）。 */
  type: AgentCallCandidateEventType;
  /** payload schema 版本。 */
  schema_version?: number;
  /** 事件发生时间（RFC 3339，仅供诊断，不参与持久化键）。 */
  occurred_at?: string;
  /** 候选负载（结构化、已脱敏）。 */
  payload: Record<string, unknown>;
}

/** Agent transport 事件批次出口（进入 AgentCallEventIngress，callId 关联）。 */
export type AgentCallEventSink = (batch: {
  callId: string;
  events: AgentCallCandidateEvent[];
  producerSequenceStart: number;
}) => Promise<void>;

/**
 * AgentCall 出站认证（协议中立）。
 *
 * 只允许 none / bearer 两种 External Agent 形态；workload_token 是 SnowHarness
 * Runtime Protocol 专属，Agent transport 收到时本地 fail closed，
 * 绝不把内部 Workload Token 当作外部 Agent 的 Bearer Token。
 */
export type AgentCallTransportAuth = { mode: "none" } | { mode: "bearer"; token: string };

/** Agent 出站 auth 失败（网络前 fail closed）。 */
export class AgentTransportAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTransportAuthError";
  }
}

/** 把 AgentCallTransportAuth 映射为 HTTP header。 */
export function agentCallAuthHeaders(auth: AgentCallTransportAuth): Record<string, string> {
  if (auth.mode === "none") return {};
  return { authorization: `Bearer ${auth.token}` };
}

/** Agent transport 错误分类：进入 SnowHarness 稳定错误码，不暴露供应商 SDK 异常字符串。 */
export type AgentTransportFailureKind =
  | "endpoint_auth"
  | "protocol_schema"
  | "unsupported_capability"
  | "remote_task_failed"
  | "remote_task_rejected"
  | "stream_interrupted"
  | "cancellation_rejected"
  | "resume_target_not_found"
  | "invalid_correlation";

export class AgentTransportError extends Error {
  constructor(
    readonly kind: AgentTransportFailureKind,
    message: string,
    readonly detail?: unknown,
  ) {
    super(`AgentTransport ${kind}: ${message}`);
    this.name = "AgentTransportError";
  }
}

/** 背景流失败种类：固定合同，不把第三方 exception class 当合同。 */
export type AgentBackgroundFailureKind =
  | "stream_eof_before_terminal"
  | "stream_read_failed"
  | "protocol_parse_failed"
  | "ingress_failed"
  | "correlation_lost";

/** 背景失败报告（只含 safe ids/failureKind/摘要；Transport 不直接写 DB）。 */
export interface AgentBackgroundFailureReport {
  readonly callId: string;
  readonly failureKind: AgentBackgroundFailureKind;
  readonly safeSummary: string;
}

/** 背景流失败上报：Transport 只报告；恢复动作由外层注入的 handler 执行。 */
export type AgentBackgroundFailureHandler = (
  report: AgentBackgroundFailureReport,
) => void | Promise<void>;

/** Agent Card 能力视图（probe 数据源）。 */
export interface AgentCardCapabilities {
  protocol_versions: string[];
  features: {
    event_stream: boolean;
    cancel: boolean;
    resume: boolean;
    steer: boolean;
    dynamic_tools: boolean;
    user_action: boolean;
    workspace_types: string[];
    filesystem_checkpoint: boolean;
  };
  limits: {
    max_invocation_seconds: number;
    max_event_bytes: number;
  };
}

/** startCall 入参（由调用方从 AgentCallBinding 冻结派生）。 */
export interface StartAgentCallParams {
  callId: string;
  /** 外部 Agent endpoint（来自 AgentCallBinding.endpointRef）。 */
  endpoint: string;
  auth: AgentCallTransportAuth;
  /** 用户输入文本（提取自 input_items / Turn user message）。 */
  input: string;
  /** 已解析的公共 Context metadata（execution_subject 等，来自单一 Authority）。 */
  contextMetadata?: Record<string, unknown>;
  /** context reuse：已有 A2A contextId（AgentSessionBinding.externalContextRef）。 */
  existingContextId?: string | null;
  /** 幂等键（防重复 outbound）。 */
  idempotencyKey: string;
  /** 流读取超时（ms）。 */
  streamTimeoutMs?: number;
  /** 冻结能力 profile：由调用方从 Binding/Contract 派生。 */
  capabilities: {
    cancel: boolean;
    resume: boolean;
    steer: boolean;
    user_action?: boolean;
    streaming?: boolean;
  };
}

/** startCall 结果：A2A taskId/contextId 关联。 */
export interface StartAgentCallResult {
  callId: string;
  /** A2A taskId → AgentCallAttempt.externalTaskRef。 */
  taskId: string;
  /** A2A contextId → AgentSessionBinding.externalContextRef。 */
  contextId: string;
  /**
   * 本次 startCall 生效的 Agent 能力（A2A 协议证据）。
   * protocol_versions 表达 A2A 0.3.0（非 Runtime 协议）；features 为冻结 effective
   * profile（cancel/resume/user_action 由调用方冻结派生，不冒充）；limits 为平台侧上限。
   */
  capabilities: AgentCardCapabilities;
}

/** resumeCall 入参。 */
export interface ResumeAgentCallParams {
  callId: string;
  endpoint: string;
  auth: AgentCallTransportAuth;
  /** A2A taskId（AgentCallAttempt.externalTaskRef）。 */
  taskId: string;
  /** A2A contextId（AgentSessionBinding.externalContextRef）。 */
  contextId: string;
  /** 用户补充文本。 */
  text: string;
  /** 已解析的公共 Context metadata。 */
  contextMetadata?: Record<string, unknown>;
  /** resume 事件重定位起始 producerSequence（禁止回退进程内计数器）。 */
  nextProducerSequence: number;
  idempotencyKey: string;
}

/** cancelCall 入参。 */
export interface CancelAgentCallParams {
  callId: string;
  endpoint: string;
  auth: AgentCallTransportAuth;
  /** A2A taskId（AgentCallAttempt.externalTaskRef）。 */
  taskId: string;
  idempotencyKey: string;
}

/** getCall 入参（诊断 / tasks/get）。 */
export interface GetAgentCallParams {
  callId: string;
  endpoint: string;
  auth: AgentCallTransportAuth;
  /** A2A taskId。 */
  taskId: string;
}

/**
 * AgentTransport Port。
 *
 * Transport 实现不得暴露 framework 分支或旁路；协议能力归属 AgentCall 域，
 * 事件经 AgentCallEventIngress 归一化，绝不触碰 parent Invocation 终态。
 */
export interface AgentTransport {
  /** Agent Card probe（/.well-known/agent-card.json）。 */
  probe(params: { endpoint: string; auth: AgentCallTransportAuth }): Promise<AgentCardCapabilities>;
  /** 启动 AgentCall（message/stream SSE）；返回 taskId/contextId 关联，后续流经 eventSink 进入 ingress。 */
  startCall(params: StartAgentCallParams): Promise<StartAgentCallResult>;
  /** 恢复 AgentCall（message/send）；same AgentCall / same task/context。 */
  resumeCall(params: ResumeAgentCallParams): Promise<void>;
  /** 取消 AgentCall（tasks/cancel）。 */
  cancelCall(params: CancelAgentCallParams): Promise<void>;
  /** 诊断读取 AgentCall 状态（tasks/get）。 */
  getCall(
    params: GetAgentCallParams,
  ): Promise<{ state: string; taskId: string; contextId: string }>;
}
