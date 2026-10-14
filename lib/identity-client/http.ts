/**
 * identity-client HTTP 基座：超时、错误分类、JSON 解析。
 *
 * 错误语义：
 * - AuthCenterUnavailableError：网络不可达/超时/5xx——调用方按 fail-closed 处理。
 * - 4xx 由各调用点自行解释（401=会话失效；400=请求契约错误）。
 */
import { identityClientConfig } from "./config";

/** auth-center 不可达（网络失败、超时或 5xx）。 */
export class AuthCenterUnavailableError extends Error {
  readonly code = "AUTH_CENTER_UNAVAILABLE";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthCenterUnavailableError";
  }
}

export interface AuthCenterResponse<T> {
  readonly status: number;
  readonly data: T | null;
}

/**
 * 发起 auth-center 请求。
 * @param options.timeoutMs 覆盖默认单次请求超时（如企业上下文装配的刷新等待）。
 * @throws AuthCenterUnavailableError 网络失败/超时/5xx
 */
export async function requestAuthCenter<T>(
  path: string,
  init: RequestInit = {},
  options: { timeoutMs?: number } = {},
): Promise<AuthCenterResponse<T>> {
  const url = `${identityClientConfig.baseUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? identityClientConfig.requestTimeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    throw new AuthCenterUnavailableError(`auth-center 请求失败：${path}`, { cause: error });
  }
  if (response.status >= 500) {
    throw new AuthCenterUnavailableError(`auth-center 服务错误 ${response.status}：${path}`);
  }
  let data: T | null = null;
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = null;
    }
  }
  return { status: response.status, data };
}

/** 会话 token → Bearer 头。 */
export function bearerHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
