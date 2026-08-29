/**
 * 仓内标准 A2A 验收 Provider（AgentCall 子执行域测试支撑）。
 *
 * 真实 HTTP A2A 0.3.0 Provider（node:http），仅存在 test-support，production 不 import。
 * 黑盒原则（07 §2）：平台侧只通过 Agent Card + 真实 A2A wire behavior 与其交互，
 * 禁止读取本文件源码形成 AgentRevision / CapabilityManifest / Route / Transport 选择。
 *
 * 公开合同（07 §3）：
 * - Agent Card：name/description + capabilities + 通用扩展（capability manifest 与
 *   Invocation Context Contract，明确版本，不绑定任何框架）。标准路径唯一：
 *   /.well-known/agent-card.json（无旧 agent.json 回退）。
 * - Capability Manifest：general assistance / context-aware task / user-input-required
 *   task（任务能力描述，不是函数列表）。
 * - Invocation Context Contract：required=[execution_subject]、
 *   preferred=[current_datetime, timezone, locale, conversation_context]、
 *   accepted=[attachment_references, workspace_context]。
 *
 * HR 官方顺序（冻结）：Task/status start（working）→ artifact-update
 * （TextPart 追问文本 + DataPart 公共结构化结果）→ 终态 status 无 status.message。
 * message/send（resume）同步返回完整 Task（kind:"task"，id/contextId/status/artifacts）。
 *
 * 场景（07 §5）：completed / chunks / input_required / long_running / failed /
 * rejected / malformed / subject_echo。场景由测试显式选择，Provider 按 A2A wire
 * 语义响应。
 */
import { randomUUID } from "node:crypto";
import { type Server, createServer } from "node:http";

/** Provider 公开的 Capability Manifest（任务能力描述，非函数列表）。 */
export const A2A_TEST_PROVIDER_CAPABILITY_MANIFEST = {
  schema_version: "snowharness.capability_manifest@1",
  capabilities: [
    { id: "general_assistance", description: "常规企业助手任务" },
    { id: "context_aware_task", description: "依赖平台上下文的文档/上下文任务" },
    { id: "user_input_required_task", description: "缺少业务信息时向用户追问的任务" },
  ],
} as const;

/** Provider 公开的 Invocation Context Contract（三种 necessity）。 */
export const A2A_TEST_PROVIDER_CONTEXT_CONTRACT = {
  schema_version: "snowharness.invocation_context_contract@1",
  required: [{ context_kind: "execution_subject" }],
  preferred: [
    { context_kind: "current_datetime" },
    { context_kind: "timezone" },
    { context_kind: "locale" },
    { context_kind: "conversation_context" },
  ],
  accepted: [{ context_kind: "attachment_references" }, { context_kind: "workspace_context" }],
} as const;

/** 场景名（07 §5）。 */
export type A2ATestProviderScenario =
  | "completed"
  | "chunks"
  | "input_required"
  | "long_running"
  | "failed"
  | "rejected"
  | "malformed"
  | "subject_echo"
  | "incremental";

/** Provider 收到的 message/stream|message/send 请求（供测试断言 wire 事实）。 */
export interface CapturedA2ARequest {
  method: string;
  /** message.metadata（公开合同：仅 execution_subject 对象，或无 metadata）。 */
  messageMetadata: Record<string, unknown> | undefined;
  /** message.contextId（跨 Turn 连续性证据）。 */
  contextId?: string;
  /** message.taskId（input-required → resume 同 Task 证据）。 */
  taskId?: string;
  /** Provider 为 message/stream 响应生成的 taskId。 */
  responseTaskId?: string;
  /** Provider 为 message/stream 响应生成的 contextId。 */
  responseContextId?: string;
  /** message.parts 文本。 */
  text: string;
  /** resume message/send 时为 true。 */
  resume: boolean;
}

