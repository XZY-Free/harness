/**
 * V10 Phase 8：自动更新管理器。
 *
 * 包装 electron-updater 的 autoUpdater，实现：
 * - 启动后定时检查更新（每 4 小时）
 * - 手动检查更新（IPC 触发）
 * - 下载更新（IPC 触发 + 进度回报）
 * - 安装更新（退出时安装 quitAndInstall）
 * - 失败回报（error 事件推送 renderer）
 * - 取消下载
 *
 * 安全约束：
 * - 开发环境（!app.isPackaged）不自动检查更新，手动检查返回 idle
 * - 生产环境 electron-updater 自动验证更新包签名，未签名包拒绝安装
 * - 更新包通过 HTTPS 下载，不降级为 HTTP
 * - autoUpdater.autoDownload = false（用户手动确认下载）
 *
 * 依赖注入：AutoUpdaterLike 接口解耦 electron-updater，
 * 便于单元测试 mock。
 */
import type { App } from "electron";

/** electron-updater autoUpdater 需要的最小接口（依赖注入） */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(): Promise<string[]> | Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  removeAllListeners(event: string): void;
  on(event: "checking-for-update", listener: () => void): void;
  on(event: "update-available", listener: (info: UpdateInfo) => void): void;
  on(event: "update-not-available", listener: (info: UpdateInfo) => void): void;
  on(event: "download-progress", listener: (progress: UpdateProgress) => void): void;
  on(event: "update-downloaded", listener: (info: UpdateInfo) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

/** 更新检查结果 */
export interface UpdateCheckResult {
  updateInfo: UpdateInfo;
  downloadPromise?: Promise<string[]>;
}

/** 更新元数据 */
export interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | unknown;
}

/** 下载进度 */
export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

/** 更新器状态 */
export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "not_available"
  | "downloading"
  | "downloaded"
  | "error";

/** 推送给 renderer 的状态对象 */
export interface UpdateStatus {
  state: UpdateState;
  info: UpdateInfo | null;
  progress: UpdateProgress | null;
  error: string | null;
}

/** 自动检查间隔（4 小时） */
const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * 自动更新管理器。
 *
 * 管理更新检查、下载、安装和状态通知。
 * 通过 onStateChange 回调将状态变化推送给 renderer。
 */
export class UpdateManager {
  private readonly autoUpdater: AutoUpdaterLike;
  private readonly app: App;
  private readonly enabled: boolean;
  private state: UpdateState = "idle";
  private info: UpdateInfo | null = null;
  private progress: UpdateProgress | null = null;
  private errorMessage: string | null = null;
  private stateListeners: Array<(status: UpdateStatus) => void> = [];
  private autoCheckTimer: NodeJS.Timeout | null = null;

  constructor(autoUpdater: AutoUpdaterLike, app: App, enabled = true) {
    this.autoUpdater = autoUpdater;
    this.app = app;
    this.enabled = enabled;
  }

  /**
   * 初始化更新管理器。
   *
   * - 配置 autoUpdater（autoDownload = false，autoInstallOnAppQuit = true）
   * - 注册事件监听
   * - 生产环境启动定时检查
   */
  initialize(): void {
    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = true;

    this.registerListeners();

    // 生产环境自动检查更新
    if (this.enabled && this.app.isPackaged) {
      this.startAutoCheck();
    }
  }

  /** 注册 autoUpdater 事件监听 */
  private registerListeners(): void {
    this.autoUpdater.on("checking-for-update", () => {
      this.setState("checking");
    });

    this.autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.info = info;
      this.setState("available");
    });

    this.autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      this.info = info;
      this.setState("not_available");
    });

    this.autoUpdater.on("download-progress", (progress: UpdateProgress) => {
      this.progress = progress;
      this.setState("downloading");
    });

    this.autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      this.info = info;
      this.setState("downloaded");
    });

    this.autoUpdater.on("error", (error: Error) => {
      this.errorMessage = error.message;
      this.setState("error");
    });
  }

  /** 启动定时自动检查 */
  private startAutoCheck(): void {
    // 首次检查延迟 30 秒（避免启动时网络拥堵）
    this.autoCheckTimer = setTimeout(() => {
      void this.checkForUpdates();
      // 后续每 4 小时检查一次
      this.autoCheckTimer = setInterval(() => {
        void this.checkForUpdates();
      }, AUTO_CHECK_INTERVAL_MS);
    }, 30_000);
  }

  /** 停止定时自动检查 */
  stopAutoCheck(): void {
    if (this.autoCheckTimer) {
      clearTimeout(this.autoCheckTimer);
      clearInterval(this.autoCheckTimer);
      this.autoCheckTimer = null;
    }
  }

  /**
   * 手动检查更新。
   *
   * 开发环境返回 idle 状态，不调用 autoUpdater。
   *
   * @returns 更新状态
   */
  async checkForUpdates(): Promise<UpdateStatus> {
    // 开发环境不检查
    if (!this.enabled || !this.app.isPackaged) {
      return this.getStatus();
    }

    try {
      await this.autoUpdater.checkForUpdates();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.setState("error");
    }
    return this.getStatus();
  }

  /**
   * 下载更新。
   *
   * 仅在状态为 available 时允许下载。
   *
   * @returns 更新状态
   */
  async downloadUpdate(): Promise<UpdateStatus> {
    if (this.state !== "available") {
      return this.getStatus();
    }

    try {
      await this.autoUpdater.downloadUpdate();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.setState("error");
    }
    return this.getStatus();
  }

  /**
   * 退出并安装更新。
   *
   * 仅在状态为 downloaded 时允许安装。
   */
  quitAndInstall(): void {
    if (this.state !== "downloaded") {
      return;
    }

    this.stopAutoCheck();
    this.autoUpdater.quitAndInstall();
  }

  /** 获取当前状态 */
  getStatus(): UpdateStatus {
    return {
      state: this.state,
      info: this.info,
      progress: this.progress,
      error: this.errorMessage,
    };
  }

  /**
   * 订阅状态变化。
   *
   * @param callback 状态变化回调
   * @returns 取消订阅函数
   */
  onStateChange(callback: (status: UpdateStatus) => void): () => void {
    this.stateListeners.push(callback);
    return () => {
      this.stateListeners = this.stateListeners.filter((l) => l !== callback);
    };
  }

  /** 更新状态并通知监听器 */
  private setState(state: UpdateState): void {
    this.state = state;
    const status = this.getStatus();
    for (const listener of this.stateListeners) {
      listener(status);
    }
  }
}
