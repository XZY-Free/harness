/** Runtime HTTP transport for the single RuntimeProtocol contract. */
import { IDEMPOTENCY_KEY_HEADER } from "@/lib/http";
import {
  type RuntimeTransportAuth,
  outboundAuthHeaders,
} from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import {
  type CallbackEndpoints,
  type CancelRequest,
  CancelRequestSchema,
  type CancelResponse,
  CancelResponseSchema,
  type HeartbeatRequest,
  HeartbeatRequestSchema,
  type HeartbeatResponse,
  HeartbeatResponseSchema,
  PROTOCOL_VERSION,
  type RuntimeCapabilities,
  RuntimeCapabilitiesSchema,
  type RuntimeEventBatch,
  RuntimeEventBatchSchema,
  type RuntimeStartRequest,
  RuntimeStartRequestSchema,
  type RuntimeStartResponse,
  RuntimeStartResponseSchema,
  type SafePointReleaseRequest,
  SafePointReleaseRequestSchema,
  type SafePointRequest,
  SafePointRequestSchema,
  type SafePointResponse,
  SafePointResponseSchema,
  type SteerRequest,
  SteerRequestSchema,
  type SteerResponse,
  SteerResponseSchema,
} from "@/lib/runtime/runtime-protocol";

export const RUNTIME_PROTOCOL_VERSION = PROTOCOL_VERSION;

export interface RuntimeStartTransportRequest {
  runtimeEndpoint: string;
  auth: RuntimeTransportAuth;
  idempotencyKey: string;
  request: RuntimeStartRequest;
}

export interface RuntimeEventTransportRequest {
  runtimeEndpoint: string;
  auth: RuntimeTransportAuth;
  invocationId: string;
  idempotencyKey?: string;
  request: RuntimeEventBatch;
}

export interface RuntimeHeartbeatTransportRequest {
  runtimeEndpoint: string;
  auth: RuntimeTransportAuth;
  invocationId: string;
  idempotencyKey: string;
  request: HeartbeatRequest;
}

export interface RuntimeCancelTransportRequest {
  runtimeEndpoint: string;
  auth: RuntimeTransportAuth;
  invocationId: string;
  idempotencyKey: string;
  request: CancelRequest;
}

export interface RuntimeSteerTransportRequest {
  runtimeEndpoint: string;
  auth: RuntimeTransportAuth;
  invocationId: string;
  idempotencyKey: string;
  request: SteerRequest;
}

export interface RuntimeSafePointTransportRequest {
  runtimeEndpoint: string;
  auth: RuntimeTransportAuth;
  invocationId: string;
  idempotencyKey: string;
  request: SafePointRequest;
}

export interface RuntimeSafePointReleaseTransportRequest {
  runtimeEndpoint: string;
  auth: RuntimeTransportAuth;
  invocationId: string;
  checkpointIntentId: string;
  idempotencyKey: string;
  request: SafePointReleaseRequest;
}

