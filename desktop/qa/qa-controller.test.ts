import { beforeEach, describe, expect, it } from "vitest";
import { PageInsightsStore } from "../browser/page-insights-store";
import {
  QaController,
  type QaViewport,
  type QaWebContentsFactory,
  type QaWebContentsHandle,
} from "./qa-controller";
import { QA_READONLY_INJECTION } from "./qa-policy";

/**
 * V10 Phase 7-4：QaController 单元测试。
 *
 * 使用 MockQaWebContentsFactory 验证：
 * - openQaPage 创建隐藏 WebContents 并应用 read-only 策略
 * - 非 http/https URL 被阻止
 * - closeQa 销毁 WebContents 并清理缓冲
 * - closeThread 清理所有资源
 * - 已有 QA 时重建
 * - read-only 脚本注入和导航拦截
 */

/** Mock QaWebContentsHandle，记录所有调用。 */
class MockQaHandle implements QaWebContentsHandle {
  readonly id: number;
  loadURLCalls: Array<{ url: string; timeoutMs?: number }> = [];
  executeJavaScriptCalls: string[] = [];
  capturePageCalls = 0;
  setViewportCalls: QaViewport[] = [];
  didFinishLoadCallbacks: Array<() => void> = [];
  willNavigateCallbacks: Array<(url: string) => boolean> = [];
  destroyCalls = 0;
  applyReadOnlyPolicyCalls = 0;
  private destroyed = false;

  constructor(id: number) {
    this.id = id;
  }

  async loadURL(url: string, opts?: { timeoutMs?: number }): Promise<void> {
    if (this.destroyed) throw new Error("handle destroyed");
    this.loadURLCalls.push({ url, timeoutMs: opts?.timeoutMs });
  }

  async executeJavaScript<T>(script: string): Promise<T> {
    if (this.destroyed) throw new Error("handle destroyed");
    this.executeJavaScriptCalls.push(script);
    return undefined as unknown as T;
  }

  async capturePage(): Promise<Buffer> {
    if (this.destroyed) throw new Error("handle destroyed");
    this.capturePageCalls++;
    return Buffer.from("fake-screenshot");
  }

  setViewport(viewport: QaViewport): void {
    this.setViewportCalls.push(viewport);
  }

  onDidFinishLoad(callback: () => void): void {
    this.didFinishLoadCallbacks.push(callback);
  }

  onWillNavigate(callback: (url: string) => boolean): void {
    this.willNavigateCallbacks.push(callback);
  }

  destroy(): void {
    this.destroyed = true;
    this.destroyCalls++;
  }

  applyReadOnlyPolicy(): void {
    this.applyReadOnlyPolicyCalls++;
  }

  /** 触发 did-finish-load 事件（测试用）。 */
  triggerDidFinishLoad(): void {
    for (const cb of this.didFinishLoadCallbacks) cb();
  }
}

/** Mock 工厂，记录创建的 handle。 */
class MockQaFactory implements QaWebContentsFactory {
  handles: MockQaHandle[] = [];
  createCalls: Array<{ threadId: string; viewport: QaViewport }> = [];
  private nextId = 1;

  createHiddenWebContents(threadId: string, viewport: QaViewport): QaWebContentsHandle {
    const handle = new MockQaHandle(this.nextId++);
    this.handles.push(handle);
    this.createCalls.push({ threadId, viewport });
    return handle;
  }
}

