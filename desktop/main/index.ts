/**
 * V10 Phase 3：Electron 主进程入口。
 *
 * 职责：
 * - 单实例锁（防止多开，第二实例聚焦已有窗口）。
 * - macOS 深链接处理（snowharness:// 协议；Phase 3 仅聚焦窗口，路由由 renderer 处理）。
 * - 创建主窗口并加载 Server URL（${origin}/desktop）。
 * - 注册系统菜单（最小集：appMenu / editMenu / viewMenu）。
 * - 生产环境启动崩溃报告（crashReporter），开发环境不启动。
 * - 注册 IPC handler（白名单 channel）。
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BrowserWindow, Menu, app, crashReporter, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import type {
  DesktopCapabilities,
  DesktopDeviceRegistration,
} from "../../lib/desktop/capabilities";
import { DESKTOP_CAPABILITY_VERSION, DESKTOP_IPC_CHANNELS } from "../../lib/desktop/capabilities";
import { ElectronProfileCleaner } from "../auth/electron-profile-cleaner";
import { BridgeClient } from "../bridge/bridge-client";
import type { BrowserActionTarget, BrowserCommandTarget } from "../bridge/command-executor";
import {
  createDeviceIdentity,
  loadDeviceIdentity,
  saveDeviceIdentity,
} from "../bridge/device-identity";
import { AiLockManager } from "../browser/ai-lock";
import type { WindowConstraints } from "../browser/bounds-validator";
import { BrowserController } from "../browser/browser-controller";
import { PageInsightsStore } from "../browser/page-insights-store";
import { DownloadManager } from "../downloads/download-manager";
import { QaController } from "../qa/qa-controller";
import { QaElectronFactory } from "../qa/qa-electron-factory";
import { openDesktopDatabase } from "../storage/database";
import { keychain } from "../storage/keychain";
import type { AutoUpdaterLike } from "../updater/update-manager";
import { UpdateManager } from "../updater/update-manager";
import { registerIpcHandlers } from "./ipc-handlers";
import { startLocalRendererServer } from "./local-renderer-server";
import { DEFAULT_SERVER_ORIGIN, loadAllowedOrigins } from "./origin-guard";
import { loadRuntimeEnvironment } from "./runtime-config";
import { createMainWindow } from "./window";

/** SnowHarness 深链接协议。 */
const DEEP_LINK_PROTOCOL = "snowharness";

/** Desktop 路由路径（追加到 Server origin 后）。 */
const DESKTOP_ROUTE_PATH = "/desktop";

/**
 * 读取 Server origin（取受信任列表第一个，回退默认值）。
 */
function getServerOrigin(env: NodeJS.ProcessEnv): string {
  const origins = loadAllowedOrigins(env);
  return origins[0] ?? DEFAULT_SERVER_ORIGIN;
}

/**
 * 构造 capability 对象，供 preload / IPC 共享。
 */
function buildCapabilities(serverOrigin: string, deviceId: string): DesktopCapabilities {
  return {
    version: DESKTOP_CAPABILITY_VERSION,
    serverOrigin,
    appVersion: app.getVersion(),
    ipcChannels: DESKTOP_IPC_CHANNELS,
    deviceId,
  };
}

/**
 * 构建最小系统菜单。
 *
 * macOS 必须有 appMenu（否则应用名显示异常）；
 * editMenu 提供 copy/paste/undo 等编辑快捷键；
 * viewMenu 提供 reload/devTools/zoom。
 */
function buildAppMenu(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      role: "editMenu",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      role: "viewMenu",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

/**
 * 聚焦已有窗口（第二实例 / 深链接触发）。
 */
function focusExistingWindow(): void {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    const win = windows[0];
    if (win !== undefined) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  }
}

/**
 * 应用主入口。
 */
