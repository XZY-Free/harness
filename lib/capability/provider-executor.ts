import { redactArguments } from "@/lib/capability/redact-arguments";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";

export type ProviderRetryClass = "safe_transient" | "permanent" | "unknown_effect";

export class ProviderExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryClass: ProviderRetryClass,
    public readonly dispatched: boolean,
  ) {
    super(message);
    this.name = "ProviderExecutionError";
  }
}

export interface ProviderExecutionInput {
  endpoint: string;
  arguments: Record<string, unknown>;
  executionSubject: ExecutionSubject;
  invocationId: string;
  toolCallId: string;
  traceId: string;
  externalIdempotencyKey: string | null;
  sideEffectMode: "none" | "read" | "write";
  timeoutMs: number;
  responseMaxBytes: number;
  credential: { authorization: string } | null;
}

export interface ProviderExecutionResult {
  status: "succeeded";
  statusCode: number;
  result: unknown;
  providerRequestRef: string | null;
}

export interface ProductionProviderExecutor {
  execute(input: ProviderExecutionInput): Promise<ProviderExecutionResult>;
}

export interface ProductionProviderExecutorRegistry {
  supports(providerType: string, executorKind: string): boolean;
  get(providerType: string, executorKind: string): ProductionProviderExecutor;
}

export function createProductionProviderExecutorRegistry(
  options: {
    allowLoopbackHttp?: boolean;
  } = {},
): ProductionProviderExecutorRegistry {
  const executors = new Map<string, ProductionProviderExecutor>([
    ["webhook\u0000webhook.post_json", createWebhookExecutor(options)],
  ]);
  return {
    supports(providerType, executorKind) {
      return executors.has(`${providerType}\u0000${executorKind}`);
    },
    get(providerType, executorKind) {
      const executor = executors.get(`${providerType}\u0000${executorKind}`);
      if (!executor) {
        throw new ProviderExecutionError(
          "PROVIDER_EXECUTOR_UNAVAILABLE",
          `没有 production executor：${providerType}/${executorKind}`,
          "permanent",
          false,
        );
      }
      return executor;
    },
  };
}

function createWebhookExecutor(options: {
  allowLoopbackHttp?: boolean;
}): ProductionProviderExecutor {
  return {
    async execute(input) {
      const endpoint = validateEndpoint(input.endpoint, options.allowLoopbackHttp === true);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(input.externalIdempotencyKey
              ? { "idempotency-key": input.externalIdempotencyKey }
              : {}),
            ...(input.credential ? { authorization: input.credential.authorization } : {}),
          },
          body: JSON.stringify({
            arguments: input.arguments,
            context: {
              tenant_id: input.executionSubject.tenantId,
              subject_kind: input.executionSubject.subjectType,
              subject_id: input.executionSubject.subjectId,
              invocation_id: input.invocationId,
              tool_call_id: input.toolCallId,
              trace_id: input.traceId,
            },
          }),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        const aborted = controller.signal.aborted;
        clearTimeout(timer);
        throw new ProviderExecutionError(
          aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR",
          aborted ? "Provider 响应超时" : "Provider 网络错误",
          canRetryAfterUncertainDispatch(input) ? "safe_transient" : "unknown_effect",
          true,
        );
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        await response.body?.cancel();
        clearTimeout(timer);
        throw new ProviderExecutionError(
          `PROVIDER_HTTP_${response.status}`,
          `Provider 拒绝请求（HTTP ${response.status}）`,
          "permanent",
          true,
        );
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        clearTimeout(timer);
        throw new ProviderExecutionError(
          `PROVIDER_HTTP_${response.status}`,
          `Provider 暂时不可用（HTTP ${response.status}）`,
          canRetryAfterUncertainDispatch(input) ? "safe_transient" : "unknown_effect",
          true,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        clearTimeout(timer);
        throw new ProviderExecutionError(
          `PROVIDER_HTTP_${response.status}`,
          "Provider 返回非成功响应",
          "permanent",
          true,
        );
      }
      let body: unknown;
      try {
        body = await readLimitedBody(response, input.responseMaxBytes);
      } catch (error) {
        if (error instanceof ProviderExecutionError) throw error;
        const aborted = controller.signal.aborted;
        throw new ProviderExecutionError(
          aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_RESPONSE_READ_FAILED",
          aborted ? "Provider 响应超时" : "Provider 响应读取失败",
          canRetryAfterUncertainDispatch(input) ? "safe_transient" : "unknown_effect",
          true,
        );
      } finally {
        clearTimeout(timer);
      }
      return {
        status: "succeeded",
        statusCode: response.status,
        result: redactProviderResult(body),
        providerRequestRef: response.headers.get("x-request-id"),
      };
    },
  };
}

function validateEndpoint(raw: string, allowLoopbackHttp: boolean): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new ProviderExecutionError(
      "PROVIDER_ENDPOINT_INVALID",
      "Provider endpoint 非法",
      "permanent",
      false,
    );
  }
  const loopback =
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "::1";
  if (
    endpoint.protocol !== "https:" &&
    !(allowLoopbackHttp && loopback && endpoint.protocol === "http:")
  ) {
    throw new ProviderExecutionError(
      "PROVIDER_ENDPOINT_INSECURE",
      "Provider endpoint 必须使用 HTTPS",
      "permanent",
      false,
    );
  }
  const sensitiveQueryKey = /^(token|secret|api[_-]?key|authorization|credential|password)$/i;
  if (
    endpoint.username ||
    endpoint.password ||
    [...endpoint.searchParams.keys()].some((key) => sensitiveQueryKey.test(key))
  ) {
    throw new ProviderExecutionError(
      "PROVIDER_CREDENTIAL_IN_ENDPOINT",
      "Provider endpoint 不允许内嵌凭证",
      "permanent",
      false,
    );
  }
  return endpoint;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ProviderExecutionError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      "Provider 响应超过合同限制",
      "permanent",
      true,
    );
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new ProviderExecutionError(
        "PROVIDER_RESPONSE_TOO_LARGE",
        "Provider 响应超过合同限制",
        "permanent",
        true,
      );
    }
    chunks.push(Buffer.from(value));
  }
  const buffer = Buffer.concat(chunks, totalBytes);
  if (buffer.byteLength === 0) return null;
  const text = buffer.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderExecutionError(
      "PROVIDER_RESPONSE_INVALID_JSON",
      "Provider 成功响应不是合法 JSON",
      "permanent",
      true,
    );
  }
}

function redactProviderResult(value: unknown): unknown {
  return redactArguments({ result: value }).result;
}

function canRetryAfterUncertainDispatch(input: ProviderExecutionInput): boolean {
  return input.sideEffectMode !== "write" || input.externalIdempotencyKey !== null;
}
