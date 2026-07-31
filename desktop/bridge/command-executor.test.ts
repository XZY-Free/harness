import { describe, expect, it, vi } from "vitest";
import type { TabMetadata } from "../browser/tab-store";
import type { BrowserActionTarget, BrowserCommandTarget } from "./command-executor";
import { executeActionCommand, executeReadCommand } from "./command-executor";

/**
 * V10 Phase 6：命令执行器单元测试。
 *
 * 验证 executeReadCommand 和 executeActionCommand 的命令分发逻辑：
 *
 * 读取类（executeReadCommand）：
 * - browser.getTabs：返回 tab 列表
 * - browser.getPageMetadata：需要 tabId，返回指定 tab 元数据
 * - browser.screenshot：通过 captureScreenshot 返回 { path }
 * - browser.snapshot/getAccessibilityTree/getConsole/getNetwork：通过 DebuggerSession
 *
 * 操作类（executeActionCommand）：
 * - browser.navigate/click/doubleClick/type/press/select/scroll
 * - browser.newTab/closeTab/switchTab/reload/goBack/goForward/uploadWorkspaceFile
 *
 * 使用内存 BrowserCommandTarget/BrowserActionTarget mock，不依赖 electron。
 */

/** 构造测试用 TabMetadata */
function makeTab(overrides: Partial<TabMetadata> = {}): TabMetadata {
  return {
    id: "tab-1",
    threadId: "thread-1",
    url: "https://example.com",
    title: "示例页面",
    favicon: "https://example.com/favicon.ico",
    loadState: "loaded",
    canGoBack: false,
    canGoForward: false,
    incognito: false,
    createdAt: 1000,
    updatedAt: 2000,
    error: null,
    ...overrides,
  };
}

/** 内存 BrowserCommandTarget，便于控制返回数据 */
class MemoryCommandTarget implements BrowserCommandTarget {
  private tabsByThread = new Map<string, TabMetadata[]>();
  private activeByThread = new Map<string, TabMetadata | null>();
  private debuggerSessions = new Map<string, unknown>();
  captureScreenshot?: (threadId: string, tabId: string, format: string) => Promise<string>;
  // Phase 7-3：CDP 读取方法（可被测试覆写）
  getSnapshot?: (
    threadId: string,
    tabId: string,
    maxTextLength?: number,
  ) => Promise<{ text: string; domSummary: string } | null>;
  getAccessibilityTree?: (threadId: string, tabId: string) => Promise<{ tree: unknown[] } | null>;
  getConsoleEntries?: (
    threadId: string,
    tabId: string,
    level?: "error" | "warning+",
    limit?: number,
  ) => Promise<{ entries: unknown[] } | null>;
  getNetworkEntries?: (
    threadId: string,
    tabId: string,
    filter?: "failed" | "slow",
    limit?: number,
  ) => Promise<{ entries: unknown[] } | null>;

  setTabs(threadId: string, tabs: TabMetadata[]): void {
    this.tabsByThread.set(threadId, tabs);
  }

  setActive(threadId: string, tab: TabMetadata | null): void {
    this.activeByThread.set(threadId, tab);
  }

  setDebuggerSession(threadId: string, tabId: string, session: unknown): void {
    this.debuggerSessions.set(`${threadId}:${tabId}`, session);
  }

  setCaptureScreenshot(
    fn: (threadId: string, tabId: string, format: string) => Promise<string>,
  ): void {
    this.captureScreenshot = fn;
  }

  /** Phase 7-3：设置 getSnapshot mock */
  setGetSnapshot(
    fn: (
      threadId: string,
      tabId: string,
      maxTextLength?: number,
    ) => Promise<{ text: string; domSummary: string } | null>,
  ): void {
    this.getSnapshot = fn;
  }

  /** Phase 7-3：设置 getAccessibilityTree mock */
  setGetAccessibilityTree(
    fn: (threadId: string, tabId: string) => Promise<{ tree: unknown[] } | null>,
  ): void {
    this.getAccessibilityTree = fn;
  }

  /** Phase 7-3：设置 getConsoleEntries mock */
  setGetConsoleEntries(
    fn: (
      threadId: string,
      tabId: string,
      level?: "error" | "warning+",
      limit?: number,
    ) => Promise<{ entries: unknown[] } | null>,
  ): void {
    this.getConsoleEntries = fn;
  }

