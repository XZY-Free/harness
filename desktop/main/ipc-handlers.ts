/**
 * IPC handler 注册。
 *
 * 只注册 DESKTOP_IPC_CHANNELS 白名单中的 channel，最小暴露面。
 * preload 通过 contextBridge 仅暴露这些 channel 的 invoke 包装，不暴露通用 ipcRenderer。
 *
 * - 设备：getCapabilities / getInfo / openExternal / isFocused / window:getFrameState
 * - 设备绑定：device:getRegistration / device:register
 * - Browser：createTab / closeTab / switchTab / navigate / setBounds / getTabs / getActiveTab / hideViews / subscribe
 * - Bridge：bridge:getState / bridge:connect / bridge:disconnect / bridge:onStateChange（无条件注册，动态读取 lifecycle）
 * - 取消 AI：browser:cancelAi（动态读取 lifecycle）
 * - 退出：auth:logout（动态读取 lifecycle）
 * - 更新：updater:checkForUpdates / downloadUpdate / quitAndInstall / getState / onStateChange
 *
 * 白名单中的 channel 运行时必须都有 handler：Bridge 相关 channel 无条件注册，
 * 不再因未注册而缺 handler。
 */
import type { IpcMain } from "electron";
import { BrowserWindow, shell } from "electron";
import type {
  DesktopCapabilities,
  DesktopDeviceRegisterResult,
  DesktopDeviceRegistrationPayload,
} from "../../lib/desktop/capabilities";
import type { BrowserProfileCleaner } from "../auth/logout-orchestrator";
import { performLogout } from "../auth/logout-orchestrator";
import { type DesktopBridgeLifecycle, isValidTenantId } from "../bridge/bridge-lifecycle";
import { type DeviceIdentity, saveDeviceIdentity } from "../bridge/device-identity";
import type { AiLockManager } from "../browser/ai-lock";
import type { BrowserController } from "../browser/browser-controller";
import type { KeychainAdapter } from "../storage/keychain";
import type { UpdateManager } from "../updater/update-manager";
import { RendererSubscriptions } from "./renderer-subscriptions";

/**
 * 注册 Desktop IPC handler。
 *
 * @param ipcMain Electron ipcMain 实例
 * @param capabilities Desktop capability 对象（含 serverOrigin / appVersion）
 * @param deviceRegistration 本机设备注册请求体（由主进程构造，不含 tenantId 信任）
 * @param bridgeLifecycle Agent Bridge 生命周期控制器（动态持有 BridgeClient）
 * @param keychain Keychain 适配器（注册回填 / logout 清理）
 * @param aiLockManager AI 输入锁管理器（可选）
 * @param browserController Browser Controller 实例（可选）
 * @param profileCleaner Browser Profile 清理器（logout 用）
 * @param updateManager 自动更新管理器（可选）
 */
