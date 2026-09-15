import * as path from "node:path";
/**
 * V10 Phase 3：BrowserWindow 创建与安全加固。
 *
 * 安全默认值遵循 Electron 官方安全检查清单：
 * - contextIsolation: true（renderer 与 preload 上下文隔离）
 * - sandbox: true（preload 运行在受限沙箱，无 Node API 泄漏）
 * - nodeIntegration: false（renderer 无 Node API）
 * - webSecurity: true（同源策略 + https 强制）
 * - allowRunningInsecureContent: false（不允许 http 子资源）
 *
 * 导航拦截：
 * - will-navigate：只允许本机 renderer origin，挡外部跳转。
 * - setWindowOpenHandler：window.open 一律 deny，http/https 转系统浏览器。
 * - did-create-window：防御性回调，对子窗口套用相同导航约束。
 */
import { BrowserWindow, shell } from "electron";
import {
  isAllowedAuthenticationWindowNavigation,
  shouldBlockNavigation,
} from "./origin-guard";

/** Desktop 路由路径（本机 renderer origin 后追加）。 */
const DESKTOP_ROUTE_PATH = "/desktop";

/**
 * 计算 preload 脚本路径。
 *
 * 开发与打包后均为 `dist/main/../preload/index.js` → `dist/preload/index.js`，
 * 由构建工具保证 main / preload 同级输出到 dist 下。
 */
function getPreloadPath(): string {
  return path.join(__dirname, "../preload/index.js");
}

/**
 * 创建主窗口并加载本机 Desktop renderer。
 *
 * @param rendererOrigin 本机 Desktop renderer origin（如 http://127.0.0.1:43123）
 * @returns 已创建的 BrowserWindow
 */
export function createMainWindow(rendererOrigin: string): BrowserWindow {
  const desktopUrl = `${rendererOrigin}${DESKTOP_ROUTE_PATH}`;

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    // macOS 沉浸式标题栏（红绿灯按钮内嵌）
    titleBarStyle: "hiddenInset",
    // 红绿灯定位：与 W2-2 的 38px 标题栏视觉居中对齐（初值 16/14，方案允许 ±2px 调优）
    trafficLightPosition: { x: 16, y: 14 },
    icon: path.join(__dirname, "../app-icon.icns"),
    // W3-1：Desktop 切换为浅色默认主题，背景色同步改为浅色 --background 等值（#ffffff），
    // 消除启动/刷新瞬间"黑闪"；最终值由 globals.css 的 :root --background 决定。
    // W3-6：vibrancy 评估性实验（macOS sidebar 毛玻璃），效果待用户确认后决定去留。
    backgroundColor: "#ffffff",
    vibrancy: "sidebar",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // App Session 独立 partition，与系统浏览器 Cookie/storage 隔离
      partition: "persist:snowharness-app",
    },
  });

  let ssoRedirectPending = false;
  let authenticationWindow: BrowserWindow | null = null;

  const isRendererNavigation = (url: string): boolean => {
    try {
      return new URL(url).origin === new URL(rendererOrigin).origin;
    } catch {
      return false;
    }
  };

  const isSsoStartNavigation = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return isRendererNavigation(url) && parsed.pathname.endsWith("/api/auth/sso");
    } catch {
      return false;
    }
  };

  const closeAuthenticationWindow = (child: BrowserWindow) => {
    if (authenticationWindow !== child) return;
    authenticationWindow = null;
    if (!child.isDestroyed()) child.close();
    if (!win.isDestroyed()) {
      // 回调已经写入同一 partition 的会话 Cookie，主窗口重新加载后即可进入 Desktop。
      void win.loadURL(desktopUrl);
    }
  };

  const openAuthenticationWindow = (url: string) => {
    if (authenticationWindow && !authenticationWindow.isDestroyed()) {
      authenticationWindow.focus();
      return;
    }

    const child = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 960,
      minHeight: 640,
      title: "企业统一登录",
      parent: win,
      modal: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        partition: "persist:snowharness-app",
      },
    });
    authenticationWindow = child;

    child.webContents.on("will-navigate", (event, targetUrl) => {
      if (!isAllowedAuthenticationWindowNavigation(targetUrl, rendererOrigin)) {
        event.preventDefault();
      }
    });
    child.webContents.on("did-navigate", (_event, targetUrl) => {
      if (isRendererNavigation(targetUrl)) {
        closeAuthenticationWindow(child);
      }
    });
    child.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      if (isAllowedAuthenticationWindowNavigation(targetUrl, rendererOrigin)) {
        return { action: "allow" };
      }
      return { action: "deny" };
    });
    child.on("closed", () => {
      if (authenticationWindow === child) authenticationWindow = null;
    });
    void child.loadURL(url);
  };

  // 页面仅允许留在本机 renderer origin；远端地址只经 API proxy 调用，不能被导航为 UI 页面。
  win.webContents.on("will-navigate", (event, url) => {
    if (isSsoStartNavigation(url)) {
      ssoRedirectPending = true;
      return;
    }
    if (ssoRedirectPending && !isRendererNavigation(url)) {
      ssoRedirectPending = false;
      if (isAllowedAuthenticationWindowNavigation(url, rendererOrigin)) {
        event.preventDefault();
        openAuthenticationWindow(url);
        return;
      }
    }
    if (isRendererNavigation(url)) {
      ssoRedirectPending = false;
    }
    if (shouldBlockNavigation(url, [rendererOrigin], true)) {
      event.preventDefault();
    }
  });

  // setWindowOpenHandler：window.open 一律 deny；
  // http/https 链接转系统默认浏览器打开，其余静默丢弃
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const publishFrameState = (isFullScreen: boolean) => {
    if (!win.isDestroyed()) {
      win.webContents.send("desktop:window:frameStateUpdate", { isFullScreen });
    }
  };
  win.on("enter-full-screen", () => publishFrameState(true));
  win.on("leave-full-screen", () => publishFrameState(false));

  // did-create-window：防御性回调（deny 模式下通常不触发）
  // 一旦未来允许受信任 origin 开窗，对子窗口套用相同导航约束
  win.webContents.on("did-create-window", (childWindow) => {
    childWindow.webContents.on("will-navigate", (event, url) => {
      if (shouldBlockNavigation(url, [rendererOrigin], true)) {
        event.preventDefault();
      }
    });
  });

  void win.loadURL(desktopUrl);
  return win;
}
