/**
 * V10 Phase 3：Electron preload 脚本。
 *
 * 职责：
 * - 同步注入 globalThis.__SNOW_DESKTOP__（capability 对象），renderer 通过
 *   getDesktopCapabilities() 读取后校验来源，才挂载 DesktopBrowserSurface。
 * - 注入 globalThis.__SNOW_PLATFORM__ = "desktop-browser"，供 getPlatformCapability() 识别。
 * - 通过 contextBridge.exposeInMainWorld('snowDesktop', {...}) 暴露最小 API，
 *   只暴露白名单 IPC channel 的 invoke 包装，不暴露通用 ipcRenderer。
 *
 * 安全约束：
 * - sandbox: true 下 preload 仅有 electron 的 contextBridge / ipcRenderer 与 process.env。
 * - capability 由 preload 同步构造（从 env 读取 origin / appVersion），renderer 无法伪造。
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopBrowserStateUpdate,
  DesktopCapabilities,
  DesktopDeviceRegistration,
  DesktopWindowFrameState,
} from "../../lib/desktop/capabilities";
import {
  DESKTOP_CAPABILITY_VERSION,
  DESKTOP_IPC_CHANNELS,
  isValidDesktopCapabilities,
} from "../../lib/desktop/capabilities";

/** 默认本地开发 Server origin。 */
const DEFAULT_SERVER_ORIGIN = "http://localhost:3000";

/** 默认 app 版本（env 未注入时回退，仅开发态生效）。 */
const DEFAULT_APP_VERSION = "0.0.0";

/**
 * 同步构造 capability 对象（供 preload 注入）。
 *
 * - serverOrigin / appVersion 由主进程通过 env 注入（SNOW_SERVER_ORIGIN / SNOW_APP_VERSION）。
 * - deviceId 在 Phase 5 设备绑定后填充，Phase 3 为 null。
 */
function buildCapabilities(): DesktopCapabilities {
  const serverOrigin = process.env.SNOW_SERVER_ORIGIN ?? DEFAULT_SERVER_ORIGIN;
  const appVersion = process.env.SNOW_APP_VERSION ?? DEFAULT_APP_VERSION;
  return {
    version: DESKTOP_CAPABILITY_VERSION,
    serverOrigin,
    appVersion,
    ipcChannels: DESKTOP_IPC_CHANNELS,
    deviceId: process.env.SNOW_DEVICE_ID ?? null,
    // 连接远程 http 部署时显式开启（主进程 env 注入）
    allowInsecureRemoteOrigin: process.env.SNOW_ALLOW_INSECURE_REMOTE_ORIGIN === "1",
  };
}

const capabilities = buildCapabilities();
if (!isValidDesktopCapabilities(capabilities)) {
  throw new Error("Desktop capabilities 无效");
}