  /** Phase 7-3：设置 getNetworkEntries mock */
  setGetNetworkEntries(
    fn: (
      threadId: string,
      tabId: string,
      filter?: "failed" | "slow",
      limit?: number,
    ) => Promise<{ entries: unknown[] } | null>,
  ): void {
    this.getNetworkEntries = fn;
  }

  getTabs(threadId: string): TabMetadata[] {
    return this.tabsByThread.get(threadId) ?? [];
  }

  getActiveTab(threadId: string): TabMetadata | null {
    return this.activeByThread.get(threadId) ?? null;
  }

  getDebuggerSession(threadId: string, tabId: string): unknown {
    return this.debuggerSessions.get(`${threadId}:${tabId}`) ?? null;
  }
}

/** 内存 BrowserActionTarget，记录调用参数并控制返回值 */
class MemoryActionTarget implements BrowserActionTarget {
  // 调用记录
  navigateCalls: Array<{ threadId: string; tabId: string; url: string }> = [];
  closeTabCalls: Array<{ threadId: string; tabId: string }> = [];
  switchTabCalls: Array<{ threadId: string; tabId: string }> = [];
  createTabCalls: Array<{
    threadId: string;
    url: string;
    opts?: { incognito?: boolean; tabId?: string; activate?: boolean };
  }> = [];
  reloadCalls: Array<{ threadId: string; tabId: string }> = [];
  goBackCalls: Array<{ threadId: string; tabId: string }> = [];
  goForwardCalls: Array<{ threadId: string; tabId: string }> = [];
  clickCalls: Array<{
    threadId: string;
    tabId: string;
    x: number;
    y: number;
    button: string;
  }> = [];
  doubleClickCalls: Array<{
    threadId: string;
    tabId: string;
    x: number;
    y: number;
  }> = [];
  typeCalls: Array<{
    threadId: string;
    tabId: string;
    text: string;
    selector?: string;
  }> = [];
  pressCalls: Array<{ threadId: string; tabId: string; key: string }> = [];
  selectCalls: Array<{
    threadId: string;
    tabId: string;
    selector: string;
    value?: string;
    label?: string;
  }> = [];
  scrollCalls: Array<{
    threadId: string;
    tabId: string;
    deltaX: number;
    deltaY: number;
  }> = [];
  uploadCalls: Array<{
    threadId: string;
    tabId: string;
    selector: string;
    downloadUrl: string;
  }> = [];

  // 返回值控制（默认成功）
  private navigateResult = true;
  private closeTabResult = true;
  private switchTabResult = true;
  private createTabResult: TabMetadata | null = makeTab({
    id: "new-tab",
    url: "https://new.example.com",
  });
  private reloadResult = true;
  private goBackResult = true;
  private goForwardResult = true;
  private clickResult = true;
  private doubleClickResult = true;
  private typeResult = true;
  private pressResult = true;
  private selectResult = true;
  private scrollResult = true;
  private uploadResult = true;

  setNavigateResult(v: boolean): void {
    this.navigateResult = v;
  }

  setCloseTabResult(v: boolean): void {
    this.closeTabResult = v;
  }

  setSwitchTabResult(v: boolean): void {
    this.switchTabResult = v;
  }

  setCreateTabResult(t: TabMetadata | null): void {
    this.createTabResult = t;
  }

  setReloadResult(v: boolean): void {
    this.reloadResult = v;
  }

  setGoBackResult(v: boolean): void {
    this.goBackResult = v;
  }

  setGoForwardResult(v: boolean): void {
    this.goForwardResult = v;
  }

  setClickResult(v: boolean): void {
    this.clickResult = v;
  }

  setDoubleClickResult(v: boolean): void {
    this.doubleClickResult = v;
  }

  setTypeResult(v: boolean): void {
    this.typeResult = v;
  }

  setPressResult(v: boolean): void {
    this.pressResult = v;
  }

  setSelectResult(v: boolean): void {
    this.selectResult = v;
  }

  setScrollResult(v: boolean): void {
    this.scrollResult = v;
  }

  setUploadResult(v: boolean): void {
    this.uploadResult = v;
  }

  navigate(threadId: string, tabId: string, url: string): boolean {
    this.navigateCalls.push({ threadId, tabId, url });
    return this.navigateResult;
  }

  closeTab(threadId: string, tabId: string): boolean {
    this.closeTabCalls.push({ threadId, tabId });
    return this.closeTabResult;
  }

  switchTab(threadId: string, tabId: string): boolean {
    this.switchTabCalls.push({ threadId, tabId });
    return this.switchTabResult;
  }