async function main(): Promise<void> {
  // 生产环境启动崩溃报告，开发环境不启动
  if (app.isPackaged) {
    crashReporter.start({ uploadToServer: false });
  }

  // 注册深链接协议（macOS：snowharness://...）
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);

  // 单实例锁：防止多开
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  // 第二实例：聚焦已有窗口
  app.on("second-instance", () => {
    focusExistingWindow();
  });

  // macOS 深链接：snowharness://open/...
  // Phase 3 仅聚焦窗口，深链接路由由 renderer 处理（Phase 4+）
  app.on("open-url", (_event, _url) => {
    focusExistingWindow();
  });

  await app.whenReady();

  const runtimeConfigPath = app.isPackaged ? join(process.resourcesPath, "runtime-config.json") : null;
  const runtimeEnv = loadRuntimeEnvironment({
    env: process.env,
    configText: runtimeConfigPath && existsSync(runtimeConfigPath) ? readFileSync(runtimeConfigPath, "utf8") : undefined,
  });
  const serverOrigin = getServerOrigin(runtimeEnv);
  const allowInsecureRemoteOrigin = runtimeEnv.SNOW_ALLOW_INSECURE_REMOTE_ORIGIN;
  const localRenderer = await startLocalRendererServer({
    rendererDir: join(app.getAppPath(), "renderer"),
    serverOrigin,
  });
  let identity = await loadDeviceIdentity(keychain);
  if (identity === null) {
    identity = createDeviceIdentity();
    await saveDeviceIdentity(keychain, identity);
  }
  const deviceRegistration: DesktopDeviceRegistration = {
    deviceId: identity.deviceId,
    publicKey: identity.keyPair.publicKeyBase64,
    name: hostname() || "SnowHarness Desktop",
    version: app.getVersion(),
  };

  // preload 在隔离上下文中同步读取，必须在创建 BrowserWindow 前注入。
  process.env.SNOW_SERVER_ORIGIN = serverOrigin;
  if (allowInsecureRemoteOrigin === undefined) {
    Reflect.deleteProperty(process.env, "SNOW_ALLOW_INSECURE_REMOTE_ORIGIN");
  } else {
    process.env.SNOW_ALLOW_INSECURE_REMOTE_ORIGIN = allowInsecureRemoteOrigin;
  }
  process.env.SNOW_APP_VERSION = app.getVersion();
  process.env.SNOW_DEVICE_ID = identity.deviceId;
  const capabilities = buildCapabilities(serverOrigin, identity.deviceId);
  const desktopDatabase = await openDesktopDatabase(
    join(app.getPath("userData"), "desktop.sqlite"),
    app.isPackaged
      ? join(process.resourcesPath, "desktop-migrations")
      : join(process.cwd(), "desktop/storage/migrations"),
  );

  // 初始化 Browser Controller（Phase 4）
  const origins = loadAllowedOrigins();
  const windowConstraints: WindowConstraints = {
    windowWidth: 1400,
    windowHeight: 900,
  };
  const browserController = new BrowserController({
    serverOrigins: origins,
    windowConstraints,
    tabRestore: desktopDatabase.tabRestore,
  });
  const aiLockManager = new AiLockManager();
  aiLockManager.onLocked((lock) => {
    void browserController.setUserInputBlocked(lock.threadId, true);
  });
  aiLockManager.onReleased((release) => {
    void browserController.setUserInputBlocked(release.threadId, false);
  });

  // Phase 7-1：注入 DownloadManager 并配置上传参数
  const downloadManager = new DownloadManager();
  browserController.setDownloadManager(downloadManager);
  browserController.setDownloadUploadConfig({ serverOrigin });

  // Phase 7-4：初始化隐藏 QA WebContents 控制器
  // 使用独立的 PageInsightsStore（与用户 tab 缓冲隔离）
  const qaPageInsightsStore = new PageInsightsStore();
  const qaController = new QaController(qaPageInsightsStore, new QaElectronFactory());
  // Phase 8：注入到 BrowserController，使 closeThread 联动清理 QA 资源
  browserController.setQaController(qaController);

  // Phase 5：初始化 Agent Bridge（异步连接，不阻塞主进程启动）
  let bridgeClient: BridgeClient | undefined;
  try {
    // 创建 BrowserCommandTarget 适配器（包装 BrowserController）
    // 包含读取类能力：getTabs / getActiveTab / getDebuggerSession / captureScreenshot / listDownloads
    // Phase 7-3：新增 getSnapshot / getAccessibilityTree / getConsoleEntries / getNetworkEntries
    const commandTarget: BrowserCommandTarget = {
      getTabs: (threadId: string) => browserController.getTabs(threadId),
      getActiveTab: (threadId: string) => browserController.getActiveTab(threadId),
      getDebuggerSession: (threadId: string, tabId: string) =>
        browserController.getDebuggerSession(threadId, tabId),
      captureScreenshot: (threadId: string, tabId: string, format: string) =>
        browserController.captureScreenshot(threadId, tabId, format),
      listDownloads: (threadId: string) => browserController.listDownloads(threadId),
      getSnapshot: (threadId: string, tabId: string, maxTextLength?: number) =>
        browserController.getSnapshot(threadId, tabId, maxTextLength),
      getAccessibilityTree: (threadId: string, tabId: string) =>
        browserController.getAccessibilityTree(threadId, tabId),
      getConsoleEntries: (
        threadId: string,
        tabId: string,
        level?: "error" | "warning+",
        limit?: number,
      ) => browserController.getConsoleEntries(threadId, tabId, level, limit),
      getNetworkEntries: (
        threadId: string,
        tabId: string,
        filter?: "failed" | "slow",
        limit?: number,
      ) => browserController.getNetworkEntries(threadId, tabId, filter, limit),
    };

    // 创建 BrowserActionTarget 适配器（包装 BrowserController 的操作类能力）
    // 14 个 action 命令的执行目标
    const actionTarget: BrowserActionTarget = {
      navigate: (threadId: string, tabId: string, url: string) =>
        browserController.navigate(threadId, tabId, { type: "navigate", threadId, tabId, url }),
      closeTab: (threadId: string, tabId: string) =>
        browserController.closeTab(threadId, tabId) !== null,
      switchTab: (threadId: string, tabId: string) => browserController.switchTab(threadId, tabId),
      createTab: (
        threadId: string,
        url: string,
        opts?: { incognito?: boolean; tabId?: string; activate?: boolean },
      ) => browserController.createTab(threadId, url, undefined, opts),
      reload: (threadId: string, tabId: string) => browserController.reload(threadId, tabId),
      goBack: (threadId: string, tabId: string) => browserController.goBack(threadId, tabId),
      goForward: (threadId: string, tabId: string) => browserController.goForward(threadId, tabId),
      click: (threadId: string, tabId: string, x: number, y: number, button?: string) =>
        browserController.click(threadId, tabId, x, y, button),
      doubleClick: (threadId: string, tabId: string, x: number, y: number) =>
        browserController.doubleClick(threadId, tabId, x, y),
      type: (threadId: string, tabId: string, text: string, selector?: string) =>
        browserController.type(threadId, tabId, text, selector),
      press: (threadId: string, tabId: string, key: string) =>
        browserController.press(threadId, tabId, key),
      select: (threadId: string, tabId: string, selector: string, value?: string, label?: string) =>
        browserController.select(threadId, tabId, selector, value, label),
      scroll: (threadId: string, tabId: string, deltaX: number, deltaY: number) =>
        browserController.scroll(threadId, tabId, deltaX, deltaY),
      uploadWorkspaceFile: (
        threadId: string,
        tabId: string,
        selector: string,
        downloadUrl: string,
      ) => browserController.uploadWorkspaceFile(threadId, tabId, selector, downloadUrl),
    };

    // 创建 BridgeClient 并连接（从环境变量读取 Server URL）
    const bridgeUrl = process.env.SNOW_BRIDGE_URL ?? "ws://localhost:3002";
    bridgeClient = new BridgeClient({
      serverUrl: bridgeUrl,
      deviceIdentity: identity,
      deviceName: "SnowHarness Desktop",
      deviceVersion: app.getVersion(),
      commandTarget,
      actionTarget,
      aiLockManager,
    });
  } catch (err) {
    // 设备身份加载失败时记录错误但继续启动（Bridge 功能不可用）
    console.error("[snowharness:desktop] Agent Bridge 初始化失败:", err);
  }

  // 注册 IPC handler（白名单 channel）
  // Phase 8：注入 ElectronProfileCleaner 和 keychain 用于 logout 流程
  const profileCleaner = new ElectronProfileCleaner();

  // Phase 8：初始化自动更新管理器
  // autoUpdater 类型为 AppUpdater，断言为 AutoUpdaterLike 接口（方法签名兼容）
  const updatesEnabled =
    !app.isPackaged || existsSync(join(process.resourcesPath, "app-update.yml"));
  const updateManager = new UpdateManager(
    autoUpdater as unknown as AutoUpdaterLike,
    app,
    updatesEnabled,
  );
  updateManager.initialize();

  registerIpcHandlers(
    ipcMain,
    capabilities,
    deviceRegistration,
    aiLockManager,
    browserController,
    bridgeClient,
    profileCleaner,
    keychain,
    updateManager,
  );

  // 设置系统菜单
  Menu.setApplicationMenu(buildAppMenu());

  // 页面固定来自本机打包 renderer；腾讯云只处理 API/SSE，避免服务端旧页面覆盖 Desktop UI。
  const attachWindow = (window: BrowserWindow) => {
    browserController.attachToWindow(window);
    window.on("resize", () => {
      const [width, height] = window.getContentSize();
      browserController.updateWindowConstraints({
        windowWidth: width ?? 1400,
        windowHeight: height ?? 900,
      });
    });
  };
  attachWindow(createMainWindow(localRenderer.origin));

  // macOS：点击 dock 图标无窗口时重建
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      attachWindow(createMainWindow(localRenderer.origin));
    }
  });

  // 非 macOS：关闭所有窗口退出应用
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      void localRenderer.close();
      app.quit();
    }
  });

  // Phase 7-6：进程退出前清理所有未上传 / 未跟踪的本地临时文件
  // （screenshot / download / artifact），避免孤儿文件堆积。
  // before-quit 允许异步操作完成后再退出——使用 preventDefault 暂停退出，
  // 清理完成后移除自身监听并调用 app.quit() 触发实际退出。
  let isCleaningUp = false;
  const cleanupBeforeQuit = (event: Electron.Event) => {
    if (isCleaningUp) return; // 避免递归——app.quit() 会再次触发 before-quit
    isCleaningUp = true;
    event.preventDefault();
    Promise.allSettled([
      localRenderer.close(),
      browserController.flushPersistentStorage(),
      browserController.cleanupAllTempFiles(),
    ])
      .catch(() => {
        // 清理失败不阻断退出
      })
      .finally(() => {
        desktopDatabase.close();
        // 移除自身监听，使后续 app.quit() 不再触发清理
        app.removeListener("before-quit", cleanupBeforeQuit);
        app.quit();
      });
  };
  app.on("before-quit", cleanupBeforeQuit);
}

main().catch((err) => {
  // 主进程启动失败时记录并退出（不暴露敏感栈到 renderer）
  console.error("[snowharness:desktop] 主进程启动失败:", err);
  app.quit();
});