export interface RuntimeHttpClient {
  probeCapabilities(endpoint: string, auth: RuntimeTransportAuth): Promise<RuntimeCapabilities>;
  startInvocation(request: RuntimeStartTransportRequest): Promise<RuntimeStartResponse>;
  resumeInvocation(request: RuntimeStartTransportRequest): Promise<RuntimeStartResponse>;
  postEventBatch(request: RuntimeEventTransportRequest): Promise<unknown>;
  heartbeat(request: RuntimeHeartbeatTransportRequest): Promise<HeartbeatResponse>;
  cancelInvocation(request: RuntimeCancelTransportRequest): Promise<CancelResponse>;
  steerInvocation(request: RuntimeSteerTransportRequest): Promise<SteerResponse>;
  requestSafePoint(request: RuntimeSafePointTransportRequest): Promise<SafePointResponse>;
  releaseSafePoint(request: RuntimeSafePointReleaseTransportRequest): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function createHttpRuntimeClient(options?: { timeoutMs?: number }): RuntimeHttpClient {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function requestJson(
    url: string,
    method: "GET" | "POST",
    auth: RuntimeTransportAuth,
    body: unknown,
    idempotencyKey: string | undefined,
    possiblyStarted: boolean,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        ...outboundAuthHeaders(auth, { allowWorkloadToken: true }),
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        let message = `Runtime HTTP ${response.status}`;
        let code: string | undefined;
        try {
          const errorBody = (await response.json()) as {
            error?: { code?: string; message?: string };
          };
          code = errorBody.error?.code;
          if (errorBody.error?.message) message = errorBody.error.message;
        } catch {
          // Preserve the status-based error when the peer did not return JSON.
        }
        throw new RuntimeHttpClientError("http", message, response.status, code, {
          dispatchPossiblyStarted: possiblyStarted,
        });
      }
      try {
        return await response.json();
      } catch {
        throw new RuntimeHttpClientError(
          "protocol",
          "Runtime 返回了非法 JSON",
          undefined,
          undefined,
          {
            stableCode: "RUNTIME_INVALID_JSON",
            retryable: false,
            dispatchPossiblyStarted: possiblyStarted,
          },
        );
      }
    } catch (error) {
      if (error instanceof RuntimeHttpClientError) throw error;
      const code = controller.signal.aborted ? "RUNTIME_TIMEOUT" : classifyNetworkFailure(error);
      throw new RuntimeHttpClientError(
        "network",
        controller.signal.aborted ? "Runtime 请求超时" : "Runtime 网络连接失败",
        undefined,
        undefined,
        { stableCode: code, retryable: true, dispatchPossiblyStarted: possiblyStarted },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function postStart(
    request: RuntimeStartTransportRequest,
    suffix: string,
  ): Promise<RuntimeStartResponse> {
    const parsedRequest = RuntimeStartRequestSchema.parse(request.request);
    const body = await requestJson(
      `${trimEndpoint(request.runtimeEndpoint)}/runtime/invocations${suffix}`,
      "POST",
      request.auth,
      parsedRequest,
      request.idempotencyKey,
      true,
    );
    const parsed = RuntimeStartResponseSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.authority.invocationId !== parsedRequest.authority.invocationId
    ) {
      throw new RuntimeHttpClientError(
        "protocol",
        "Runtime Start/Resume 响应结构非法",
        undefined,
        undefined,
        {
          stableCode: "RUNTIME_PROTOCOL_SCHEMA_MISMATCH",
          retryable: false,
          dispatchPossiblyStarted: true,
        },
      );
    }
    return parsed.data;
  }

  return {
    async probeCapabilities(endpoint, auth) {
      const body = await requestJson(
        `${trimEndpoint(endpoint)}/runtime/capabilities?protocolVersion=${PROTOCOL_VERSION}`,
        "GET",
        auth,
        undefined,
        undefined,
        false,
      );
      const parsed = RuntimeCapabilitiesSchema.safeParse(body);
      if (!parsed.success) {
        throw new RuntimeHttpClientError(
          "protocol",
          "Runtime capabilities 响应结构非法",
          undefined,
          undefined,
          {
            stableCode: "RUNTIME_CAPABILITY_MISMATCH",
            retryable: false,
            dispatchPossiblyStarted: false,
          },
        );
      }
      return parsed.data;
    },
    startInvocation(request) {
      return postStart(request, "");
    },
    resumeInvocation(request) {
      return postStart(request, `/${request.request.authority.invocationId}/resume`);
    },
    async postEventBatch(request) {
      const parsedRequest = RuntimeEventBatchSchema.parse(request.request);
      return requestJson(
        `${trimEndpoint(request.runtimeEndpoint)}/runtime/invocations/${request.invocationId}/events`,
        "POST",
        request.auth,
        parsedRequest,
        request.idempotencyKey,
        true,
      );
    },
    async heartbeat(request) {
      const parsedRequest = HeartbeatRequestSchema.parse(request.request);
      const body = await requestJson(
        `${trimEndpoint(request.runtimeEndpoint)}/runtime/invocations/${request.invocationId}/heartbeat`,
        "POST",
        request.auth,
        parsedRequest,
        request.idempotencyKey,
        true,
      );
      const parsed = HeartbeatResponseSchema.safeParse(body);
      if (!parsed.success) throw protocolMismatch("Heartbeat 响应结构非法", true);
      return parsed.data;
    },
    async cancelInvocation(request) {
      const parsedRequest = CancelRequestSchema.parse(request.request);
      const body = await requestJson(
        `${trimEndpoint(request.runtimeEndpoint)}/runtime/invocations/${request.invocationId}/cancel`,
        "POST",
        request.auth,
        parsedRequest,
        request.idempotencyKey,
        true,
      );
      const parsed = CancelResponseSchema.safeParse(body);
      if (!parsed.success) throw protocolMismatch("Cancel 响应结构非法", true);
      return parsed.data;
    },
    async steerInvocation(request) {
      const parsedRequest = SteerRequestSchema.parse(request.request);
      const body = await requestJson(
        `${trimEndpoint(request.runtimeEndpoint)}/runtime/invocations/${request.invocationId}/steer`,
        "POST",
        request.auth,
        parsedRequest,
        request.idempotencyKey,
        true,
      );
      const parsed = SteerResponseSchema.safeParse(body);
      if (!parsed.success) throw protocolMismatch("Steer 响应结构非法", true);
      return parsed.data;
    },
    async requestSafePoint(request) {
      const parsedRequest = SafePointRequestSchema.parse(request.request);
      const body = await requestJson(
        `${trimEndpoint(request.runtimeEndpoint)}/runtime/invocations/${request.invocationId}/safe-points`,
        "POST",
        request.auth,
        parsedRequest,
        request.idempotencyKey,
        true,
      );
      const parsed = SafePointResponseSchema.safeParse(body);
      if (!parsed.success || parsed.data.checkpointIntentId !== parsedRequest.checkpointIntentId) {
        throw protocolMismatch("Safe-point 响应结构非法", true);
      }
      return parsed.data;
    },
    async releaseSafePoint(request) {
      const parsedRequest = SafePointReleaseRequestSchema.parse(request.request);
      await requestJson(
        `${trimEndpoint(request.runtimeEndpoint)}/runtime/invocations/${request.invocationId}/safe-points/${request.checkpointIntentId}/release`,
        "POST",
        request.auth,
        parsedRequest,
        request.idempotencyKey,
        true,
      );
    },
  };
}

function protocolMismatch(message: string, possiblyStarted: boolean): RuntimeHttpClientError {
  return new RuntimeHttpClientError("protocol", message, undefined, undefined, {
    stableCode: "RUNTIME_PROTOCOL_SCHEMA_MISMATCH",
    retryable: false,
    dispatchPossiblyStarted: possiblyStarted,
  });
}

function trimEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function classifyNetworkFailure(
  error: unknown,
): "RUNTIME_CONNECT_FAILED" | "RUNTIME_DNS_FAILED" | "RUNTIME_TLS_FAILED" {
  const cause =
    error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code ?? "")
      : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "RUNTIME_DNS_FAILED";
  if (/CERT|TLS|SSL/.test(code)) return "RUNTIME_TLS_FAILED";
  return "RUNTIME_CONNECT_FAILED";
}

