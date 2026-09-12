import type { ToolExecutionTarget } from "@/lib/runtime/tool-execution-target";
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
  attemptId?: string;
  executionTarget?: ToolExecutionTarget;
  endpoint: string;
  /** 来自持久 ToolCall，不接受模型传入执行上下文。 */
  threadId?: string;
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

export async function readLimitedBody(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
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
