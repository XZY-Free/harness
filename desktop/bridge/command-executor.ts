/**
 * V10 Phase 6：命令执行器。
 *
 * 将 Server 发来的 RPC 命令分发到 BrowserController（通过 BrowserCommandTarget
 * 抽象接口），返回统一的 CommandResult。
 *
 * Phase 6 扩展：
 * - 读取类：getTabs, getPageMetadata, screenshot, snapshot, getAccessibilityTree,
 *   getConsole, getNetwork
 * - 操作类：navigate, click, doubleClick, type, press, select, scroll,
 *   newTab, closeTab, switchTab, reload, goBack, goForward, uploadWorkspaceFile
 *
 * 设计要点：
 * - 不直接依赖 BrowserController，便于单元测试（传入 mock target）
 * - 命令白名单由 lib/desktop/commands.ts 维护，本模块仅处理已知命令的分发
 * - 读取类命令通过 executeReadCommand 分发（同步）
 * - 操作类命令通过 executeActionCommand 分发（异步，可能需要 approval）
 * - 未知命令返回 unknown_command，payload 缺字段返回 rpc_invalid_payload
 */
import type { TabMetadata } from "../browser/tab-store";

/**
 * 命令执行结果。
 */
export interface CommandResult {
  ok: boolean;
  result?: unknown;
  code?: string;
  message?: string;
}

/**
 * 浏览器命令目标接口（读取能力）。
 *
 * 抽象 BrowserController 的读取能力，便于测试 mock。
 */
export interface BrowserCommandTarget {
  /** 获取 Thread 的所有 tab 元数据 */
  getTabs(threadId: string): TabMetadata[];
  /** 获取 Thread 的 active tab */
  getActiveTab(threadId: string): TabMetadata | null;
  /** 获取指定 tab 的 DebuggerSession（用于 CDP 命令） */
  getDebuggerSession?(threadId: string, tabId: string): unknown;
  /** 对指定 tab 截图，返回临时文件路径 */
  captureScreenshot?(threadId: string, tabId: string, format: string): Promise<string>;
  /** 列出 Thread 的浏览器下载记录（V10 Phase 7-1） */
  listDownloads?(threadId: string): unknown[];
  /** Phase 7-3：获取页面快照（结构化 DOM 摘要 + 可见文本） */
  getSnapshot?(
    threadId: string,
    tabId: string,
    maxTextLength?: number,
  ): Promise<{ text: string; domSummary: string } | null>;
  /** Phase 7-3：获取页面可访问性树 */
  getAccessibilityTree?(threadId: string, tabId: string): Promise<{ tree: unknown[] } | null>;
  /** Phase 7-3：获取缓冲的 Console 条目 */
  getConsoleEntries?(
    threadId: string,
    tabId: string,
    level?: "error" | "warning+",
    limit?: number,
  ): Promise<{ entries: unknown[] } | null>;
  /** Phase 7-3：获取缓冲的 Network 条目 */
  getNetworkEntries?(
    threadId: string,
    tabId: string,
    filter?: "failed" | "slow",
    limit?: number,
  ): Promise<{ entries: unknown[] } | null>;
}

/**
 * 浏览器命令目标接口（操作能力）。
 *
 * 抽象 BrowserController 的操作能力，便于测试 mock。
 */
export interface BrowserActionTarget {
  /** 导航 tab 到 URL */
  navigate(threadId: string, tabId: string, url: string): boolean;
  /** 关闭 tab */
  closeTab(threadId: string, tabId: string): boolean;
  /** 切换 active tab */
  switchTab(threadId: string, tabId: string): boolean;
  /** 创建新 tab */
  createTab(
    threadId: string,
    url: string,
    opts?: { incognito?: boolean; tabId?: string; activate?: boolean },
  ): TabMetadata | null;
  /** reload */
  reload(threadId: string, tabId: string): boolean;
  /** goBack */
  goBack(threadId: string, tabId: string): boolean;
  /** goForward */
  goForward(threadId: string, tabId: string): boolean;
  /** 在指定坐标点击 */
  click(threadId: string, tabId: string, x: number, y: number, button?: string): Promise<boolean>;
  /** 双击 */
  doubleClick(threadId: string, tabId: string, x: number, y: number): Promise<boolean>;
  /** 输入文本 */
  type(threadId: string, tabId: string, text: string, selector?: string): Promise<boolean>;
  /** 按键 */
  press(threadId: string, tabId: string, key: string): Promise<boolean>;
  /** 选择下拉选项 */
  select(
    threadId: string,
    tabId: string,
    selector: string,
    value?: string,
    label?: string,
  ): Promise<boolean>;
  /** 滚动 */
  scroll(threadId: string, tabId: string, deltaX: number, deltaY: number): Promise<boolean>;
  /** 上传工作区文件（Phase 7-2：接收 downloadUrl，下载到临时目录后交给 CDP） */
  uploadWorkspaceFile(
    threadId: string,
    tabId: string,
    selector: string,
    downloadUrl: string,
  ): Promise<boolean>;
}

