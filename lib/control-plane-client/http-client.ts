import type { ApiErrorCode } from "@/lib/error-codes";

export interface ApiClientConfig {
  baseUrl: string;
  headers: () => Record<string, string>;
  fetcher?: typeof fetch;
}

export class ControlPlaneRequestError extends Error {
  readonly name = "ControlPlaneRequestError";

  constructor(
    readonly code: ApiErrorCode | "INTERNAL_ERROR",
    message: string,
    readonly requestId: string,
    readonly retryable: boolean,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.request_id === "string" &&
    typeof candidate.retryable === "boolean" &&
    (candidate.details === undefined ||
      (candidate.details !== null && typeof candidate.details === "object"))
  );
}

function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createControlPlaneRequest(config: ApiClientConfig) {
  return async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(config.headers());
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (init?.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await (config.fetcher ?? fetch)(joinUrl(config.baseUrl, path), {
      ...init,
      headers,
    });
    const body = await parseJson(response);
    if (response.ok) return body as T;

    if (isErrorEnvelope(body)) {
      throw new ControlPlaneRequestError(
        body.error.code as ApiErrorCode,
        body.error.message,
        body.error.request_id,
        body.error.retryable,
        response.status,
        body.error.details,
      );
    }

    throw new ControlPlaneRequestError(
      "INTERNAL_ERROR",
      `控制面返回了无效错误响应（HTTP ${response.status}）`,
      response.headers.get("x-request-id") ?? "",
      response.status >= 500,
      response.status,
    );
  };
}