  createTab(
    threadId: string,
    url: string,
    opts?: { incognito?: boolean; tabId?: string; activate?: boolean },
  ): TabMetadata | null {
    this.createTabCalls.push({ threadId, url, opts });
    return this.createTabResult;
  }

  reload(threadId: string, tabId: string): boolean {
    this.reloadCalls.push({ threadId, tabId });
    return this.reloadResult;
  }

  goBack(threadId: string, tabId: string): boolean {
    this.goBackCalls.push({ threadId, tabId });
    return this.goBackResult;
  }

  goForward(threadId: string, tabId: string): boolean {
    this.goForwardCalls.push({ threadId, tabId });
    return this.goForwardResult;
  }

  async click(
    threadId: string,
    tabId: string,
    x: number,
    y: number,
    button?: string,
  ): Promise<boolean> {
    this.clickCalls.push({ threadId, tabId, x, y, button: button ?? "left" });
    return this.clickResult;
  }

  async doubleClick(threadId: string, tabId: string, x: number, y: number): Promise<boolean> {
    this.doubleClickCalls.push({ threadId, tabId, x, y });
    return this.doubleClickResult;
  }

  async type(threadId: string, tabId: string, text: string, selector?: string): Promise<boolean> {
    this.typeCalls.push({ threadId, tabId, text, selector });
    return this.typeResult;
  }

  async press(threadId: string, tabId: string, key: string): Promise<boolean> {
    this.pressCalls.push({ threadId, tabId, key });
    return this.pressResult;
  }

  async select(
    threadId: string,
    tabId: string,
    selector: string,
    value?: string,
    label?: string,
  ): Promise<boolean> {
    this.selectCalls.push({ threadId, tabId, selector, value, label });
    return this.selectResult;
  }

  async scroll(threadId: string, tabId: string, deltaX: number, deltaY: number): Promise<boolean> {
    this.scrollCalls.push({ threadId, tabId, deltaX, deltaY });
    return this.scrollResult;
  }

  async uploadWorkspaceFile(
    threadId: string,
    tabId: string,
    selector: string,
    downloadUrl: string,
  ): Promise<boolean> {
    this.uploadCalls.push({ threadId, tabId, selector, downloadUrl });
    return this.uploadResult;
  }
}

