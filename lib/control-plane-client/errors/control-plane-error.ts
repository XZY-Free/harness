/**
 * 控制面统一错误模型 — Web 端和桌面端共用。
 *
 * 所有控制面 API 错误使用此结构。
 * 客户端根据 code 字段选择处理策略，不解析 message。
 */

/** 控制面错误码 — 精确区分所有失败场景。 */
export type ControlPlaneErrorCode =
  // 认证与授权
  | "AUTHENTICATION_REQUIRED"
  | "AUTHORIZATION_DENIED"
  | "TENANT_MISMATCH"
  // 资源不存在
  | "RESOURCE_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "RUNTIME_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  | "ROUTE_SET_NOT_FOUND"
  | "ROUTE_NOT_FOUND"
  | "POLICY_REVISION_NOT_FOUND"
  // 状态冲突
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "REQUEST_IN_PROGRESS"
  // 资格不足
  | "EXECUTION_INELIGIBLE"
  | "ARTIFACT_NOT_VERIFIED"
  | "REVISION_NOT_PUBLISHED"
  | "AGENT_CAPABILITY_UNSUPPORTED"
  | "POLICY_REVISION_CROSS_TENANT"
  | "POLICY_REVISION_NOT_PUBLISHED"
  | "POLICY_REVISION_WITHDRAWN"
  | "AGENT_REVISION_NOT_PUBLISHED"
  | "RUNTIME_REVISION_NOT_PUBLISHED"
  // 业务约束
  | "BUSINESS_CONSTRAINT_VIOLATION"
  | "ROUTE_SET_REQUIRES_ATOMIC_UPDATE"
  | "PROVISIONING_PERMANENT_FAILED"
  | "PROVISIONING_RETRYABLE_FAILED"
  // 请求格式
  | "SCHEMA_INVALID"
  | "ETAG_MISMATCH"
  // 签名验证
  | "SIGNATURE_INVALID"
  | "BUILDER_IDENTITY_MISMATCH"
  | "SBOM_DIGEST_MISMATCH"
  | "PROVENANCE_DIGEST_MISMATCH"
  // 内部
  | "INTERNAL_ERROR";

/** 控制面错误结构 — API 响应错误体。 */
export interface ControlPlaneError {
  /** 错误码 — 客户端根据此字段路由处理逻辑。 */
  code: ControlPlaneErrorCode;
  /** 人类可读消息 — 仅展示用，客户端不解析。 */
  message: string;
  /** 请求 ID — 用于日志关联。 */
  request_id: string;
  /** 附加详情 — 按错误码不同而不同。 */
  details?: Record<string, unknown>;
}

/**
 * 判断错误是否可重试。
 *
 * 客户端据此决定是否自动重试，而非硬编码错误码列表。
 */
export function isRetryable(error: ControlPlaneError): boolean {
  return (
    error.code === "PROVISIONING_RETRYABLE_FAILED" ||
    error.code === "REQUEST_IN_PROGRESS" ||
    error.code === "INTERNAL_ERROR"
  );
}

/**
 * 判断错误是否为永久失败。
 */
export function isPermanent(error: ControlPlaneError): boolean {
  return (
    error.code === "PROVISIONING_PERMANENT_FAILED" ||
    error.code === "AUTHENTICATION_REQUIRED" ||
    error.code === "AUTHORIZATION_DENIED" ||
    error.code === "TENANT_MISMATCH" ||
    error.code === "BUSINESS_CONSTRAINT_VIOLATION"
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
  details?: Record<string, unknown>;
}): ControlPlaneError {
  return {
    code: (response.code as ControlPlaneErrorCode) ?? "INTERNAL_ERROR",
    message: response.message ?? "未知错误",
    request_id: response.request_id ?? "",
    details: response.details,
  };
}
