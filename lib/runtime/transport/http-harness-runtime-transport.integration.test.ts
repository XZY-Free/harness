import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OutboundRuntimeAuthError } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import type { RuntimeHttpClientError } from "@/lib/runtime/errors";
import { defaultRuntimeCapabilities } from "@/lib/runtime/runtime-client";
import type { AuthorityIdentity, RuntimeStartRequest } from "@/lib/runtime/runtime-protocol";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import { afterEach, describe, expect, it, vi } from "vitest";

const DIGEST = `sha256:${"a".repeat(64)}`;
const closeServers: Array<() => Promise<void>> = [];

interface RecordedRequest {
  method: string;
  url: string;
  authorization?: string;
  body: unknown;
}

function authority(): AuthorityIdentity {
  return {
    invocationId: randomUUID(),
    runtimeRevisionId: randomUUID(),
    attemptId: randomUUID(),
    ownershipId: randomUUID(),
    leaseEpoch: "1",
    sessionBindingId: randomUUID(),
  };
}

function startRequest(intentType: "start" | "resume" = "start"): RuntimeStartRequest {
  const current = authority();
  return {
    protocolVersion: 3,
    authority: current,
    intentType,
    semanticRequestDigest: DIGEST,
    executionBinding: {
      bindingDigest: DIGEST,
      runtimeRevisionId: current.runtimeRevisionId,
      policyRefs: [randomUUID()],
      governanceRefs: [randomUUID()],
      capabilityRefs: [randomUUID()],
      modelRefs: [randomUUID()],
      allowedEgress: [],
    },
    context: {
      common: {
        contractVersion: 1,
        tenantId: randomUUID(),
        invocationId: current.invocationId,
        bindingDigest: DIGEST,
        initialCompression: null,
        principal: { type: "service", id: "conformance", source: "trusted_service" },
        runtimeRevisionId: current.runtimeRevisionId,
        policy: { revisionId: randomUUID(), digest: DIGEST },
        workspace: { bindingId: randomUUID(), contractDigest: DIGEST },
        environment: { mode: "NO_PLATFORM_ENVIRONMENT" },
        contextSourceDigest: DIGEST,
        issuedAt: 1,
        expiresAt: Date.now() + 60_000,
        jti: randomUUID(),
      },
      subject: {
        type: "job",
        jobId: randomUUID(),
        inputKind: "inline",
        inputHash: DIGEST,
        triggerRef: "test",
      },
    },
    inputs: [{ kind: "inline", digest: DIGEST }],
    environment: { mode: "NO_PLATFORM_ENVIRONMENT" },
    workspace: { mode: "NONE" },
    activationDigest: DIGEST,
    recovery:
      intentType === "resume"
        ? { kind: "resume", anchor: "checkpoint", anchorDigest: DIGEST, checkpointId: randomUUID() }
        : { kind: "initial" },
    producerSequenceStart: "1",
    callbackEndpoints: {
      events: "https://platform.example/runtime/invocations/events",
      heartbeat: "https://platform.example/runtime/invocations/heartbeat",
      context: "https://platform.example/gateway/context",
      capabilityActions: "https://platform.example/gateway/capability-actions",
      toolCalls: "https://platform.example/gateway/tool-calls",
      userActions: "https://platform.example/gateway/user-actions",
    },
    credentials: {
      runtimeToken: "runtime",
      gatewayToken: "gateway",
      expiresAt: Date.now() + 60_000,
    },
    executionLimits: {
      maxEventBytes: 1024,
      maxBatchEvents: 10,
      maxBatchBytes: 4096,
      dispatchDeadlineMs: 60_000,
      executionTimeoutMs: 120_000,
    },
  };
}