export interface MockRuntimeClientHandlers {
  probeCapabilities?: (
    endpoint: string,
    auth: RuntimeTransportAuth,
  ) => Promise<RuntimeCapabilities>;
  startInvocation?: (request: RuntimeStartTransportRequest) => Promise<RuntimeStartResponse>;
  resumeInvocation?: (request: RuntimeStartTransportRequest) => Promise<RuntimeStartResponse>;
  postEventBatch?: (request: RuntimeEventTransportRequest) => Promise<unknown>;
  heartbeat?: (request: RuntimeHeartbeatTransportRequest) => Promise<HeartbeatResponse>;
  cancelInvocation?: (request: RuntimeCancelTransportRequest) => Promise<CancelResponse>;
  steerInvocation?: (request: RuntimeSteerTransportRequest) => Promise<SteerResponse>;
  requestSafePoint?: (request: RuntimeSafePointTransportRequest) => Promise<SafePointResponse>;
  releaseSafePoint?: (request: RuntimeSafePointReleaseTransportRequest) => Promise<void>;
}

export function createMockRuntimeClient(handlers: MockRuntimeClientHandlers): RuntimeHttpClient & {
  calls: {
    probeCapabilities: Array<{ endpoint: string; auth: RuntimeTransportAuth }>;
    startInvocation: RuntimeStartTransportRequest[];
    resumeInvocation: RuntimeStartTransportRequest[];
    postEventBatch: RuntimeEventTransportRequest[];
    heartbeat: RuntimeHeartbeatTransportRequest[];
    cancelInvocation: RuntimeCancelTransportRequest[];
    steerInvocation: RuntimeSteerTransportRequest[];
    requestSafePoint: RuntimeSafePointTransportRequest[];
    releaseSafePoint: RuntimeSafePointReleaseTransportRequest[];
  };
} {
  const calls = {
    probeCapabilities: [] as Array<{ endpoint: string; auth: RuntimeTransportAuth }>,
    startInvocation: [] as RuntimeStartTransportRequest[],
    resumeInvocation: [] as RuntimeStartTransportRequest[],
    postEventBatch: [] as RuntimeEventTransportRequest[],
    heartbeat: [] as RuntimeHeartbeatTransportRequest[],
    cancelInvocation: [] as RuntimeCancelTransportRequest[],
    steerInvocation: [] as RuntimeSteerTransportRequest[],
    requestSafePoint: [] as RuntimeSafePointTransportRequest[],
    releaseSafePoint: [] as RuntimeSafePointReleaseTransportRequest[],
  };
  const missing = (name: string): never => {
    throw new RuntimeHttpClientError("protocol", `mock ${name} 未实现`, undefined, undefined, {
      stableCode: "RUNTIME_PROTOCOL_SCHEMA_MISMATCH",
      retryable: false,
      dispatchPossiblyStarted: false,
    });
  };
  return {
    calls,
    async probeCapabilities(endpoint, auth) {
      calls.probeCapabilities.push({ endpoint, auth });
      return handlers.probeCapabilities
        ? handlers.probeCapabilities(endpoint, auth)
        : missing("probeCapabilities");
    },
    async startInvocation(request) {
      calls.startInvocation.push(request);
      return handlers.startInvocation
        ? handlers.startInvocation(request)
        : missing("startInvocation");
    },
    async resumeInvocation(request) {
      calls.resumeInvocation.push(request);
      return handlers.resumeInvocation
        ? handlers.resumeInvocation(request)
        : missing("resumeInvocation");
    },
    async postEventBatch(request) {
      calls.postEventBatch.push(request);
      return handlers.postEventBatch ? handlers.postEventBatch(request) : missing("postEventBatch");
    },
    async heartbeat(request) {
      calls.heartbeat.push(request);
      return handlers.heartbeat ? handlers.heartbeat(request) : missing("heartbeat");
    },
    async cancelInvocation(request) {
      calls.cancelInvocation.push(request);
      return handlers.cancelInvocation
        ? handlers.cancelInvocation(request)
        : missing("cancelInvocation");
    },
    async steerInvocation(request) {
      calls.steerInvocation.push(request);
      return handlers.steerInvocation
        ? handlers.steerInvocation(request)
        : missing("steerInvocation");
    },
    async requestSafePoint(request) {
      calls.requestSafePoint.push(request);
      return handlers.requestSafePoint
        ? handlers.requestSafePoint(request)
        : missing("requestSafePoint");
    },
    async releaseSafePoint(request) {
      calls.releaseSafePoint.push(request);
      if (handlers.releaseSafePoint) return handlers.releaseSafePoint(request);
      return missing("releaseSafePoint");
    },
  };
}

export function defaultRuntimeCapabilities(): RuntimeCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    contractDigest: `sha256:${"0".repeat(64)}`,
    runtimeTargetDigest: `sha256:${"0".repeat(64)}`,
    features: {
      heartbeat: true,
      durableStartIdempotency: true,
      startedEvent: true,
      exactReplay: true,
      cancel: true,
      resume: true,
      steer: true,
      subjectTypes: ["thread", "job"],
      workspaceModes: [
        "NO_PLATFORM_WORKSPACE",
        "HOST_AFFINE",
        "SHARED_DURABLE",
        "CHECKPOINT_RESTORABLE",
      ],
      filesystemSemantics: {
        kind: "portable",
        caseSensitive: true,
        symlinks: true,
        permissions: true,
        hardlinks: false,
        specialFiles: false,
        xattrsAcl: false,
        mtime: "preserved",
      },
    },
    limits: {
      maxEventBytes: 262_144,
      maxBatchEvents: 100,
      maxBatchBytes: 1_048_576,
    },
  };
}

export type { CallbackEndpoints };
