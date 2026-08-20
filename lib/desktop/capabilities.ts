/**
 * Desktop preload capability schema 和 IPC channel 定义。
 *
 * Desktop Electron 的 preload 脚本注入 `globalThis.__SNOW_DESKTOP__` 包含 capability
 * 信息。renderer 通过 `getDesktopCapabilities()` 读取后验证来源，才挂载 DesktopBrowserSurface。
 *
 * 普通浏览器（Web 端）不注入此标识，`getDesktopCapabilities()` 返回 null，
 * `/desktop` 路由显示"需要 SnowHarness Desktop"提示页。
 *
 * 安全约束：
 * - capability 只能由受信任 preload 脚本注入，不可通过 URL 参数或 localStorage 伪造。
 * - preload 脚本由 Electron 主进程加载，外部网站不加载 preload（WebContentsView 无 preload）。
 * - IPC channel 使用 allowlisted 白名单，preload 只暴露最小 API。
 */

/**
 * Desktop capability 版本。schema 不兼容时递增。
 */
export const DESKTOP_CAPABILITY_VERSION = 1 as const;

/**
 * IPC channel 白名单。preload 只暴露这些 channel。
 *
 * 应用生命周期和窗口控制、Browser tab 操作（create/close/switch/navigate/setBounds/getTabs）、
 * Agent Bridge、本地任务操作等 channel 全部在此登记。
 */
export const DESKTOP_IPC_CHANNELS = [
  /** renderer → main：获取 capability handshake */
  "desktop:getCapabilities",
  /** renderer → main：获取当前 Desktop 版本和 Server origin */
  "desktop:getInfo",
  /** renderer → main：在系统默认浏览器打开外部链接 */
  "desktop:openExternal",
  /** renderer → main：获取窗口是否聚焦 */
  "desktop:isFocused",
  /** renderer → main：获取当前窗口原生全屏状态 */
  "desktop:window:getFrameState",
  /** renderer → main：获取设备绑定所需的本机公钥信息 */
  "desktop:device:getRegistration",
  /** renderer → main：发起设备注册（main 用 Electron Session fetch 同源注册端点） */
  "desktop:device:register",
  /** renderer → main：创建 browser tab */
  "desktop:browser:createTab",
  /** renderer → main：关闭 browser tab */
  "desktop:browser:closeTab",
  /** renderer → main：切换 active tab */
  "desktop:browser:switchTab",
  /** renderer → main：重排 tabs */
  "desktop:browser:reorderTabs",
  /** renderer → main：导航操作（navigate/back/forward/reload/stop） */
  "desktop:browser:navigate",
  /** renderer → main：设置 view bounds（resize） */
  "desktop:browser:setBounds",
  /** renderer → main：获取 Thread 的所有 tab 元数据 */
  "desktop:browser:getTabs",
  /** renderer → main：获取 active tab */
  "desktop:browser:getActiveTab",
  /** renderer → main：隐藏 Thread 的所有 views */
  "desktop:browser:hideViews",
  /** renderer → main：订阅 tab 变更事件 */
  "desktop:browser:subscribe",
  /** renderer → main：从本地 SQLite 惰性恢复 Thread tabs */
  "desktop:browser:restoreTabs",
  /** renderer → main：读取/订阅 AI 输入锁并请求接管 */
  "desktop:browser:getLockState",
  "desktop:browser:subscribeLockState",
  "desktop:browser:cancelAi",
  /** renderer → main：获取 Agent Bridge 连接状态 */
  "desktop:bridge:getState",
  /** renderer → main：连接到 Agent Bridge Server */
  "desktop:bridge:connect",
  /** renderer → main：断开 Agent Bridge 连接 */
  "desktop:bridge:disconnect",
  /** renderer → main：订阅 Agent Bridge 状态变化 */
  "desktop:bridge:onStateChange",
  /** renderer → main：退出登录（清除本地身份 + Browser Profile + 断开 Bridge） */
  "desktop:auth:logout",
  /** renderer → main：检查更新 */
  "desktop:updater:checkForUpdates",
  /** renderer → main：下载更新 */
  "desktop:updater:downloadUpdate",
  /** renderer → main：退出并安装更新 */
  "desktop:updater:quitAndInstall",
  /** renderer → main：获取更新状态 */
  "desktop:updater:getState",
  /** renderer → main：订阅更新状态变化 */
  "desktop:updater:onStateChange",
  // ─── 本地任务操作 channel ──────────────────────
  /** renderer → main：执行 Shell 命令（白名单 + 工作目录限制） */
  "desktop:shell:exec",
  /** renderer → main：读取文件（路径白名单内） */
  "desktop:file:read",
  /** renderer → main：写入文件（路径白名单内 + 高影响确认） */
  "desktop:file:write",
  /** renderer → main：列出目录内容 */
  "desktop:file:list",
  /** renderer → main：Git 状态 */
  "desktop:git:status",
  /** renderer → main：Git diff（工作区或指定文件） */
  "desktop:git:diff",
  /** renderer → main：Git log（最近 N 条） */
  "desktop:git:log",
  /** renderer → main：打开本机应用（白名单 bundleId/appPath） */
  "desktop:app:open",
  /** renderer → main：执行构建命令（make/gradle/npm run build 等） */
  "desktop:build:run",
  /** renderer → main：执行测试命令（pytest/jest/vitest 等） */
  "desktop:test:run",
] as const;