describe("QaController", () => {
  let store: PageInsightsStore;
  let factory: MockQaFactory;
  let controller: QaController;

  beforeEach(() => {
    store = new PageInsightsStore();
    factory = new MockQaFactory();
    controller = new QaController(store, factory);
  });

  describe("openQaPage", () => {
    it("创建隐藏 WebContents 并返回 QaPage", () => {
      const page = controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });

      expect(page).not.toBeNull();
      expect(factory.createCalls).toHaveLength(1);
      expect(factory.createCalls[0]?.threadId).toBe("thread-1");
      expect(factory.createCalls[0]?.viewport).toEqual({ width: 1280, height: 720 });
    });

    it("对返回的 QaPage 调用 goto 导航到 http URL", async () => {
      const page = controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });
      expect(page).not.toBeNull();
      if (!page) return;

      await page.goto("http://localhost:3000/page");

      const handle = factory.handles[0];
      expect(handle.loadURLCalls).toHaveLength(1);
      expect(handle.loadURLCalls[0]?.url).toBe("http://localhost:3000/page");
    });

    it("goto 传 timeoutMs", async () => {
      const page = controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });
      expect(page).not.toBeNull();
      if (!page) return;

      await page.goto("http://localhost:3000/slow", 5000);

      expect(factory.handles[0]?.loadURLCalls[0]?.timeoutMs).toBe(5000);
    });

    it("goto 对非 http URL 抛异常", async () => {
      const page = controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });
      expect(page).not.toBeNull();
      if (!page) return;

      await expect(page.goto("file:///etc/passwd")).rejects.toThrow("QA 导航被阻止");
    });

    it("screenshotFullPage 返回 Buffer", async () => {
      const page = controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });
      expect(page).not.toBeNull();
      if (!page) return;

      const buf = await page.screenshotFullPage();
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(factory.handles[0]?.capturePageCalls).toBe(1);
    });

    it("evaluate 执行 JS 表达式", async () => {
      const page = controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });
      expect(page).not.toBeNull();
      if (!page) return;

      await page.evaluate("document.title");

      expect(factory.handles[0]?.executeJavaScriptCalls).toContain("document.title");
    });

    it("close 调用后 handle 被销毁", async () => {
      const page = controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });
      expect(page).not.toBeNull();
      if (!page) return;

      await page.close();

      expect(factory.handles[0]?.destroyCalls).toBe(1);
      expect(controller.hasQaPage("thread-1")).toBe(false);
    });

    it("非 http/https URL 返回 null（不创建 handle）", () => {
      const page = controller.openQaPage("thread-1", "file:///etc/passwd", {
        width: 1280,
        height: 720,
      });

      expect(page).toBeNull();
      expect(factory.createCalls).toHaveLength(0);
    });

    it("data: URL 返回 null", () => {
      const page = controller.openQaPage("thread-1", "data:text/html,<h1>hi</h1>", {
        width: 1280,
        height: 720,
      });

      expect(page).toBeNull();
    });

    it("javascript: URL 返回 null", () => {
      const page = controller.openQaPage("thread-1", "javascript:alert(1)", {
        width: 1280,
        height: 720,
      });

      expect(page).toBeNull();
    });

    it("已存在 QA 时先关闭再重建", () => {
      controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });
      controller.openQaPage("thread-1", "http://localhost:3000/other", {
        width: 375,
        height: 667,
      });

      // 第一个 handle 应被销毁
      expect(factory.handles[0]?.destroyCalls).toBe(1);
      // 第二个 handle 应被创建
      expect(factory.handles).toHaveLength(2);
      expect(factory.createCalls).toHaveLength(2);
      expect(factory.createCalls[1]?.viewport).toEqual({ width: 375, height: 667 });
    });

    it("应用 read-only 策略", () => {
      controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });

      expect(factory.handles[0]?.applyReadOnlyPolicyCalls).toBe(1);
    });

    it("did-finish-load 时注入 read-only 脚本", () => {
      controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });

      const handle = factory.handles[0];
      expect(handle).toBeDefined();
      if (!handle) return;

      // 触发 did-finish-load
      handle.triggerDidFinishLoad();

      // 验证注入了 read-only 脚本
      expect(handle.executeJavaScriptCalls).toContain(QA_READONLY_INJECTION);
    });

    it("注册 will-navigate 拦截器", () => {
      controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });

      const handle = factory.handles[0];
      expect(handle).toBeDefined();
      if (!handle) return;

      expect(handle.willNavigateCallbacks).toHaveLength(1);

      // will-navigate 回调允许 http
      const cb = handle.willNavigateCallbacks[0];
      expect(cb).toBeDefined();
      if (!cb) return;
      expect(cb("http://localhost:3000/page")).toBe(true);
      expect(cb("https://example.com/")).toBe(true);
      expect(cb("file:///etc/passwd")).toBe(false);
      expect(cb("javascript:alert(1)")).toBe(false);
    });

    it("QaPage viewport 字段正确", () => {
      const viewport = { width: 375, height: 667 };
      const page = controller.openQaPage("thread-1", "http://localhost:3000/", viewport);

      expect(page).not.toBeNull();
      if (!page) return;
      expect(page.viewport).toEqual(viewport);
    });
  });

  describe("closeQa", () => {
    it("销毁 handle", () => {
      controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });
      expect(controller.hasQaPage("thread-1")).toBe(true);

      controller.closeQa("thread-1");

      expect(factory.handles[0]?.destroyCalls).toBe(1);
      expect(controller.hasQaPage("thread-1")).toBe(false);
    });

    it("对不存在的 thread 不抛异常", () => {
      expect(() => controller.closeQa("nonexistent")).not.toThrow();
    });

    it("清理 PageInsightsStore 中该 thread 的 QA 缓冲", () => {
      // 先添加一些 QA console 条目
      store.addConsoleEntry("thread-1", "qa", {
        level: "log",
        text: "test",
        timestamp: Date.now(),
      });
      expect(store.consoleCount("thread-1", "qa")).toBe(1);

      controller.closeQa("thread-1");

      expect(store.consoleCount("thread-1", "qa")).toBe(0);
    });
  });

  describe("closeThread", () => {
    it("销毁 handle 并清理所有缓冲", () => {
      controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });
      // 添加 QA console 和 network 条目
      store.addConsoleEntry("thread-1", "qa", {
        level: "error",
        text: "err",
        timestamp: 1000,
      });
      store.bufferNetworkRequest("thread-1", "qa", "req-1", {
        url: "http://localhost:3000/api",
        method: "GET",
        timestamp: 1000,
      });
      // 添加用户 tab 的条目（确保 closeThread 清理所有 tab）
      store.addConsoleEntry("thread-1", "tab-1", {
        level: "log",
        text: "user tab",
        timestamp: 1000,
      });

      controller.closeThread("thread-1");

      expect(factory.handles[0]?.destroyCalls).toBe(1);
      expect(controller.hasQaPage("thread-1")).toBe(false);
      expect(store.consoleCount("thread-1", "qa")).toBe(0);
      expect(store.consoleCount("thread-1", "tab-1")).toBe(0);
      expect(store.networkCount("thread-1", "qa")).toBe(0);
    });

    it("对不存在的 thread 不抛异常", () => {
      expect(() => controller.closeThread("nonexistent")).not.toThrow();
    });
  });

  describe("hasQaPage", () => {
    it("openQaPage 后返回 true", () => {
      controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });
      expect(controller.hasQaPage("thread-1")).toBe(true);
    });

    it("未创建时返回 false", () => {
      expect(controller.hasQaPage("thread-1")).toBe(false);
    });

    it("closeQa 后返回 false", () => {
      controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });
      controller.closeQa("thread-1");
      expect(controller.hasQaPage("thread-1")).toBe(false);
    });

    it("不同 thread 互不影响", () => {
      controller.openQaPage("thread-1", "http://localhost:3000/", {
        width: 1280,
        height: 720,
      });
      expect(controller.hasQaPage("thread-1")).toBe(true);
      expect(controller.hasQaPage("thread-2")).toBe(false);
    });
  });
});