/**
 * 执行读取类命令。
 *
 * 支持的命令：
 * - browser.getTabs → 返回 { tabs: TabMetadata[] }
 * - browser.getPageMetadata → 返回 { url, title, favicon, loadState, canGoBack, canGoForward }
 * - browser.screenshot → 返回 { path }（通过 captureScreenshot）
 * - browser.snapshot → 返回 { text, domSummary }（Phase 6 通过 DebuggerSession）
 * - browser.getAccessibilityTree → 返回 { tree }（Phase 6 通过 DebuggerSession）
 * - browser.getConsole → 返回 { entries }（Phase 6 通过 DebuggerSession）
 * - browser.getNetwork → 返回 { entries }（Phase 6 通过 DebuggerSession）
 * - browser.listDownloads → 返回 { downloads }（Phase 7-1）
 */
export async function executeReadCommand(params: {
  target: BrowserCommandTarget;
  command: string;
  payload: unknown;
  threadId: string;
}): Promise<CommandResult> {
  const { target, command, payload, threadId } = params;

  switch (command) {
    case "browser.getTabs": {
      const tabs = target.getTabs(threadId);
      const active = target.getActiveTab(threadId);
      return { ok: true, result: { tabs, activeTabId: active?.id ?? null } };
    }

    case "browser.getPageMetadata": {
      const tabId = extractTabId(payload);
      if (tabId === null) {
        return {
          ok: false,
          code: "rpc_invalid_payload",
          message: "缺少 tabId",
        };
      }
      const tabs = target.getTabs(threadId);
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) {
        return {
          ok: false,
          code: "tab_not_found",
          message: `tab ${tabId} 不存在`,
        };
      }
      return {
        ok: true,
        result: {
          url: tab.url,
          title: tab.title,
          favicon: tab.favicon,
          loadState: tab.loadState,
          canGoBack: tab.canGoBack,
          canGoForward: tab.canGoForward,
        },
      };
    }

    case "browser.screenshot": {
      const tabId = extractTabId(payload);
      if (tabId === null) {
        return {
          ok: false,
          code: "rpc_invalid_payload",
          message: "缺少 tabId",
        };
      }
      const format = extractFormat(payload);
      if (!target.captureScreenshot) {
        return {
          ok: false,
          code: "browser_internal",
          message: "captureScreenshot 不可用",
        };
      }
      try {
        const path = await target.captureScreenshot(threadId, tabId, format);
        return { ok: true, result: { path } };
      } catch (e) {
        return {
          ok: false,
          code: "browser_internal",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "browser.snapshot": {
      if (!target.getSnapshot) {
        return {
          ok: false,
          code: "browser_internal",
          message: "getSnapshot 不可用",
        };
      }
      const tabId = extractTabId(payload);
      if (tabId === null) {
        return {
          ok: false,
          code: "rpc_invalid_payload",
          message: "缺少 tabId",
        };
      }
      const maxTextLength = extractNumber((payload as Record<string, unknown>)?.maxTextLength);
      try {
        const result = await target.getSnapshot(threadId, tabId, maxTextLength ?? undefined);
        if (result === null) {
          return {
            ok: false,
            code: "tab_not_found",
            message: `tab ${tabId} 不存在或无法 attach DebuggerSession`,
          };
        }
        return { ok: true, result };
      } catch (e) {
        return {
          ok: false,
          code: "browser_internal",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "browser.getAccessibilityTree": {
      if (!target.getAccessibilityTree) {
        return {
          ok: false,
          code: "browser_internal",
          message: "getAccessibilityTree 不可用",
        };
      }
      const tabId = extractTabId(payload);
      if (tabId === null) {
        return {
          ok: false,
          code: "rpc_invalid_payload",
          message: "缺少 tabId",
        };
      }
      try {
        const result = await target.getAccessibilityTree(threadId, tabId);
        if (result === null) {
          return {
            ok: false,
            code: "tab_not_found",
            message: `tab ${tabId} 不存在或无法 attach DebuggerSession`,
          };
        }
        return { ok: true, result };
      } catch (e) {
        return {
          ok: false,
          code: "browser_internal",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "browser.getConsole": {
      if (!target.getConsoleEntries) {
        return {
          ok: false,
          code: "browser_internal",
          message: "getConsoleEntries 不可用",
        };
      }
      const tabId = extractTabId(payload);
      if (tabId === null) {
        return {
          ok: false,
          code: "rpc_invalid_payload",
          message: "缺少 tabId",
        };
      }
      const level = extractString((payload as Record<string, unknown>)?.level) as
        | "error"
        | "warning+"
        | null;
      const limit = extractNumber((payload as Record<string, unknown>)?.limit);
      try {
        const result = await target.getConsoleEntries(
          threadId,
          tabId,
          level ?? undefined,
          limit ?? undefined,
        );
        if (result === null) {
          return {
            ok: false,
            code: "tab_not_found",
            message: `tab ${tabId} 不存在或无法 attach DebuggerSession`,
          };
        }
        return { ok: true, result };
      } catch (e) {
        return {
          ok: false,
          code: "browser_internal",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "browser.getNetwork": {
      if (!target.getNetworkEntries) {
        return {
          ok: false,
          code: "browser_internal",
          message: "getNetworkEntries 不可用",
        };
      }
      const tabId = extractTabId(payload);
      if (tabId === null) {
        return {
          ok: false,
          code: "rpc_invalid_payload",
          message: "缺少 tabId",
        };
      }
      const filter = extractString((payload as Record<string, unknown>)?.filter) as
        | "failed"
        | "slow"
        | null;
      const limit = extractNumber((payload as Record<string, unknown>)?.limit);
      try {
        const result = await target.getNetworkEntries(
          threadId,
          tabId,
          filter ?? undefined,
          limit ?? undefined,
        );
        if (result === null) {
          return {
            ok: false,
            code: "tab_not_found",
            message: `tab ${tabId} 不存在或无法 attach DebuggerSession`,
          };
        }
        return { ok: true, result };
      } catch (e) {
        return {
          ok: false,
          code: "browser_internal",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "browser.listDownloads": {
      if (!target.listDownloads) {
        return {
          ok: false,
          code: "browser_internal",
          message: "listDownloads 不可用",
        };
      }
      const downloads = target.listDownloads(threadId);
      return { ok: true, result: { downloads } };
    }

    default: {
      return {
        ok: false,
        code: "unknown_command",
        message: `未知命令：${command}`,
      };
    }
  }
}

/**
 * 执行操作类命令。
 *
 * 支持的命令：
 * - browser.navigate → 导航到 URL
 * - browser.click → 点击坐标
 * - browser.doubleClick → 双击坐标
 * - browser.type → 输入文本
 * - browser.press → 按键
 * - browser.select → 选择下拉选项
 * - browser.scroll → 滚动
 * - browser.newTab → 创建新 tab
 * - browser.closeTab → 关闭 tab
 * - browser.switchTab → 切换 tab
 * - browser.reload → 重新加载
 * - browser.goBack → 后退
 * - browser.goForward → 前进
 * - browser.uploadWorkspaceFile → 上传工作区文件
 */
export async function executeActionCommand(params: {
  target: BrowserActionTarget;
  command: string;
  payload: unknown;
  threadId: string;
}): Promise<CommandResult> {
  const { target, command, payload, threadId } = params;
  const p = (payload ?? {}) as Record<string, unknown>;

  switch (command) {
    case "browser.navigate": {
      const tabId = extractString(p.tabId);
      const url = extractString(p.url);
      if (!tabId || !url) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 tabId 或 url" };
      }
      const success = target.navigate(threadId, tabId, url);
      return { ok: success, code: success ? undefined : "browser_internal" };
    }

    case "browser.click": {
      const tabId = extractString(p.tabId);
      const x = extractNumber(p.x);
      const y = extractNumber(p.y);
      if (!tabId || x === null || y === null) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 tabId/x/y" };
      }
      const button = extractString(p.button);
      const success = await target.click(threadId, tabId, x, y, button ?? "left");
      return { ok: success, code: success ? undefined : "browser_internal" };
    }

    case "browser.doubleClick": {
      const tabId = extractString(p.tabId);
      const x = extractNumber(p.x);
      const y = extractNumber(p.y);
      if (!tabId || x === null || y === null) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 tabId/x/y" };
      }
      const success = await target.doubleClick(threadId, tabId, x, y);
      return { ok: success, code: success ? undefined : "browser_internal" };
    }

    case "browser.type": {
      const tabId = extractString(p.tabId);
      const text = extractString(p.text);
      if (!tabId || text === null) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 tabId 或 text" };
      }
      const selector = extractString(p.selector) ?? undefined;
      const success = await target.type(threadId, tabId, text, selector);
      return { ok: success, code: success ? undefined : "browser_internal" };
    }

    case "browser.press": {
      const tabId = extractString(p.tabId);
      const key = extractString(p.key);
      if (!tabId || !key) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 tabId 或 key" };
      }
      const success = await target.press(threadId, tabId, key);
      return { ok: success, code: success ? undefined : "browser_internal" };
    }

    case "browser.select": {
      const tabId = extractString(p.tabId);
      const selector = extractString(p.selector);
      if (!tabId || !selector) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 tabId 或 selector" };
      }
      const value = extractString(p.value) ?? undefined;
      const label = extractString(p.label) ?? undefined;
      const success = await target.select(threadId, tabId, selector, value, label);
      return { ok: success, code: success ? undefined : "browser_internal" };
    }

    case "browser.scroll": {
      const tabId = extractString(p.tabId);
      const deltaX = extractNumber(p.deltaX);
      const deltaY = extractNumber(p.deltaY);
      if (!tabId || deltaX === null || deltaY === null) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 tabId/deltaX/deltaY" };
      }
      const success = await target.scroll(threadId, tabId, deltaX, deltaY);
      return { ok: success, code: success ? undefined : "browser_internal" };
    }

    case "browser.newTab": {
      const url = extractString(p.url);
      if (!url) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 url" };
      }
      const tab = target.createTab(threadId, url, { activate: true });
      if (!tab) {
        return { ok: false, code: "browser_internal", message: "创建 tab 失败" };
      }
      return { ok: true, result: { tabId: tab.id, url: tab.url } };
    }

    case "browser.closeTab": {
      const tabId = extractString(p.tabId);
      if (!tabId) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 tabId" };
      }
      const success = target.closeTab(threadId, tabId);
      return { ok: success, code: success ? undefined : "tab_not_found" };
    }

    case "browser.switchTab": {
      const tabId = extractString(p.tabId);
      if (!tabId) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 tabId" };
      }
      const success = target.switchTab(threadId, tabId);
      return { ok: success, code: success ? undefined : "tab_not_found" };
    }

    case "browser.reload": {
      const tabId = extractString(p.tabId);
      if (!tabId) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 tabId" };
      }
      const success = target.reload(threadId, tabId);
      return { ok: success, code: success ? undefined : "tab_not_found" };
    }

    case "browser.goBack": {
      const tabId = extractString(p.tabId);
      if (!tabId) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 tabId" };
      }
      const success = target.goBack(threadId, tabId);
      return { ok: success, code: success ? undefined : "tab_not_found" };
    }

    case "browser.goForward": {
      const tabId = extractString(p.tabId);
      if (!tabId) {
        return { ok: false, code: "rpc_invalid_payload", message: "缺少 tabId" };
      }
      const success = target.goForward(threadId, tabId);
      return { ok: success, code: success ? undefined : "tab_not_found" };
    }

    case "browser.uploadWorkspaceFile": {
      const tabId = extractString(p.tabId);
      const selector = extractString(p.selector);
      const downloadUrl = extractString(p.downloadUrl);
      if (!tabId || !selector || !downloadUrl) {
        return {
          ok: false,
          code: "rpc_invalid_payload",
          message: "缺少 tabId/selector/downloadUrl",
        };
      }
      const success = await target.uploadWorkspaceFile(threadId, tabId, selector, downloadUrl);
      return { ok: success, code: success ? undefined : "browser_internal" };
    }

    default: {
      return {
        ok: false,
        code: "unknown_command",
        message: `未知命令：${command}`,
      };
    }
  }
}

/**
 * 从 payload 中提取非空 tabId。
 */
function extractTabId(payload: unknown): string | null {
  return extractString((payload as Record<string, unknown>)?.tabId);
}

/**
 * 从 payload 中提取 format（默认 png）。
 */
function extractFormat(payload: unknown): string {
  const format = (payload as Record<string, unknown>)?.format;
  return format === "jpeg" ? "jpeg" : "png";
}

/**
 * 提取字符串值，空或非字符串返回 null。
 */
function extractString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

/**
 * 提取数值，非数值返回 null。
 */
function extractNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}
