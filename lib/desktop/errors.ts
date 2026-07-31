/**
 * V10 Phase 3：Desktop 稳定错误码。
 *
 * Server 和 Desktop 共享的错误码枚举。所有 IPC/RPC 错误返回使用这些稳定码，
 * 前端根据 code 而非 message 做分支。新增错误码只能追加，不修改已有码值。
 */

/**
 * Desktop 错误码。
 *
 * 命名规则：`<scope>_<reason>`，全小写下划线分隔。
 */
export const DesktopErrorCode = {
  /** Desktop 未连接/离线 */
  DESKTOP_UNAVAILABLE: "desktop_unavailable",
  /** Desktop 连接已断开 */
  DESKTOP_DISCONNECTED: "desktop_disconnected",
  /** 设备未绑定/未授权 */
  DESKTOP_UNAUTHORIZED: "desktop_unauthorized",
  /** 设备已被撤销 */
  DESKTOP_REVOKED: "desktop_revoked",
  /** 协议版本不兼容 */
  PROTOCOL_MISMATCH: "protocol_mismatch",
  /** RPC 请求超时 */
  RPC_TIMEOUT: "rpc_timeout",
  /** RPC nonce 重放 */
  RPC_REPLAY: "rpc_replay",
  /** RPC 签名校验失败 */
  RPC_INVALID_SIGNATURE: "rpc_invalid_signature",
  /** RPC 字段缺失或类型错误 */
  RPC_INVALID_PAYLOAD: "rpc_invalid_payload",
  /** Thread 不存在或无权访问 */
  THREAD_NOT_FOUND: "thread_not_found",
  /** Tab 不存在 */
  TAB_NOT_FOUND: "tab_not_found",
  /** AI 锁被其他设备持有 */
  LEASE_HELD_BY_OTHER: "lease_held_by_other",
  /** 操作需要 approval 但未提供 */
  APPROVAL_REQUIRED: "approval_required",
  /** URL 不在允许列表 */
  URL_BLOCKED: "url_blocked",
  /** 返回内容超出字节上限 */
  RESULT_TOO_LARGE: "result_to_large",
  /** Browser Controller 内部错误 */
  BROWSER_INTERNAL: "browser_internal",
  /** Origin 校验失败 */
  ORIGIN_REJECTED: "origin_rejected",
  /** IPC channel 未注册 */
  IPC_UNKNOWN_CHANNEL: "ipc_unknown_channel",
  /** Keychain 操作失败 */
  KEYCHAIN_ERROR: "keychain_error",
  /** SQLite migration 失败 */
  MIGRATION_FAILED: "migration_failed",
} as const;

export type DesktopErrorCode = (typeof DesktopErrorCode)[keyof typeof DesktopErrorCode];

/**
 * Desktop 错误体。IPC/RPC 错误统一使用此结构。
 */
export interface DesktopError {
  ok: false;
  code: DesktopErrorCode;
  message: string;
  /** 可选的诊断上下文（不含敏感数据） */
  detail?: unknown;
}

/**
 * 构造 DesktopError。
 */
export function desktopError(
  code: DesktopErrorCode,
  message: string,
  detail?: unknown,
): DesktopError {
  return { ok: false, code, message, detail };
}

/**
 * 判断值是否为 DesktopError。
 */
export function isDesktopError(value: unknown): value is DesktopError {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok: unknown }).ok === false &&
    "code" in value &&
    "message" in value
  );
}
