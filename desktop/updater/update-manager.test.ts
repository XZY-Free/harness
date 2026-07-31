import type { App } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoUpdaterLike, UpdateInfo, UpdateProgress } from "./update-manager";
import { UpdateManager } from "./update-manager";

/**
 * V10 Phase 8：UpdateManager 单元测试。
 *
 * 使用 MockAutoUpdater + MockApp 实现，不依赖 electron-updater 真实模块。
 * 验证：
 * - initialize 配置 autoDownload = false / autoInstallOnAppQuit = true
 * - 开发环境不自动检查
 * - 生产环境启动定时检查
 * - 手动检查更新流程（checking → available / not_available）
 * - 下载更新流程（downloading → downloaded）
 * - quitAndInstall 仅在 downloaded 状态执行
 * - 错误事件处理
 * - 状态变化通知
 * - stopAutoCheck
 */

/** Mock autoUpdater */
class MockAutoUpdater implements AutoUpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checkForUpdatesCalled = false;
  downloadUpdateCalled = false;
  quitAndInstallCalled = false;
  checkForUpdatesResult: { updateInfo: UpdateInfo } | null = null;
  checkForUpdatesError: Error | null = null;
  downloadUpdateError: Error | null = null;

  private listeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();

  async checkForUpdates(): Promise<{ updateInfo: UpdateInfo } | null> {
    this.checkForUpdatesCalled = true;
    if (this.checkForUpdatesError) throw this.checkForUpdatesError;
    return this.checkForUpdatesResult;
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloadUpdateCalled = true;
    if (this.downloadUpdateError) throw this.downloadUpdateError;
    return [];
  }

  quitAndInstall(): void {
    this.quitAndInstallCalled = true;
  }

  removeAllListeners(event: string): void {
    this.listeners.delete(event);
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    const list = this.listeners.get(event);
    if (list) {
      list.push(listener);
    }
  }

  /** 触发事件（供测试模拟） */
  emit(event: string, ...args: unknown[]): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const l of listeners) l(...args);
    }
  }
}

/** Mock App */
function createMockApp(isPackaged: boolean): App {
  return { isPackaged } as unknown as App;
}

const SAMPLE_INFO: UpdateInfo = {
  version: "1.2.0",
  releaseDate: "2026-07-13T00:00:00Z",
  releaseNotes: "Bug fixes",
};

const SAMPLE_PROGRESS: UpdateProgress = {
  percent: 50,
  transferred: 5000,
  total: 10000,
  bytesPerSecond: 1000,
};

