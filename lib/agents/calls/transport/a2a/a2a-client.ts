/**
 * A2A 0.3.0 AgentTransport 实现（lib/agents/calls/transport/a2a/a2a-client.ts）。
 *
 * 冻结 A2A 0.3.0 wire 合同，不实现 A2A 1.x 兼容层：
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
 * 归属：A2A 是「AgentCall → 外部 Agent」的通信协议，绝不是
 * Harness Runtime Protocol。本实现是 AgentTransport，不实现 RuntimeHttpClient。
 *
 * 事件归一化：A2A wire event 必须先进入本 Mapper → AgentCallCandidateEvent
 * （callId 关联）→ eventSink → AgentCallEventIngress → AgentCall state。禁止
 * Web/Desktop 解析 A2A JSON；禁止 Transport 直接更新 Turn/Item；禁止 Transport
 * 直接完成/失败/丢失 parent Invocation。
 *
 * 错误分类：统一抛 AgentTransportError（稳定 kind），不向调用方暴露
 * 供应商 SDK 异常字符串作为合同。
 */
import { randomUUID } from "node:crypto";
import {
  buildA2APublicMessageMetadata,
  createA2AArtifactCache,
  isA2AStreamUpdate,
  isRpcError,
  mapAgentCallUpdate,
  parseAgentCallUpdate,
} from "@/lib/agents/calls/transport/a2a/a2a-mapper";
import type {
  A2AAgentCard,
  A2AArtifact,
  A2AMessage,
  A2AStreamUpdate,
  A2ATask,
  A2ATaskState,
  JsonRpcResponse,
  a2aMessageText,
} from "@/lib/agents/calls/transport/a2a/a2a-types";
import {
  type AgentBackgroundFailureHandler,
  type AgentBackgroundFailureKind,
  type AgentCallEventSink,
  type AgentCallTransportAuth,
  type AgentTransport,
  AgentTransportAuthError,
  AgentTransportError,
  agentCallAuthHeaders,
} from "@/lib/agents/calls/transport/agent-transport";
import type {
  AgentCallCandidateEvent,
  CancelAgentCallParams,
  GetAgentCallParams,
  ResumeAgentCallParams,
  StartAgentCallParams,
  StartAgentCallResult,
} from "@/lib/agents/calls/transport/agent-transport";

export interface CreateA2AAgentTransportParams {
  /**
   * 冻结的能力 profile：创建时由调用方从 Binding 派生。
   * cancel=false / resume=false 时对应方法在网络之前本地拒绝（unsupported_capability，
   * 网络请求次数=0）；Transport 不得用"协议方法实现存在"冒充 capability。
   */
  capabilities: {
    cancel: boolean;
    resume: boolean;
    steer: boolean;
    /**
     * 05 专项（P2-1）：Start response user_action 投影 = effective input_required AND
     * effective resume。Transport 不是 Capability Authority，只投影调用方冻结的
     * effective 事实；缺省 false（fail closed）。
     */
    user_action?: boolean;
    /** Start response event_stream 投影（effective streaming / 本次实际 transport mode）。缺省 true（A2A stream）。 */
    streaming?: boolean;
  };
  /** 归一化事件批次出口（AgentCallCandidateEvent → AgentCallEventIngress）。 */
  eventSink: AgentCallEventSink;
  /** 注入 fetch（测试用；缺省全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 流读取超时（ms；缺省 300s）。 */
  streamTimeoutMs?: number;
  /**
   * 背景流失败上报：Transport 只报告 callId/failureKind/safeSummary，
   * 不直接写 DB；外层 orchestration 再调用正式 AgentCall lost/failed 转移。
   */
  onBackgroundFailure?: AgentBackgroundFailureHandler;
}

