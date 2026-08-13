/**
 * ：平台能力标识。
 *
 * 区分 Web 和 macOS Desktop 两种产品形态，决定 WorkbenchPanel 注册哪种 Surface：
 * - `web-preview`：Web 端使用 iframe Preview Surface（默认）。
 * - `desktop-browser`：macOS Desktop 使用 WebContentsView Browser Surface（Phase 3+）。
 *
 * Web 端始终返回 `web-preview`。Desktop 端在 通过 preload 注入全局标识后返回 `desktop-browser`。
 * 检测顺序：preload 注入的 `window.__SNOW_PLATFORM__` → 默认 `web-preview`。
 */

export type PlatformCapability = "web-preview" | "desktop-browser";

/**
 * 获取当前平台能力。Web 端默认 `web-preview`。
 * Desktop Electron 端通过 preload 脚本注入 `globalThis.__SNOW_PLATFORM__ = "desktop-browser"`。
 *
 * 使用 globalThis 而非 window，使其在 SSR / Node 环境也能安全调用。
 */
export function getPlatformCapability(): PlatformCapability {
  const platform = (globalThis as unknown as { __SNOW_PLATFORM__?: PlatformCapability })
    .__SNOW_PLATFORM__;
  if (platform) {
    return platform;
  }
  return "web-preview";
}

/**
 * 是否为 Web 预览平台（iframe Preview Surface）。
 */
export function isWebPreview(): boolean {
  return getPlatformCapability() === "web-preview";
}

/**
 * 是否为 Desktop 浏览器平台（WebContentsView Browser Surface）。
 */
export function isDesktopBrowser(): boolean {
  return getPlatformCapability() === "desktop-browser";
}