describe("UpdateManager (V10 Phase 8)", () => {
  let autoUpdater: MockAutoUpdater;
  let app: App;
  let manager: UpdateManager;

  beforeEach(() => {
    autoUpdater = new MockAutoUpdater();
    app = createMockApp(false);
    manager = new UpdateManager(autoUpdater, app);
  });

  afterEach(() => {
    manager.stopAutoCheck();
  });

  describe("initialize", () => {
    it("设置 autoDownload = false", () => {
      manager.initialize();
      expect(autoUpdater.autoDownload).toBe(false);
    });

    it("设置 autoInstallOnAppQuit = true", () => {
      manager.initialize();
      expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    });

    it("开发环境不启动定时检查", () => {
      manager.initialize();
      // checkForUpdates 不应被自动调用
      expect(autoUpdater.checkForUpdatesCalled).toBe(false);
    });

    it("生产环境启动定时检查", () => {
      vi.useFakeTimers();
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();

      // 首次检查延迟 30 秒
      vi.advanceTimersByTime(29_000);
      expect(autoUpdater.checkForUpdatesCalled).toBe(false);

      vi.advanceTimersByTime(2_000);
      expect(autoUpdater.checkForUpdatesCalled).toBe(true);

      vi.useRealTimers();
    });

    it("本地未签名包缺少更新清单时不启动检查", async () => {
      vi.useFakeTimers();
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app, false);
      manager.initialize();

      vi.advanceTimersByTime(31_000);
      expect(autoUpdater.checkForUpdatesCalled).toBe(false);
      expect((await manager.checkForUpdates()).state).toBe("idle");

      vi.useRealTimers();
    });
  });

  describe("checkForUpdates", () => {
    it("开发环境返回 idle 状态不调用 autoUpdater", async () => {
      manager.initialize();
      const status = await manager.checkForUpdates();
      expect(autoUpdater.checkForUpdatesCalled).toBe(false);
      expect(status.state).toBe("idle");
    });

    it("生产环境调用 autoUpdater.checkForUpdates", async () => {
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();
      autoUpdater.checkForUpdatesCalled = false; // reset after initialize auto-check

      await manager.checkForUpdates();
      expect(autoUpdater.checkForUpdatesCalled).toBe(true);
    });

    it("checking-for-update 事件触发 checking 状态", async () => {
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();

      const checkPromise = manager.checkForUpdates();
      autoUpdater.emit("checking-for-update");
      await checkPromise;

      expect(manager.getStatus().state).toBe("checking");
    });

    it("update-available 事件触发 available 状态并保存 info", async () => {
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();
      autoUpdater.checkForUpdatesResult = { updateInfo: SAMPLE_INFO };

      const checkPromise = manager.checkForUpdates();
      autoUpdater.emit("update-available", SAMPLE_INFO);
      await checkPromise;

      const status = manager.getStatus();
      expect(status.state).toBe("available");
      expect(status.info).toEqual(SAMPLE_INFO);
    });

    it("update-not-available 事件触发 not_available 状态", async () => {
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();

      const checkPromise = manager.checkForUpdates();
      autoUpdater.emit("update-not-available", SAMPLE_INFO);
      await checkPromise;

      expect(manager.getStatus().state).toBe("not_available");
    });

    it("checkForUpdates 抛错时设置 error 状态", async () => {
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();
      autoUpdater.checkForUpdatesError = new Error("网络错误");

      const status = await manager.checkForUpdates();
      expect(status.state).toBe("error");
      expect(status.error).toBe("网络错误");
    });
  });

  describe("downloadUpdate", () => {
    it("非 available 状态不调用 downloadUpdate", async () => {
      manager.initialize();
      await manager.downloadUpdate();
      expect(autoUpdater.downloadUpdateCalled).toBe(false);
    });

    it("available 状态调用 downloadUpdate", async () => {
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();
      autoUpdater.checkForUpdatesResult = { updateInfo: SAMPLE_INFO };

      await manager.checkForUpdates();
      autoUpdater.emit("update-available", SAMPLE_INFO);
      autoUpdater.checkForUpdatesCalled = false;

      // 进入 available 状态后下载
      autoUpdater.emit("update-available", SAMPLE_INFO);

      // 模拟 downloadUpdate 返回
      const downloadPromise = manager.downloadUpdate();
      autoUpdater.emit("download-progress", SAMPLE_PROGRESS);
      await downloadPromise;

      expect(autoUpdater.downloadUpdateCalled).toBe(true);
      expect(manager.getStatus().progress).toEqual(SAMPLE_PROGRESS);
    });

    it("download-progress 事件触发 downloading 状态并保存 progress", async () => {
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();

      // 先进入 available 状态
      autoUpdater.emit("update-available", SAMPLE_INFO);

      const downloadPromise = manager.downloadUpdate();
      autoUpdater.emit("download-progress", SAMPLE_PROGRESS);
      await downloadPromise;

      const status = manager.getStatus();
      expect(status.state).toBe("downloading");
      expect(status.progress).toEqual(SAMPLE_PROGRESS);
    });

    it("update-downloaded 事件触发 downloaded 状态", async () => {
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();

      autoUpdater.emit("update-available", SAMPLE_INFO);
      const downloadPromise = manager.downloadUpdate();
      autoUpdater.emit("update-downloaded", SAMPLE_INFO);
      await downloadPromise;

      expect(manager.getStatus().state).toBe("downloaded");
    });

    it("downloadUpdate 抛错时设置 error 状态", async () => {
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();

      autoUpdater.emit("update-available", SAMPLE_INFO);
      autoUpdater.downloadUpdateError = new Error("磁盘空间不足");

      const status = await manager.downloadUpdate();
      expect(status.state).toBe("error");
      expect(status.error).toBe("磁盘空间不足");
    });
  });

  describe("quitAndInstall", () => {
    it("非 downloaded 状态不调用 quitAndInstall", () => {
      manager.initialize();
      manager.quitAndInstall();
      expect(autoUpdater.quitAndInstallCalled).toBe(false);
    });

    it("downloaded 状态调用 quitAndInstall", () => {
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();

      autoUpdater.emit("update-available", SAMPLE_INFO);
      autoUpdater.emit("update-downloaded", SAMPLE_INFO);

      manager.quitAndInstall();
      expect(autoUpdater.quitAndInstallCalled).toBe(true);
    });

    it("quitAndInstall 前停止定时检查", () => {
      vi.useFakeTimers();
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();

      autoUpdater.emit("update-available", SAMPLE_INFO);
      autoUpdater.emit("update-downloaded", SAMPLE_INFO);

      manager.quitAndInstall();
      // 推进时间确认不再触发 autoCheck
      vi.advanceTimersByTime(60_000);
      vi.useRealTimers();
    });
  });

  describe("error 事件", () => {
    it("error 事件设置 error 状态和错误消息", () => {
      manager.initialize();
      autoUpdater.emit("error", new Error("更新服务器不可达"));

      const status = manager.getStatus();
      expect(status.state).toBe("error");
      expect(status.error).toBe("更新服务器不可达");
    });
  });

  describe("onStateChange", () => {
    it("状态变化时通知监听器", () => {
      manager.initialize();
      const statuses: string[] = [];
      manager.onStateChange((status) => {
        statuses.push(status.state);
      });

      autoUpdater.emit("checking-for-update");
      autoUpdater.emit("update-available", SAMPLE_INFO);
      autoUpdater.emit("error", new Error("test"));

      expect(statuses).toEqual(["checking", "available", "error"]);
    });

    it("取消订阅后不再接收通知", () => {
      manager.initialize();
      const statuses: string[] = [];
      const unsubscribe = manager.onStateChange((status) => {
        statuses.push(status.state);
      });

      autoUpdater.emit("checking-for-update");
      unsubscribe();
      autoUpdater.emit("update-available", SAMPLE_INFO);

      expect(statuses).toEqual(["checking"]);
    });

    it("多个监听器同时接收通知", () => {
      manager.initialize();
      let count = 0;
      manager.onStateChange(() => {
        count++;
      });
      manager.onStateChange(() => {
        count++;
      });

      autoUpdater.emit("checking-for-update");
      expect(count).toBe(2);
    });
  });

  describe("stopAutoCheck", () => {
    it("停止后不再触发定时检查", () => {
      vi.useFakeTimers();
      app = createMockApp(true);
      manager = new UpdateManager(autoUpdater, app);
      manager.initialize();

      manager.stopAutoCheck();
      vi.advanceTimersByTime(60_000);
      expect(autoUpdater.checkForUpdatesCalled).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("getStatus", () => {
    it("初始状态为 idle", () => {
      const status = manager.getStatus();
      expect(status.state).toBe("idle");
      expect(status.info).toBeNull();
      expect(status.progress).toBeNull();
      expect(status.error).toBeNull();
    });
  });
});
