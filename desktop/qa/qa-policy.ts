/**
 * V10 Phase 7-4：QA WebContents read-only 策略。
 *
 * 纯逻辑模块，定义隐藏 QA WebContents 的安全策略决策。
 *
 * 策略原则（fail-closed + read-only）：
 * - 下载一律拒绝（QA 不产生本机文件）
 * - 权限一律拒绝（notification/camera/mic 等）
 * - 弹窗一律拒绝（防止恶意页面打开新窗口）
 * - 外部协议一律拒绝（防止 mailto:/custom-scheme: 触发本机应用）
 * - 证书错误一律拒绝（不接受自签名证书）
 * - 导航只允许 http/https（阻止 file:/data:/javascript:/blob:）
 * - 请求方法只允许 GET/HEAD/OPTIONS（POST/PUT/DELETE/PATCH 阻断，防止状态变更）
 *
 * 与 browser/permission-policy.ts 的区别：
 * - browser/permission-policy.ts 策略较宽松（允许 fullscreen/display-capture 等用户操作）
 * - qa-policy 策略全部 fail-closed（QA 是不可见的，不需要任何用户交互权限）
 */

/** QA 决策（allow/deny 或 granted/denied）。 */
export type QaDecision = "allow" | "deny" | "granted" | "denied";

/** QA WebContents 中一律拒绝的权限类型。 */
export const BLOCKED_QA_PERMISSIONS = [
  "media",
  "geolocation",
  "notifications",
  "midiSysex",
  "pointerLock",
  "fullscreen",
  "openExternal",
  "openHidden",
  "clipboard-read",
  "clipboard-sanitized-write",
  "display-capture",
  "speaker-selection",
  "window-management",
  "unknown",
] as const;

/** QA 中允许的 URL scheme（仅 http/https）。 */
const ALLOWED_QA_SCHEMES = new Set(["http:", "https:"]);

/** read-only 允许的 HTTP 方法（不含 body、不改变服务器状态）。 */
const READ_ONLY_METHODS = new Set(["get", "head", "options"]);

/**
 * QA 下载决策：始终 deny。
 *
 * QA WebContents 不允许产生任何下载文件。
 */
export function decideQaDownload(): "deny" {
  return "deny";
}

/**
 * QA 权限决策：始终 denied。
 *
 * @param _permissionType - 权限类型（QA 中一律拒绝，不区分类型）
 */
export function decideQaPermission(_permissionType: string): "denied" {
  return "denied";
}

/**
 * QA 弹窗决策：始终 deny。
 *
 * 防止 QA 页面打开新窗口（tabnabbing、弹窗广告等）。
 */
export function decideQaPopup(): "deny" {
  return "deny";
}

/**
 * QA 外部协议决策：始终 deny。
 *
 * 防止 mailto:/custom-scheme: 触发本机应用。
 */
export function decideQaExternalProtocol(): "deny" {
  return "deny";
}

/**
 * QA 证书错误决策：始终 deny。
 *
 * 不接受自签名或过期证书的 HTTPS 连接。
 */
export function decideQaCertificateError(): "deny" {
  return "deny";
}

/**
 * QA 导航决策。
 *
 * 只允许 http/https URL，阻止 file:/data:/javascript:/blob: 等危险 scheme。
 * 防止 QA WebContents 读取本机文件或执行注入脚本。
 *
 * @param targetUrl - 目标 URL
 * @returns "allow" 或 "deny"
 */
export function decideQaNavigation(targetUrl: string): "allow" | "deny" {
  if (!targetUrl || typeof targetUrl !== "string") return "deny";
  try {
    const parsed = new URL(targetUrl);
    return ALLOWED_QA_SCHEMES.has(parsed.protocol) ? "allow" : "deny";
  } catch {
    return "deny";
  }
}

/**
 * 判断 HTTP 请求方法是否 read-only。
 *
 * GET/HEAD/OPTIONS 不改变服务器状态，允许通过。
 * POST/PUT/DELETE/PATCH 可能改变服务器状态，一律阻断。
 *
 * @param method - HTTP 方法（大小写不敏感）
 */
export function isReadOnlyRequestMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method.toLowerCase());
}

/**
 * QA read-only 注入脚本。
 *
 * 在页面 did-finish-load 后通过 wc.executeJavaScript 注入，
 * 阻止表单提交和弹窗。
 */
export const QA_READONLY_INJECTION = `
(function() {
  'use strict';
  // 阻止所有表单提交（防止 POST/GET 改变服务器状态）
  document.addEventListener('submit', function(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }, true);
  // 阻止 window.open（弹窗策略的二次保障）
  window.open = function() { return null; };
})();
`;
