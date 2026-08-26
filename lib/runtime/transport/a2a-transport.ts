/**
 * A2A 0.3.0 RuntimeTransport 实现（04 §4–§6）。
 *
 * 冻结 wire 合同（04 §4，不实现 A2A 1.x 兼容层；HR 公开合同兼容）：
 * - JSON-RPC over HTTP（POST {endpoint}）；
 * - Agent Card 仅 /.well-known/agent-card.json（无旧 agent.json 回退）；
 * - message/stream（SSE Task/Artifact updates）；start Message metadata 仅允许
 *   execution_subject 公开对象（subject_id/subject_kind），内部 ID/trace 一律不发；
 * - message/send（resume）：发送精确纯文本（标准 Message 字段），同步返回官方
 *   Task（kind:"task" + id/contextId/status/artifacts），correlation 必须一致；
 * - tasks/get（诊断）；
 * - tasks/cancel；
 * - contextId / taskId 关联。
 *
 * 事件归一化（04 §6）：A2A wire event 必须先进入本 Transport Mapper →
 * RuntimeCandidateEvent（knownTypes 六种）→ eventBatchSink → RuntimeEventIngress。
 * 禁止 Web/Desktop 解析 A2A JSON；禁止 Transport 直接更新 Turn/Item。
 *
 * 错误分类（04 §7）：统一抛 RuntimeTransportError（稳定 kind），不向调用方
 * 暴露供应商 SDK 异常字符串作为合同。
 */
import { randomUUID } from "node:crypto";
import {
  type RuntimeTransportAuth,
  outboundAuthHeaders,
} from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
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
import { RuntimeTransportError } from "@/lib/runtime/transport/runtime-transport";

/** 公开合同（HR 兼容）：input 型 user_action 的通用严格 JSON Schema。 */
const A2A_INPUT_ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: 20_000 },
  },
} as const;

/** A2A 事件批次出口（进入归一化 RuntimeEventIngress，04 §6）。 */
export type A2AEventBatchSink = (batch: {
  invocationId: string;
  events: RuntimeCandidateEvent[];
  producerSequenceStart: number;
}) => Promise<void>;