/** 抛出 JSON-RPC error 的稳定分类映射。 */
function throwRpcError(error: NonNullable<JsonRpcResponse["error"]>): never {
  const code = error.code ?? 0;
  // JSON-RPC error → 稳定分类：task 不存在 → resume/correlation；-32700/-32600 系列 → protocol_schema；
  // 任务被拒绝 → remote_task_rejected；其余 → remote_task_failed。
  if (code === -32001 || /task.*not.*(found|exist)/i.test(error.message ?? "")) {
    throw new AgentTransportError(
      "resume_target_not_found",
      `A2A task 不存在：${error.message ?? code}`,
    );
  }
  if (code === -32700 || code === -32600 || code === -32602) {
    throw new AgentTransportError("protocol_schema", `A2A 协议错误：${error.message ?? code}`);
  }
  if (code === -32002 || /reject/i.test(error.message ?? "")) {
    throw new AgentTransportError(
      "remote_task_rejected",
      `A2A task 被拒绝：${error.message ?? code}`,
    );
  }
  throw new AgentTransportError("remote_task_failed", `A2A task 失败：${error.message ?? code}`);
}

/**
 * 创建 A2A 0.3.0 AgentTransport（实现 AgentTransport 端口）。
 *
 * - probe → Agent Card（/.well-known/agent-card.json）
 * - startCall → message/stream（SSE），taskId/contextId 关联为
 *   AgentCall.externalTaskRef / AgentSessionBinding.externalContextRef；
 *   后续 updates 由 Mapper 归一化后经 eventSink 进入 AgentCallEventIngress。
 * - cancelCall → tasks/cancel
 * - resumeCall → message/send（same AgentCall / same task/context）
 * - getCall → tasks/get（诊断）
 *
 * 本实现绝不触碰 parent Invocation 终态：completed/failed/lost/input-required
 * 一律落到 AgentCall，由 Harness Loop 决定顶层走向。
 */