// 暴露最小 API：只暴露白名单 IPC channel 的 invoke 包装
contextBridge.exposeInMainWorld("snowDesktop", {
  /** 同步 capability 值，由 contextBridge 安全复制到 renderer main world。 */
  capabilities,
  /** 获取 Desktop capability handshake（异步从主进程取，含校验值）。 */
  getCapabilities: (): Promise<DesktopCapabilities> =>
    ipcRenderer.invoke("desktop:getCapabilities"),
  /** 在系统默认浏览器打开外部链接（主进程校验 http/https）。 */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("desktop:openExternal", url),
  /** 当前窗口是否聚焦。 */
  isFocused: (): Promise<boolean> => ipcRenderer.invoke("desktop:isFocused"),
  /** 原生窗口框架状态，用于协调 macOS 红绿灯安全区。 */
  windowControls: {
    getFrameState: (): Promise<DesktopWindowFrameState> =>
      ipcRenderer.invoke("desktop:window:getFrameState"),
    onFrameStateChange: (callback: (state: DesktopWindowFrameState) => void) => {
      const handler = (_event: unknown, state: DesktopWindowFrameState) => callback(state);
      ipcRenderer.on("desktop:window:frameStateUpdate", handler);
      return () => {
        ipcRenderer.removeListener("desktop:window:frameStateUpdate", handler);
      };
    },
  },

  /** 设备绑定只暴露公钥和展示信息，私钥始终留在主进程 Keychain。 */
  device: {
    getRegistration: (): Promise<DesktopDeviceRegistration> =>
      ipcRenderer.invoke("desktop:device:getRegistration"),
  },

  // Phase 4：Browser tab 操作
  /** 创建新 browser tab。 */
  browser: {
    /** 创建新 tab */
    createTab: (
      threadId: string,
      url: string,
      userId: string,
      opts?: { incognito?: boolean; tabId?: string; activate?: boolean },
    ) => ipcRenderer.invoke("desktop:browser:createTab", threadId, url, userId, opts),
    /** 关闭 tab */
    closeTab: (threadId: string, tabId: string) =>
      ipcRenderer.invoke("desktop:browser:closeTab", threadId, tabId),
    /** 切换 active tab */
    switchTab: (threadId: string, tabId: string) =>
      ipcRenderer.invoke("desktop:browser:switchTab", threadId, tabId),
    /** 重排 tabs */
    reorderTabs: (threadId: string, tabIds: string[]) =>
      ipcRenderer.invoke("desktop:browser:reorderTabs", threadId, tabIds),
    /** 导航操作 */
    navigate: (threadId: string, tabId: string, action: unknown) =>
      ipcRenderer.invoke("desktop:browser:navigate", threadId, tabId, action),
    /** 设置 view bounds */
    setBounds: (threadId: string, tabId: string, bounds: unknown, scaleFactor: number) =>
      ipcRenderer.invoke("desktop:browser:setBounds", threadId, tabId, bounds, scaleFactor),
    /** 获取所有 tab */
    getTabs: (threadId: string) => ipcRenderer.invoke("desktop:browser:getTabs", threadId),
    /** 获取 active tab */
    getActiveTab: (threadId: string) =>
      ipcRenderer.invoke("desktop:browser:getActiveTab", threadId),
    /** 隐藏 Thread 的所有 views */
    hideViews: (threadId: string) => ipcRenderer.invoke("desktop:browser:hideViews", threadId),
    /** 订阅 tab 变更事件 */
    subscribe: (threadId: string) => ipcRenderer.invoke("desktop:browser:subscribe", threadId),
    /** 从本地 SQLite 惰性恢复当前 Thread 的普通 tabs。 */
    restoreTabs: (threadId: string, userId: string) =>
      ipcRenderer.invoke("desktop:browser:restoreTabs", threadId, userId),
    getLockState: (threadId: string) =>
      ipcRenderer.invoke("desktop:browser:getLockState", threadId),
    cancelAi: (threadId: string) => ipcRenderer.invoke("desktop:browser:cancelAi", threadId),
    onLockStateChange: (callback: (data: { threadId: string; locked: boolean }) => void) => {
      const handler = (_event: unknown, data: { threadId: string; locked: boolean }) =>
        callback(data);
      ipcRenderer.on("desktop:browser:lockStateUpdate", handler);
      void ipcRenderer.invoke("desktop:browser:subscribeLockState");
      return () => ipcRenderer.removeListener("desktop:browser:lockStateUpdate", handler);
    },
    /** 监听 tab 变更事件推送（由主进程主动 send） */
    onTabUpdate: (callback: (data: DesktopBrowserStateUpdate) => void) => {
      const handler = (_event: unknown, data: DesktopBrowserStateUpdate) => callback(data);
      ipcRenderer.on("desktop:browser:tabUpdate", handler);
      return () => {
        ipcRenderer.removeListener("desktop:browser:tabUpdate", handler);
      };
    },
  },

  // Phase 5：Agent Bridge 操作
  /** Agent Bridge 连接管理 */
  bridge: {
    /** 获取当前连接状态 */
    getState: (): Promise<string> => ipcRenderer.invoke("desktop:bridge:getState"),
    /** 连接到 Agent Bridge Server */
    connect: (): Promise<boolean> => ipcRenderer.invoke("desktop:bridge:connect"),
    /** 断开 Agent Bridge 连接 */
    disconnect: (): Promise<boolean> => ipcRenderer.invoke("desktop:bridge:disconnect"),
    /** 订阅连接状态变化（由主进程主动推送） */
    onStateChange: (callback: (state: string) => void) => {
      const handler = (_event: unknown, state: string) => callback(state);
      ipcRenderer.on("desktop:bridge:stateUpdate", handler);
      return () => {
        ipcRenderer.removeListener("desktop:bridge:stateUpdate", handler);
      };
    },
  },

  // Phase 8：退出登录
  /** 退出登录：清除本地身份 + Browser Profile + 断开 Bridge */
  auth: {
    /** 退出登录，返回成功状态 */
    logout: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("desktop:auth:logout"),
  },

  // Phase 8：自动更新
  updater: {
    /** 检查更新 */
    checkForUpdates: () => ipcRenderer.invoke("desktop:updater:checkForUpdates"),
    /** 下载更新（仅在 available 状态可用） */
    downloadUpdate: () => ipcRenderer.invoke("desktop:updater:downloadUpdate"),
    /** 退出并安装更新（仅在 downloaded 状态可用） */
    quitAndInstall: () => ipcRenderer.invoke("desktop:updater:quitAndInstall"),
    /** 获取当前更新状态 */
    getState: () => ipcRenderer.invoke("desktop:updater:getState"),
    /** 订阅更新状态变化（由主进程主动推送） */
    onStateChange: (callback: (data: unknown) => void) => {
      const handler = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on("desktop:updater:stateUpdate", handler);
      return () => {
        ipcRenderer.removeListener("desktop:updater:stateUpdate", handler);
      };
    },
  },
});
