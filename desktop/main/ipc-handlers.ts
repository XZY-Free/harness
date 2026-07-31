/**
 * V10 Phase 3+4+5+8：IPC handler 注册。
 *
 * 只注册 DESKTOP_IPC_CHANNELS 白名单中的 channel，最小暴露面。
 * preload 通过 contextBridge 仅暴露这些 channel 的 invoke 包装，不暴露通用 ipcRenderer。
 *
 * Phase 3：getCapabilities / getInfo / openExternal / isFocused
 * Phase 4：browser:createTab / closeTab / switchTab / navigate / setBounds / getTabs / getActiveTab / hideViews / subscribe
 * Phase 5：bridge:getState / bridge:connect / bridge:disconnect / bridge:onStateChange
 * Phase 8：auth:logout / updater:checkForUpdates / downloadUpdate / quitAndInstall / getState / onStateChange
 */
import type { IpcMain } from "electron";
import { BrowserWindow, shell } from "electron";
import type {
  DesktopCapabilities,
  DesktopDeviceRegistration,
} from "../../lib/desktop/capabilities";
import type { BrowserProfileCleaner } from "../auth/logout-orchestrator";
import { performLogout } from "../auth/logout-orchestrator";
import type { BridgeClient } from "../bridge/bridge-client";
import type { AiLockManager } from "../browser/ai-lock";
import type { BrowserController } from "../browser/browser-controller";
import type { KeychainAdapter } from "../storage/keychain";
import type { UpdateManager } from "../updater/update-manager";
import { RendererSubscriptions } from "./renderer-subscriptions";

/**
 * 注册 Desktop IPC handler。
 *
 * @param ipcMain Electron ipcMain 实例
 * @param capabilities Desktop capability 对象（由主进程构造，含版本 / origin / appVersion）
 * @param browserController Browser Controller 实例（Phase 4 起传入）
 * @param bridgeClient Agent Bridge 客户端实例（Phase 5 起传入，可选）
 * @param profileCleaner Browser Profile 清理器（Phase 8 起传入，用于 logout）
 * @param keychain Keychain 适配器（Phase 8 起传入，用于 logout）
 * @param updateManager 自动更新管理器（Phase 8 起传入，用于 autoUpdater）
 */