export function createA2AAgentTransport(params: CreateA2AAgentTransportParams): AgentTransport {
  const fetchImpl = params.fetchImpl ?? fetch;
  // 超时配置由调用方注入；不再二次固定回退路径。
  const streamTimeoutMs = params.streamTimeoutMs ?? 300_000;
  const artifacts = createA2AArtifactCache();
  if (!Number.isFinite(streamTimeoutMs) || streamTimeoutMs <= 0) {
    throw new AgentTransportError("protocol_schema", "streamTimeoutMs 必须为正数");
  }

  /** 网络前校验 auth：仅 none 或非空 bearer；未知 mode / workload_token / 空 bearer → 拒绝。 */
  function validateAuth(auth: AgentCallTransportAuth): Record<string, string> {
    if (auth && auth.mode === "none") return {};
    if (
      auth &&
      auth.mode === "bearer" &&
      typeof auth.token === "string" &&
      auth.token.trim().length > 0
    ) {
      return { authorization: `Bearer ${auth.token}` };
    }
    throw new AgentTransportAuthError(
      "A2A AgentTransport 仅接受 none 或非空 bearer 认证；workload_token/空 bearer 本地 fail closed",
    );
  }

  /** 网络前校验非空字符串字段（endpoint / input / idempotency key）。 */
  function assertNonblank(value: unknown, field: string): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new AgentTransportError("protocol_schema", `${field} 必须是非空字符串`);
    }
  }

  async function jsonRpc<T>(
    endpoint: string,
    auth: AgentCallTransportAuth,
    method: string,
    rpcParams: unknown,
    idempotencyKey?: string,
  ): Promise<JsonRpcResponse<T>> {
    const authHeader = validateAuth(auth);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), streamTimeoutMs);
    let resp: Response;
    try {
      resp = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeader,
          ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params: rpcParams }),
      });
    } catch (err) {
      throw new AgentTransportError(
        "stream_interrupted",
        `A2A endpoint 不可达：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new AgentTransportError(
        "endpoint_auth",
        `A2A endpoint 认证失败（HTTP ${resp.status}）`,
      );
    }
    if (resp.status === 503) {
      throw new AgentTransportError("stream_interrupted", "A2A endpoint HTTP 503 暂不可用");
    }
    if (!resp.ok) {
      throw new AgentTransportError("protocol_schema", `A2A endpoint HTTP ${resp.status}`);
    }
    try {
      return (await resp.json()) as JsonRpcResponse<T>;
    } catch {
      throw new AgentTransportError("protocol_schema", "A2A 响应不是合法 JSON");
    }
  }

  /** 解析 SSE 流的一行 data JSON（失败抛 protocol_schema）。 */
  function parseUpdate(raw: string): A2AStreamUpdate | JsonRpcResponse | null {
    try {
      return parseAgentCallUpdate(raw) as A2AStreamUpdate | JsonRpcResponse | null;
    } catch (err) {
      throw new AgentTransportError(
        "protocol_schema",
        err instanceof Error ? err.message : "A2A SSE data 不是合法 JSON",
      );
    }
  }

  return {
    async probe({ endpoint, auth }) {
      assertNonblank(endpoint, "endpoint");
      const authHeader = validateAuth(auth);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), streamTimeoutMs);
      let resp: Response;
      try {
        resp = await fetchImpl(`${endpoint.replace(/\/$/, "")}/.well-known/agent-card.json`, {
          method: "GET",
          headers: authHeader,
          signal: controller.signal,
        });
      } catch (err) {
        throw new AgentTransportError(
          "stream_interrupted",
          `A2A Agent Card 不可达：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new AgentTransportError(
          "endpoint_auth",
          `A2A Agent Card 认证失败（HTTP ${resp.status}）`,
        );
      }
      if (!resp.ok) {
        throw new AgentTransportError("protocol_schema", `A2A Agent Card HTTP ${resp.status}`);
      }
      let card: A2AAgentCard;
      try {
        card = (await resp.json()) as typeof card;
      } catch {
        throw new AgentTransportError("protocol_schema", "A2A Agent Card 不是合法 JSON");
      }
      if (typeof card !== "object" || card === null) {
        throw new AgentTransportError("protocol_schema", "A2A Agent Card 结构非法");
      }
      // A2A 0.3.0：Agent Card 必须声明 protocolVersion === "0.3.0"（version 只是 Agent 版本）。
      if (card.protocolVersion !== "0.3.0") {
        throw new AgentTransportError(
          "protocol_schema",
          `A2A Agent Card protocolVersion 必须为 0.3.0（收到 ${String(card.protocolVersion)}）`,
        );
      }
      // Agent Card → AgentCardCapabilities（协议中立能力视图）。
      // Transport 的“协议方法实现存在”不得冒充 effective capability；
      // cancel/resume/user_action 不无条件为 true —— effective capability
      // 来自 Conformance 的 measured 证据（Agent Card 无对应声明 → false）。
      return {
        protocol_versions: ["0.3.0"],
        features: {
          event_stream: card.capabilities?.streaming !== false,
          cancel: false,
          resume: false,
          steer: false,
          dynamic_tools: false,
          user_action: false,
          workspace_types: [],
          filesystem_checkpoint: false,
        },
        limits: {
          max_invocation_seconds: 600,
          max_event_bytes: 1_048_576,
        },
      };
    },

    async startCall(req: StartAgentCallParams): Promise<StartAgentCallResult> {
      // 网络前校验：input / endpoint / idempotencyKey 非空，auth none 或非空 bearer。
      assertNonblank(req.callId, "callId");
      assertNonblank(req.input, "input");
      assertNonblank(req.endpoint, "endpoint");
      assertNonblank(req.idempotencyKey, "idempotencyKey");
      const authHeaders = validateAuth(req.auth);

      const text = req.input;
      const existingContextId = req.existingContextId ?? null;
      const contextMetadata = buildA2APublicMessageMetadata(toContextEntries(req.contextMetadata));
      const rpcParams = {
        message: {
          kind: "message",
          messageId: randomUUID(),
          role: "user",
          parts: [{ kind: "text", text }],
          ...(existingContextId ? { contextId: existingContextId } : {}),
          ...(Object.keys(contextMetadata).length > 0 ? { metadata: contextMetadata } : {}),
        },
        configuration: { blocking: false },
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), streamTimeoutMs);
      let resp: Response;
      try {
        resp = await fetchImpl(req.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            ...authHeaders,
            "x-idempotency-key": req.idempotencyKey,
          },
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: randomUUID(),
            method: "message/stream",
            params: rpcParams,
          }),
        });
      } catch (err) {
        throw new AgentTransportError(
          "stream_interrupted",
          `A2A message/stream 不可达：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new AgentTransportError(
          "endpoint_auth",
          `A2A message/stream 认证失败（HTTP ${resp.status}）`,
        );
      }
      if (resp.status === 503) {
        throw new AgentTransportError(
          "stream_interrupted",
          "A2A message/stream HTTP 503（Agent 暂不可用）",
        );
      }
      if (!resp.ok || !resp.body) {
        throw new AgentTransportError("protocol_schema", `A2A message/stream HTTP ${resp.status}`);
      }

      // SSE 解析：等首个含 taskId 的 update 确定 correlation 后返回；
      // 剩余流在后台继续消费并经 Mapper → eventSink 进入 AgentCallEventIngress。
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let nextSequence = 1;
      const pendingBatches: Array<{ events: AgentCallCandidateEvent[]; start: number }> = [];
      let taskId: string | null = null;
      let contextId: string | null = null;
      let firstError: JsonRpcResponse["error"] | null = null;
      let streamDone = false;
      const stopped = false;
      // 背景失败上报 per-call（非 transport 全局）：多个独立 call 互不抑制。
      let backgroundFailureReported = false;
      const reportBackgroundFailure = async (
        failureKind: AgentBackgroundFailureKind,
        callId: string,
        safeSummary: string,
      ): Promise<void> => {
        if (backgroundFailureReported) return;
        backgroundFailureReported = true;
        if (!params.onBackgroundFailure) return;
        try {
          await params.onBackgroundFailure({ callId, failureKind, safeSummary });
        } catch {
          // handler 自身异常不改变流消费事实（幂等兜底）。
        }
      };
      // correlation 已确立后，后续事件 taskId/contextId 失配 → correlation_lost，停止消费。
      let correlationBroken = false;

      // 每次 reader.read 都以 streamTimeoutMs 上界竞速；超时取消 reader 并抛错。
      // 用可清理 timer：read 先完成即 clear，避免残留计时器造成额外延迟。
      const readOnce = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reader.cancel().catch(() => {});
            reject(new AgentTransportError("stream_interrupted", "A2A stream read timeout"));
          }, streamTimeoutMs);
          (timer as unknown as { unref?: () => void }).unref?.();
        });
        try {
          return await Promise.race([reader.read(), timeout]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };

      const collectOneEvent = async (): Promise<void> => {
        const { done, value } = await readOnce();
        if (done) {
          streamDone = true;
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        // SSE 事件以空行分隔（规范允许 LF 或 CRLF）；每个事件内取 data: 行。
        let boundaryMatch = /\r?\n\r?\n/.exec(buffer);
        while (boundaryMatch !== null) {
          const rawEvent = buffer.slice(0, boundaryMatch.index);
          buffer = buffer.slice(boundaryMatch.index + boundaryMatch[0].length);
          boundaryMatch = /\r?\n\r?\n/.exec(buffer);
          const dataLines = rawEvent
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());
          if (dataLines.length === 0) continue;
          const parsed = parseUpdate(dataLines.join("\n"));
          if (isRpcError(parsed)) {
            if (!taskId) firstError = parsed.error;
            else {
              pendingBatches.push({
                events: [
                  {
                    producer_event_id: `a2a:${req.callId}:${nextSequence}`,
                    producer_sequence: nextSequence,
                    schema_version: 1,
                    type: "call.failed",
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
          if (!isA2AStreamUpdate(parsed)) {
            // 官方 Task 形态首事件（kind=task + id/contextId，无 taskId 字段）：
            // 建立 correlation refs，并把 Task.status 映射为 call.* 事件（不丢 started）。
            if (
              parsed &&
              typeof parsed === "object" &&
              (parsed as Record<string, unknown>).kind === "task"
            ) {
              const task = parsed as {
                id?: unknown;
                contextId?: unknown;
                status?: { state?: unknown; message?: unknown };
              };
              if (
                typeof task.id === "string" &&
                task.id.length > 0 &&
                typeof task.contextId === "string" &&
                task.contextId.length > 0
              ) {
                // correlation 已确立后，Task 形态也必须 exact match，否则 fail closed。
                if (taskId !== null && (task.id !== taskId || task.contextId !== contextId)) {
                  correlationBroken = true;
                  await reportBackgroundFailure(
                    "correlation_lost",
                    req.callId,
                    "A2A Task 事件 correlation 失配",
                  );
                  break;
                }
                taskId = task.id;
                contextId = task.contextId;
                if (
                  task.status &&
                  typeof task.status === "object" &&
                  typeof task.status.state === "string"
                ) {
                  const events = mapAgentCallUpdate(
                    req.callId,
                    nextSequence,
                    {
                      kind: "status-update",
                      taskId,
                      contextId,
                      status: task.status as {
                        state: A2ATaskState;
                        message?: A2AMessage | null;
                      },
                    },
                    artifacts,
                  );
                  pendingBatches.push({ events, start: nextSequence });
                  nextSequence += events.length;
                }
              }
            }
            continue;
          }
          // 正常 A2AStreamUpdate：correlation 已确立后必须 exact match，不得重定 correlation。
          if (
            taskId !== null &&
            (parsed.taskId !== taskId ||
              (parsed.contextId != null && parsed.contextId !== contextId))
          ) {
            correlationBroken = true;
            await reportBackgroundFailure(
              "correlation_lost",
              req.callId,
              "A2A 流 task/context correlation 失配",
            );
            break;
          }
          taskId = parsed.taskId;
          contextId = parsed.contextId ?? contextId;
          const events = mapAgentCallUpdate(req.callId, nextSequence, parsed, artifacts);
          pendingBatches.push({ events, start: nextSequence });
          nextSequence += events.length;
        }
      };

      // 读到首个确定 taskId 的 update（或错误/流结束）。
      const deadline = Date.now() + streamTimeoutMs;
      while (!taskId && !firstError && !streamDone) {
        if (Date.now() > deadline) {
          throw new AgentTransportError("stream_interrupted", "A2A message/stream 首事件超时");
        }
        await collectOneEvent();
      }
      if (firstError) {
        throwRpcError(firstError);
      }
      if (!taskId || !contextId) {
        throw new AgentTransportError(
          "invalid_correlation",
          "A2A message/stream 首事件缺少 taskId/contextId",
        );
      }

      // ─── detached stream 显式终态跟踪 + 背景失败上报 ───
      // terminalObserved：明确 terminal 事件已成功进入 Ingress 后置 true；
      // waitingUserObserved：call.input_required 已成功进入 Ingress 后置 true。
      let terminalObserved = false;
      let waitingUserObserved = false;

      const isTerminalEvent = (type: string): boolean =>
        type === "call.completed" ||
        type === "call.failed" ||
        type === "call.cancelled" ||
        type === "call.lost";

      // 批次进入归一化 AgentCallEventIngress；只忽略 typed expected condition。
      // 幂等重放由 ingress 静默复用（不抛错）。
      const flushBatches = async (): Promise<void> => {
        for (const batch of pendingBatches.splice(0)) {
          try {
            await params.eventSink({
              callId: req.callId,
              events: batch.events,
              producerSequenceStart: batch.start,
            });
          } catch {
            await reportBackgroundFailure(
              "ingress_failed",
              req.callId,
              "A2A 事件批次 ingress 失败",
            );
            throw new AgentTransportError("stream_interrupted", "A2A 事件批次 ingress 失败");
          }
          if (batch.events.some((e) => isTerminalEvent(e.type))) terminalObserved = true;
          if (batch.events.some((e) => e.type === "call.input_required")) {
            waitingUserObserved = true;
          }
        }
      };

      // Durable handoff：startCall 返回前必须把首个已确认 task/context 事件落库。
      // 长运行流可能在首个 working 后长期无新帧，不能把关联只留在进程内队列。
      await flushBatches();

      // 后台消费剩余流 → Mapper → eventSink；只经归一化 ingress。
      // reader/network error → stream_read_failed；malformed JSON/protocol →
      // protocol_parse_failed；remote explicit terminal（failed/rejected/canceled）
      // 是协议终态（call.failed/cancelled），不是 lost。
      const consumeRest = async (): Promise<void> => {
        let stopped = false;
        while (!streamDone && !stopped && !correlationBroken) {
          try {
            await collectOneEvent();
          } catch (err) {
            stopped = true;
            if (err instanceof AgentTransportError && err.kind === "protocol_schema") {
              await reportBackgroundFailure(
                "protocol_parse_failed",
                req.callId,
                "A2A SSE data 不是合法协议事件",
              );
            } else {
              await reportBackgroundFailure(
                "stream_read_failed",
                req.callId,
                err instanceof Error ? err.message : "A2A stream 读取失败",
              );
            }
            break;
          }
          try {
            await flushBatches();
          } catch {
            stopped = true;
            break;
          }
        }
        // correlation 失配已上报（correlation_lost），不再冲刷/不覆盖为 EOF lost。
        if (stopped || correlationBroken) return;
        // 正常 EOF：冲刷尾部批次后按正式终态规则判定。
        try {
          await flushBatches();
        } catch {
          return;
        }
        if (!terminalObserved && !waitingUserObserved) {
          await reportBackgroundFailure(
            "stream_eof_before_terminal",
            req.callId,
            "A2A stream EOF 前未观察到 terminal 或 input-required 事件",
          );
        }
      };
      const background = consumeRest();
      void background.catch(() => {});

      return {
        callId: req.callId,
        taskId,
        contextId,
        capabilities: {
          protocol_versions: ["0.3.0"],
          features: {
            event_stream: params.capabilities.streaming ?? true,
            cancel: params.capabilities.cancel,
            resume: params.capabilities.resume,
            steer: params.capabilities.steer,
            dynamic_tools: false,
            user_action: params.capabilities.user_action ?? false,
            workspace_types: [],
            filesystem_checkpoint: false,
          },
          limits: {
            max_invocation_seconds: 600,
            max_event_bytes: 1_048_576,
          },
        },
      };
    },

    async resumeCall(req: ResumeAgentCallParams): Promise<void> {
      // frozen profile 二次保护：resume=false 本地拒绝，不发任何网络请求。
      if (!params.capabilities.resume) {
        throw new AgentTransportError(
          "unsupported_capability",
          `A2A Transport 冻结能力不含 resume（call=${req.callId}）`,
        );
      }
      // 1) payload 校验（网络之前）：非空纯文本字符串（null/undefined/对象等非字符串
      //    也必须在此 fail closed，绝不在 .trim() 上抛裸 TypeError）。
      if (typeof req.text !== "string" || req.text.trim().length === 0) {
        throw new AgentTransportError("protocol_schema", "resume_payload 必须是非空纯文本");
      }
      const resumeText = req.text.trim();

      // 2) 关联 refs：taskId/contextId 必须精确已知（fail-closed）。
      if (!req.taskId || !req.contextId) {
        throw new AgentTransportError(
          "resume_target_not_found",
          `无 taskId/contextId 可恢复（call=${req.callId}）`,
        );
      }

      // 3) next producer sequence 重定位（resume 事件；禁止回退进程内计数器）。
      if (
        typeof req.nextProducerSequence !== "number" ||
        !Number.isInteger(req.nextProducerSequence) ||
        req.nextProducerSequence < 1
      ) {
        throw new AgentTransportError(
          "invalid_correlation",
          `next-producer-sequence 非法（call=${req.callId}）`,
        );
      }

      // 4) message/send：标准 Message 字段（kind/messageId/role/contextId/taskId/parts）
      //    + 公共 Context metadata（same task/context、fresh metadata）。
      const resumeMetadata = buildA2APublicMessageMetadata(toContextEntries(req.contextMetadata));
      const resp = await jsonRpc<A2ATask>(
        req.endpoint,
        req.auth,
        "message/send",
        {
          message: {
            kind: "message",
            messageId: randomUUID(),
            role: "user",
            contextId: req.contextId,
            taskId: req.taskId,
            parts: [{ kind: "text", text: resumeText }],
            ...(Object.keys(resumeMetadata).length > 0 ? { metadata: resumeMetadata } : {}),
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
        throw new AgentTransportError("protocol_schema", "A2A message/send 响应不是官方 Task 形态");
      }
      if (task.id !== req.taskId || task.contextId !== req.contextId) {
        throw new AgentTransportError(
          "invalid_correlation",
          "A2A message/send Task correlation 与存储 refs 不一致",
        );
      }
      // Task artifacts 进入任务级缓存（status.message 缺失时的答复文本来源）。
      for (const artifact of task.artifacts ?? []) {
        artifacts.set(task.id, artifact as A2AArtifact);
      }

      // 6) 终态 status 经同一 Mapper 归一化，事件序号重定位到注入的 next sequence；
      //    sink 恰一次且失败上抛，成功后才返回。
      const events = mapAgentCallUpdate(
        req.callId,
        req.nextProducerSequence,
        {
          kind: "status-update",
          taskId: task.id,
          contextId: task.contextId,
          status: task.status,
        },
        artifacts,
      );
      await params.eventSink({
        callId: req.callId,
        events,
        producerSequenceStart: req.nextProducerSequence,
      });
    },

    async cancelCall(req: CancelAgentCallParams): Promise<void> {
      // frozen profile 二次保护：cancel=false 本地拒绝，不发任何网络请求。
      if (!params.capabilities.cancel) {
        throw new AgentTransportError(
          "unsupported_capability",
          `A2A Transport 冻结能力不含 cancel（call=${req.callId}）`,
        );
      }
      if (!req.taskId) {
        throw new AgentTransportError(
          "invalid_correlation",
          `无 taskId 可取消（call=${req.callId}）`,
        );
      }
      const resp = await jsonRpc(
        req.endpoint,
        req.auth,
        "tasks/cancel",
        // 官方 A2A 0.3.0：TaskIdParams.id，不是 taskId。
        { id: req.taskId },
        req.idempotencyKey,
      );
      if (resp.error) {
        if (/not.*(found|exist)/i.test(resp.error.message ?? "")) {
          throw new AgentTransportError(
            "resume_target_not_found",
            `A2A task 不存在：${resp.error.message}`,
          );
        }
        throw new AgentTransportError(
          "cancellation_rejected",
          `A2A tasks/cancel 被拒绝：${resp.error.message}`,
        );
      }
    },

    async getCall(
      req: GetAgentCallParams,
    ): Promise<{ state: string; taskId: string; contextId: string }> {
      const resp = await jsonRpc<{
        kind?: string;
        id?: string;
        contextId?: string;
        status?: { state?: string };
      }>(
        req.endpoint,
        req.auth,
        "tasks/get",
        // 官方 A2A 0.3.0：TaskQueryParams.id，不是 taskId。
        { id: req.taskId },
      );
      if (resp.error) {
        throwRpcError(resp.error);
      }
      const task = resp.result;
      // 先验官方 Task 形状（kind/id/contextId/status）；缺任何字段 → protocol_schema。
      if (
        !task ||
        typeof task !== "object" ||
        task.kind !== "task" ||
        typeof task.id !== "string" ||
        typeof task.contextId !== "string" ||
        !task.status ||
        typeof task.status.state !== "string"
      ) {
        throw new AgentTransportError("protocol_schema", "A2A tasks/get 响应不是官方 Task 形状");
      }
      // 再验 correlation：返回的 task id 必须等于请求 ref，否则拒绝错配。
      if (task.id !== req.taskId) {
        throw new AgentTransportError(
          "invalid_correlation",
          `A2A tasks/get 返回 task id 与请求 ref 不一致（${task.id} ≠ ${req.taskId}）`,
        );
      }
      return { state: task.status.state, taskId: task.id, contextId: task.contextId };
    },
  };
}

/** 把平坦 metadata object 转成 invocation_context 条目数组（mapper 输入形状）。 */
function toContextEntries(
  metadata?: Record<string, unknown>,
): Array<{ context_kind: string; value: unknown }> {
  if (!metadata) return [];
  return Object.entries(metadata).map(([context_kind, value]) => ({ context_kind, value }));
}
