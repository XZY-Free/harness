/**
 * 控制面统一错误模型 — Web 端和桌面端共用。
 *
 * 所有控制面 API 错误使用此结构。
 * 客户端根据 code 字段选择处理策略，不解析 message。
 */

import type { ApiErrorCode } from "@/lib/error-codes";

/** 控制面错误码与服务端公共错误目录一致。 */
export type ControlPlaneErrorCode = ApiErrorCode | "INTERNAL_ERROR";

/** 控制面错误结构 — API 响应错误体。 */
export interface ControlPlaneError {
  /** 错误码 — 客户端根据此字段路由处理逻辑。 */
  code: ControlPlaneErrorCode;
  /** 人类可读消息 — 仅展示用，客户端不解析。 */
  message: string;
  /** 请求 ID — 用于日志关联。 */
  request_id: string;
  /** 服务端判定的重试语义。 */
  retryable: boolean;
  /** 附加详情 — 按错误码不同而不同。 */
  details?: Record<string, unknown>;
}

/**
 * 判断错误是否可重试。
 *
 * 客户端据此决定是否自动重试，而非硬编码错误码列表。
 */
export function isRetryable(error: ControlPlaneError): boolean {
  return error.retryable;
}

/**
 * 判断错误是否为永久失败。
 */
export function isPermanent(error: ControlPlaneError): boolean {
  return (
    !error.retryable &&
    (error.code === "BUSINESS_CONSTRAINT_VIOLATION" ||
      error.code === "AUTHENTICATION_REQUIRED" ||
      error.code === "ACCESS_DENIED" ||
      error.code === "ACTION_SCOPE_DENIED")
  );
}

/**
 * 从 API 响应解析控制面错误。
 *
 * 非控制面错误包装为 INTERNAL_ERROR。
 */
export function parseControlPlaneError(response: {
  code?: string;
  message?: string;
  request_id?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}): ControlPlaneError {
  return {
    code: (response.code as ControlPlaneErrorCode) ?? "INTERNAL_ERROR",
    message: response.message ?? "未知错误",
    request_id: response.request_id ?? "",
    retryable: response.retryable ?? true,
    details: response.details,
  };
}
