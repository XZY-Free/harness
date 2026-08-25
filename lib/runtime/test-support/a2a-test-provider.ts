import { randomUUID } from "node:crypto";
/**
 * 仓内标准 A2A 验收 Provider（07，Batch 9）。
 *
 * 真实 HTTP A2A 0.3.0 Provider（node:http），仅存在 test-support，production 不 import。
 * 黑盒原则（07 §2）：平台侧只通过 Agent Card + 真实 A2A wire behavior 与其交互，
 * 禁止读取本文件源码形成 AgentRevision / CapabilityManifest / Route / Transport 选择。
 *
 * 公开合同（07 §3）：
 * - Agent Card：name/description + capabilities + 通用扩展（capability manifest 与
 *   Invocation Context Contract，明确版本，不绑定任何框架）。
 * - Capability Manifest：general assistance / context-aware task / user-input-required
 *   task（任务能力描述，不是函数列表）。
 * - Invocation Context Contract：required=[execution_subject]、
 *   preferred=[current_datetime, timezone, locale, conversation_context]、
 *   accepted=[attachment_references, workspace_context]。
 *
 * 场景（07 §5）：completed / chunks / input_required / failed / rejected /
 * malformed / subject_echo / long_running（cancel）。场景由测试显式选择，
 * Provider 按 A2A wire 语义响应，供 dispatch E2E 黑盒验证。
 */
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
  | "subject_echo";

/** Provider 收到的 message/stream 请求（供测试断言 wire 事实）。 */
export interface CapturedA2ARequest {
  method: string;
  /** message.metadata（含 invocation_id / snowharness.execution_subject）。 */
  messageMetadata: Record<string, unknown>;
  /** message.contextId（跨 Turn 连续性证据）。 */
  contextId?: string;
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
  /** 场景切换（每个 Invocation 可用不同场景）。 */
  setScenario(scenario: A2ATestProviderScenario): void;
  close(): Promise<void>;
}

interface RpcRequest {
  jsonrpc?: string;
  method?: string;
  params?: {
    message?: {
      role?: string;
      parts?: Array<{ kind?: string; text?: string }>;
      contextId?: string;
      taskId?: string;
      metadata?: Record<string, unknown>;
    };
    taskId?: string;
  };
  id?: string | number;
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 启动真实 A2A Provider。resolveTransport 的黑盒 E2E 用真实 fetch 与之交互。
 */
export async function startA2ATestProvider(
  initialScenario: A2ATestProviderScenario = "completed",
): Promise<A2ATestProvider> {
  const captured: CapturedA2ARequest[] = [];
  let scenario: A2ATestProviderScenario = initialScenario;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // ─── Agent Card（07 §3/§7：公开合同，含通用扩展）──────────
    if (req.method === "GET" && url.pathname === "/.well-known/agent.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name: "Test Enterprise Agent",
          description: "deterministic external test agent",
          capabilities: { streaming: true, push_notifications: false },
          // 通用扩展合同（07 §7：不绑定 HR/veADK/AgentKit，明确版本）。
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

      // ─── tasks/cancel（long-running cancel 场景）──────────────
      if (rpc.method === "tasks/cancel") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            result: { taskId: rpc.params?.taskId ?? "unknown", state: "canceled" },
          }),
        );
        return;
      }

      const message = rpc.params?.message;
      if (!message) {
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

      const text = (message.parts ?? [])
        .filter((p) => p.kind === "text")
        .map((p) => p.text ?? "")
        .join("");
      captured.push({
        method: rpc.method ?? "",
        messageMetadata: message.metadata ?? {},
        contextId: message.contextId,
        text,
        resume: message.metadata?.resume === true || message.taskId !== undefined,
      });

      // ─── message/send（resume；08：继续原 taskId/context）──────
      if (rpc.method === "message/send") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            result: {
              kind: "status-update",
              taskId: message.taskId ?? "task-1",
              contextId: message.contextId ?? "ctx-1",
              status: { state: "working" },
            },
          }),
        );
        return;
      }

      // ─── message/stream：按场景输出真实 SSE wire ─────────────
      const taskId = randomUUID();
      const contextId = message.contextId ?? randomUUID();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });

      const frame = (payload: unknown) => res.write(sseFrame(payload));
      const subject = message.metadata?.["snowharness.execution_subject"];

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
              ...extra,
              ...(scenario === "subject_echo" && subject
                ? {
                    message: {
                      role: "agent",
                      parts: [{ kind: "text", text: `subject:${String(subject)}` }],
                    },
                  }
                : {}),
            },
          },
        });

      switch (scenario) {
        case "completed":
          statusUpdate("working");
          statusUpdate("completed", {
            message: { role: "agent", parts: [{ kind: "text", text: "处理完成" }] },
          });
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
          statusUpdate("input-required", {
            message: { role: "agent", parts: [{ kind: "text", text: "请提供申请日期" }] },
          });
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
