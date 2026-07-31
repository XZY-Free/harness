import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabStoreEvent } from "./tab-store";
import { TabStore, generateTabId } from "./tab-store";

/**
 * V10 Phase 4：Browser tab 内存状态管理单元测试。
 *
 * 验证 TabStore 纯逻辑行为：Thread 级 tab 分组、active tab 管理、
 * create/close/switch/reorder/update 操作、事件订阅与多 Thread 隔离。
 * 不依赖 electron，不涉及 WebContentsView 生命周期。
 */

/** 创建 store 并收集事件，便于断言事件序列。 */
function createStoreWithEvents(): {
  store: TabStore;
  events: TabStoreEvent[];
  unsubscribe: () => void;
} {
  const store = new TabStore();
  const events: TabStoreEvent[] = [];
  const unsubscribe = store.subscribe((e) => {
    events.push(e);
  });
  return { store, events, unsubscribe };
}

describe("TabStore (V10 Phase 4)", () => {
  let store: TabStore;

  beforeEach(() => {
    store = new TabStore();
  });

  describe("Thread 初始化", () => {
    it("getThreadState 不存在的 thread 返回 null", () => {
      expect(store.getThreadState("thread-1")).toBeNull();
    });

    it("createTab 自动初始化 thread state", () => {
      store.createTab("thread-1", "https://example.com");
      const state = store.getThreadState("thread-1");
      expect(state).not.toBeNull();
      expect(state?.threadId).toBe("thread-1");
      expect(state?.tabs.size).toBe(1);
      expect(state?.tabOrder).toHaveLength(1);
    });
  });

  describe("createTab", () => {
    it("记录 URL", () => {
      const tab = store.createTab("thread-1", "https://example.com/path");
      expect(tab.url).toBe("https://example.com/path");
    });

    it("默认 incognito 为 false", () => {
      const tab = store.createTab("thread-1", "https://example.com");
      expect(tab.incognito).toBe(false);
    });

    it("incognito 标记为 true", () => {
      const tab = store.createTab("thread-1", "https://example.com", { incognito: true });
      expect(tab.incognito).toBe(true);
    });

    it("自动激活为新 active tab", () => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      const active = store.getActiveTab("thread-1");
      expect(active?.id).toBe("tab-2");
    });

    it("使用自定义 tabId", () => {
      const tab = store.createTab("thread-1", "https://example.com", { tabId: "custom-id" });
      expect(tab.id).toBe("custom-id");
      expect(store.getTab("thread-1", "custom-id")?.id).toBe("custom-id");
    });

    it("activate: false 不自动激活", () => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2", activate: false });
      // active 仍为 tab-1
      expect(store.getActiveTab("thread-1")?.id).toBe("tab-1");
    });

    it("初始 loadState 为 idle、error 为 null", () => {
      const tab = store.createTab("thread-1", "https://example.com");
      expect(tab.loadState).toBe("idle");
      expect(tab.error).toBeNull();
    });

    it("初始 canGoBack/canGoForward 为 false", () => {
      const tab = store.createTab("thread-1", "https://example.com");
      expect(tab.canGoBack).toBe(false);
      expect(tab.canGoForward).toBe(false);
    });
  });

  describe("getTabs", () => {
    it("按 tabOrder 顺序返回", () => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      store.createTab("thread-1", "https://c.com", { tabId: "tab-3" });
      const tabs = store.getTabs("thread-1");
      expect(tabs.map((t) => t.id)).toEqual(["tab-1", "tab-2", "tab-3"]);
    });

    it("不存在的 thread 返回空数组", () => {
      expect(store.getTabs("nonexistent")).toEqual([]);
    });
  });

  describe("getTab / getActiveTab", () => {
    beforeEach(() => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
    });

    it("getTab 存在返回 tab", () => {
      const tab = store.getTab("thread-1", "tab-1");
      expect(tab).not.toBeNull();
      expect(tab?.id).toBe("tab-1");
      expect(tab?.url).toBe("https://a.com");
    });

    it("getTab 不存在返回 null", () => {
      expect(store.getTab("thread-1", "nope")).toBeNull();
    });

    it("getActiveTab 存在返回 active tab", () => {
      // tab-2 是最后创建并自动激活的
      const active = store.getActiveTab("thread-1");
      expect(active?.id).toBe("tab-2");
    });

    it("getActiveTab 不存在 thread 返回 null", () => {
      expect(store.getActiveTab("nonexistent")).toBeNull();
    });

    it("getActiveTab activeTabId 为 null 返回 null", () => {
      // 关闭所有 tab 后 activeTabId 变为 null
      store.closeTab("thread-1", "tab-2");
      store.closeTab("thread-1", "tab-1");
      expect(store.getActiveTab("thread-1")).toBeNull();
    });
  });

  describe("closeTab", () => {
    it("普通关闭非 active tab 返回被关闭的 tab", () => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      const closed = store.closeTab("thread-1", "tab-1");
      expect(closed?.id).toBe("tab-1");
      expect(store.getTab("thread-1", "tab-1")).toBeNull();
      expect(store.getTabCount("thread-1")).toBe(1);
      // active 不变
      expect(store.getActiveTab("thread-1")?.id).toBe("tab-2");
    });

    it("关闭 active tab 自动切换到右侧相邻", () => {
      // [tab-1, tab-2, tab-3]，active 为 tab-2
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      store.createTab("thread-1", "https://c.com", { tabId: "tab-3" });
      store.setActiveTab("thread-1", "tab-2");
      // 关闭 tab-2，右侧相邻是 tab-3
      store.closeTab("thread-1", "tab-2");
      expect(store.getActiveTab("thread-1")?.id).toBe("tab-3");
    });

    it("关闭末尾 active tab 切换到左侧", () => {
      // [tab-1, tab-2, tab-3]，active 为 tab-3（末尾）
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      store.createTab("thread-1", "https://c.com", { tabId: "tab-3" });
      // active 为 tab-3（最后创建）
      store.closeTab("thread-1", "tab-3");
      // 末尾关闭，切换到左侧 tab-2
      expect(store.getActiveTab("thread-1")?.id).toBe("tab-2");
    });

    it("关闭最后一个 tab activeTabId 为 null", () => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.closeTab("thread-1", "tab-1");
      expect(store.getActiveTab("thread-1")).toBeNull();
      expect(store.getTabCount("thread-1")).toBe(0);
    });

    it("关闭不存在的 tab 返回 null", () => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      expect(store.closeTab("thread-1", "nope")).toBeNull();
    });

    it("不存在的 thread 返回 null", () => {
      expect(store.closeTab("nonexistent", "tab-1")).toBeNull();
    });

    it("关闭后 tabOrder 正确更新", () => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      store.createTab("thread-1", "https://c.com", { tabId: "tab-3" });
      store.closeTab("thread-1", "tab-2");
      const tabs = store.getTabs("thread-1");
      expect(tabs.map((t) => t.id)).toEqual(["tab-1", "tab-3"]);
    });
  });

  describe("setActiveTab", () => {
    beforeEach(() => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
    });

    it("切换成功返回 true", () => {
      expect(store.setActiveTab("thread-1", "tab-1")).toBe(true);
      expect(store.getActiveTab("thread-1")?.id).toBe("tab-1");
    });

    it("切换到不存在的 tab 返回 false", () => {
      expect(store.setActiveTab("thread-1", "nope")).toBe(false);
      // active 不变
      expect(store.getActiveTab("thread-1")?.id).toBe("tab-2");
    });

    it("切换到不存在的 thread 返回 false", () => {
      expect(store.setActiveTab("nonexistent", "tab-1")).toBe(false);
    });

    it("切换到当前 active tab 返回 true 且不发出事件", () => {
      const { store: s, events } = createStoreWithEvents();
      s.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      events.length = 0;
      // 当前 active 就是 tab-1
      expect(s.setActiveTab("thread-1", "tab-1")).toBe(true);
      // 不应发出 active-tab-changed 事件
      expect(events.filter((e) => e.type === "active-tab-changed")).toHaveLength(0);
    });
  });

  describe("updateTab", () => {
    beforeEach(() => {
      store.createTab("thread-1", "https://example.com", { tabId: "tab-1" });
    });

    it("更新 url", () => {
      const updated = store.updateTab("thread-1", "tab-1", { url: "https://updated.com" });
      expect(updated?.url).toBe("https://updated.com");
    });

    it("更新 title", () => {
      const updated = store.updateTab("thread-1", "tab-1", { title: "页面标题" });
      expect(updated?.title).toBe("页面标题");
    });

    it("更新 loadState", () => {
      const updated = store.updateTab("thread-1", "tab-1", { loadState: "loading" });
      expect(updated?.loadState).toBe("loading");
    });

    it("更新 canGoBack/canGoForward", () => {
      const updated = store.updateTab("thread-1", "tab-1", {
        canGoBack: true,
        canGoForward: true,
      });
      expect(updated?.canGoBack).toBe(true);
      expect(updated?.canGoForward).toBe(true);
    });

    it("更新 favicon", () => {
      const updated = store.updateTab("thread-1", "tab-1", {
        favicon: "https://icon.com/favicon.ico",
      });
      expect(updated?.favicon).toBe("https://icon.com/favicon.ico");
    });

    it("更新 error", () => {
      const updated = store.updateTab("thread-1", "tab-1", {
        loadState: "error",
        error: "网络超时",
      });
      expect(updated?.error).toBe("网络超时");
      expect(updated?.loadState).toBe("error");
    });

    it("更新 incognito", () => {
      const updated = store.updateTab("thread-1", "tab-1", { incognito: true });
      expect(updated?.incognito).toBe(true);
    });

    it("不更新 id/threadId/createdAt（即使通过类型断言传入）", () => {
      const original = store.getTab("thread-1", "tab-1");
      expect(original).not.toBeNull();
      const originalCreatedAt = original?.createdAt ?? 0;

      // 通过类型断言传入 id/threadId/createdAt，验证实现忽略它们
      const malicious = {
        url: "https://updated.com",
        id: "hijacked",
        threadId: "hijacked-thread",
        createdAt: 0,
      } as unknown as Parameters<typeof store.updateTab>[2];
      store.updateTab("thread-1", "tab-1", malicious);

      const updated = store.getTab("thread-1", "tab-1");
      expect(updated?.id).toBe("tab-1");
      expect(updated?.threadId).toBe("thread-1");
      expect(updated?.createdAt).toBe(originalCreatedAt);
      // url 应该被更新
      expect(updated?.url).toBe("https://updated.com");
    });

    it("更新后 updatedAt 大于等于 createdAt", () => {
      const updated = store.updateTab("thread-1", "tab-1", { title: "new" });
      expect(updated?.updatedAt).toBeGreaterThanOrEqual(updated?.createdAt ?? 0);
    });

    it("不存在的 thread 返回 null", () => {
      expect(store.updateTab("nonexistent", "tab-1", { title: "x" })).toBeNull();
    });

    it("不存在的 tab 返回 null", () => {
      expect(store.updateTab("thread-1", "nope", { title: "x" })).toBeNull();
    });
  });

  describe("reorderTabs", () => {
    beforeEach(() => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      store.createTab("thread-1", "https://c.com", { tabId: "tab-3" });
    });

    it("合法重排成功返回 true", () => {
      expect(store.reorderTabs("thread-1", ["tab-3", "tab-1", "tab-2"])).toBe(true);
      expect(store.getTabs("thread-1").map((t) => t.id)).toEqual(["tab-3", "tab-1", "tab-2"]);
    });

    it("数量不匹配返回 false", () => {
      expect(store.reorderTabs("thread-1", ["tab-1", "tab-2"])).toBe(false);
      // 原顺序不变
      expect(store.getTabs("thread-1").map((t) => t.id)).toEqual(["tab-1", "tab-2", "tab-3"]);
    });

    it("缺少 tab 返回 false", () => {
      // newOrder 包含不存在的 tab-99
      expect(store.reorderTabs("thread-1", ["tab-1", "tab-2", "tab-99"])).toBe(false);
    });

    it("不存在的 thread 返回 false", () => {
      expect(store.reorderTabs("nonexistent", [])).toBe(false);
    });

    it("重排相同顺序也成功", () => {
      expect(store.reorderTabs("thread-1", ["tab-1", "tab-2", "tab-3"])).toBe(true);
    });
  });

  describe("closeAllTabs", () => {
    it("清除所有 tab", () => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      store.createTab("thread-1", "https://c.com", { tabId: "tab-3" });
      store.closeAllTabs("thread-1");
      expect(store.getTabCount("thread-1")).toBe(0);
    });

    it("返回关闭数量", () => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      const count = store.closeAllTabs("thread-1");
      expect(count).toBe(2);
    });

    it("Thread 状态删除", () => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.closeAllTabs("thread-1");
      expect(store.getThreadState("thread-1")).toBeNull();
    });

    it("不存在的 thread 返回 0", () => {
      expect(store.closeAllTabs("nonexistent")).toBe(0);
    });

    it("为每个关闭的 tab 发出 tab-closed 事件", () => {
      const { store: s, events } = createStoreWithEvents();
      s.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      s.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      events.length = 0;
      s.closeAllTabs("thread-1");
      const closedEvents = events.filter((e) => e.type === "tab-closed");
      expect(closedEvents).toHaveLength(2);
    });
  });

  describe("subscribe 事件", () => {
    it("收到 tab-created 事件，payload 包含 tab 元数据", () => {
      const { store: s, events } = createStoreWithEvents();
      const tab = s.createTab("thread-1", "https://example.com", { tabId: "tab-1" });
      const created = events.filter((e) => e.type === "tab-created");
      expect(created).toHaveLength(1);
      expect(created[0]).toEqual({ type: "tab-created", tab });
    });

    it("收到 tab-closed 事件，payload 包含 tabId/threadId", () => {
      const { store: s, events } = createStoreWithEvents();
      s.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      events.length = 0;
      s.closeTab("thread-1", "tab-1");
      const closed = events.filter((e) => e.type === "tab-closed");
      expect(closed).toHaveLength(1);
      expect(closed[0]).toEqual({ type: "tab-closed", tabId: "tab-1", threadId: "thread-1" });
    });

    it("收到 tab-updated 事件，payload 包含更新后的 tab", () => {
      const { store: s, events } = createStoreWithEvents();
      s.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      events.length = 0;
      const updated = s.updateTab("thread-1", "tab-1", { title: "新标题" });
      const updatedEvents = events.filter((e) => e.type === "tab-updated");
      expect(updatedEvents).toHaveLength(1);
      expect(updated).not.toBeNull();
      expect(updatedEvents[0]).toEqual({ type: "tab-updated", tab: updated });
    });

    it("收到 active-tab-changed 事件（createTab 自动激活）", () => {
      const { store: s, events } = createStoreWithEvents();
      s.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      const changed = events.filter((e) => e.type === "active-tab-changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]).toEqual({
        type: "active-tab-changed",
        threadId: "thread-1",
        activeTabId: "tab-1",
      });
    });

    it("收到 active-tab-changed 事件（closeTab 自动切换）", () => {
      const { store: s, events } = createStoreWithEvents();
      s.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      s.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      events.length = 0;
      // 关闭 active tab-2，应自动切换
      s.closeTab("thread-1", "tab-2");
      const changed = events.filter((e) => e.type === "active-tab-changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]).toEqual({
        type: "active-tab-changed",
        threadId: "thread-1",
        activeTabId: "tab-1",
      });
    });

    it("收到 tab-reordered 事件", () => {
      const { store: s, events } = createStoreWithEvents();
      s.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      s.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      events.length = 0;
      s.reorderTabs("thread-1", ["tab-2", "tab-1"]);
      const reordered = events.filter((e) => e.type === "tab-reordered");
      expect(reordered).toHaveLength(1);
      expect(reordered[0]).toEqual({
        type: "tab-reordered",
        threadId: "thread-1",
        tabOrder: ["tab-2", "tab-1"],
      });
    });

    it("unsubscribe 后不再收到事件", () => {
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      unsubscribe();
      store.createTab("thread-1", "https://example.com");
      expect(listener).not.toHaveBeenCalled();
    });

    it("createTab activate:false 不发出 active-tab-changed 事件", () => {
      const { store: s, events } = createStoreWithEvents();
      s.createTab("thread-1", "https://a.com", { tabId: "tab-1", activate: false });
      const changed = events.filter((e) => e.type === "active-tab-changed");
      expect(changed).toHaveLength(0);
      // tab-created 仍应发出
      expect(events.filter((e) => e.type === "tab-created")).toHaveLength(1);
    });
  });

  describe("多 Thread 隔离", () => {
    it("Thread A 和 Thread B 的 tabs 独立", () => {
      store.createTab("thread-a", "https://a.com", { tabId: "tab-a1" });
      store.createTab("thread-b", "https://b.com", { tabId: "tab-b1" });
      expect(store.getTabCount("thread-a")).toBe(1);
      expect(store.getTabCount("thread-b")).toBe(1);
      expect(store.getTabs("thread-a").map((t) => t.id)).toEqual(["tab-a1"]);
      expect(store.getTabs("thread-b").map((t) => t.id)).toEqual(["tab-b1"]);
    });

    it("closeTab 不影响其他 thread", () => {
      store.createTab("thread-a", "https://a.com", { tabId: "tab-a1" });
      store.createTab("thread-a", "https://a2.com", { tabId: "tab-a2" });
      store.createTab("thread-b", "https://b.com", { tabId: "tab-b1" });
      store.closeTab("thread-a", "tab-a1");
      expect(store.getTabCount("thread-a")).toBe(1);
      expect(store.getTabCount("thread-b")).toBe(1);
      expect(store.getTab("thread-b", "tab-b1")).not.toBeNull();
    });

    it("activeTabId 各 thread 独立", () => {
      store.createTab("thread-a", "https://a.com", { tabId: "tab-a1" });
      store.createTab("thread-a", "https://a2.com", { tabId: "tab-a2" });
      store.createTab("thread-b", "https://b.com", { tabId: "tab-b1" });
      // thread-a active 是 tab-a2，thread-b active 是 tab-b1
      expect(store.getActiveTab("thread-a")?.id).toBe("tab-a2");
      expect(store.getActiveTab("thread-b")?.id).toBe("tab-b1");
      // 在 thread-b 切换 active 不影响 thread-a
      store.setActiveTab("thread-b", "tab-b1");
      expect(store.getActiveTab("thread-a")?.id).toBe("tab-a2");
    });

    it("reorderTabs 不影响其他 thread", () => {
      store.createTab("thread-a", "https://a.com", { tabId: "tab-a1" });
      store.createTab("thread-a", "https://a2.com", { tabId: "tab-a2" });
      store.createTab("thread-b", "https://b.com", { tabId: "tab-b1" });
      store.createTab("thread-b", "https://b2.com", { tabId: "tab-b2" });
      store.reorderTabs("thread-a", ["tab-a2", "tab-a1"]);
      // thread-b 顺序不变
      expect(store.getTabs("thread-b").map((t) => t.id)).toEqual(["tab-b1", "tab-b2"]);
    });
  });

  describe("getThreadIds / getTabCount", () => {
    it("getThreadIds 返回所有 thread ID", () => {
      store.createTab("thread-a", "https://a.com");
      store.createTab("thread-b", "https://b.com");
      store.createTab("thread-c", "https://c.com");
      const ids = store.getThreadIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain("thread-a");
      expect(ids).toContain("thread-b");
      expect(ids).toContain("thread-c");
    });

    it("getThreadIds 无 thread 时返回空数组", () => {
      expect(store.getThreadIds()).toEqual([]);
    });

    it("getTabCount 返回 tab 数量", () => {
      store.createTab("thread-1", "https://a.com", { tabId: "tab-1" });
      store.createTab("thread-1", "https://b.com", { tabId: "tab-2" });
      store.createTab("thread-1", "https://c.com", { tabId: "tab-3" });
      expect(store.getTabCount("thread-1")).toBe(3);
    });

    it("getTabCount 不存在的 thread 返回 0", () => {
      expect(store.getTabCount("nonexistent")).toBe(0);
    });

    it("closeAllTabs 后 getThreadIds 不再包含该 thread", () => {
      store.createTab("thread-a", "https://a.com");
      store.createTab("thread-b", "https://b.com");
      store.closeAllTabs("thread-a");
      const ids = store.getThreadIds();
      expect(ids).toEqual(["thread-b"]);
    });
  });

  describe("generateTabId", () => {
    it("生成 tab_ 前缀的唯一 ID", () => {
      const id = generateTabId();
      expect(id).toMatch(/^tab_/);
      expect(typeof id).toBe("string");
    });

    it("多次调用生成不同 ID", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateTabId());
      }
      // 由于 timestamp + random，100 次调用应全部唯一
      expect(ids.size).toBe(100);
    });
  });
});
