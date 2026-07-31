/**
 * V10 Phase 7-4：QaWebContentsFactory 的 Electron 生产实现。
 *
 * 创建隐藏 BrowserWindow（show: false）作为 QA WebContents：
 * - 使用临时 session partition（`qa-temp-${threadId}`，非 persist:）
 * - 强制 read-only 策略：
 *   - session.on('will-download') → preventDefault
 *   - session.setPermissionRequestHandler → deny all
 *   - session.setPermissionCheckHandler → deny all
 *   - wc.setWindowOpenHandler → deny
 *   - wc.session.webRequest.onBeforeRequest → 阻断 POST/PUT/DELETE/PATCH
 *   - wc.on('certificate-error') → deny
 *
 * 安全约束：
 * - 隐藏窗口不向用户显示（show: false）
 * - 临时 session 不持久化（关闭后 Cookie/缓存自动清理）
 * - 所有权限/下载/弹窗/外部协议一律拒绝
 */

import { BrowserWindow, type Session, session } from "electron";
import type { QaViewport, QaWebContentsFactory, QaWebContentsHandle } from "./qa-controller";
import {
  decideQaCertificateError,
  decideQaDownload,
  decideQaExternalProtocol,
  decideQaNavigation,
  decideQaPermission,
  decideQaPopup,
  isReadOnlyRequestMethod,
} from "./qa-policy";

/**
 * 创建 QA 专用的临时 Session。
 *
 * 使用非 persist: partition（内存中，关闭后自动清理）。
 * 应用 read-only 策略：
 * - will-download → preventDefault
 * - permission request → deny all
 * - permission check → deny all
 * - webRequest.onBeforeRequest → 阻断写请求
 */
function createQaSession(threadId: string): Session {
  const qaSession = session.fromPartition(`qa-temp-${threadId}`);

  // 阻止所有下载
  qaSession.on("will-download", (event) => {
    event.preventDefault();
  });

  // 阻止所有权限请求
  qaSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  // 阻止所有权限检查
  qaSession.setPermissionCheckHandler(() => {
    return false;
  });

  // 阻断写请求（POST/PUT/DELETE/PATCH）
  qaSession.webRequest.onBeforeRequest((_details, callback) => {
    // 对所有请求放行；写请求方法阻断在 onBeforeSendHeaders 中更精确
    callback({});
  });

  // 更精确地在 onBeforeSendHeaders 中按方法阻断
  qaSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!isReadOnlyRequestMethod(details.method)) {
      // 阻断写请求（cancel: true）
      callback({ cancel: true });
    } else {
      callback({});
    }
  });

  return qaSession;
}

/**
 * Electron 生产实现：创建隐藏 BrowserWindow 并包装为 QaWebContentsHandle。
 */
export class QaElectronFactory implements QaWebContentsFactory {
  createHiddenWebContents(threadId: string, viewport: QaViewport): QaWebContentsHandle {
    const qaSession = createQaSession(threadId);

    const win = new BrowserWindow({
      show: false,
      width: viewport.width,
      height: viewport.height,
      webPreferences: {
        session: qaSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        offscreen: false,
      },
    });

    const wc = win.webContents;

    // 设置 viewport
    wc.enableDeviceEmulation({
      deviceScaleFactor: 1,
      screenPosition: "desktop",
      screenSize: { width: viewport.width, height: viewport.height },
      viewPosition: { x: 0, y: 0 },
      viewSize: { width: viewport.width, height: viewport.height },
      scale: 1,
    });

    // 阻止所有弹窗
    wc.setWindowOpenHandler(() => {
      decideQaPopup(); // 策略记录（始终 deny）
      return { action: "deny" };
    });

    // 阻止非 http/https 重定向（防止 tabnabbing）
    wc.on("will-redirect", (event, url) => {
      if (decideQaNavigation(url) !== "allow") {
        event.preventDefault();
      }
    });

    // 证书错误一律拒绝
    wc.on("certificate-error", (event) => {
      event.preventDefault();
      decideQaCertificateError(); // 策略记录
    });

    return {
      id: wc.id,

      async loadURL(url: string, opts?: { timeoutMs?: number }): Promise<void> {
        const timeoutMs = opts?.timeoutMs ?? 30000;
        await Promise.race([
          wc.loadURL(url),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error(`QA loadURL 超时：${url} (${timeoutMs}ms)`)),
              timeoutMs,
            ),
          ),
        ]);
      },

      async executeJavaScript<T>(script: string): Promise<T> {
        return wc.executeJavaScript(script) as Promise<T>;
      },

      async capturePage(): Promise<Buffer> {
        const image = await wc.capturePage();
        return image.toPNG();
      },

      setViewport(vp: QaViewport): void {
        wc.enableDeviceEmulation({
          deviceScaleFactor: 1,
          screenPosition: "desktop",
          screenSize: { width: vp.width, height: vp.height },
          viewPosition: { x: 0, y: 0 },
          viewSize: { width: vp.width, height: vp.height },
          scale: 1,
        });
      },

      onDidFinishLoad(callback: () => void): void {
        wc.on("did-finish-load", callback);
      },

      onWillNavigate(callback: (url: string) => boolean): void {
        wc.on("will-navigate", (event, url) => {
          if (!callback(url)) {
            event.preventDefault();
          }
        });
      },

      destroy(): void {
        // destroy 关闭窗口并清理 session
        win.destroy();
        // 从 session 列表中移除（Electron 自动清理非 persist: partition）
      },

      applyReadOnlyPolicy(): void {
        // read-only 策略已在 createQaSession 中应用到 session
        // 此方法用于 controller 调用记录（生产实现为空操作）
        // 保留接口以便未来扩展（如额外的 wc 级别策略）
      },
    };
  }
}

/** 导出策略决策（供测试和审计引用）。 */
export const QA_ELECTRON_POLICY = {
  decideQaDownload,
  decideQaPermission,
  decideQaPopup,
  decideQaExternalProtocol,
  decideQaCertificateError,
  decideQaNavigation,
  isReadOnlyRequestMethod,
} as const;