async function startBlackBoxServer(
  handler?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean> | boolean,
) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    if (handler && (await handler(request, response))) return;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/runtime/capabilities"))
      return void response.end(JSON.stringify(defaultRuntimeCapabilities()));
    if (request.url === "/runtime/invocations" || request.url?.endsWith("/resume")) {
      const requestBody = body as RuntimeStartRequest;
      return void response.end(
        JSON.stringify({
          protocolVersion: 3,
          authority: requestBody.authority,
          semanticRequestDigest: requestBody.semanticRequestDigest,
          accepted: true,
          remoteSessionRef: "remote-session",
          remoteExecutionRef: "remote-execution",
          capabilitiesDigest: DIGEST,
          acceptedAt: Date.now(),
        }),
      );
    }
    if (request.url?.endsWith("/heartbeat")) {
      const requestBody = body as { authority: AuthorityIdentity };
      return void response.end(
        JSON.stringify({
          protocolVersion: 3,
          authority: requestBody.authority,
          serverTime: Date.now(),
          leaseExpiresAt: Date.now() + 30_000,
          acceptedThroughProducerSequence: "0",
          continueExecution: true,
        }),
      );
    }
    if (request.url?.endsWith("/cancel")) {
      const requestBody = body as { targetAuthority: AuthorityIdentity };
      return void response.end(
        JSON.stringify({
          accepted: true,
          targetAuthority: requestBody.targetAuthority,
          stopState: "requested",
        }),
      );
    }
    const requestBody = body as {
      commandId: string;
      targetAuthority: AuthorityIdentity;
      inputDigest: string;
    };
    return void response.end(
      JSON.stringify({
        accepted: true,
        commandId: requestBody.commandId,
        targetAuthority: requestBody.targetAuthority,
        inputDigest: requestBody.inputDigest,
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

afterEach(async () => {
  for (const close of closeServers.splice(0)) await close();
  vi.unstubAllGlobals();
});

describe("HttpHarnessRuntimeTransport", () => {
  it("只发送 protocolVersion=3 的 Canonical 路由和字段", async () => {
    const server = await startBlackBoxServer();
    const transport = createHttpHarnessRuntimeTransport({
      endpoint: server.endpoint,
      auth: { mode: "bearer", token: "external-test-token" },
    });
    const request = startRequest();
    await transport.probeCapabilities("https://ignored.example", { mode: "none" });
    await transport.startInvocation({
      runtimeEndpoint: "https://ignored.example",
      auth: { mode: "none" },
      idempotencyKey: "start",
      request,
    });
    await transport.resumeInvocation({
      runtimeEndpoint: "https://ignored.example",
      auth: { mode: "none" },
      idempotencyKey: "resume",
      request: {
        ...request,
        intentType: "resume",
        recovery: {
          kind: "resume",
          anchor: "anchor",
          anchorDigest: DIGEST,
          checkpointId: randomUUID(),
        },
      },
    });
    await transport.heartbeat({
      runtimeEndpoint: "ignored",
      auth: { mode: "none" },
      invocationId: request.authority.invocationId,
      idempotencyKey: "heartbeat",
      request: {
        protocolVersion: 3,
        authority: request.authority,
        heartbeatId: randomUUID(),
        runtimeState: "running",
        lastObservedProducerSequence: "0",
        requestCredentialRefresh: false,
      },
    });
    await transport.cancelInvocation({
      runtimeEndpoint: "ignored",
      auth: { mode: "none" },
      invocationId: request.authority.invocationId,
      idempotencyKey: "cancel",
      request: {
        protocolVersion: 3,
        commandId: randomUUID(),
        targetAuthority: request.authority,
        reasonCode: "user_cancel",
      },
    });
    await transport.steerInvocation({
      runtimeEndpoint: "ignored",
      auth: { mode: "none" },
      invocationId: request.authority.invocationId,
      idempotencyKey: "steer",
      request: {
        protocolVersion: 3,
        commandId: randomUUID(),
        targetAuthority: request.authority,
        inputRef: "input:1",
        inputDigest: DIGEST,
      },
    });

    expect(server.requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "/runtime/capabilities?protocolVersion=3" },
      { method: "POST", url: "/runtime/invocations" },
      { method: "POST", url: `/runtime/invocations/${request.authority.invocationId}/resume` },
      { method: "POST", url: `/runtime/invocations/${request.authority.invocationId}/heartbeat` },
      { method: "POST", url: `/runtime/invocations/${request.authority.invocationId}/cancel` },
      { method: "POST", url: `/runtime/invocations/${request.authority.invocationId}/steer` },
    ]);
    expect(
      server.requests.every((entry) => entry.authorization === "Bearer external-test-token"),
    ).toBe(true);
    expect(server.requests[1]?.body).toMatchObject({
      protocolVersion: 3,
      authority: request.authority,
    });
  });

  it("拒绝内部 workload credential，且不发送网络请求", async () => {
    const server = await startBlackBoxServer();
    expect(() =>
      createHttpHarnessRuntimeTransport({
        endpoint: server.endpoint,
        auth: { mode: "workload_token", token: "internal" },
      }),
    ).toThrow(OutboundRuntimeAuthError);
    expect(server.requests).toHaveLength(0);
  });

  it("无效 JSON 和不可用响应均失败关闭", async () => {
    const invalid = await startBlackBoxServer((request, response) => {
      if (!request.url?.startsWith("/runtime/capabilities")) return false;
      response.setHeader("content-type", "application/json");
      response.end("not-json");
      return true;
    });
    await expect(
      createHttpHarnessRuntimeTransport({
        endpoint: invalid.endpoint,
        auth: { mode: "none" },
      }).probeCapabilities("", { mode: "none" }),
    ).rejects.toMatchObject({
      stableCode: "RUNTIME_INVALID_JSON",
      retryable: false,
    } satisfies Partial<RuntimeHttpClientError>);

    const unavailable = await startBlackBoxServer((_request, response) => {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "busy" } }));
      return true;
    });
    const request = startRequest();
    await expect(
      createHttpHarnessRuntimeTransport({
        endpoint: unavailable.endpoint,
        auth: { mode: "none" },
      }).cancelInvocation({
        runtimeEndpoint: "ignored",
        auth: { mode: "none" },
        invocationId: request.authority.invocationId,
        idempotencyKey: "cancel",
        request: {
          protocolVersion: 3,
          commandId: randomUUID(),
          targetAuthority: request.authority,
          reasonCode: "user_cancel",
        },
      }),
    ).rejects.toMatchObject({
      kind: "http",
      stableCode: "RUNTIME_UNAVAILABLE",
      retryable: true,
    } satisfies Partial<RuntimeHttpClientError>);
  });
});
