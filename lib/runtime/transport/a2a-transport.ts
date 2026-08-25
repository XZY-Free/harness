/**
 * A2A 0.3.0 RuntimeTransport 实现（04 §4–§6）。
 *
 * 冻结 wire 合同（04 §4，不实现 A2A 1.x 兼容层）：
 * - JSON-RPC over HTTP（POST {endpoint}）；
 * - message/stream（SSE Task/Artifact updates）；
 * - message/send（resume）；
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
  artifact: { artifactId: string; name?: string; parts?: A2APart[] };
}

/** A2A Message（role/parts）。 */
interface A2AMessage {
  role: string;
  parts: A2APart[];
}

/** A2A Part（取 text）。 */
interface A2APart {
  kind: string;
  text?: string;
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

export interface CreateA2ATransportParams {
  /** 归一化事件批次出口（RuntimeCandidateEvent → RuntimeEventIngress）。 */
  eventBatchSink: A2AEventBatchSink;
  /** invocation → taskId/contextId（cancel/resume 必需；缺省 fail-closed）。 */
  resolveRuntimeRefs?: A2ARuntimeRefResolver;
  /** thread → 已有 contextId（context reuse；不传则每次新会话）。 */
  resolveExistingContextId?: A2AExistingContextResolver;
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

  async function jsonRpc<T>(
    runtimeEndpoint: string,
    authToken: string,
    method: string,
    rpcParams: unknown,
    idempotencyKey?: string,
  ): Promise<JsonRpcResponse<T>> {
    let resp: Response;
    try {
      resp = await fetchImpl(runtimeEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
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
      case "input-required":
        return [
          {
            ...base,
            type: "user_action.requested",
            payload: {
              source: "a2a",
              task_id: update.taskId,
              request_type: "input",
              purpose: "a2a_input_required",
              prompt: messageText(update.status.message) ?? "Agent 请求补充输入",
              message: messageText(update.status.message),
            },
          },
        ];
      case "completed": {
        const text = messageText(update.status.message);
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
    async probeCapabilities(endpoint: string, token: string): Promise<RuntimeCapabilitiesResponse> {
      let resp: Response;
      try {
        resp = await fetchImpl(`${endpoint.replace(/\/$/, "")}/.well-known/agent.json`, {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
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
          metadata: {
            invocation_id: body.invocation_id,
            trace_id: body.trace_context?.trace_id ?? body.invocation_id,
            span_id: body.trace_context?.span_id ?? body.invocation_id,
            protocol: "a2a",
          },
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
            authorization: `Bearer ${req.authToken}`,
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
        req.authToken,
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
      // resume → message/send（blocking 语义下返回最终/下一个 Task 状态）。
      const resumeText =
        typeof req.requestBody.resume_payload === "object" &&
        req.requestBody.resume_payload !== null
          ? JSON.stringify(req.requestBody.resume_payload)
          : String(req.requestBody.resume_payload ?? "");
      const resp = await jsonRpc<A2AStatusUpdate>(
        req.runtimeEndpoint,
        req.authToken,
        "message/send",
        {
          message: {
            kind: "message",
            messageId: randomUUID(),
            role: "user",
            contextId,
            taskId,
            parts: [{ kind: "text", text: resumeText }],
            metadata: { invocation_id: req.invocationId, resume: true },
          },
        },
        req.idempotencyKey,
      );
      if (resp.error) {
        throwRpcError(resp.error);
      }
      const update = resp.result;
      if (!update || typeof update !== "object" || !("taskId" in update)) {
        throw new RuntimeTransportError("protocol_schema", "A2A message/send 响应缺少 Task");
      }
      // resume 后续状态经归一化事件进入（Batch 10 完整接入流式 resume）。
      return { invocation_id: req.invocationId, resumed: true, attempt_no: 1 };
    },

    async steerInvocation(_req: SteerInvocationRequest): Promise<SteerInvocationResponse> {
      // A2A 0.3.0 冻结范围不含 steer（04 §4）。
      throw new RuntimeTransportError("unsupported_capability", "A2A 0.3.0 不支持 steer");
    },
  };
}
