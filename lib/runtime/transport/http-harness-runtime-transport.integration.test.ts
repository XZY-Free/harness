import { once } from "node:events";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OutboundRuntimeAuthError } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import type { RuntimeHttpClientError } from "@/lib/runtime/errors";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import { afterEach, describe, expect, it, vi } from "vitest";

const capabilities = {
  protocol_versions: ["2"],
  features: {
    event_stream: true,
    cancel: true,
    resume: true,
    steer: true,
    dynamic_tools: false,
    user_action: true,
    workspace_types: ["cloud"],
    filesystem_checkpoint: false,
  },
  limits: { max_invocation_seconds: 600, max_event_bytes: 1_048_576 },
};

interface RecordedRequest {
  method: string;
  url: string;
  authorization?: string;
  body: unknown;
}

const closeServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closeServers.splice(0)) await close();
  vi.unstubAllGlobals();
});

async function startBlackBoxServer(
  handler?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean> | boolean,
) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    if (handler && (await handler(request, response))) return;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
      body: rawBody ? JSON.parse(rawBody) : null,
    });
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/runtime/v1/capabilities")) {
      response.end(JSON.stringify(capabilities));
      return;
    }
    if (request.url === "/runtime/v1/invocations") {
      response.end(
        JSON.stringify({
          invocation_id: "invocation-1",
          accepted: true,
          attempt_no: 1,
          runtime_session_ref: "external-session-1",
          runtime_execution_ref: "external-execution-1",
          capabilities,
        }),
      );
      return;
    }
    const invocationId = request.url?.split("/")[4];
    response.end(
      JSON.stringify({
        invocation_id: invocationId,
        attempt_no: 1,
        ...(request.url?.endsWith("/cancel")
          ? { cancelled: true }
          : request.url?.endsWith("/resume")
            ? { resumed: true, requires_redispatch: false }
            : { steered: true }),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  closeServers.push(async () => {
    server.close();
    await once(server, "close");
  });
  return { endpoint: `http://127.0.0.1:${address.port}`, requests };
}

describe("HttpHarnessRuntimeTransport black-box wire", () => {
  it("五个方法只使用绑定的 endpoint/auth 与 canonical Runtime Protocol route", async () => {
    const server = await startBlackBoxServer();
    const transport = createHttpHarnessRuntimeTransport({
      endpoint: server.endpoint,
      auth: { mode: "bearer", token: "external-test-token" },
    });
    await transport.probeCapabilities("https://ignored.example", { mode: "none" });
    await transport.startInvocation({
      runtimeEndpoint: "https://ignored.example",
      auth: { mode: "none" },
      idempotencyKey: "start-1",
      requestBody: {
        protocol_version: "2",
        invocation_id: "invocation-1",
        input_items: [],
        context_handle: "context-1",
        governance_config: { revision_id: "gov-1", config_digest: "sha256:x", config: {} },
        gateway_access: { access_token: "gateway-token", expires_at: new Date().toISOString() },
        gateway_endpoints: {} as never,
        execution_limits: { max_invocation_seconds: 60, max_event_bytes: 1_000 },
        trace_context: { trace_id: "trace-1", span_id: "span-1" },
      },
    });
    await transport.cancelInvocation({
      runtimeEndpoint: "ignored",
      auth: { mode: "none" },
      invocationId: "invocation-1",
      idempotencyKey: "cancel-1",
      requestBody: { reason: "user_cancel" },
    });
    await transport.resumeInvocation({
      runtimeEndpoint: "ignored",
      auth: { mode: "none" },
      invocationId: "invocation-1",
      idempotencyKey: "resume-1",
      requestBody: {
        resume_payload: { answer: "同意" },
        gateway_access: { access_token: "gateway-token-2", expires_at: new Date().toISOString() },
      },
    });
    await transport.steerInvocation({
      runtimeEndpoint: "ignored",
      auth: { mode: "none" },
      invocationId: "invocation-1",
      idempotencyKey: "steer-1",
      requestBody: { steer_payload: { guidance: "先核对余额" } },
    });

    expect(server.requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "/runtime/v1/capabilities?protocol_version=2" },
      { method: "POST", url: "/runtime/v1/invocations" },
      { method: "POST", url: "/runtime/v1/invocations/invocation-1/cancel" },
      { method: "POST", url: "/runtime/v1/invocations/invocation-1/resume" },
      { method: "POST", url: "/runtime/v1/invocations/invocation-1/steer" },
    ]);
    expect(
      server.requests.every((request) => request.authorization === "Bearer external-test-token"),
    ).toBe(true);
    expect(server.requests[1]?.body).not.toHaveProperty("tenantId");
    expect(server.requests[1]?.body).not.toHaveProperty("userId");
    expect(server.requests[1]?.body).not.toHaveProperty("execution_subject");
  });

  it("External transport 拒绝内部 workload token，且不发网络", async () => {
    const server = await startBlackBoxServer();
    expect(() =>
      createHttpHarnessRuntimeTransport({
        endpoint: server.endpoint,
        auth: { mode: "workload_token", token: "internal-token" },
      }),
    ).toThrow(OutboundRuntimeAuthError);
    expect(server.requests).toHaveLength(0);
  });

  it("invalid JSON 与 503 产生稳定、可分类错误", async () => {
    const invalid = await startBlackBoxServer((request, response) => {
      if (!request.url?.startsWith("/runtime/v1/capabilities")) return false;
      response.setHeader("content-type", "application/json");
      response.end("not-json");
      return true;
    });
    const invalidTransport = createHttpHarnessRuntimeTransport({
      endpoint: invalid.endpoint,
      auth: { mode: "none" },
    });
    await expect(invalidTransport.probeCapabilities("", { mode: "none" })).rejects.toMatchObject({
      name: "RuntimeHttpClientError",
      kind: "protocol",
      stableCode: "RUNTIME_INVALID_JSON",
      retryable: false,
      dispatchPossiblyStarted: false,
    } satisfies Partial<RuntimeHttpClientError>);

    const unavailable = await startBlackBoxServer((_request, response) => {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "busy" } }));
      return true;
    });
    const unavailableTransport = createHttpHarnessRuntimeTransport({
      endpoint: unavailable.endpoint,
      auth: { mode: "none" },
    });
    await expect(
      unavailableTransport.cancelInvocation({
        runtimeEndpoint: "ignored",
        auth: { mode: "none" },
        invocationId: "invocation-1",
        idempotencyKey: "cancel-503",
        requestBody: { reason: "user_cancel" },
      }),
    ).rejects.toMatchObject({
      kind: "http",
      stableCode: "RUNTIME_UNAVAILABLE",
      retryable: true,
      dispatchPossiblyStarted: true,
    } satisfies Partial<RuntimeHttpClientError>);
  });

  it.each([
    [401, "RUNTIME_AUTH_REJECTED", false],
    [403, "RUNTIME_AUTH_REJECTED", false],
    [404, "RUNTIME_ROUTE_NOT_FOUND", false],
    [409, "RUNTIME_CONFLICT", false],
    [429, "RUNTIME_RATE_LIMITED", true],
    [500, "RUNTIME_UNAVAILABLE", true],
  ] as const)("HTTP %i 保留稳定错误分类", async (status, stableCode, retryable) => {
    const server = await startBlackBoxServer((_request, response) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { code: `HTTP_${status}`, message: "rejected" } }));
      return true;
    });
    const transport = createHttpHarnessRuntimeTransport({
      endpoint: server.endpoint,
      auth: { mode: "none" },
    });
    await expect(
      transport.cancelInvocation({
        runtimeEndpoint: "ignored",
        auth: { mode: "none" },
        invocationId: "invocation-1",
        idempotencyKey: `cancel-${status}`,
        requestBody: { reason: "classification" },
      }),
    ).rejects.toMatchObject({
      kind: "http",
      httpStatus: status,
      stableCode,
      retryable,
      dispatchPossiblyStarted: true,
    } satisfies Partial<RuntimeHttpClientError>);
  });

  it("timeout 与响应 schema mismatch fail closed", async () => {
    const timeout = await startBlackBoxServer(() => true);
    const timeoutTransport = createHttpHarnessRuntimeTransport({
      endpoint: timeout.endpoint,
      auth: { mode: "none" },
      timeoutMs: 20,
    });
    await expect(timeoutTransport.probeCapabilities("", { mode: "none" })).rejects.toMatchObject({
      stableCode: "RUNTIME_TIMEOUT",
      retryable: true,
      dispatchPossiblyStarted: false,
    } satisfies Partial<RuntimeHttpClientError>);

    const mismatch = await startBlackBoxServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ protocol_versions: ["2"], features: {} }));
      return true;
    });
    const mismatchTransport = createHttpHarnessRuntimeTransport({
      endpoint: mismatch.endpoint,
      auth: { mode: "none" },
    });
    await expect(mismatchTransport.probeCapabilities("", { mode: "none" })).rejects.toMatchObject({
      stableCode: "RUNTIME_PROTOCOL_SCHEMA_MISMATCH",
      retryable: false,
      dispatchPossiblyStarted: false,
    } satisfies Partial<RuntimeHttpClientError>);
  });

  it.each([
    ["ENOTFOUND", "RUNTIME_DNS_FAILED"],
    ["CERT_HAS_EXPIRED", "RUNTIME_TLS_FAILED"],
    ["ECONNREFUSED", "RUNTIME_CONNECT_FAILED"],
  ] as const)("%s 网络失败映射为 %s", async (code, stableCode) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code } })),
    );
    const transport = createHttpHarnessRuntimeTransport({
      endpoint: "https://runtime.example.com",
      auth: { mode: "none" },
    });
    await expect(transport.probeCapabilities("", { mode: "none" })).rejects.toMatchObject({
      kind: "network",
      stableCode,
      retryable: true,
      dispatchPossiblyStarted: false,
    } satisfies Partial<RuntimeHttpClientError>);
  });
});