export function registerIpcHandlers(
  ipcMain: IpcMain,
  capabilities: DesktopCapabilities,
  deviceRegistration?: DesktopDeviceRegistration,
  aiLockManager?: AiLockManager,
  browserController?: BrowserController,
  bridgeClient?: BridgeClient,
  profileCleaner?: BrowserProfileCleaner,
  keychain?: KeychainAdapter,
  updateManager?: UpdateManager,
): void {
  const rendererSubscriptions = new RendererSubscriptions();

  // desktop:getCapabilities → 返回 capability 对象（renderer 用于校验来源）
  ipcMain.handle("desktop:getCapabilities", () => {
    return capabilities;
  });

  // desktop:getInfo → 返回应用版本 / Server origin / Electron 版本
  ipcMain.handle("desktop:getInfo", () => {
    return {
      appVersion: capabilities.appVersion,
      serverOrigin: capabilities.serverOrigin,
      electronVersion: process.versions.electron ?? "",
    };
  });

  // desktop:openExternal → 在系统默认浏览器打开（只允许 http/https）
  ipcMain.handle("desktop:openExternal", async (_event, url: unknown) => {
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("openExternal: url 为空或非字符串");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`openExternal: 无效 URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`openExternal: 仅允许 http/https，拒绝协议 ${parsed.protocol}`);
    }
    await shell.openExternal(url);
  });

  // desktop:isFocused → 返回当前聚焦窗口是否聚焦
  ipcMain.handle("desktop:isFocused", () => {
    const focused = BrowserWindow.getFocusedWindow();
    return focused?.isFocused() ?? false;
  });

  // desktop:window:getFrameState → 返回发起调用窗口的原生全屏状态
  ipcMain.handle("desktop:window:getFrameState", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return { isFullScreen: window?.isFullScreen() ?? false };
  });

  if (deviceRegistration) {
    ipcMain.handle("desktop:device:getRegistration", () => deviceRegistration);
  }

  // Phase 4：Browser tab 操作
  if (browserController) {
    // desktop:browser:createTab → 创建新 browser tab
    ipcMain.handle(
      "desktop:browser:createTab",
      (
        _event,
        threadId: string,
        url: string,
        userId: string,
        opts?: { incognito?: boolean; tabId?: string; activate?: boolean },
      ) => {
        if (browserController.isUserInputBlocked(threadId)) return null;
        return browserController.createTab(threadId, url, userId, opts);
      },
    );

    // desktop:browser:closeTab → 关闭 tab
    ipcMain.handle("desktop:browser:closeTab", (_event, threadId: string, tabId: string) => {
      if (browserController.isUserInputBlocked(threadId)) return null;
      return browserController.closeTab(threadId, tabId);
    });

    // desktop:browser:switchTab → 切换 active tab
    ipcMain.handle("desktop:browser:switchTab", (_event, threadId: string, tabId: string) => {
      if (browserController.isUserInputBlocked(threadId)) return false;
      return browserController.switchTab(threadId, tabId);
    });

    // desktop:browser:reorderTabs → 重排 tabs
    ipcMain.handle("desktop:browser:reorderTabs", (_event, threadId: string, tabIds: string[]) => {
      if (browserController.isUserInputBlocked(threadId)) return false;
      return browserController.reorderTabs(threadId, tabIds);
    });

    // desktop:browser:navigate → 导航操作
    ipcMain.handle(
      "desktop:browser:navigate",
      (_event, threadId: string, tabId: string, action: unknown) => {
        if (browserController.isUserInputBlocked(threadId)) return false;
        return browserController.navigate(threadId, tabId, action as never);
      },
    );

    // desktop:browser:setBounds → 设置 view bounds
    ipcMain.handle(
      "desktop:browser:setBounds",
      (_event, threadId: string, tabId: string, bounds: unknown, scaleFactor: number) => {
        return browserController.setBounds(threadId, tabId, bounds, scaleFactor);
      },
    );

    // desktop:browser:getTabs → 获取 Thread 的所有 tab
    ipcMain.handle("desktop:browser:getTabs", (_event, threadId: string) => {
      return browserController.getTabs(threadId);
    });

    // desktop:browser:getActiveTab → 获取 active tab
    ipcMain.handle("desktop:browser:getActiveTab", (_event, threadId: string) => {
      return browserController.getActiveTab(threadId);
    });

    // desktop:browser:hideViews → 隐藏 Thread 的所有 views
    ipcMain.handle("desktop:browser:hideViews", (_event, threadId: string) => {
      browserController.hideThreadViews(threadId);
      return true;
    });

    // desktop:browser:subscribe → 订阅 tab 变更事件
    ipcMain.handle("desktop:browser:subscribe", (event, threadId: string) => {
      rendererSubscriptions.replace(event.sender, `browser:${threadId}`, () =>
        browserController.subscribe(threadId, (tabs, activeTab) => {
          event.sender.send("desktop:browser:tabUpdate", { threadId, tabs, activeTab });
        }),
      );
      return true;
    });

    ipcMain.handle("desktop:browser:restoreTabs", (_event, threadId: string, userId: string) => {
      browserController.restoreTabs(threadId, userId);
      return true;
    });

    if (aiLockManager) {
      ipcMain.handle("desktop:browser:getLockState", (_event, threadId: string) =>
        aiLockManager.isLocked(threadId),
      );
      ipcMain.handle(
        "desktop:browser:cancelAi",
        (_event, threadId: string) => bridgeClient?.cancelAndTakeOver(threadId) ?? false,
      );
      ipcMain.handle("desktop:browser:subscribeLockState", (event) => {
        rendererSubscriptions.ensure(event.sender, "browser-lock", () => {
          const onLocked = aiLockManager.onLocked((lock) => {
            event.sender.send("desktop:browser:lockStateUpdate", {
              threadId: lock.threadId,
              locked: true,
            });
          });
          const onReleased = aiLockManager.onReleased((release) => {
            event.sender.send("desktop:browser:lockStateUpdate", {
              threadId: release.threadId,
              locked: false,
            });
          });
          return () => {
            onLocked();
            onReleased();
          };
        });
        return true;
      });
    }
  }

  // Phase 5：Agent Bridge 操作
  if (bridgeClient) {
    // desktop:bridge:getState → 获取连接状态
    ipcMain.handle("desktop:bridge:getState", () => {
      return bridgeClient.getState();
    });

    // desktop:bridge:connect → 连接到 Server
    ipcMain.handle("desktop:bridge:connect", () => {
      bridgeClient.connect();
      return true;
    });

    // desktop:bridge:disconnect → 断开连接
    ipcMain.handle("desktop:bridge:disconnect", () => {
      bridgeClient.disconnect();
      return true;
    });

    // desktop:bridge:onStateChange → 订阅状态变化（通过 webContents.send 推送）
    ipcMain.handle("desktop:bridge:onStateChange", (event) => {
      rendererSubscriptions.ensure(event.sender, "bridge-state", () =>
        bridgeClient.onStateChange((state) => {
          event.sender.send("desktop:bridge:stateUpdate", state);
        }),
      );
      return true;
    });
  }

  // Phase 8：退出登录
  // 清理本地身份 + Browser Profile + 断开 Bridge
  if (browserController && profileCleaner && keychain) {
    ipcMain.handle("desktop:auth:logout", async () => {
      const sessionManager = browserController.getSessionManager();
      const result = await performLogout(
        bridgeClient ?? null,
        sessionManager,
        profileCleaner,
        keychain,
      );
      return { ok: result.ok };
    });
  }

  // Phase 8：自动更新
  if (updateManager) {
    // desktop:updater:checkForUpdates → 检查更新
    ipcMain.handle("desktop:updater:checkForUpdates", async () => {
      return updateManager.checkForUpdates();
    });

    // desktop:updater:downloadUpdate → 下载更新
    ipcMain.handle("desktop:updater:downloadUpdate", async () => {
      return updateManager.downloadUpdate();
    });

    // desktop:updater:quitAndInstall → 退出并安装
    ipcMain.handle("desktop:updater:quitAndInstall", () => {
      updateManager.quitAndInstall();
      return true;
    });

    // desktop:updater:getState → 获取当前状态
    ipcMain.handle("desktop:updater:getState", () => {
      return updateManager.getStatus();
    });

    // desktop:updater:onStateChange → 订阅状态变化（通过 webContents.send 推送）
    ipcMain.handle("desktop:updater:onStateChange", (event) => {
      rendererSubscriptions.ensure(event.sender, "updater-state", () =>
        updateManager.onStateChange((status) => {
          event.sender.send("desktop:updater:stateUpdate", status);
        }),
      );
      return true;
    });
  }
}