/** 从 input_items 提取用户消息文本（与 HostedAdapter 相同结构约定）。 */
function extractUserMessage(inputItems: unknown[]): string {
  for (const item of inputItems) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "user_message") {
      const content = record.content;
      if (content && typeof content === "object") {
        const text = (content as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return "";
}

/** A2A Task state（0.3.0 冻结子集）。 */
type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "auth-required"
  | "unknown";

/** A2A status-update 事件（SSE JSON-RPC result）。 */
interface A2AStatusUpdate {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: { state: A2ATaskState; message?: A2AMessage | null };
  final?: boolean;
}

/** A2A artifact-update 事件。 */
interface A2AArtifactUpdate {
  kind: "artifact-update";
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
}

/** A2A Message（role/parts）。 */
interface A2AMessage {
  role: string;
  parts: A2APart[];
}

/** A2A Part（TextPart 展示文本 / DataPart 公共结构化结果）。 */
interface A2APart {
  kind: string;
  text?: string;
  data?: unknown;
}

/** A2A Artifact（parts 携带展示文本与结构化结果）。 */
interface A2AArtifact {
  artifactId: string;
  name?: string;
  parts?: A2APart[];
}

/** A2A Task（官方 message/send 同步结果形态）。 */
interface A2ATask {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: A2ATaskState; message?: A2AMessage | null };
  artifacts?: A2AArtifact[];
}

type A2AStreamUpdate = A2AStatusUpdate | A2AArtifactUpdate;

/** JSON-RPC 响应（SSE data 或同步响应）。 */
interface JsonRpcResponse<T = unknown> {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: { code?: number; message?: string; data?: unknown };
}

/** 从 Message parts 提取文本。 */
function messageText(message: A2AMessage | null | undefined): string | null {
  if (!message || !Array.isArray(message.parts)) return null;
  const texts = message.parts
    .map((p) => (typeof p?.text === "string" ? p.text : null))
    .filter((t): t is string => t !== null);
  return texts.length > 0 ? texts.join("\n") : null;
}

/** A2A Agent Card（probeCapabilities 数据源，仅取必需字段）。 */
interface A2AAgentCard {
  name?: string;
  url?: string;
  version?: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  skills?: Array<{ id?: string; name?: string }>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

/** invocation → 远端 taskId/contextId 解析（cancel/resume 关联用）。 */
export type A2ARuntimeRefResolver = (
  invocationId: string,
) => Promise<{ runtimeExecutionRef: string | null; runtimeSessionRef: string | null } | null>;

/** 线程已有 A2A contextId 解析（context reuse，04 §5）。 */
export type A2AExistingContextResolver = (threadId: string) => Promise<string | null>;

/** invocation → 下一个 producer_sequence 解析（resume 事件重定位；缺省 fail-closed）。 */
export type A2ANextProducerSequenceResolver = (invocationId: string) => Promise<number | null>;

export interface CreateA2ATransportParams {
  /** 归一化事件批次出口（RuntimeCandidateEvent → RuntimeEventIngress）。 */
  eventBatchSink: A2AEventBatchSink;
  /** invocation → taskId/contextId（cancel/resume 必需；缺省 fail-closed）。 */
  resolveRuntimeRefs?: A2ARuntimeRefResolver;
  /** thread → 已有 contextId（context reuse；不传则每次新会话）。 */
  resolveExistingContextId?: A2AExistingContextResolver;
  /**
   * invocation → 下一个 producer_sequence（resume 归一化事件重定位用；
   * resume 必需，缺省/非法值 fail-closed，不回退到进程内计数器或全局状态）。
   */
  resolveNextProducerSequence?: A2ANextProducerSequenceResolver;
  /** 注入 fetch（测试用；缺省全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 流读取超时（ms；缺省 300s）。 */
  streamTimeoutMs?: number;
}

/**
 * 创建 A2A 0.3.0 Transport（实现 RuntimeHttpClient 五端点形状）。
 *
 * - probeCapabilities → Agent Card（/.well-known/agent.json）
 * - startInvocation → message/stream（SSE），taskId/contextId 映射为
 *   runtime_execution_ref/runtime_session_ref；后续 updates 由 Mapper 归一化后
 *   经 eventBatchSink 进入 ingress。
 * - cancelInvocation → tasks/cancel
 * - resumeInvocation → message/send
 * - steerInvocation → unsupported_capability（A2A 0.3.0 冻结范围不含 steer）
 */
export function createA2ATransport(params: CreateA2ATransportParams): RuntimeHttpClient {
  const fetchImpl = params.fetchImpl ?? fetch;
  const streamTimeoutMs = params.streamTimeoutMs ?? 300_000;

  // Task 级最新 artifact 缓存（仅本 Transport 实例内）：HR 官方顺序中 artifact-update
  // 携带 TextPart 展示文本 + DataPart 公共结构化结果；input-required/completed 的
  // status.message 缺失时，追问/答复文本取自该 task 最新 artifact。
  const latestArtifactByTask = new Map<string, { text: string | null; data: unknown }>();

  function cacheArtifact(taskId: string, artifact: A2AArtifact): void {
    const parts = Array.isArray(artifact.parts) ? artifact.parts : [];
    const texts = parts
      .filter((p) => typeof p?.text === "string" && p.text.length > 0)
      .map((p) => p.text as string);
    const dataPart = parts.find((p) => p && "data" in p && p.data !== undefined);
    latestArtifactByTask.set(taskId, {
      text: texts.length > 0 ? texts.join("\n") : null,
      data: dataPart?.data,
    });
  }

  async function jsonRpc<T>(
    runtimeEndpoint: string,
    auth: RuntimeTransportAuth,
    method: string,
    rpcParams: unknown,
    idempotencyKey?: string,
  ): Promise<JsonRpcResponse<T>> {
    // External A2A：workload_token 本地 fail closed（outboundAuthHeaders 不带
    // allowWorkloadToken），none 完全不发 Authorization（03 §9）。
    const authHeader = outboundAuthHeaders(auth);
    let resp: Response;
    try {
      resp = await fetchImpl(runtimeEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeader,
          ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params: rpcParams }),
      });
    } catch (err) {
      throw new RuntimeTransportError(
        "stream_interrupted",
        `A2A endpoint 不可达：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new RuntimeTransportError(
        "endpoint_auth",
        `A2A endpoint 认证失败（HTTP ${resp.status}）`,
      );
    }
    if (!resp.ok) {
      throw new RuntimeTransportError("protocol_schema", `A2A endpoint HTTP ${resp.status}`);
    }
    try {
      return (await resp.json()) as JsonRpcResponse<T>;
    } catch {
      throw new RuntimeTransportError("protocol_schema", "A2A 响应不是合法 JSON");
    }
  }

  /** 抛出 JSON-RPC error 映射（04 §7 错误分类）。 */
  function throwRpcError(error: NonNullable<JsonRpcResponse["error"]>): never {
    const code = error.code ?? 0;
    // JSON-RPC error → 稳定分类：task 不存在 → resume/correlation；-32700/-32600 系列 → protocol_schema；
    // 任务被拒绝 → remote_task_rejected；其余 → remote_task_failed。
    if (code === -32001 || /task.*not.*(found|exist)/i.test(error.message ?? "")) {
      throw new RuntimeTransportError(
        "resume_target_not_found",
        `A2A task 不存在：${error.message ?? code}`,
      );
    }
    if (code === -32700 || code === -32600 || code === -32602) {
      throw new RuntimeTransportError("protocol_schema", `A2A 协议错误：${error.message ?? code}`);
    }
    if (code === -32002 || /reject/i.test(error.message ?? "")) {
      throw new RuntimeTransportError(
        "remote_task_rejected",
        `A2A task 被拒绝：${error.message ?? code}`,
      );
    }
    throw new RuntimeTransportError(
      "remote_task_failed",
      `A2A task 失败：${error.message ?? code}`,
    );
  }

  /** A2A update → RuntimeCandidateEvent（knownTypes 六种，04 §6 Mapper）。 */
  function mapUpdate(
    invocationId: string,
    sequence: number,
    update: A2AStreamUpdate,
  ): RuntimeCandidateEvent[] {
    const base = {
      producer_event_id: `a2a:${invocationId}:${sequence}`,
      producer_sequence: sequence,
      schema_version: 1,
      occurred_at: new Date().toISOString(),
    };
    if (update.kind === "artifact-update") {
      cacheArtifact(update.taskId, update.artifact);
      return [
        {
          ...base,
          type: "progress.snapshot",
          payload: {
            source: "a2a",
            task_id: update.taskId,
            artifact_id: update.artifact.artifactId,
            artifact_name: update.artifact.name ?? null,
          },
        },
      ];
    }
    const state = update.status.state;
    switch (state) {
      case "submitted":
      case "working":
        return [
          {
            ...base,
            type: "progress.snapshot",
            payload: {
              source: "a2a",
              task_id: update.taskId,
              task_state: state,
              message: messageText(update.status.message),
            },
          },
        ];
      case "input-required": {
        // status.message 缺失时（HR 官方顺序），追问文本取最新 artifact 的 TextPart。
        const text =
          messageText(update.status.message) ??
          latestArtifactByTask.get(update.taskId)?.text ??
          null;
        return [
          {
            ...base,
            type: "user_action.requested",
            payload: {
              source: "a2a",
              task_id: update.taskId,
              context_id: update.contextId,
              request_type: "input",
              purpose: "a2a_input_required",
              prompt: text ?? "Agent 请求补充输入",
              message: text,
              input_schema: A2A_INPUT_ACTION_SCHEMA,
            },
          },
        ];
      }
      case "completed": {
        const text =
          messageText(update.status.message) ??
          latestArtifactByTask.get(update.taskId)?.text ??
          null;
        // completed → response.completed + execution.completed（两个序号）。
        return [
          {
            ...base,
            type: "response.completed",
            payload: { source: "a2a", task_id: update.taskId, text },
          },
          {
            ...base,
            producer_event_id: `a2a:${invocationId}:${sequence + 1}`,
            producer_sequence: sequence + 1,
            type: "execution.completed",
            payload: { source: "a2a", task_id: update.taskId, finish_reason: "a2a_task_completed" },
          },
        ];
      }
      case "failed":
        return [
          {
            ...base,
            type: "execution.failed",
            payload: {
              source: "a2a",
              task_id: update.taskId,
              error_code: "REMOTE_TASK_FAILED",
              error_summary: messageText(update.status.message) ?? "A2A task failed",
            },
          },
        ];
      case "canceled":
        return [
          {
            ...base,
            type: "execution.cancelled",
            payload: { source: "a2a", task_id: update.taskId, cancelled_by: "remote" },
          },
        ];
      case "rejected":
        return [
          {
            ...base,
            type: "execution.failed",
            payload: {
              source: "a2a",
              task_id: update.taskId,
              error_code: "REMOTE_TASK_REJECTED",
              error_summary: messageText(update.status.message) ?? "A2A task rejected",
            },
          },
        ];
      case "auth-required":
        return [
          {
            ...base,
            type: "execution.failed",
            payload: {
              source: "a2a",
              task_id: update.taskId,
              error_code: "REMOTE_AUTH_REQUIRED",
              error_summary: "A2A task requires additional authentication",
            },
          },
        ];
      default:
        // unknown 状态：归一化为 progress（不伪造终态）。
        return [
          {
            ...base,
            type: "progress.snapshot",
            payload: { source: "a2a", task_id: update.taskId, task_state: state },
          },
        ];
    }
  }

  /** 解析 SSE 流的一行 data JSON。 */
  function parseUpdate(raw: string): A2AStreamUpdate | JsonRpcResponse | null {
    let parsed: JsonRpcResponse<A2AStreamUpdate> | A2AStreamUpdate;
    try {
      parsed = JSON.parse(raw) as JsonRpcResponse<A2AStreamUpdate>;
    } catch {
      throw new RuntimeTransportError("protocol_schema", "A2A SSE data 不是合法 JSON");
    }
    // JSON-RPC envelope（有 result/error 字段）→ 解包。
    if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) {
      const envelope = parsed as JsonRpcResponse<A2AStreamUpdate>;
      if (envelope.error) {
        return envelope; // 调用方按 error 处理
      }
      return envelope.result ?? null;
    }
    return parsed as A2AStreamUpdate;
  }

  function isUpdate(v: A2AStreamUpdate | JsonRpcResponse | null): v is A2AStreamUpdate {
    return !!v && typeof v === "object" && "kind" in v && "taskId" in v;
  }

  function isRpcError(v: A2AStreamUpdate | JsonRpcResponse | null): v is JsonRpcResponse & {
    error: NonNullable<JsonRpcResponse["error"]>;
  } {
    return !!v && typeof v === "object" && "error" in v && !("kind" in v);
  }

  return {
    async probeCapabilities(
      endpoint: string,
      auth: RuntimeTransportAuth,
    ): Promise<RuntimeCapabilitiesResponse> {
      let resp: Response;
      try {
        resp = await fetchImpl(`${endpoint.replace(/\/$/, "")}/.well-known/agent-card.json`, {
          method: "GET",
          headers: outboundAuthHeaders(auth),
        });
      } catch (err) {
        throw new RuntimeTransportError(
          "stream_interrupted",
          `A2A Agent Card 不可达：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new RuntimeTransportError(
          "endpoint_auth",
          `A2A Agent Card 认证失败（HTTP ${resp.status}）`,
        );
      }
      if (!resp.ok) {
        throw new RuntimeTransportError("protocol_schema", `A2A Agent Card HTTP ${resp.status}`);
      }
      let card: A2AAgentCard;
      try {
        card = (await resp.json()) as A2AAgentCard;
      } catch {
        throw new RuntimeTransportError("protocol_schema", "A2A Agent Card 不是合法 JSON");
      }
      if (typeof card !== "object" || card === null) {
        throw new RuntimeTransportError("protocol_schema", "A2A Agent Card 结构非法");
      }
      // Agent Card → RuntimeCapabilitiesResponse（协议中立能力视图）。
      return {
        protocol_versions: ["2"],
        features: {
          event_stream: card.capabilities?.streaming !== false,
          cancel: true,
          resume: true,
          steer: false,
          dynamic_tools: false,
          user_action: true,
          workspace_types: [],
          filesystem_checkpoint: false,
        },
        limits: {
          max_invocation_seconds: 600,
          max_event_bytes: 1_048_576,
        },
      };
    },

    async startInvocation(req: StartInvocationRequest): Promise<StartInvocationResponse> {
      const body = req.requestBody;
      const threadId = body.turn_context?.thread_id ?? null;
      const text = extractUserMessage(body.input_items);
      const existingContextId =
        threadId && params.resolveExistingContextId
          ? await params.resolveExistingContextId(threadId)
          : null;

      const messageId = randomUUID();
      const rpcParams = {
        message: {
          kind: "message",
          messageId,
          role: "user",
          parts: [{ kind: "text", text }],
          ...(existingContextId ? { contextId: existingContextId } : {}),
          // 公开合同（HR 兼容）：metadata 仅允许 execution_subject 公开对象；
          // 内部 ID/trace/protocol/tenant 等一律不得出现在 wire 上；缺省不发送。
          ...(body.execution_subject
            ? {
                metadata: {
                  execution_subject: {
                    subject_id: body.execution_subject.subject_id,
                    subject_kind:
                      body.execution_subject.subject_type === "service"
                        ? "service"
                        : "platform_user",
                  },
                },
              }
            : {}),
        },
        configuration: { blocking: false },
      };

      let resp: Response;
      try {
        resp = await fetchImpl(req.runtimeEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            // External A2A：workload_token 本地 fail closed；none 不发 Authorization（03 §9）。
            ...outboundAuthHeaders(req.auth),
            "x-idempotency-key": req.idempotencyKey,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: randomUUID(),
            method: "message/stream",
            params: rpcParams,
          }),
        });
      } catch (err) {
        throw new RuntimeTransportError(
          "stream_interrupted",
          `A2A message/stream 不可达：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new RuntimeTransportError(
          "endpoint_auth",
          `A2A message/stream 认证失败（HTTP ${resp.status}）`,
        );
      }
      if (!resp.ok || !resp.body) {
        throw new RuntimeTransportError(
          "protocol_schema",
          `A2A message/stream HTTP ${resp.status}`,
        );
      }

      // SSE 解析：等首个含 taskId 的 update 确定 correlation 后返回；
      // 剩余流在后台继续消费并经 Mapper → eventBatchSink 进入 ingress。
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let nextSequence = 1;
      const pendingBatches: Array<{ events: RuntimeCandidateEvent[]; start: number }> = [];
      let taskId: string | null = null;
      let contextId: string | null = null;
      let firstError: JsonRpcResponse["error"] | null = null;
      let streamDone = false;

      const collectOneEvent = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          streamDone = true;
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        // SSE 事件以空行分隔；每个事件内取 data: 行。
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          // 先推进 boundary（continue 分支不再重复处理同一事件）。
          boundary = buffer.indexOf("\n\n");
          const dataLines = rawEvent
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());
          if (dataLines.length === 0) continue;
          const parsed = parseUpdate(dataLines.join("\n"));
          if (isRpcError(parsed)) {
            if (!taskId) firstError = parsed.error;
            else {
              // 流中错误 → 归一化 execution.failed 推 ingress。
              pendingBatches.push({
                events: [
                  {
                    producer_event_id: `a2a:${body.invocation_id}:${nextSequence}`,
                    producer_sequence: nextSequence,
                    schema_version: 1,
                    type: "execution.failed",
                    payload: {
                      source: "a2a",
                      error_code: "REMOTE_TASK_FAILED",
                      error_summary: parsed.error.message ?? "A2A stream error",
                    },
                  },
                ],
                start: nextSequence,
              });
              nextSequence += 1;
            }
            continue;
          }
          if (!isUpdate(parsed)) continue;
          taskId = parsed.taskId;
          contextId = parsed.contextId ?? contextId;
          const events = mapUpdate(body.invocation_id, nextSequence, parsed);
          pendingBatches.push({ events, start: nextSequence });
          nextSequence += events.length;
        }
      };

      // 读到首个确定 taskId 的 update（或错误/流结束）。
      const deadline = Date.now() + streamTimeoutMs;
      while (!taskId && !firstError && !streamDone) {
        if (Date.now() > deadline) {
          throw new RuntimeTransportError("stream_interrupted", "A2A message/stream 首事件超时");
        }
        await collectOneEvent();
      }
      if (firstError) {
        throwRpcError(firstError);
      }
      if (!taskId || !contextId) {
        throw new RuntimeTransportError(
          "invalid_correlation",
          "A2A message/stream 首事件缺少 taskId/contextId",
        );
      }

      // 批次进入归一化 ingress（幂等/终态拒绝按 Hosted 容错语义忽略）。
      const flushBatches = async (): Promise<void> => {
        for (const batch of pendingBatches.splice(0)) {
          try {
            await params.eventBatchSink({
              invocationId: body.invocation_id,
              events: batch.events,
              producerSequenceStart: batch.start,
            });
          } catch {
            // ingress 幂等/终态拒绝与 Hosted 容错语义一致（终态后事件忽略）。
          }
        }
      };

      // 后台消费剩余流 → Mapper → eventBatchSink（04 §6：只经归一化 ingress）。
      const consumeRest = async (): Promise<void> => {
        try {
          while (!streamDone) {
            await collectOneEvent();
            await flushBatches();
          }
        } catch {
          // 中断已由 deadline/reader 错误表达；不再向调度方抛出（后台任务）。
        }
        await flushBatches();
      };
      const background = consumeRest();
      // 保存后台 promise，避免 unhandled rejection（consumeRest 内部已吞错）。
      void background.catch(() => {});

      return {
        invocation_id: body.invocation_id,
        accepted: true,
        attempt_no: body.attempt?.attempt_no ?? 1,
        runtime_session_ref: contextId,
        runtime_execution_ref: taskId,
        capabilities: {
          protocol_versions: ["2"],
          features: {
            event_stream: true,
            cancel: true,
            resume: true,
            steer: false,
            dynamic_tools: false,
            user_action: true,
            workspace_types: [],
            filesystem_checkpoint: false,
          },
          limits: {
            max_invocation_seconds: body.execution_limits.max_invocation_seconds,
            max_event_bytes: body.execution_limits.max_event_bytes,
          },
        },
      };
    },

    async cancelInvocation(req: CancelInvocationRequest): Promise<CancelInvocationResponse> {
      const refs = params.resolveRuntimeRefs
        ? await params.resolveRuntimeRefs(req.invocationId)
        : null;
      const taskId = refs?.runtimeExecutionRef;
      if (!taskId) {
        throw new RuntimeTransportError(
          "invalid_correlation",
          `无 taskId 可取消（invocation=${req.invocationId}）`,
        );
      }
      const resp = await jsonRpc(
        req.runtimeEndpoint,
        req.auth,
        "tasks/cancel",
        { taskId },
        req.idempotencyKey,
      );
      if (resp.error) {
        if (/not.*(found|exist)/i.test(resp.error.message ?? "")) {
          throw new RuntimeTransportError(
            "resume_target_not_found",
            `A2A task 不存在：${resp.error.message}`,
          );
        }
        throw new RuntimeTransportError(
          "cancellation_rejected",
          `A2A tasks/cancel 被拒绝：${resp.error.message}`,
        );
      }
      return { invocation_id: req.invocationId, cancelled: true, attempt_no: 1 };
    },

    async resumeInvocation(req: ResumeInvocationRequest): Promise<ResumeInvocationResponse> {
      // 1) payload 校验（网络之前）：非空纯文本字符串，或 text 为非空字符串的对象；
      //    发送 trim 后的精确纯文本，绝不 JSON.stringify 任意对象。
      const payload = req.requestBody.resume_payload;
      let resumeText: string | null = null;
      if (typeof payload === "string") {
        resumeText = payload.trim();
      } else if (payload !== null && typeof payload === "object") {
        const text = (payload as Record<string, unknown>).text;
        if (typeof text === "string") resumeText = text.trim();
      }
      if (!resumeText) {
        throw new RuntimeTransportError(
          "protocol_schema",
          "resume_payload 必须是非空纯文本或含非空 text 字段",
        );
      }

      // 2) 关联 refs：taskId/contextId 必须精确已知（fail-closed）。
      const refs = params.resolveRuntimeRefs
        ? await params.resolveRuntimeRefs(req.invocationId)
        : null;
      const taskId = refs?.runtimeExecutionRef;
      const contextId = refs?.runtimeSessionRef;
      if (!taskId || !contextId) {
        throw new RuntimeTransportError(
          "resume_target_not_found",
          `无 taskId/contextId 可恢复（invocation=${req.invocationId}）`,
        );
      }

      // 3) 注入的 next producer sequence（resume 事件重定位；禁止回退进程内计数器）。
      if (!params.resolveNextProducerSequence) {
        throw new RuntimeTransportError(
          "invalid_correlation",
          `resume 缺少 next-producer-sequence resolver（invocation=${req.invocationId}）`,
        );
      }
      const nextSequence = await params.resolveNextProducerSequence(req.invocationId);
      if (typeof nextSequence !== "number" || !Number.isInteger(nextSequence) || nextSequence < 1) {
        throw new RuntimeTransportError(
          "invalid_correlation",
          `next-producer-sequence 非法（invocation=${req.invocationId}）`,
        );
      }

      // 4) message/send：标准 Message 字段（kind/messageId/role/contextId/taskId/parts），
      //    不携带任何内部 metadata。
      const resp = await jsonRpc<A2ATask>(
        req.runtimeEndpoint,
        req.auth,
        "message/send",
        {
          message: {
            kind: "message",
            messageId: randomUUID(),
            role: "user",
            contextId,
            taskId,
            parts: [{ kind: "text", text: resumeText }],
          },
        },
        req.idempotencyKey,
      );
      if (resp.error) {
        throwRpcError(resp.error);
      }
      // 5) 官方 Task 形态（冻结）：kind:"task" + id/contextId/status/artifacts；
      //    不保留非标准同步 status-update 兼容路径。
      const task = resp.result;
      if (
        !task ||
        typeof task !== "object" ||
        task.kind !== "task" ||
        typeof task.id !== "string" ||
        typeof task.contextId !== "string" ||
        !task.status
      ) {
        throw new RuntimeTransportError(
          "protocol_schema",
          "A2A message/send 响应不是官方 Task 形态",
        );
      }
      if (task.id !== taskId || task.contextId !== contextId) {
        throw new RuntimeTransportError(
          "invalid_correlation",
          "A2A message/send Task correlation 与存储 refs 不一致",
        );
      }
      // Task artifacts 进入 task 级缓存（status.message 缺失时的答复文本来源）；
      // 同步 resume 批次不为 artifacts 单独产 progress 事件。
      for (const artifact of task.artifacts ?? []) {
        cacheArtifact(taskId, artifact);
      }

      // 6) 终态 status 经同一 Mapper 归一化，事件序号重定位到注入的 next sequence；
      //    sink 恰一次且失败上抛，成功后才返回 resumed=true。
      const events = mapUpdate(req.invocationId, nextSequence, {
        kind: "status-update",
        taskId: task.id,
        contextId: task.contextId,
        status: task.status,
      });
      await params.eventBatchSink({
        invocationId: req.invocationId,
        events,
        producerSequenceStart: nextSequence,
      });
      return { invocation_id: req.invocationId, resumed: true, attempt_no: 1 };
    },

    async steerInvocation(_req: SteerInvocationRequest): Promise<SteerInvocationResponse> {
      // A2A 0.3.0 冻结范围不含 steer（04 §4）。
      throw new RuntimeTransportError("unsupported_capability", "A2A 0.3.0 不支持 steer");
    },
  };
}
