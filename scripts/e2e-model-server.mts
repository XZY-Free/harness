/**
 * e2e 确定性模型服务（OpenAI 兼容端点）。
 *
 * 为什么这样做：
 * - §20.4 要求 Web E2E 一路断言到「Agent 回复显示」，因此 Agent Loop 必须真的产出文本。
 * - §11.2 允许测试使用「测试密钥 / 测试 HTTP Server」，但要求跑正式组件。
 * - 本服务实现 OpenAI 兼容协议，让 `lib/ai/provider.ts`（含多 endpoint 熔断逻辑）与
 *   `streamText` / `collectModelText` 全部按生产路径执行——生产代码里不需要任何
 *   测试专用分支或 modelFn 注入开关。
 *
 * 确定性：回复由请求中的用户文本推导，同输入同输出，不依赖外部网络。
 * 测试只断言「出现非空 assistant 回复」，不校验文本内容（避免脆弱断言）。
 */
import { type Server, createServer } from "node:http";

/** e2e 回复前缀，便于在服务端日志中辨认确定性回复。 */
export const E2E_REPLY_PREFIX = "[e2e-model]";

export interface E2eModelServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
}

/** 提取最后一条 user 消息的纯文本。 */
function lastUserText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const { content } = message;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part && typeof part === "object" && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
        )
        .join("");
    }
  }
  return "";
}

/** 由用户输入推导确定性回复。 */
function buildReply(userText: string): string {
  const trimmed = userText.trim();
  if (trimmed.length === 0) return `${E2E_REPLY_PREFIX} 收到空消息。`;
  return `${E2E_REPLY_PREFIX} 已收到你的消息：「${trimmed}」。这是 e2e 确定性回复。`;
}

/** 切分为若干 delta，模拟真实流式输出。 */
function toChunks(text: string, size = 12): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}") as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * 启动 e2e 模型服务。
 *
 * @param port 0 表示由系统分配空闲端口。
 */
export function startE2eModelServer(port = 0): Promise<E2eModelServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // 模型列表（部分客户端会探测）。
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "e2e-deterministic", object: "model", owned_by: "snow-harness-e2e" }],
        }),
      );
      return;
    }

    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `未实现的 e2e 模型端点: ${url.pathname}` } }));
      return;
    }

    void readBody(req).then((body) => {
      const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
      const model = typeof body.model === "string" ? body.model : "e2e-deterministic";
      const reply = buildReply(lastUserText(messages));
      const id = `chatcmpl-e2e-${Buffer.from(reply).length}`;
      const created = 1_700_000_000;
      console.log(`[e2e-model] 请求 model=${model} → 回复 ${reply.length} 字符`);

      // 非流式：一次性返回完整结果。
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model,
            choices: [
              { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: reply.length,
              total_tokens: reply.length + 1,
            },
          }),
        );
        return;
      }

      // 流式：标准 OpenAI SSE chunk 序列。
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const base = { id, object: "chat.completion.chunk", created, model };

      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      for (const chunk of toChunks(reply)) {
        send({ ...base, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
      }
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: reply.length,
          total_tokens: reply.length + 1,
        },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("e2e 模型服务无法解析监听地址"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