export interface A2ATestProvider {
  server: Server;
  /** Provider 监听地址（http://127.0.0.1:port）。 */
  endpoint: string;
  /** 已捕获的 message 请求（黑盒断言用）。 */
  captured: CapturedA2ARequest[];
  /**
   * 全部到达 Provider 的 HTTP 请求（method + path + Authorization 头，黑盒断言网络序列用）。
   */
  requests: Array<{
    method: string;
    path: string;
    authorization?: string;
    /** x-idempotency-key 头（稳定 Idempotency-Key 断言用）。 */
    idempotencyKey?: string;
  }>;
  /** 每个已解析 JSON-RPC 请求的 method（含 tasks/cancel，分支前记录，wire 观测用）。 */
  rpcMethods: string[];
  /** 下一次 resume（message/send）返回篡改后的 taskId/contextId（correlation 反例）。 */
  corruptResumeCorrelation(): void;
  /** 设置后所有请求必须携带恰好 `Authorization: Bearer <token>`，否则 401。 */
  setExpectedBearerToken(token: string | null): void;
  /** 切换 message/send 的响应形态；默认（冻结）为官方完整 Task。 */
  setResumeResponseShape(shape: "status-update" | "task"): void;
  /** 覆盖 AgentCard 协议版本（制造 "AgentCard 与 Snapshot 冲突" 反例）。缺省 "0.3.0"。 */
  setCardProtocolVersion(version: string): void;
  /** 覆盖 AgentCard capabilities.streaming。缺省 true。 */
  setCardStreaming(streaming: boolean): void;
  /** 设置后任何 message.metadata 携带 allowlist 之外的 context key 即返回 JSON-RPC error。 */
  setStrictMetadataAllowlist(keys: string[] | null): void;
  /** 设置后前 N 个 POST /（JSON-RPC）请求返回 HTTP 503（真实 transient 反例）。 */
  setFlaky(failures: number): void;
  /** 清空 requests/captured/rpcMethods、复位 correlation 篡改与 Bearer 校验，并重置场景。 */
  reset(): void;
  /** 场景切换（每个 Invocation 可用不同场景）。 */
  setScenario(scenario: A2ATestProviderScenario): void;
  close(): Promise<void>;
}