describe("command-executor (V10 Phase 6)", () => {
  describe("executeReadCommand", () => {
    describe("browser.getTabs", () => {
      it("返回 tab 列表", async () => {
        const target = new MemoryCommandTarget();
        const tabs = [makeTab({ id: "tab-1" }), makeTab({ id: "tab-2", url: "https://b.com" })];
        target.setTabs("thread-1", tabs);

        const result = await executeReadCommand({
          target,
          command: "browser.getTabs",
          payload: { threadId: "thread-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(result.result).toEqual({ tabs, activeTabId: null });
      });

      it("Thread 无 tabs 返回空列表", async () => {
        const target = new MemoryCommandTarget();
        target.setTabs("empty-thread", []);

        const result = await executeReadCommand({
          target,
          command: "browser.getTabs",
          payload: { threadId: "empty-thread" },
          threadId: "empty-thread",
        });

        expect(result.ok).toBe(true);
        expect(result.result).toEqual({ tabs: [], activeTabId: null });
      });

      it("Thread 不存在返回空列表", async () => {
        const target = new MemoryCommandTarget();

        const result = await executeReadCommand({
          target,
          command: "browser.getTabs",
          payload: { threadId: "nonexistent" },
          threadId: "nonexistent",
        });

        expect(result.ok).toBe(true);
        expect(result.result).toEqual({ tabs: [], activeTabId: null });
      });
    });

    describe("browser.getPageMetadata", () => {
      it("返回指定 tabId 的元数据", async () => {
        const target = new MemoryCommandTarget();
        const tab = makeTab({
          id: "tab-1",
          url: "https://example.com/page",
          title: "页面标题",
          favicon: "https://example.com/icon.ico",
          loadState: "loaded",
          canGoBack: true,
          canGoForward: false,
        });
        target.setTabs("thread-1", [tab]);

        const result = await executeReadCommand({
          target,
          command: "browser.getPageMetadata",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(result.result).toEqual({
          url: "https://example.com/page",
          title: "页面标题",
          favicon: "https://example.com/icon.ico",
          loadState: "loaded",
          canGoBack: true,
          canGoForward: false,
        });
      });

      it("缺少 tabId 返回 rpc_invalid_payload", async () => {
        const target = new MemoryCommandTarget();
        target.setTabs("thread-1", [makeTab()]);

        const result = await executeReadCommand({
          target,
          command: "browser.getPageMetadata",
          payload: { threadId: "thread-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
      });

      it("tabId 为空字符串返回 rpc_invalid_payload", async () => {
        const target = new MemoryCommandTarget();
        target.setTabs("thread-1", [makeTab()]);

        const result = await executeReadCommand({
          target,
          command: "browser.getPageMetadata",
          payload: { threadId: "thread-1", tabId: "" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
      });

      it("tabId 不存在返回 tab_not_found", async () => {
        const target = new MemoryCommandTarget();
        target.setTabs("thread-1", [makeTab({ id: "tab-1" })]);

        const result = await executeReadCommand({
          target,
          command: "browser.getPageMetadata",
          payload: { threadId: "thread-1", tabId: "nonexistent" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("tab_not_found");
      });

      it("Thread 无 tabs 时返回 tab_not_found", async () => {
        const target = new MemoryCommandTarget();

        const result = await executeReadCommand({
          target,
          command: "browser.getPageMetadata",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("tab_not_found");
      });
    });

    describe("browser.screenshot", () => {
      it("无 captureScreenshot 回调返回 browser_internal", async () => {
        const target = new MemoryCommandTarget();

        const result = await executeReadCommand({
          target,
          command: "browser.screenshot",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
        expect(result.message).toContain("captureScreenshot");
      });

      it("有 captureScreenshot 回调返回 { path }", async () => {
        const target = new MemoryCommandTarget();
        target.setCaptureScreenshot(async () => "/tmp/screenshot.png");

        const result = await executeReadCommand({
          target,
          command: "browser.screenshot",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(result.result).toEqual({ path: "/tmp/screenshot.png" });
      });

      it("captureScreenshot 抛错返回 browser_internal", async () => {
        const target = new MemoryCommandTarget();
        target.setCaptureScreenshot(async () => {
          throw new Error("截图失败");
        });

        const result = await executeReadCommand({
          target,
          command: "browser.screenshot",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
        expect(result.message).toContain("截图失败");
      });

      it("缺少 tabId 返回 rpc_invalid_payload", async () => {
        const target = new MemoryCommandTarget();
        target.setCaptureScreenshot(async () => "/tmp/x.png");

        const result = await executeReadCommand({
          target,
          command: "browser.screenshot",
          payload: { threadId: "thread-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
      });

      it("传递 format 参数给 captureScreenshot", async () => {
        const target = new MemoryCommandTarget();
        const captureMock = vi.fn(async () => "/tmp/x.jpg");
        target.setCaptureScreenshot(captureMock);

        const result = await executeReadCommand({
          target,
          command: "browser.screenshot",
          payload: { threadId: "thread-1", tabId: "tab-1", format: "jpeg" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(captureMock).toHaveBeenCalledWith("thread-1", "tab-1", "jpeg");
      });

      it("format 缺省为 png", async () => {
        const target = new MemoryCommandTarget();
        const captureMock = vi.fn(async () => "/tmp/x.png");
        target.setCaptureScreenshot(captureMock);

        await executeReadCommand({
          target,
          command: "browser.screenshot",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(captureMock).toHaveBeenCalledWith("thread-1", "tab-1", "png");
      });
    });

    describe("browser.snapshot", () => {
      it("无 getSnapshot 返回 browser_internal", async () => {
        // 只实现必需方法，不实现 getSnapshot
        const target: BrowserCommandTarget = {
          getTabs: () => [],
          getActiveTab: () => null,
        };

        const result = await executeReadCommand({
          target,
          command: "browser.snapshot",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
        expect(result.message).toContain("getSnapshot");
      });

      it("getSnapshot 返回 null 返回 tab_not_found", async () => {
        const target = new MemoryCommandTarget();
        target.setGetSnapshot(async () => null);

        const result = await executeReadCommand({
          target,
          command: "browser.snapshot",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("tab_not_found");
      });

      it("getSnapshot 返回结构化摘要", async () => {
        const target = new MemoryCommandTarget();
        target.setGetSnapshot(async () => ({
          text: "页面文本内容",
          domSummary: JSON.stringify({ title: "测试页面", formCount: 1 }),
        }));

        const result = await executeReadCommand({
          target,
          command: "browser.snapshot",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(result.result).toEqual({
          text: "页面文本内容",
          domSummary: JSON.stringify({ title: "测试页面", formCount: 1 }),
        });
      });

      it("传递 maxTextLength 参数", async () => {
        const target = new MemoryCommandTarget();
        let receivedMaxTextLength: number | undefined;
        target.setGetSnapshot(async (_t, _tab, maxTextLength) => {
          receivedMaxTextLength = maxTextLength;
          return { text: "文本", domSummary: "{}" };
        });

        await executeReadCommand({
          target,
          command: "browser.snapshot",
          payload: { threadId: "thread-1", tabId: "tab-1", maxTextLength: 5000 },
          threadId: "thread-1",
        });

        expect(receivedMaxTextLength).toBe(5000);
      });

      it("缺少 tabId 返回 rpc_invalid_payload", async () => {
        const target = new MemoryCommandTarget();
        target.setGetSnapshot(async () => ({ text: "", domSummary: "{}" }));

        const result = await executeReadCommand({
          target,
          command: "browser.snapshot",
          payload: { threadId: "thread-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
      });

      it("getSnapshot 抛出异常返回 browser_internal", async () => {
        const target = new MemoryCommandTarget();
        target.setGetSnapshot(async () => {
          throw new Error("CDP attach 失败");
        });

        const result = await executeReadCommand({
          target,
          command: "browser.snapshot",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
        expect(result.message).toContain("CDP attach 失败");
      });
    });

    describe("browser.getAccessibilityTree", () => {
      it("无 getAccessibilityTree 返回 browser_internal", async () => {
        const target: BrowserCommandTarget = {
          getTabs: () => [],
          getActiveTab: () => null,
        };

        const result = await executeReadCommand({
          target,
          command: "browser.getAccessibilityTree",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
      });

      it("getAccessibilityTree 返回 null 返回 tab_not_found", async () => {
        const target = new MemoryCommandTarget();
        target.setGetAccessibilityTree(async () => null);

        const result = await executeReadCommand({
          target,
          command: "browser.getAccessibilityTree",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("tab_not_found");
      });

      it("getAccessibilityTree 返回 tree 节点数组", async () => {
        const target = new MemoryCommandTarget();
        const nodes = [
          { nodeId: 1, role: "button" },
          { nodeId: 2, role: "link" },
        ];
        target.setGetAccessibilityTree(async () => ({ tree: nodes }));

        const result = await executeReadCommand({
          target,
          command: "browser.getAccessibilityTree",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(result.result).toEqual({ tree: nodes });
      });
    });

    describe("browser.getConsole", () => {
      it("无 getConsoleEntries 返回 browser_internal", async () => {
        const target: BrowserCommandTarget = {
          getTabs: () => [],
          getActiveTab: () => null,
        };

        const result = await executeReadCommand({
          target,
          command: "browser.getConsole",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
      });

      it("getConsoleEntries 返回 null 返回 tab_not_found", async () => {
        const target = new MemoryCommandTarget();
        target.setGetConsoleEntries(async () => null);

        const result = await executeReadCommand({
          target,
          command: "browser.getConsole",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("tab_not_found");
      });

      it("getConsoleEntries 返回条目数组", async () => {
        const target = new MemoryCommandTarget();
        const entries = [
          { level: "error", text: "错误" },
          { level: "warning", text: "警告" },
        ];
        target.setGetConsoleEntries(async () => ({ entries }));

        const result = await executeReadCommand({
          target,
          command: "browser.getConsole",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(result.result).toEqual({ entries });
      });

      it("传递 level 和 limit 参数", async () => {
        const target = new MemoryCommandTarget();
        let receivedLevel: string | undefined;
        let receivedLimit: number | undefined;
        target.setGetConsoleEntries(async (_t, _tab, level, limit) => {
          receivedLevel = level;
          receivedLimit = limit;
          return { entries: [] };
        });

        await executeReadCommand({
          target,
          command: "browser.getConsole",
          payload: {
            threadId: "thread-1",
            tabId: "tab-1",
            level: "error",
            limit: 10,
          },
          threadId: "thread-1",
        });

        expect(receivedLevel).toBe("error");
        expect(receivedLimit).toBe(10);
      });
    });

    describe("browser.getNetwork", () => {
      it("无 getNetworkEntries 返回 browser_internal", async () => {
        const target: BrowserCommandTarget = {
          getTabs: () => [],
          getActiveTab: () => null,
        };

        const result = await executeReadCommand({
          target,
          command: "browser.getNetwork",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
      });

      it("getNetworkEntries 返回 null 返回 tab_not_found", async () => {
        const target = new MemoryCommandTarget();
        target.setGetNetworkEntries(async () => null);

        const result = await executeReadCommand({
          target,
          command: "browser.getNetwork",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("tab_not_found");
      });

      it("getNetworkEntries 返回条目数组", async () => {
        const target = new MemoryCommandTarget();
        const entries = [
          { url: "https://example.com/api", method: "GET", status: 200, body: null },
        ];
        target.setGetNetworkEntries(async () => ({ entries }));

        const result = await executeReadCommand({
          target,
          command: "browser.getNetwork",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(result.result).toEqual({ entries });
      });

      it("传递 filter 和 limit 参数", async () => {
        const target = new MemoryCommandTarget();
        let receivedFilter: string | undefined;
        let receivedLimit: number | undefined;
        target.setGetNetworkEntries(async (_t, _tab, filter, limit) => {
          receivedFilter = filter;
          receivedLimit = limit;
          return { entries: [] };
        });

        await executeReadCommand({
          target,
          command: "browser.getNetwork",
          payload: {
            threadId: "thread-1",
            tabId: "tab-1",
            filter: "failed",
            limit: 5,
          },
          threadId: "thread-1",
        });

        expect(receivedFilter).toBe("failed");
        expect(receivedLimit).toBe(5);
      });
    });

    describe("未知命令", () => {
      it("返回 unknown_command", async () => {
        const target = new MemoryCommandTarget();

        const result = await executeReadCommand({
          target,
          command: "browser.unknown",
          payload: {},
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("unknown_command");
      });

      it("任意字符串命令返回 unknown_command", async () => {
        const target = new MemoryCommandTarget();

        const result = await executeReadCommand({
          target,
          command: "system.shutdown",
          payload: {},
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("unknown_command");
      });
    });

    describe("跨 Thread 隔离", () => {
      it("getTabs 只返回指定 thread 的 tabs", async () => {
        const target = new MemoryCommandTarget();
        target.setTabs("thread-a", [makeTab({ id: "tab-a1" })]);
        target.setTabs("thread-b", [makeTab({ id: "tab-b1" })]);

        const resultA = await executeReadCommand({
          target,
          command: "browser.getTabs",
          payload: { threadId: "thread-a" },
          threadId: "thread-a",
        });
        const resultB = await executeReadCommand({
          target,
          command: "browser.getTabs",
          payload: { threadId: "thread-b" },
          threadId: "thread-b",
        });

        expect(resultA.ok).toBe(true);
        expect((resultA.result as { tabs: TabMetadata[] }).tabs).toHaveLength(1);
        expect((resultA.result as { tabs: TabMetadata[] }).tabs[0].id).toBe("tab-a1");
        expect(resultB.ok).toBe(true);
        expect((resultB.result as { tabs: TabMetadata[] }).tabs[0].id).toBe("tab-b1");
      });

      it("getPageMetadata 在 thread-a 查不到 thread-b 的 tab", async () => {
        const target = new MemoryCommandTarget();
        target.setTabs("thread-a", [makeTab({ id: "tab-a1" })]);
        target.setTabs("thread-b", [makeTab({ id: "tab-b1" })]);

        const result = await executeReadCommand({
          target,
          command: "browser.getPageMetadata",
          payload: { threadId: "thread-a", tabId: "tab-b1" },
          threadId: "thread-a",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("tab_not_found");
      });
    });
  });

  describe("executeActionCommand", () => {
    describe("browser.navigate", () => {
      it("成功导航返回 ok", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.navigate",
          payload: { tabId: "tab-1", url: "https://example.com" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(result.code).toBeUndefined();
        expect(target.navigateCalls).toHaveLength(1);
        expect(target.navigateCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-1",
          url: "https://example.com",
        });
      });

      it("缺少 tabId 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.navigate",
          payload: { url: "https://example.com" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
        expect(target.navigateCalls).toHaveLength(0);
      });

      it("缺少 url 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.navigate",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
      });

      it("target 返回 false 返回 browser_internal", async () => {
        const target = new MemoryActionTarget();
        target.setNavigateResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.navigate",
          payload: { tabId: "tab-1", url: "https://example.com" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
      });
    });

    describe("browser.click", () => {
      it("成功点击返回 ok", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.click",
          payload: { tabId: "tab-1", x: 100, y: 200, button: "right" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.clickCalls).toHaveLength(1);
        expect(target.clickCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-1",
          x: 100,
          y: 200,
          button: "right",
        });
      });

      it("缺少 x/y 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.click",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
        expect(target.clickCalls).toHaveLength(0);
      });

      it("缺少 tabId 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.click",
          payload: { x: 100, y: 200 },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
      });

      it("默认 button 为 left", async () => {
        const target = new MemoryActionTarget();

        await executeActionCommand({
          target,
          command: "browser.click",
          payload: { tabId: "tab-1", x: 10, y: 20 },
          threadId: "thread-1",
        });

        expect(target.clickCalls[0].button).toBe("left");
      });

      it("target 失败返回 browser_internal", async () => {
        const target = new MemoryActionTarget();
        target.setClickResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.click",
          payload: { tabId: "tab-1", x: 10, y: 20 },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
      });
    });

    describe("browser.doubleClick", () => {
      it("成功双击返回 ok", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.doubleClick",
          payload: { tabId: "tab-1", x: 100, y: 200 },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.doubleClickCalls).toHaveLength(1);
        expect(target.doubleClickCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-1",
          x: 100,
          y: 200,
        });
      });

      it("缺少 x/y 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.doubleClick",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
      });

      it("target 失败返回 browser_internal", async () => {
        const target = new MemoryActionTarget();
        target.setDoubleClickResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.doubleClick",
          payload: { tabId: "tab-1", x: 10, y: 20 },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
      });
    });

    describe("browser.type", () => {
      it("成功输入文本（带 selector）", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.type",
          payload: {
            tabId: "tab-1",
            text: "hello",
            selector: "#input",
          },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.typeCalls).toHaveLength(1);
        expect(target.typeCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-1",
          text: "hello",
          selector: "#input",
        });
      });

      it("可选 selector 缺省为 undefined", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.type",
          payload: { tabId: "tab-1", text: "hello" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.typeCalls[0].selector).toBeUndefined();
      });

      it("缺少 text 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.type",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
        expect(target.typeCalls).toHaveLength(0);
      });

      it("target 失败返回 browser_internal", async () => {
        const target = new MemoryActionTarget();
        target.setTypeResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.type",
          payload: { tabId: "tab-1", text: "hello" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
      });
    });

    describe("browser.press", () => {
      it("成功按键返回 ok", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.press",
          payload: { tabId: "tab-1", key: "Enter" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.pressCalls).toHaveLength(1);
        expect(target.pressCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-1",
          key: "Enter",
        });
      });

      it("缺少 key 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.press",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
        expect(target.pressCalls).toHaveLength(0);
      });

      it("target 失败返回 browser_internal", async () => {
        const target = new MemoryActionTarget();
        target.setPressResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.press",
          payload: { tabId: "tab-1", key: "Enter" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
      });
    });

    describe("browser.select", () => {
      it("成功选择返回 ok", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.select",
          payload: {
            tabId: "tab-1",
            selector: "#sel",
            value: "opt1",
            label: "选项1",
          },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.selectCalls).toHaveLength(1);
        expect(target.selectCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-1",
          selector: "#sel",
          value: "opt1",
          label: "选项1",
        });
      });

      it("缺少 selector 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.select",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
        expect(target.selectCalls).toHaveLength(0);
      });

      it("target 失败返回 browser_internal", async () => {
        const target = new MemoryActionTarget();
        target.setSelectResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.select",
          payload: { tabId: "tab-1", selector: "#sel" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
      });
    });

    describe("browser.scroll", () => {
      it("成功滚动返回 ok", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.scroll",
          payload: { tabId: "tab-1", deltaX: 0, deltaY: 100 },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.scrollCalls).toHaveLength(1);
        expect(target.scrollCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-1",
          deltaX: 0,
          deltaY: 100,
        });
      });

      it("缺少 deltaX/deltaY 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.scroll",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
        expect(target.scrollCalls).toHaveLength(0);
      });

      it("target 失败返回 browser_internal", async () => {
        const target = new MemoryActionTarget();
        target.setScrollResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.scroll",
          payload: { tabId: "tab-1", deltaX: 0, deltaY: 100 },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
      });
    });

    describe("browser.newTab", () => {
      it("成功创建 tab 返回 { tabId, url }", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.newTab",
          payload: { url: "https://new.example.com" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(result.result).toEqual({
          tabId: "new-tab",
          url: "https://new.example.com",
        });
        expect(target.createTabCalls).toHaveLength(1);
        expect(target.createTabCalls[0].threadId).toBe("thread-1");
        expect(target.createTabCalls[0].url).toBe("https://new.example.com");
        expect(target.createTabCalls[0].opts).toEqual({ activate: true });
      });

      it("缺少 url 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.newTab",
          payload: {},
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
        expect(target.createTabCalls).toHaveLength(0);
      });

      it("createTab 返回 null 返回 browser_internal", async () => {
        const target = new MemoryActionTarget();
        target.setCreateTabResult(null);

        const result = await executeActionCommand({
          target,
          command: "browser.newTab",
          payload: { url: "https://new.example.com" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
        expect(result.message).toContain("创建 tab");
      });
    });

    describe("browser.closeTab", () => {
      it("成功关闭返回 ok", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.closeTab",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.closeTabCalls).toHaveLength(1);
        expect(target.closeTabCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-1",
        });
      });

      it("缺少 tabId 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.closeTab",
          payload: {},
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
        expect(target.closeTabCalls).toHaveLength(0);
      });

      it("target 返回 false 返回 tab_not_found", async () => {
        const target = new MemoryActionTarget();
        target.setCloseTabResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.closeTab",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("tab_not_found");
      });
    });

    describe("browser.switchTab", () => {
      it("成功切换返回 ok", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.switchTab",
          payload: { tabId: "tab-2" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.switchTabCalls).toHaveLength(1);
        expect(target.switchTabCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-2",
        });
      });

      it("缺少 tabId 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.switchTab",
          payload: {},
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
      });

      it("target 返回 false 返回 tab_not_found", async () => {
        const target = new MemoryActionTarget();
        target.setSwitchTabResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.switchTab",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("tab_not_found");
      });
    });

    describe("browser.reload", () => {
      it("成功 reload 返回 ok", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.reload",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.reloadCalls).toHaveLength(1);
        expect(target.reloadCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-1",
        });
      });

      it("缺少 tabId 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.reload",
          payload: {},
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
      });

      it("target 返回 false 返回 tab_not_found", async () => {
        const target = new MemoryActionTarget();
        target.setReloadResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.reload",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("tab_not_found");
      });
    });

    describe("browser.goBack", () => {
      it("成功 goBack 返回 ok", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.goBack",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.goBackCalls).toHaveLength(1);
        expect(target.goBackCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-1",
        });
      });

      it("缺少 tabId 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.goBack",
          payload: {},
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
      });

      it("target 返回 false 返回 tab_not_found", async () => {
        const target = new MemoryActionTarget();
        target.setGoBackResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.goBack",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("tab_not_found");
      });
    });

    describe("browser.goForward", () => {
      it("成功 goForward 返回 ok", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.goForward",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.goForwardCalls).toHaveLength(1);
        expect(target.goForwardCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-1",
        });
      });

      it("缺少 tabId 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.goForward",
          payload: {},
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
      });

      it("target 返回 false 返回 tab_not_found", async () => {
        const target = new MemoryActionTarget();
        target.setGoForwardResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.goForward",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("tab_not_found");
      });
    });

    describe("browser.uploadWorkspaceFile", () => {
      it("成功上传返回 ok", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.uploadWorkspaceFile",
          payload: {
            tabId: "tab-1",
            selector: "#file-input",
            downloadUrl: "http://localhost:3000/api/threads/t1/workspace/download?token=abc",
          },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(true);
        expect(target.uploadCalls).toHaveLength(1);
        expect(target.uploadCalls[0]).toEqual({
          threadId: "thread-1",
          tabId: "tab-1",
          selector: "#file-input",
          downloadUrl: "http://localhost:3000/api/threads/t1/workspace/download?token=abc",
        });
      });

      it("缺少 selector/downloadUrl 返回 rpc_invalid_payload", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.uploadWorkspaceFile",
          payload: { tabId: "tab-1" },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("rpc_invalid_payload");
        expect(target.uploadCalls).toHaveLength(0);
      });

      it("target 失败返回 browser_internal", async () => {
        const target = new MemoryActionTarget();
        target.setUploadResult(false);

        const result = await executeActionCommand({
          target,
          command: "browser.uploadWorkspaceFile",
          payload: {
            tabId: "tab-1",
            selector: "#file-input",
            downloadUrl: "http://localhost:3000/api/threads/t1/workspace/download?token=abc",
          },
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("browser_internal");
      });
    });

    describe("未知命令", () => {
      it("返回 unknown_command", async () => {
        const target = new MemoryActionTarget();

        const result = await executeActionCommand({
          target,
          command: "browser.unknown",
          payload: {},
          threadId: "thread-1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe("unknown_command");
      });
    });
  });
});
