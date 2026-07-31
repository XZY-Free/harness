/**
 * V11 HTTP 公共协议基线（S01-W03）。
 *
 * 适用于 /api/v1、/runtime/v1、/gateway/v1、/admin/api/v1 四类 audience。
 * - 错误 Envelope 统一为 `{ error: { code, message, request_id, retryable, details? } }`。
 * - 成功响应直接返回资源（异步命令返回状态 + 可跟踪 id），不再包裹 `ok` 字段。
 * - X-Request-ID 透传或平台生成；RFC 3339 UTC 时间；不透明 cursor；资源隐藏式 404。
 * - 可编辑资源 PUT/PATCH 用 ETag/If-Match，冲突 412。
 *
 * 下方 `jsonOk`/`jsonError`/`omitThreadSecrets` 是旧路由遗留出口，新旧写路径隔离，
 * Stage 13 删除旧路径后一并移除；新 v1 路由必须使用 V11 出口。
 */
import { type V11ErrorCode, errorDefinition } from "@/lib/v11/error-codes";

/** 公共请求头名称。 */
export const REQUEST_ID_HEADER = "x-request-id";
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const IF_MATCH_HEADER = "if-match";
export const ETAG_HEADER = "etag";

/**
 * V11 四类 API audience（与 11-api-and-event-boundaries.md §2.1 一致）。
 * - employee：员工前端，前缀 /api/v1。
 * - runtime：Run 编排内部，前缀 /runtime/v1。
 * - gateway：CI/CD 与外部系统接入网关，前缀 /gateway/v1。
 * - admin：管理面，前缀 /admin/api/v1。
 */
export type V11Audience = "employee" | "runtime" | "gateway" | "admin";

/** 各 audience 的路径前缀。 */
export const AUDIENCE_PREFIX: Record<V11Audience, string> = {
  employee: "/api/v1",
  runtime: "/runtime/v1",
  gateway: "/gateway/v1",
  admin: "/admin/api/v1",
};

/**
 * V11 状态码使用边界（与 11-api-and-event-boundaries.md §2.5 一致）。
 * 413 用于 CONTEXT_CHECKPOINT_TOO_LARGE 等 payload 过大场景。
 */
export const V11_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
} as const;

/** 生成平台侧 Request ID（调用方未传 X-Request-ID 时使用）。 */
export function generateRequestId(): string {
  return `req_${globalThis.crypto.randomUUID()}`;
}

/**
 * 读取请求的 X-Request-ID；未携带则生成新 id。
 * 路由入口调用一次，错误响应与日志统一引用此 id。
 */
export function getRequestId(request: Request): string {
  const header = request.headers.get(REQUEST_ID_HEADER);
  if (header?.trim()) {
    return header.trim();
  }
  return generateRequestId();
}

/** RFC 3339 UTC 时间，如 `2026-07-15T01:23:45.123Z`。 */
export function nowUtc(): string {
  return new Date().toISOString();
}

/** V11 错误 Envelope 体。 */
export interface V11ErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

/**
 * 构造 V11 错误响应。HTTP 状态与 retryable 由错误码目录决定，调用方不能凭空覆盖。
 * `requestId` 必须来自请求上下文（getRequestId），保证可跟踪。
 */
export function v11Error(
  code: V11ErrorCode,
  message: string,
  options: { requestId: string; details?: Record<string, unknown> },
): Response {
  const def = errorDefinition(code);
  const body: V11ErrorBody = {
    error: {
      code,
      message,
      request_id: options.requestId,
      retryable: def.retryable,
      ...(options.details ? { details: options.details } : {}),
    },
  };
  return Response.json(body, {
    status: def.http,
    headers: { [REQUEST_ID_HEADER]: options.requestId },
  });
}

/**
 * 资源隐藏式 404：资源不存在或为防越权而隐藏时统一返回 RESOURCE_NOT_FOUND，
 * 不暴露“存在但无权”与“不存在”的区别。
 */
export function v11NotFound(requestId: string, message = "资源不存在或无权访问"): Response {
  return v11Error("RESOURCE_NOT_FOUND", message, { requestId });
}

/**
 * V11 成功响应：直接返回资源（不包裹 ok/data）。
 * 异步命令调用方自行构造 `{ status, ... }` 体后传入。
 */
export function v11Ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/**
 * 解析 If-Match 头，去掉弱验证前缀 `W/` 与引号，返回裸 ETag 值。
 * 缺失返回 null（路由据此返回 428 或按业务处理）。
 */
export function parseIfMatch(request: Request): string | null {
  const raw = request.headers.get(IF_MATCH_HEADER);
  if (!raw || !raw.trim()) {
    return null;
  }
  return raw.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** 构造强验证 ETag 响应头。 */
export function etagHeader(value: string): Record<string, string> {
  return { [ETAG_HEADER]: `"${value}"` };
}

/**
 * 编码不透明 cursor。客户端不能拼接数据库 offset。
 * 内部为 base64url(JSON)，但这是实现细节，客户端不应解析。
 */
export function encodeCursor(payload: unknown): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf-8").toString("base64url");
  return b64;
}

/** 解码不透明 cursor。非法 cursor 抛错（路由捕获后返回 EVENT_CURSOR_EXPIRED 等）。 */
export function decodeCursor(cursor: string): unknown {
  const json = Buffer.from(cursor, "base64url").toString("utf-8");
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// 旧路由遗留出口（Stage 13 删除旧路径后移除）。新 v1 路由禁止使用。
// ---------------------------------------------------------------------------

/** @deprecated 旧路由信封，新 v1 路由用 v11Ok。 */
export function jsonOk<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ ok: true, data }, init);
}

/** @deprecated 旧路由信封，新 v1 路由用 v11Error。 */
export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

/**
 * 从 thread 对象剥离密文/敏感列，供旧 HTTP 响应边界统一调用。
 * P1-5：防 cicdApiToken（AES-256-GCM 密文）经 Studio list/detail 接口泄露给前端。
 * @deprecated 旧路由用；V11 资源投影在阶段 4+ 统一处理。
 */
export function omitThreadSecrets<T extends { cicdApiToken?: unknown }>(
  thread: T,
): Omit<T, "cicdApiToken"> {
  const { cicdApiToken: _drop, ...rest } = thread;
  return rest;
}