export function registerIpcHandlers(
  ipcMain: IpcMain,
  capabilities: DesktopCapabilities,
  deviceRegistration: DesktopDeviceRegistrationPayload,
  bridgeLifecycle: DesktopBridgeLifecycle,
  keychain: KeychainAdapter,
  aiLockManager?: AiLockManager,
  browserController?: BrowserController,
  profileCleaner?: BrowserProfileCleaner,
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

  // 设备绑定（白名单 channel 无条件注册 handler）
  ipcMain.handle("desktop:device:getRegistration", () => deviceRegistration);

  // 设备注册闭环：renderer 挂载后调用。
  // - main 用发起 renderer 的 Electron Session fetch 同源注册端点（不信任 renderer 传 tenantId）
  // - 请求体由主进程的 registration payload 构造，tenantId 由 Server 从认证主体解析
  // - 校验 HTTP/JSON、响应 deviceId 等于本机 identity.deviceId、tenantId 为合法非空 UUID
  // - 成功：回填 Keychain 并立即创建/连接 Bridge（无需重启）；失败保持 disconnected，可重试，无默认租户
  ipcMain.handle("desktop:device:register", async (event): Promise<DesktopDeviceRegisterResult> => {
    // 幂等：已注册则确保 Bridge 连接，不重复注册
    if (bridgeLifecycle.isRegistered()) {
      bridgeLifecycle.ensureConnected();
      return { ok: true, tenantId: bridgeLifecycle.getIdentity().tenantId ?? undefined };
    }
    const identity = bridgeLifecycle.getIdentity();
    const serverOrigin = capabilities.serverOrigin;
    const url = `${serverOrigin}/api/desktop/devices/register`;
    let res: Response;
    try {
      res = await event.sender.session.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: deviceRegistration.deviceId,
          publicKey: deviceRegistration.publicKey,
          name: deviceRegistration.name,
          version: deviceRegistration.version,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "network_error", message: `注册请求失败：${message}` };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, code: "invalid_response", message: "注册响应不是合法 JSON" };
    }
    if (!res.ok || typeof json !== "object" || json === null) {
      return { ok: false, code: "http_error", message: `注册端点返回 HTTP ${res.status}` };
    }
    const data = (json as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) {
      return { ok: false, code: "invalid_response", message: "注册响应缺少 data" };
    }
    const { deviceId: respDeviceId, tenantId } = data as { deviceId?: unknown; tenantId?: unknown };
    if (typeof respDeviceId !== "string" || respDeviceId !== identity.deviceId) {
      return { ok: false, code: "device_mismatch", message: "注册响应的 deviceId 与本机身份不符" };
    }
    if (typeof tenantId !== "string" || !isValidTenantId(tenantId)) {
      return { ok: false, code: "invalid_tenant", message: "注册响应的 tenantId 非法" };
    }
    // 校验通过：先构造不可变候选身份并持久化到 Keychain，成功后才提交内存态并连接。
    // 保存失败时原 identity.tenantId 仍为 null、lifecycle 不创建 client，可重试。
    const candidate: DeviceIdentity = { ...identity, tenantId };
    try {
      await saveDeviceIdentity(keychain, candidate);
    } catch {
      return { ok: false, code: "persist_error", message: "设备身份持久化失败" };
    }
    if (!bridgeLifecycle.applyTenantId(tenantId)) {
      return { ok: false, code: "invalid_tenant", message: "回填租户失败" };
    }
    bridgeLifecycle.connect();
    return { ok: true, tenantId };
  });

  // Browser tab 操作
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

    // desktop:browser:cancelAi → 请求 Server 停止当前 AI 命令（动态读取 lifecycle 当前 client）
    ipcMain.handle("desktop:browser:cancelAi", (_event, threadId: string) =>
      bridgeLifecycle.cancelAndTakeOver(threadId),
    );

    if (aiLockManager) {
      ipcMain.handle("desktop:browser:getLockState", (_event, threadId: string) =>
        aiLockManager.isLocked(threadId),
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

  // Agent Bridge 操作（白名单 channel 无条件注册，动态读取 lifecycle 当前 client）
  // desktop:bridge:getState → 获取连接状态
  ipcMain.handle("desktop:bridge:getState", () => {
    return bridgeLifecycle.getState();
  });

  // desktop:bridge:connect → 连接到 Server
  ipcMain.handle("desktop:bridge:connect", () => {
    bridgeLifecycle.connect();
    return true;
  });

  // desktop:bridge:disconnect → 断开连接
  ipcMain.handle("desktop:bridge:disconnect", () => {
    bridgeLifecycle.disconnect();
    return true;
  });

  // desktop:bridge:onStateChange → 订阅状态变化（通过 webContents.send 推送）
  ipcMain.handle("desktop:bridge:onStateChange", (event) => {
    rendererSubscriptions.ensure(event.sender, "bridge-state", () =>
      bridgeLifecycle.onStateChange((state) => {
        event.sender.send("desktop:bridge:stateUpdate", state);
      }),
    );
    return true;
  });

  // 退出登录：清理本地身份 + Browser Profile + 断开 Bridge（动态读取 lifecycle）
  if (browserController && profileCleaner) {
    ipcMain.handle("desktop:auth:logout", async () => {
      const sessionManager = browserController.getSessionManager();
      bridgeLifecycle.disconnect();
      const result = await performLogout(null, sessionManager, profileCleaner, keychain);
      // 清空内存态租户，使下次注册重新走完整流程
      bridgeLifecycle.clearTenant();
      return { ok: result.ok };
    });
  }

  // 自动更新
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
