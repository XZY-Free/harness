import { describe, expect, it } from "vitest";
import { PageInsightsStore } from "./page-insights-store";

/**
 * V10 Phase 7-3：PageInsightsStore 单元测试。
 *
 * 验证 Console / Network 条目缓冲、过滤、清理逻辑。
 * 纯逻辑模块，不依赖 electron / CDP。
 */

describe("PageInsightsStore", () => {
  describe("Console 缓冲", () => {
    it("addConsoleEntry 追加条目", () => {
      const store = new PageInsightsStore();
      store.addConsoleEntry("thread-1", "tab-1", {
        level: "error",
        text: "Uncaught Error",
      });
      store.addConsoleEntry("thread-1", "tab-1", {
        level: "log",
        text: "hello",
      });

      expect(store.consoleCount("thread-1", "tab-1")).toBe(2);
    });

    it("getConsoleEntries 返回全部条目（无 filter）", () => {
      const store = new PageInsightsStore();
      store.addConsoleEntry("thread-1", "tab-1", { level: "error", text: "err1" });
      store.addConsoleEntry("thread-1", "tab-1", { level: "log", text: "log1" });
      store.addConsoleEntry("thread-1", "tab-1", { level: "warning", text: "warn1" });

      const entries = store.getConsoleEntries("thread-1", "tab-1");
      expect(entries).toHaveLength(3);
      expect(entries[0].text).toBe("err1");
      expect(entries[2].text).toBe("warn1");
    });

    it('getConsoleEntries level="error" 仅返回 error+pageerror', () => {
      const store = new PageInsightsStore();
      store.addConsoleEntry("thread-1", "tab-1", { level: "error", text: "err" });
      store.addConsoleEntry("thread-1", "tab-1", { level: "pageerror", text: "page" });
      store.addConsoleEntry("thread-1", "tab-1", { level: "warning", text: "warn" });
      store.addConsoleEntry("thread-1", "tab-1", { level: "log", text: "log" });

      const entries = store.getConsoleEntries("thread-1", "tab-1", "error");
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.level === "error" || e.level === "pageerror")).toBe(true);
    });

    it('getConsoleEntries level="warning+" 返回 error+pageerror+warning', () => {
      const store = new PageInsightsStore();
      store.addConsoleEntry("thread-1", "tab-1", { level: "error", text: "err" });
      store.addConsoleEntry("thread-1", "tab-1", { level: "pageerror", text: "page" });
      store.addConsoleEntry("thread-1", "tab-1", { level: "warning", text: "warn" });
      store.addConsoleEntry("thread-1", "tab-1", { level: "log", text: "log" });
      store.addConsoleEntry("thread-1", "tab-1", { level: "info", text: "info" });

      const entries = store.getConsoleEntries("thread-1", "tab-1", "warning+");
      expect(entries).toHaveLength(3);
      expect(entries.every((e) => ["error", "pageerror", "warning"].includes(e.level))).toBe(true);
    });

    it("getConsoleEntries 应用 limit（保留最新 N 条）", () => {
      const store = new PageInsightsStore();
      for (let i = 0; i < 10; i++) {
        store.addConsoleEntry("thread-1", "tab-1", { level: "log", text: `msg-${i}` });
      }

      const entries = store.getConsoleEntries("thread-1", "tab-1", undefined, 3);
      expect(entries).toHaveLength(3);
      expect(entries[0].text).toBe("msg-7");
      expect(entries[2].text).toBe("msg-9");
    });

    it("getConsoleEntries 默认 limit=50", () => {
      const store = new PageInsightsStore();
      for (let i = 0; i < 60; i++) {
        store.addConsoleEntry("thread-1", "tab-1", { level: "log", text: `msg-${i}` });
      }

      const entries = store.getConsoleEntries("thread-1", "tab-1");
      expect(entries).toHaveLength(50);
      expect(entries[0].text).toBe("msg-10");
    });

    it("getConsoleEntries 空缓冲返回空数组", () => {
      const store = new PageInsightsStore();
      expect(store.getConsoleEntries("thread-1", "tab-1")).toEqual([]);
    });

    it("Console 条目按 thread+tab 隔离", () => {
      const store = new PageInsightsStore();
      store.addConsoleEntry("thread-1", "tab-a", { level: "log", text: "a" });
      store.addConsoleEntry("thread-1", "tab-b", { level: "log", text: "b" });
      store.addConsoleEntry("thread-2", "tab-a", { level: "log", text: "c" });

      expect(store.getConsoleEntries("thread-1", "tab-a")).toHaveLength(1);
      expect(store.getConsoleEntries("thread-1", "tab-b")).toHaveLength(1);
      expect(store.getConsoleEntries("thread-2", "tab-a")).toHaveLength(1);
      expect(store.getConsoleEntries("thread-1", "tab-a")[0].text).toBe("a");
    });
  });

  describe("Network 缓冲", () => {
    it("bufferNetworkRequest 创建条目", () => {
      const store = new PageInsightsStore();
      store.bufferNetworkRequest("thread-1", "tab-1", "req-1", {
        url: "https://example.com/api",
        method: "GET",
        timestamp: 1000,
      });

      expect(store.networkCount("thread-1", "tab-1")).toBe(1);
    });

    it("bufferNetworkResponse 更新响应字段", () => {
      const store = new PageInsightsStore();
      store.bufferNetworkRequest("thread-1", "tab-1", "req-1", {
        url: "https://example.com/api",
        method: "GET",
        timestamp: 1000,
      });
      store.bufferNetworkResponse("thread-1", "tab-1", "req-1", {
        status: 200,
        statusText: "OK",
        mimeType: "application/json",
      });

      const entries = store.getNetworkEntries("thread-1", "tab-1");
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe(200);
      expect(entries[0].statusText).toBe("OK");
      expect(entries[0].mimeType).toBe("application/json");
    });

    it("finalizeNetworkEntry 设置完成时间和大小", () => {
      const store = new PageInsightsStore();
      store.bufferNetworkRequest("thread-1", "tab-1", "req-1", {
        url: "https://example.com",
        method: "GET",
        timestamp: 1000,
      });
      store.bufferNetworkResponse("thread-1", "tab-1", "req-1", { status: 200 });
      store.finalizeNetworkEntry("thread-1", "tab-1", "req-1", {
        timestamp: 1500,
        encodedDataLength: 1024,
      });

      const entries = store.getNetworkEntries("thread-1", "tab-1");
      expect(entries[0].duration).toBe(500);
    });

    it("failNetworkEntry 标记失败", () => {
      const store = new PageInsightsStore();
      store.bufferNetworkRequest("thread-1", "tab-1", "req-1", {
        url: "https://example.com",
        method: "GET",
        timestamp: 1000,
      });
      store.failNetworkEntry("thread-1", "tab-1", "req-1", {
        timestamp: 1200,
        errorText: "net::ERR_CONNECTION_REFUSED",
      });

      const failed = store.getNetworkEntries("thread-1", "tab-1", "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].status).toBe(0);
    });

    it('getNetworkEntries filter="failed" 仅返回失败请求', () => {
      const store = new PageInsightsStore();
      store.bufferNetworkRequest("thread-1", "tab-1", "req-ok", {
        url: "https://ok.com",
        method: "GET",
        timestamp: 1000,
      });
      store.bufferNetworkResponse("thread-1", "tab-1", "req-ok", { status: 200 });
      store.finalizeNetworkEntry("thread-1", "tab-1", "req-ok", { timestamp: 1200 });

      store.bufferNetworkRequest("thread-1", "tab-1", "req-fail", {
        url: "https://fail.com",
        method: "POST",
        timestamp: 1100,
      });
      store.failNetworkEntry("thread-1", "tab-1", "req-fail", {
        timestamp: 1300,
        errorText: "timeout",
      });

      const failed = store.getNetworkEntries("thread-1", "tab-1", "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].url).toBe("https://fail.com");
    });

    it('getNetworkEntries filter="slow" 仅返回慢请求', () => {
      const store = new PageInsightsStore();
      // 快请求（duration=200ms）
      store.bufferNetworkRequest("thread-1", "tab-1", "req-fast", {
        url: "https://fast.com",
        method: "GET",
        timestamp: 1000,
      });
      store.finalizeNetworkEntry("thread-1", "tab-1", "req-fast", { timestamp: 1200 });

      // 慢请求（duration=2000ms）
      store.bufferNetworkRequest("thread-1", "tab-1", "req-slow", {
        url: "https://slow.com",
        method: "GET",
        timestamp: 1000,
      });
      store.finalizeNetworkEntry("thread-1", "tab-1", "req-slow", { timestamp: 3000 });

      const slow = store.getNetworkEntries("thread-1", "tab-1", "slow");
      expect(slow).toHaveLength(1);
      expect(slow[0].url).toBe("https://slow.com");
      expect(slow[0].duration).toBe(2000);
    });

    it("getNetworkEntries 应用 limit", () => {
      const store = new PageInsightsStore();
      for (let i = 0; i < 10; i++) {
        store.bufferNetworkRequest("thread-1", "tab-1", `req-${i}`, {
          url: `https://example.com/${i}`,
          method: "GET",
          timestamp: 1000 + i,
        });
      }

      const entries = store.getNetworkEntries("thread-1", "tab-1", undefined, 3);
      expect(entries).toHaveLength(3);
    });

    it("getNetworkEntries 按时间戳降序（最新在前）", () => {
      const store = new PageInsightsStore();
      store.bufferNetworkRequest("thread-1", "tab-1", "req-1", {
        url: "https://first.com",
        method: "GET",
        timestamp: 1000,
      });
      store.bufferNetworkRequest("thread-1", "tab-1", "req-2", {
        url: "https://second.com",
        method: "GET",
        timestamp: 2000,
      });

      const entries = store.getNetworkEntries("thread-1", "tab-1");
      expect(entries[0].url).toBe("https://second.com");
      expect(entries[1].url).toBe("https://first.com");
    });

    it("getNetworkEntries 空缓冲返回空数组", () => {
      const store = new PageInsightsStore();
      expect(store.getNetworkEntries("thread-1", "tab-1")).toEqual([]);
    });

    it("Network 条目 body 始终为 null", () => {
      const store = new PageInsightsStore();
      store.bufferNetworkRequest("thread-1", "tab-1", "req-1", {
        url: "https://example.com",
        method: "GET",
        timestamp: 1000,
      });
      store.bufferNetworkResponse("thread-1", "tab-1", "req-1", { status: 200 });
      store.finalizeNetworkEntry("thread-1", "tab-1", "req-1", { timestamp: 1200 });

      const entries = store.getNetworkEntries("thread-1", "tab-1");
      expect(entries[0].body).toBeNull();
    });

    it("bufferNetworkResponse 对未知 requestId 忽略", () => {
      const store = new PageInsightsStore();
      store.bufferNetworkResponse("thread-1", "tab-1", "unknown-req", { status: 200 });
      expect(store.networkCount("thread-1", "tab-1")).toBe(0);
    });

    it("Network 条目按 thread+tab 隔离", () => {
      const store = new PageInsightsStore();
      store.bufferNetworkRequest("thread-1", "tab-a", "req-1", {
        url: "https://a.com",
        method: "GET",
        timestamp: 1000,
      });
      store.bufferNetworkRequest("thread-1", "tab-b", "req-1", {
        url: "https://b.com",
        method: "GET",
        timestamp: 1000,
      });

      expect(store.getNetworkEntries("thread-1", "tab-a")).toHaveLength(1);
      expect(store.getNetworkEntries("thread-1", "tab-b")).toHaveLength(1);
      expect(store.getNetworkEntries("thread-1", "tab-a")[0].url).toBe("https://a.com");
    });
  });

  describe("清理", () => {
    it("clearTab 清理指定 tab 的 Console 和 Network", () => {
      const store = new PageInsightsStore();
      store.addConsoleEntry("thread-1", "tab-1", { level: "log", text: "msg" });
      store.bufferNetworkRequest("thread-1", "tab-1", "req-1", {
        url: "https://example.com",
        method: "GET",
        timestamp: 1000,
      });

      store.clearTab("thread-1", "tab-1");

      expect(store.consoleCount("thread-1", "tab-1")).toBe(0);
      expect(store.networkCount("thread-1", "tab-1")).toBe(0);
    });

    it("clearTab 不影响其他 tab", () => {
      const store = new PageInsightsStore();
      store.addConsoleEntry("thread-1", "tab-1", { level: "log", text: "msg1" });
      store.addConsoleEntry("thread-1", "tab-2", { level: "log", text: "msg2" });

      store.clearTab("thread-1", "tab-1");

      expect(store.consoleCount("thread-1", "tab-1")).toBe(0);
      expect(store.consoleCount("thread-1", "tab-2")).toBe(1);
    });

    it("clearThread 清理指定 thread 的所有 tab", () => {
      const store = new PageInsightsStore();
      store.addConsoleEntry("thread-1", "tab-1", { level: "log", text: "msg1" });
      store.addConsoleEntry("thread-1", "tab-2", { level: "log", text: "msg2" });
      store.addConsoleEntry("thread-2", "tab-1", { level: "log", text: "msg3" });

      const cleared = store.clearThread("thread-1");

      expect(cleared).toBe(2);
      expect(store.consoleCount("thread-1", "tab-1")).toBe(0);
      expect(store.consoleCount("thread-1", "tab-2")).toBe(0);
      expect(store.consoleCount("thread-2", "tab-1")).toBe(1);
    });

    it("clearThread 同时清理 Network", () => {
      const store = new PageInsightsStore();
      store.bufferNetworkRequest("thread-1", "tab-1", "req-1", {
        url: "https://example.com",
        method: "GET",
        timestamp: 1000,
      });

      store.clearThread("thread-1");

      expect(store.networkCount("thread-1", "tab-1")).toBe(0);
    });
  });
});
