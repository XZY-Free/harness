/**
 * V10 Phase 4：浏览器权限策略。
 *
 * 定义 WebContentsView 的 permission、popup、external protocol、
 * certificate 和 download 默认策略。
 *
 * 策略原则（fail-closed）：
 * - 权限默认拒绝（notification、camera、mic 等）
 * - 弹窗默认拒绝（防止恶意网站打开新窗口）
 * - 外部协议默认询问（用户确认后才打开）
 * - 证书错误默认拒绝
 * - 下载默认允许（但记录审计）
 */

/** 权限类型（Electron permission 类型） */
export type PermissionType =
  | "media"
  | "geolocation"
  | "notifications"
  | "midiSysex"
  | "pointerLock"
  | "fullscreen"
  | "openExternal"
  | "openHidden"
  | "clipboard-read"
  | "clipboard-sanitized-write"
  | "display-capture"
  | "speaker-selection"
  | "window-management"
  | "unknown";

/** 权限决策 */
export type PermissionDecision = "granted" | "denied" | "prompt";

/** 弹窗决策 */
export type PopupDecision = "allow" | "deny";

/** 外部协议决策 */
export type ExternalProtocolDecision = "allow" | "deny" | "prompt";

/** 证书错误决策 */
export type CertificateDecision = "trust" | "deny";

/** 下载决策 */
export type DownloadDecision = "allow" | "deny";

/** URL 安全检查结果 */
export type UrlSafetyResult = "safe" | "blocked" | "prompt";

/**
 * 允许的权限列表（安全白名单）。
 *
 * fullscreen 和 display-capture 允许（网页会议/演示需要），
 * clipboard-sanitized-write 允许（复制粘贴需要），
 * 其他默认拒绝。
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<PermissionType> = new Set([
  "fullscreen",
  "display-capture",
  "clipboard-sanitized-write",
]);

/**
 * 阻止的 URL scheme（外部协议默认阻止）。
 * 只允许 http/https 在 WebContentsView 中打开。
 */
export const BLOCKED_SCHEMES: ReadonlySet<string> = new Set(["file", "data", "blob", "javascript"]);

/**
 * 对 permission request 做决策。
 *
 * @param permissionType - 权限类型
 * @param requestingUrl - 请求权限的页面 URL
 * @returns granted/denied/prompt
 */
export function decidePermission(
  permissionType: PermissionType,
  _requestingUrl: string,
): PermissionDecision {
  if (ALLOWED_PERMISSIONS.has(permissionType)) {
    return "granted";
  }
  // 其他权限默认拒绝
  return "denied";
}

/**
 * 对弹窗请求做决策。
 *
 * 默认拒绝所有弹窗。防止恶意网站打开新窗口。
 * 弹窗的 URL 由用户手动在系统浏览器打开（通过 openExternal）。
 *
 * @param targetUrl - 弹窗目标 URL
 * @returns allow/deny
 */
export function decidePopup(_targetUrl: string): PopupDecision {
  // 默认拒绝所有弹窗
  return "deny";
}

/**
 * 对外部协议请求做决策。
 *
 * http/https 在 WebContentsView 内导航。
 * 其他协议（mailto/tel/custom）默认 prompt（用户确认后 allow）。
 *
 * @param targetUrl - 目标 URL
 * @returns allow/deny/prompt
 */
export function decideExternalProtocol(targetUrl: string): ExternalProtocolDecision {
  try {
    const url = new URL(targetUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      // http/https 不是外部协议，在 WebContentsView 内导航
      return "allow";
    }
    // mailto/tel/custom 协议需要用户确认
    return "prompt";
  } catch {
    // 无效 URL 拒绝
    return "deny";
  }
}

/**
 * 对证书错误做决策。
 *
 * 默认拒绝所有证书错误（fail-closed）。
 * 用户不能在 WebContentsView 中忽略证书错误。
 *
 * @param _certificate - 证书信息
 * @param _error - 错误类型
 * @returns trust/deny
 */
export function decideCertificateError(_certificate: unknown, _error: string): CertificateDecision {
  return "deny";
}

/**
 * 对下载请求做决策。
 *
 * 默认允许下载（但通过 DownloadItem 事件捕获审计）。
 * 可以根据 URL 策略阻止特定来源的下载。
 *
 * @param url - 下载来源 URL
 * @returns allow/deny
 */
export function decideDownload(url: string): DownloadDecision {
  // 检查 URL 合法性
  try {
    new URL(url);
    return "allow";
  } catch {
    return "deny";
  }
}

/**
 * 检查 URL 是否安全（用于导航前校验）。
 *
 * @param url - 要检查的 URL
 * @returns safe/blocked/prompt
 */
export function checkUrlSafety(url: string): UrlSafetyResult {
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.replace(":", "");
    // 阻止危险 scheme
    if (BLOCKED_SCHEMES.has(scheme)) {
      return "blocked";
    }
    // http/https 安全
    if (scheme === "http" || scheme === "https") {
      return "safe";
    }
    // 其他协议（mailto/tel/custom）需要用户确认
    return "prompt";
  } catch {
    return "blocked";
  }
}

/**
 * 判断 URL 是否为内部 SnowHarness Server URL。
 *
 * serverOrigins 条目可含 basePath（如 http://host/snowharness），比对时提取 origin。
 *
 * @param url - 要检查的 URL
 * @param serverOrigins - 受信任 Server origin 列表（可含 basePath）
 * @returns true 表示是 Server URL
 */
export function isServerUrl(url: string, serverOrigins: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    return serverOrigins.some((entry) => {
      try {
        const entryUrl = new URL(entry);
        const entryOrigin = `${entryUrl.protocol}//${entryUrl.host}`;
        return entryOrigin === origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