interface RpcRequest {
  jsonrpc?: string;
  method?: string;
  params?: {
    message?: {
      kind?: string;
      messageId?: string;
      role?: string;
      parts?: Array<{ kind?: string; text?: string }>;
      contextId?: string;
      taskId?: string;
      metadata?: Record<string, unknown>;
    };
    /** tasks/get 与 tasks/cancel 官方 TaskQueryParams/TaskIdParams 的 id 字段。 */
    id?: string;
    taskId?: string;
  };
  id?: string | number;
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 启动真实 A2A Provider。黑盒 E2E 用真实 fetch 与之交互。
 */
export async function startA2ATestProvider(
  initialScenario: A2ATestProviderScenario = "completed",
  options: { legacyCardOnly?: boolean } = {},
): Promise<A2ATestProvider> {
  const captured: CapturedA2ARequest[] = [];
  const requests: Array<{
    method: string;
    path: string;
    authorization?: string;
    idempotencyKey?: string;
  }> = [];
  const rpcMethods: string[] = [];
  let scenario: A2ATestProviderScenario = initialScenario;
  let resumeCorrelationCorrupted = false;
  let expectedBearerToken: string | null = null;
  // 官方非流式 message/send 返回完整 Task（默认冻结）。
  let resumeResponseShape: "status-update" | "task" = "task";
  let cardProtocolVersion = "0.3.0";
  let cardStreaming = true;
  let strictMetadataAllowlist: string[] | null = null;
  // 前 N 个 POST / 请求返回 HTTP 503（transient 反例）；随后恢复正常。
  let flakyFailuresRemaining = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    requests.push({
      method: req.method ?? "",
      path: url.pathname,
      authorization:
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      idempotencyKey:
        typeof req.headers["x-idempotency-key"] === "string"
          ? (req.headers["x-idempotency-key"] as string)
          : undefined,
    });

    // Bearer 校验：设置 expected token 后，任何请求不携带恰好匹配的 Authorization 头即 401。
    if (
      expectedBearerToken !== null &&
      req.headers.authorization !== `Bearer ${expectedBearerToken}`
    ) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // ─── Agent Card（07 §3/§7：公开合同，含通用扩展）──────────
    // A2A 0.3.0 标准路径唯一：/.well-known/agent-card.json（无旧 agent.json 回退；
    // legacyCardOnly 只暴露已废弃旧路径，用于冻结 "旧路径不能通过注册验收" 反例）。
    if (
      req.method === "GET" &&
      ((options.legacyCardOnly ? false : url.pathname === "/.well-known/agent-card.json") ||
        url.pathname === "/.well-known/agent.json")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name: "Test Enterprise Agent",
          description: "deterministic external test agent",
          protocolVersion: cardProtocolVersion,
          preferredTransport: "JSONRPC",
          capabilities: { streaming: cardStreaming, push_notifications: false },
          "snowharness:capability_manifest": A2A_TEST_PROVIDER_CAPABILITY_MANIFEST,
          "snowharness:invocation_context_contract": A2A_TEST_PROVIDER_CONTEXT_CONTRACT,
        }),
      );
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    // Failure E2E：真实 transient 反例（前 N 个 JSON-RPC 请求 → HTTP 503）。
    if (flakyFailuresRemaining > 0) {
      flakyFailuresRemaining -= 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "temporarily unavailable" }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let rpc: RpcRequest;
      try {
        rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcRequest;
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
        );
        return;
      }

      // wire 观测：分支前记录每个已解析 JSON-RPC method（含 tasks/cancel）。
      rpcMethods.push(rpc.method ?? "");

      // ─── tasks/cancel（long-running cancel 场景）──────────────
      // 兼容两种 wire：官方 A2A 0.3.0 TaskIdParams.id，与旧 Runtime conformance
      // probe 的 TaskIdParams.taskId；响应同时回填 id 与 taskId。
      if (rpc.method === "tasks/cancel") {
        const taskId = rpc.params?.id ?? rpc.params?.taskId ?? "unknown";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            result: { id: taskId, taskId, state: "canceled" },
          }),
        );
        return;
      }

      // ─── tasks/get（诊断）────────────────────────────────────
      // 官方 A2A 0.3.0：TaskQueryParams.id；响应回填 id/contextId/status。
      if (rpc.method === "tasks/get") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            result: {
              kind: "task",
              id: rpc.params?.id ?? rpc.params?.taskId ?? "unknown",
              taskId: rpc.params?.id ?? rpc.params?.taskId ?? "unknown",
              contextId: "ctx-get",
              status: { state: "working" },
            },
          }),
        );
        return;
      }

      const message = rpc.params?.message;
      if (!message || message.kind !== "message" || !message.messageId) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            error: { code: -32602, message: "Invalid params" },
          }),
        );
        return;
      }

      // 03 专项 Strict Provider：未知 metadata context key → JSON-RPC error（fail closed）。
      const allowlist = strictMetadataAllowlist;
      if (allowlist !== null) {
        const metaKeys = Object.keys(message.metadata ?? {});
        if (metaKeys.some((k) => !allowlist.includes(k))) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id ?? 1,
              error: { code: -32602, message: "unexpected context key" },
            }),
          );
          return;
        }
      }
      const text = (message.parts ?? [])
        .filter((p) => p.kind === "text")
        .map((p) => p.text ?? "")
        .join("");
      const capturedRequest: CapturedA2ARequest = {
        method: rpc.method ?? "",
        messageMetadata: message.metadata,
        contextId: message.contextId,
        taskId: message.taskId,
        text,
        resume: message.taskId !== undefined,
      };
      captured.push(capturedRequest);

      // ─── message/send ─────────────────────────────────────────
      // 带 taskId = resume（官方：返回完整 Task，completed，可篡改 correlation）；
      // 不带 taskId = 非流式 start 调用，按当前场景返回对应状态的完整 Task。
      if (rpc.method === "message/send") {
        const corrupted = (id: string) => (resumeCorrelationCorrupted ? `corrupted-${id}` : id);
        res.writeHead(200, { "content-type": "application/json" });
        if (message.taskId !== undefined) {
          const resumeTaskId = message.taskId ?? "task-1";
          const resumeContextId = message.contextId ?? "ctx-1";
          const result =
            resumeResponseShape === "task"
              ? {
                  kind: "task",
                  id: corrupted(resumeTaskId),
                  contextId: corrupted(resumeContextId),
                  status: { state: "completed" },
                  artifacts: [
                    {
                      artifactId: "art-final",
                      name: "answer",
                      parts: [
                        { kind: "text", text: "申请已提交完成" },
                        { kind: "data", data: { result: { status: "ok" } } },
                      ],
                    },
                  ],
                }
              : {
                  kind: "status-update",
                  taskId: corrupted(resumeTaskId),
                  contextId: corrupted(resumeContextId),
                  status: {
                    state: "completed",
                    message: { role: "agent", parts: [{ kind: "text", text: "已收到补充信息" }] },
                  },
                };
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? 1, result }));
          return;
        }
        // 非流式首次调用：新 Task（有效 id/contextId），状态由场景决定。
        const taskId = randomUUID();
        const contextId = randomUUID();
        const stateByScenario: Record<string, string> = {
          completed: "completed",
          chunks: "completed",
          input_required: "input-required",
          long_running: "working",
          incremental: "completed",
          failed: "failed",
        };
        const state = stateByScenario[scenario] ?? "completed";
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            result: {
              kind: "task",
              id: taskId,
              contextId,
              status: { state },
              ...(state === "completed"
                ? {
                    artifacts: [
                      {
                        artifactId: "art-final",
                        name: "answer",
                        parts: [{ kind: "text", text: "处理完成" }],
                      },
                    ],
                  }
                : {}),
            },
          }),
        );
        return;
      }

      // ─── message/stream：按场景输出真实 SSE wire ─────────────
      const taskId = randomUUID();
      const contextId = message.contextId ?? randomUUID();
      capturedRequest.responseTaskId = taskId;
      capturedRequest.responseContextId = contextId;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });

      const frame = (payload: unknown) => res.write(sseFrame(payload));
      // HR 官方顺序：artifact-update（TextPart 追问 + DataPart 公共结构化结果）
      // 先于无 status.message 的 input-required 终态。
      const artifactUpdate = (artifactId: string, question: string) =>
        frame({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: {
            kind: "artifact-update",
            taskId,
            contextId,
            artifact: {
              artifactId,
              name: "answer",
              parts: [
                { kind: "text", text: question },
                { kind: "data", data: { result: { question } } },
              ],
            },
          },
        });
      const subject = message.metadata?.execution_subject;
      const subjectId =
        subject && typeof subject === "object"
          ? String((subject as Record<string, unknown>).subject_id ?? "")
          : "";
      const subjectKind =
        subject && typeof subject === "object"
          ? String((subject as Record<string, unknown>).subject_kind ?? "")
          : "";

      // A2A 0.3.0 规范：status-update 的 final 为必需字段（终态 final=true，
      // 非终态 final=false）。fixture 按规范发出。
      const FINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);
      const statusUpdate = (state: string, extra: Record<string, unknown> = {}) =>
        frame({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: {
            kind: "status-update",
            taskId,
            contextId,
            status: {
              state,
              final: FINAL_STATES.has(state),
              ...extra,
              ...(scenario === "subject_echo" && subjectId
                ? {
                    message: {
                      role: "agent",
                      parts: [{ kind: "text", text: `subject:${subjectId}:${subjectKind}` }],
                    },
                  }
                : {}),
            },
          },
        });

      switch (scenario) {
        case "completed":
          // HR 官方顺序：artifact-update（TextPart 答复 + DataPart 公共结构化结果）
          // 先于无 status.message 的 completed 终态 → resultText/resultJson 均非空。
          statusUpdate("working");
          frame({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            result: {
              kind: "artifact-update",
              taskId,
              contextId,
              artifact: {
                artifactId: "art-final",
                name: "answer",
                parts: [
                  { kind: "text", text: "处理完成" },
                  { kind: "data", data: { result: { status: "ok" } } },
                ],
              },
            },
          });
          statusUpdate("completed");
          break;
        case "chunks":
          statusUpdate("working");
          statusUpdate("working");
          statusUpdate("completed", {
            message: { role: "agent", parts: [{ kind: "text", text: "分片完成" }] },
          });
          break;
        case "input_required":
          statusUpdate("working");
          artifactUpdate("art-question", "请提供申请日期");
          statusUpdate("input-required");
          break;
        case "long_running":
          statusUpdate("working");
          // 不发终态，等 cancel（测试侧断言 cancel 后连接结束）。
          break;
        case "failed":
          statusUpdate("failed", {
            message: { role: "agent", parts: [{ kind: "text", text: "远端执行失败" }] },
          });
          break;
        case "rejected":
          res.write(
            sseFrame({
              jsonrpc: "2.0",
              id: rpc.id ?? 1,
              error: { code: -32002, message: "Task rejected" },
            }),
          );
          break;
        case "malformed":
          res.write("data: {not-json\n\n");
          break;
        case "subject_echo":
          statusUpdate("completed");
          break;
        case "incremental":
          statusUpdate("working");
          artifactUpdate("art-chunk-1", "第一段内容");
          artifactUpdate("art-chunk-2", "第二段内容");
          statusUpdate("completed", {
            message: { role: "agent", parts: [{ kind: "text", text: "分片完成" }] },
          });
          break;
      }
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("A2A test provider 监听失败");
  }
  const endpoint = `http://127.0.0.1:${address.port}`;

  return {
    server,
    endpoint,
    captured,
    requests,
    rpcMethods,
    corruptResumeCorrelation() {
      resumeCorrelationCorrupted = true;
    },
    setExpectedBearerToken(token: string | null) {
      expectedBearerToken = token;
    },
    setResumeResponseShape(shape: "status-update" | "task") {
      resumeResponseShape = shape;
    },
    setCardProtocolVersion(version: string) {
      cardProtocolVersion = version;
    },
    setCardStreaming(streaming: boolean) {
      cardStreaming = streaming;
    },
    setStrictMetadataAllowlist(keys: string[] | null) {
      strictMetadataAllowlist = keys;
    },
    setFlaky(failures: number) {
      flakyFailuresRemaining = failures;
    },
    reset() {
      strictMetadataAllowlist = null;
      flakyFailuresRemaining = 0;
      captured.length = 0;
      requests.length = 0;
      rpcMethods.length = 0;
      resumeCorrelationCorrupted = false;
      expectedBearerToken = null;
      resumeResponseShape = "task";
      cardProtocolVersion = "0.3.0";
      cardStreaming = true;
      scenario = "input_required";
    },
    setScenario(next: A2ATestProviderScenario) {
      scenario = next;
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