export type DesktopIpcChannel = (typeof DESKTOP_IPC_CHANNELS)[number];

/**
 * Desktop capability 结构。由 preload 注入到 `globalThis.__SNOW_DESKTOP__`。
 */
export interface DesktopCapabilities {
  /** Capability schema 版本 */
  version: typeof DESKTOP_CAPABILITY_VERSION;
  /** 受信任 SnowHarness Server origin（如 https://snow.example.com） */
  serverOrigin: string;
  /** Desktop 应用版本（从 package.json 读取） */
  appVersion: string;
  /** 允许的 IPC channel 列表 */
  ipcChannels: readonly DesktopIpcChannel[];
  /** 设备 ID（设备绑定后填充，为 null） */
  deviceId: string | null;
  /**
   * 是否允许非 localhost 的 http origin（连接远程 http 部署时显式开启）。
   *
   * 默认 false：仅允许 https 或 http://localhost|127.0.0.1（生产安全默认）。
   * preload 从环境变量 SNOW_ALLOW_INSECURE_REMOTE_ORIGIN 读取注入。
   * renderer 校验时通过此 flag 放行公网 http origin（capability 由 preload 在
   * contextIsolation 下注入，renderer 无法伪造）。
   */
  allowInsecureRemoteOrigin?: boolean;
}

export interface DesktopTabMetadata {
  id: string;
  threadId: string;
  url: string;
  title: string;
  favicon: string | null;
  loadState: "idle" | "loading" | "loaded" | "crashed" | "error";
  canGoBack: boolean;
  canGoForward: boolean;
  incognito: boolean;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}

export interface DesktopBrowserStateUpdate {
  threadId: string;
  tabs: DesktopTabMetadata[];
  activeTab: DesktopTabMetadata | null;
}

/**
 * 设备注册请求体（由主进程用本机身份构造，POST 到 Server 注册端点）。
 *
 * 请求体不携带 tenantId——Server 从认证主体解析租户；响应的 tenantId 由主进程
 * 校验后回填本地身份。local 额外保留 tenantId 供 renderer 读取注册状态。
 */
export interface DesktopDeviceRegistrationPayload {
  deviceId: string;
  publicKey: string;
  name: string;
  version: string;
  /**
   * 设备所属租户。来自 Server 注册响应（非本地默认）。
   * 未注册为 null，此时无法建立认证连接。
   */
  tenantId: string | null;
}

/** 设备注册结果（renderer 可见）。 */
export interface DesktopDeviceRegisterResult {
  ok: boolean;
  tenantId?: string;
  code?: string;
  message?: string;
}

// ─── 本地任务操作类型 ──────────────────────────────

/** Desktop 操作类别（与 DesktopOperationCategory 一致）。 */
export type DesktopOperationCategory =
  | "shell"
  | "git"
  | "file"
  | "browser"
  | "app"
  | "build"
  | "test";

/**
 * 本地操作执行结果。
 *
 * 所有 shell/git/file/app/build/test 命名空间的方法统一返回此结构，
 * 主进程负责填充 device_id/cwd/exit_code/stdout/stderr/duration_ms 等字段，
 * 并对 stdout/stderr 进行脱敏（移除 Secret、绝对路径中的用户名等）。
 *
 * 高影响操作（如 file:write、build:run、test:run 触发外部副作用）会先通过
 * UserAction 流程请求员工确认；此时 exit_code 为 null、requires_confirmation=true、
 * user_action_request_id 非空。
 */
export interface DesktopOperationResult {
  /** 操作类别。 */
  readonly category: DesktopOperationCategory;
  /** 操作名称（如 "git status"、"shell.exec"）。 */
  readonly operation: string;
  /** 执行设备 id（来自 capability.deviceId）。 */
  readonly device_id: string;
  /** 工作目录（可选）。 */
  readonly cwd: string | null;
  /** 退出码（0 表示成功；非 0 表示失败；null 表示未捕获或需要确认）。 */
  readonly exit_code: number | null;
  /** 标准输出（已脱敏）。 */
  readonly stdout: string;
  /** 标准错误（已脱敏）。 */
  readonly stderr: string;
  /** 执行时长（毫秒）。 */
  readonly duration_ms: number;
  /** 是否需要 UserAction 确认（高影响操作）。 */
  readonly requires_confirmation: boolean;
  /** 已触发的 UserAction request_id（如有）。 */
  readonly user_action_request_id: string | null;
  /** 完成时间（ISO 8601）。 */
  readonly completed_at: string;
}

