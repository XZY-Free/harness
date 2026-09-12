import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ProviderExecutionError,
  createProductionProviderExecutorRegistry,
} from "./provider-executor";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake server address missing");
  return `http://127.0.0.1:${address.port}`;
}

describe("production provider executor registry", () => {
  it("联网工具遵守执行合同超时，不使用更宽松的全局超时", async () => {
    vi.stubEnv("WEB_FETCH_DOMAIN_ALLOWLIST", "example.com");
    vi.stubEnv("WEB_FETCH_TIMEOUT_MS", "15000");
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const executor = createProductionProviderExecutorRegistry().get(
      "builtin",
      "builtin.web_search",
    );
    const pending = executor
      .execute({
        endpoint: "",
        threadId: "timeout-thread",
        arguments: { query: "example" },
        executionSubject: { tenantId: "tenant", subjectType: "user", subjectId: "owner" },
        invocationId: "inv",
        toolCallId: "call",
        traceId: "trace",
        externalIdempotencyKey: null,
        sideEffectMode: "read",
        timeoutMs: 100,
        responseMaxBytes: 8192,
        credential: null,
      })
      .catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ code: "WEB_REQUEST_FAILED", dispatched: true });
  });
  it("只注册真实 executor，不把 unsupported provider fallback 成 webhook", () => {
    const registry = createProductionProviderExecutorRegistry({ allowLoopbackHttp: true });
    expect(registry.supports("webhook", "webhook.post_json")).toBe(true);
    expect(registry.supports("builtin", "builtin.web_search")).toBe(true);
    expect(registry.supports("builtin", "builtin.web_fetch")).toBe(true);
    expect(registry.supports("builtin", "builtin.shell")).toBe(true);
    expect(registry.supports("mcp", "webhook.post_json")).toBe(false);
    expect(registry.supports("custom", "webhook.post_json")).toBe(false);
  });

  it("webhook 发送真实 POST，平台注入幂等与主体字段且不回显 auth", async () => {
    type ReceivedRequest = {
      headers: Record<string, string | string[] | undefined>;
      body: unknown;
    };
    let received: ReceivedRequest | null = null;
    const endpoint = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received = {
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, token: "provider-secret" }));
      });
    });
    const executor = createProductionProviderExecutorRegistry({ allowLoopbackHttp: true }).get(
      "webhook",
      "webhook.post_json",
    );
    const result = await executor.execute({
      endpoint,
      arguments: { message: "hello" },
      executionSubject: { tenantId: "tenant-1", subjectType: "user", subjectId: "user-1" },
      invocationId: "inv-1",
      toolCallId: "call-1",
      traceId: "trace-1",
      externalIdempotencyKey: "idem-1",
      sideEffectMode: "write",
      timeoutMs: 1_000,
      responseMaxBytes: 8_192,
      credential: { authorization: "Bearer top-secret" },
    });
    expect(received).not.toBeNull();
    const captured = received as unknown as ReceivedRequest;
    expect(captured.headers.authorization).toBe("Bearer top-secret");
    expect(captured.headers["idempotency-key"]).toBe("idem-1");
    expect(captured.body).toMatchObject({
      arguments: { message: "hello" },
      context: { tenant_id: "tenant-1", subject_id: "user-1", invocation_id: "inv-1" },
    });
    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(result.status).toBe("succeeded");
  });

  it("4xx 是确定失败，可能已送达且无幂等的超时是 unknown", async () => {
    const badEndpoint = await listen((_request, response) => {
      response.writeHead(422).end("invalid");
    });
    const executor = createProductionProviderExecutorRegistry({ allowLoopbackHttp: true }).get(
      "webhook",
      "webhook.post_json",
    );
    await expect(
      executor.execute({
        endpoint: badEndpoint,
        arguments: {},
        executionSubject: { tenantId: "tenant-1", subjectType: "service", subjectId: "svc-1" },
        invocationId: "inv-1",
        toolCallId: "call-1",
        traceId: "trace-1",
        externalIdempotencyKey: null,
        sideEffectMode: "write",
        timeoutMs: 1_000,
        responseMaxBytes: 1_024,
        credential: null,
      }),
    ).rejects.toMatchObject({
      retryClass: "permanent",
      dispatched: true,
    } satisfies Partial<ProviderExecutionError>);

    const transientEndpoint = await listen((_request, response) => {
      response.writeHead(503).end("retry later");
    });
    await expect(
      executor.execute({
        endpoint: transientEndpoint,
        arguments: {},
        executionSubject: { tenantId: "tenant-1", subjectType: "service", subjectId: "svc-1" },
        invocationId: "inv-1",
        toolCallId: "call-1",
        traceId: "trace-1",
        externalIdempotencyKey: "idem-1",
        sideEffectMode: "write",
        timeoutMs: 1_000,
        responseMaxBytes: 1_024,
        credential: null,
      }),
    ).rejects.toMatchObject({ retryClass: "safe_transient", dispatched: true });
    await expect(
      executor.execute({
        endpoint: transientEndpoint,
        arguments: {},
        executionSubject: { tenantId: "tenant-1", subjectType: "service", subjectId: "svc-1" },
        invocationId: "inv-1",
        toolCallId: "call-read",
        traceId: "trace-read",
        externalIdempotencyKey: null,
        sideEffectMode: "read",
        timeoutMs: 1_000,
        responseMaxBytes: 1_024,
        credential: null,
      }),
    ).rejects.toMatchObject({ retryClass: "safe_transient", dispatched: true });

    const timeoutEndpoint = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      setTimeout(() => response.end("{}"), 100);
    });
    await expect(
      executor.execute({
        endpoint: timeoutEndpoint,
        arguments: {},
        executionSubject: { tenantId: "tenant-1", subjectType: "service", subjectId: "svc-1" },
        invocationId: "inv-1",
        toolCallId: "call-1",
        traceId: "trace-1",
        externalIdempotencyKey: null,
        sideEffectMode: "write",
        timeoutMs: 20,
        responseMaxBytes: 1_024,
        credential: null,
      }),
    ).rejects.toMatchObject({ retryClass: "unknown_effect", dispatched: true });
  });

  it("按 execution contract 流式截断过大的 Provider 响应", async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ value: "x".repeat(4_096) }));
    });
    const executor = createProductionProviderExecutorRegistry({ allowLoopbackHttp: true }).get(
      "webhook",
      "webhook.post_json",
    );
    await expect(
      executor.execute({
        endpoint,
        arguments: {},
        executionSubject: { tenantId: "tenant-1", subjectType: "service", subjectId: "svc-1" },
        invocationId: "inv-1",
        toolCallId: "call-1",
        traceId: "trace-1",
        externalIdempotencyKey: null,
        sideEffectMode: "read",
        timeoutMs: 1_000,
        responseMaxBytes: 128,
        credential: null,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE", retryClass: "permanent" });
  });
});