/** shell:exec 参数。 */
export interface DesktopShellExecParams {
  readonly threadId: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** file:read 参数。 */
export interface DesktopFileReadParams {
  readonly threadId: string;
  readonly path: string;
  readonly encoding?: "utf8" | "base64";
}

/** file:write 参数（高影响，需要 UserAction 确认）。 */
export interface DesktopFileWriteParams {
  readonly threadId: string;
  readonly path: string;
  readonly content: string;
  readonly encoding?: "utf8" | "base64";
}

/** file:list 参数。 */
export interface DesktopFileListParams {
  readonly threadId: string;
  readonly path: string;
}

/** git:status 参数。 */
export interface DesktopGitStatusParams {
  readonly threadId: string;
  readonly cwd: string;
}

/** git:diff 参数。 */
export interface DesktopGitDiffParams {
  readonly threadId: string;
  readonly cwd: string;
  readonly path?: string;
  readonly staged?: boolean;
}

/** git:log 参数。 */
export interface DesktopGitLogParams {
  readonly threadId: string;
  readonly cwd: string;
  readonly limit?: number;
}

/** app:open 参数。 */
export interface DesktopAppOpenParams {
  readonly threadId: string;
  /** bundleId（macOS）或 appPath（其他平台）或 URL scheme。 */
  readonly target: string;
  readonly args?: readonly string[];
}

/** build:run 参数（高影响）。 */
export interface DesktopBuildRunParams {
  readonly threadId: string;
  readonly cwd: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

/** test:run 参数。 */
export interface DesktopTestRunParams {
  readonly threadId: string;
  readonly cwd: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

/**
 * 本地任务操作桥（可选命名空间）。
 *
 * 旧 preload 若未注入这些命名空间，对应字段为 undefined；
 * use-desktop-operations Hook 在调用前需检查存在性，并降级为"当前 Desktop 不支持此操作"。
 */
export interface DesktopOperationsBridge {
  shell: {
    exec(params: DesktopShellExecParams): Promise<DesktopOperationResult>;
  };
  file: {
    read(params: DesktopFileReadParams): Promise<DesktopOperationResult>;
    write(params: DesktopFileWriteParams): Promise<DesktopOperationResult>;
    list(params: DesktopFileListParams): Promise<DesktopOperationResult>;
  };
  git: {
    status(params: DesktopGitStatusParams): Promise<DesktopOperationResult>;
    diff(params: DesktopGitDiffParams): Promise<DesktopOperationResult>;
    log(params: DesktopGitLogParams): Promise<DesktopOperationResult>;
  };
  app: {
    open(params: DesktopAppOpenParams): Promise<DesktopOperationResult>;
  };
  build: {
    run(params: DesktopBuildRunParams): Promise<DesktopOperationResult>;
  };
  test: {
    run(params: DesktopTestRunParams): Promise<DesktopOperationResult>;
  };
}

export interface DesktopRendererBridge {
  capabilities: DesktopCapabilities;
  getCapabilities(): Promise<DesktopCapabilities>;
  openExternal(url: string): Promise<void>;
  isFocused(): Promise<boolean>;
  windowControls: {
    getFrameState(): Promise<DesktopWindowFrameState>;
    onFrameStateChange(callback: (state: DesktopWindowFrameState) => void): () => void;
  };
  device: {
    getRegistration(): Promise<DesktopDeviceRegistrationPayload>;
    register(): Promise<DesktopDeviceRegisterResult>;
  };
  bridge: {
    getState(): Promise<string>;
    connect(): Promise<boolean>;
    disconnect(): Promise<boolean>;
    onStateChange(callback: (state: string) => void): () => void;
  };
  browser: {
    createTab(
      threadId: string,
      url: string,
      userId: string,
      opts?: { incognito?: boolean; tabId?: string; activate?: boolean },
    ): Promise<DesktopTabMetadata>;
    closeTab(threadId: string, tabId: string): Promise<DesktopTabMetadata | null>;
    switchTab(threadId: string, tabId: string): Promise<boolean>;
    reorderTabs(threadId: string, tabIds: string[]): Promise<boolean>;
    navigate(threadId: string, tabId: string, action: unknown): Promise<boolean>;
    setBounds(
      threadId: string,
      tabId: string,
      bounds: { x: number; y: number; width: number; height: number },
      scaleFactor: number,
    ): Promise<boolean>;
    getTabs(threadId: string): Promise<DesktopTabMetadata[]>;
    getActiveTab(threadId: string): Promise<DesktopTabMetadata | null>;
    hideViews(threadId: string): Promise<boolean>;
    subscribe(threadId: string): Promise<boolean>;
    restoreTabs(threadId: string, userId: string): Promise<boolean>;
    getLockState(threadId: string): Promise<boolean>;
    cancelAi(threadId: string): Promise<boolean>;
    onLockStateChange(callback: (data: { threadId: string; locked: boolean }) => void): () => void;
    onTabUpdate(callback: (data: DesktopBrowserStateUpdate) => void): () => void;
  };
  /**
   * 本地任务操作命名空间。
   *
   * 可选：旧 preload 未注入时为 undefined。调用方需先检查存在性。
   */
  shell?: DesktopOperationsBridge["shell"];
  file?: DesktopOperationsBridge["file"];
  git?: DesktopOperationsBridge["git"];
  app?: DesktopOperationsBridge["app"];
  build?: DesktopOperationsBridge["build"];
  test?: DesktopOperationsBridge["test"];
}

export interface DesktopWindowFrameState {
  readonly isFullScreen: boolean;
}

/**
 * 从 globalThis 读取 Desktop capability。
 *
 * 返回 null 表示当前不在 Desktop Electron 环境中（普通浏览器 / SSR）。
 * 返回对象时需进一步校验 version 和 serverOrigin。
 */
export function getDesktopCapabilities(): DesktopCapabilities | null {
  const bridge = (globalThis as unknown as { snowDesktop?: { capabilities?: unknown } })
    .snowDesktop;
  const cap = bridge?.capabilities;
  if (!isValidDesktopCapabilities(cap)) {
    return null;
  }
  return cap;
}

export function getDesktopBridge(): DesktopRendererBridge | null {
  const bridge = (globalThis as unknown as { snowDesktop?: unknown }).snowDesktop;
  if (typeof bridge !== "object" || bridge === null) return null;
  const candidate = bridge as Partial<DesktopRendererBridge>;
  if (!isValidDesktopCapabilities(candidate.capabilities)) return null;
  if (typeof candidate.browser !== "object" || candidate.browser === null) return null;
  if (typeof candidate.device !== "object" || candidate.device === null) return null;
  if (typeof candidate.bridge !== "object" || candidate.bridge === null) return null;
  return candidate as DesktopRendererBridge;
}

/**
 * 校验值是否为合法 DesktopCapabilities。
 *
 * 防止恶意脚本通过注入假 `__SNOW_DESKTOP__` 伪造 Desktop 环境：
 * - 必须是对象
 * - version 必须等于当前 schema 版本
 * - serverOrigin 必须是 https URL（本地开发允许 http://localhost）
 * - appVersion 必须是非空字符串
 * - ipcChannels 必须是白名单子集
 * - deviceId 必须是 string | null
 */
export function isValidDesktopCapabilities(value: unknown): value is DesktopCapabilities {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.version !== DESKTOP_CAPABILITY_VERSION) {
    return false;
  }
  if (
    typeof v.serverOrigin !== "string" ||
    !isAllowedOrigin(v.serverOrigin, v.allowInsecureRemoteOrigin === true)
  ) {
    return false;
  }
  if (typeof v.appVersion !== "string" || v.appVersion.length === 0) {
    return false;
  }
  if (!Array.isArray(v.ipcChannels)) {
    return false;
  }
  const validChannels = new Set<string>(DESKTOP_IPC_CHANNELS);
  for (const ch of v.ipcChannels) {
    if (typeof ch !== "string" || !validChannels.has(ch)) {
      return false;
    }
  }
  if (v.deviceId !== null && typeof v.deviceId !== "string") {
    return false;
  }
  return true;
}

/**
 * 校验 origin 是否为允许的 Server origin。
 *
 * 允许：
 * - https://<domain>（生产环境）
 * - http://localhost:<port>（本地开发）
 * - http://127.0.0.1:<port>（本地开发）
 * - http://<任意 host>（仅当 allowInsecureRemote=true，连接远程 http 部署时显式开启）
 *
 * 不允许：
 * - file://、data:、blob: 等非 http(s) 协议
 * - http://<非 localhost>（默认，生产环境不允许 http）
 */
export function isAllowedOrigin(origin: string, allowInsecureRemote = false): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol === "https:") {
      return true;
    }
    if (url.protocol === "http:") {
      const host = url.hostname;
      if (host === "localhost" || host === "127.0.0.1") {
        return true;
      }
      // 显式 opt-in 放行公网 http（如连接远程 http 部署的服务器）
      return allowInsecureRemote;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 判断当前环境是否为 Desktop Electron。
 */
export function isDesktop(): boolean {
  return getDesktopCapabilities() !== null;
}
