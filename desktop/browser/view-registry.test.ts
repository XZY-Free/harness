import { beforeEach, describe, expect, it } from "vitest";
import { ViewRegistry } from "./view-registry";

/**
 * V10 Phase 4：View 注册表单元测试。
 *
 * 验证 ViewRegistry 纯逻辑行为：threadId+tabId → view 映射、
 * active view 切换、显示/隐藏变更计算、多 Thread 隔离与销毁。
 * 不依赖 electron，view 使用简单对象字面量注入。
 */

/** 简单 view 句柄，仅用于引用比对。 */
interface FakeView {
  id: string;
  label: string;
}

/** 创建一个测试用 view。 */
function makeView(id: string, label = id): FakeView {
  return { id, label };
}

describe("ViewRegistry (V10 Phase 4)", () => {
  let registry: ViewRegistry<FakeView>;

  beforeEach(() => {
    registry = new ViewRegistry<FakeView>();
  });

  describe("set + get", () => {
    it("set 注册并可通过 get 获取", () => {
      const view = makeView("v1");
      registry.set("thread-1", "tab-1", view);
      expect(registry.get("thread-1", "tab-1")).toBe(view);
    });

    it("set 默认将 view 设为 active", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      expect(registry.getActiveTabId("thread-1")).toBe("tab-1");
    });

    it("set 重复 tabId 覆盖旧 view 但保留 active 状态", () => {
      const old = makeView("v1", "old");
      const next = makeView("v2", "new");
      registry.set("thread-1", "tab-1", old);
      registry.set("thread-1", "tab-1", next);
      expect(registry.get("thread-1", "tab-1")).toBe(next);
      expect(registry.getCount("thread-1")).toBe(1);
      // active 仍为 tab-1
      expect(registry.isActive("thread-1", "tab-1")).toBe(true);
    });
  });

  describe("set with activate=false", () => {
    it("activate=false 不设为 active", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      registry.set("thread-1", "tab-2", makeView("v2"), false);
      // active 仍为 tab-1
      expect(registry.getActiveTabId("thread-1")).toBe("tab-1");
      // 但 view 已注册
      expect(registry.get("thread-1", "tab-2")).toBeDefined();
      expect(registry.isActive("thread-1", "tab-2")).toBe(false);
    });

    it("首个 view 用 activate=false 注册时 active 为空", () => {
      registry.set("thread-1", "tab-1", makeView("v1"), false);
      expect(registry.getActiveTabId("thread-1")).toBeUndefined();
      expect(registry.getActiveView("thread-1")).toBeUndefined();
    });
  });

  describe("get", () => {
    it("不存在的 thread 返回 undefined", () => {
      expect(registry.get("nonexistent", "tab-1")).toBeUndefined();
    });

    it("存在的 thread 不存在的 tab 返回 undefined", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      expect(registry.get("thread-1", "nope")).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("delete 删除非 active view 返回被删除的 view", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      const v2 = makeView("v2");
      registry.set("thread-1", "tab-2", v2, false);
      const deleted = registry.delete("thread-1", "tab-2");
      expect(deleted).toBe(v2);
      // active 不变
      expect(registry.getActiveTabId("thread-1")).toBe("tab-1");
    });

    it("delete 删除 active view 后 active 标记清除（不自动切换）", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      registry.set("thread-1", "tab-2", makeView("v2"), false);
      // 删除 active（tab-1）
      registry.delete("thread-1", "tab-1");
      expect(registry.getActiveTabId("thread-1")).toBeUndefined();
      expect(registry.isActive("thread-1", "tab-1")).toBe(false);
      // tab-2 仍存在
      expect(registry.get("thread-1", "tab-2")).toBeDefined();
    });

    it("delete 删除最后一个 view 后 Thread 整体清理", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      const deleted = registry.delete("thread-1", "tab-1");
      expect(deleted).toBeDefined();
      // Thread 不再存在
      expect(registry.getCount("thread-1")).toBe(0);
      expect(registry.getViewIds("thread-1")).toEqual([]);
      expect(registry.getActiveTabId("thread-1")).toBeUndefined();
      expect(registry.getThreadIds()).not.toContain("thread-1");
    });

    it("delete 不存在的 thread 返回 undefined", () => {
      expect(registry.delete("nonexistent", "tab-1")).toBeUndefined();
    });

    it("delete 不存在的 tab 返回 undefined", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      expect(registry.delete("thread-1", "nope")).toBeUndefined();
    });
  });

  describe("setActive", () => {
    beforeEach(() => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      registry.set("thread-1", "tab-2", makeView("v2"), false);
    });

    it("设置已存在的 tab 为 active 返回 true", () => {
      expect(registry.setActive("thread-1", "tab-2")).toBe(true);
      expect(registry.getActiveTabId("thread-1")).toBe("tab-2");
      expect(registry.isActive("thread-1", "tab-2")).toBe(true);
      // 旧 active 不再 active
      expect(registry.isActive("thread-1", "tab-1")).toBe(false);
    });

    it("设置不存在的 tab 为 active 返回 false", () => {
      expect(registry.setActive("thread-1", "nope")).toBe(false);
      // active 不变
      expect(registry.getActiveTabId("thread-1")).toBe("tab-1");
    });

    it("设置不存在的 thread 为 active 返回 false", () => {
      expect(registry.setActive("nonexistent", "tab-1")).toBe(false);
    });

    it("重复设置当前 active 无副作用", () => {
      expect(registry.setActive("thread-1", "tab-1")).toBe(true);
      expect(registry.setActive("thread-1", "tab-1")).toBe(true);
      expect(registry.getActiveTabId("thread-1")).toBe("tab-1");
    });
  });

  describe("getActiveTabId", () => {
    it("存在的 Thread 有 active 返回 tabId", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      expect(registry.getActiveTabId("thread-1")).toBe("tab-1");
    });

    it("不存在的 Thread 返回 undefined", () => {
      expect(registry.getActiveTabId("nonexistent")).toBeUndefined();
    });

    it("删除 active 后返回 undefined", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      registry.delete("thread-1", "tab-1");
      expect(registry.getActiveTabId("thread-1")).toBeUndefined();
    });
  });

  describe("getActiveView", () => {
    it("存在的 active view 返回实例", () => {
      const v1 = makeView("v1");
      registry.set("thread-1", "tab-1", v1);
      expect(registry.getActiveView("thread-1")).toBe(v1);
    });

    it("不存在的 Thread 返回 undefined", () => {
      expect(registry.getActiveView("nonexistent")).toBeUndefined();
    });

    it("Thread 存在但无 active 返回 undefined", () => {
      registry.set("thread-1", "tab-1", makeView("v1"), false);
      expect(registry.getActiveView("thread-1")).toBeUndefined();
    });
  });

  describe("getViewIds", () => {
    it("返回 Thread 中所有 tabId", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      registry.set("thread-1", "tab-2", makeView("v2"), false);
      registry.set("thread-1", "tab-3", makeView("v3"), false);
      const ids = registry.getViewIds("thread-1");
      expect(ids).toHaveLength(3);
      expect(ids).toContain("tab-1");
      expect(ids).toContain("tab-2");
      expect(ids).toContain("tab-3");
    });

    it("不存在的 Thread 返回空数组", () => {
      expect(registry.getViewIds("nonexistent")).toEqual([]);
    });
  });

  describe("getCount", () => {
    it("返回 Thread 中 view 数量", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      registry.set("thread-1", "tab-2", makeView("v2"), false);
      expect(registry.getCount("thread-1")).toBe(2);
    });

    it("不存在的 Thread 返回 0", () => {
      expect(registry.getCount("nonexistent")).toBe(0);
    });

    it("delete 后数量更新", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      registry.set("thread-1", "tab-2", makeView("v2"), false);
      registry.delete("thread-1", "tab-1");
      expect(registry.getCount("thread-1")).toBe(1);
    });
  });

  describe("isActive", () => {
    it("active view 返回 true", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      expect(registry.isActive("thread-1", "tab-1")).toBe(true);
    });

    it("非 active view 返回 false", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      registry.set("thread-1", "tab-2", makeView("v2"), false);
      expect(registry.isActive("thread-1", "tab-2")).toBe(false);
    });

    it("不存在的 Thread 返回 false", () => {
      expect(registry.isActive("nonexistent", "tab-1")).toBe(false);
    });
  });

  describe("getActivationChange", () => {
    it("切换到新 view 返回 show+hide", () => {
      const v1 = makeView("v1");
      const v2 = makeView("v2");
      registry.set("thread-1", "tab-1", v1);
      registry.set("thread-1", "tab-2", v2, false);
      const change = registry.getActivationChange("thread-1", "tab-2");
      expect(change).not.toBeNull();
      expect(change?.show).toBe(v2);
      expect(change?.hide).toBe(v1);
    });

    it("切换到当前 active view 不返回 hide", () => {
      const v1 = makeView("v1");
      registry.set("thread-1", "tab-1", v1);
      const change = registry.getActivationChange("thread-1", "tab-1");
      expect(change).not.toBeNull();
      expect(change?.show).toBe(v1);
      expect(change?.hide).toBeUndefined();
    });

    it("切换到不存在的 tab 返回 null", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      expect(registry.getActivationChange("thread-1", "nope")).toBeNull();
    });

    it("切换到不存在的 Thread 返回 null", () => {
      expect(registry.getActivationChange("nonexistent", "tab-1")).toBeNull();
    });

    it("无旧 active 时只返回 show", () => {
      const v1 = makeView("v1");
      registry.set("thread-1", "tab-1", v1, false);
      const change = registry.getActivationChange("thread-1", "tab-1");
      expect(change).not.toBeNull();
      expect(change?.show).toBe(v1);
      expect(change?.hide).toBeUndefined();
    });

    it("不修改 activeViews 状态（只读查询）", () => {
      const v1 = makeView("v1");
      const v2 = makeView("v2");
      registry.set("thread-1", "tab-1", v1);
      registry.set("thread-1", "tab-2", v2, false);
      registry.getActivationChange("thread-1", "tab-2");
      // active 仍是 tab-1
      expect(registry.getActiveTabId("thread-1")).toBe("tab-1");
    });
  });

  describe("clearThread", () => {
    it("返回所有 view 供销毁", () => {
      const v1 = makeView("v1");
      const v2 = makeView("v2");
      const v3 = makeView("v3");
      registry.set("thread-1", "tab-1", v1);
      registry.set("thread-1", "tab-2", v2, false);
      registry.set("thread-1", "tab-3", v3, false);
      const views = registry.clearThread("thread-1");
      expect(views).toHaveLength(3);
      expect(views).toContain(v1);
      expect(views).toContain(v2);
      expect(views).toContain(v3);
    });

    it("清除后 getThreadIds 不再包含该 thread", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      registry.set("thread-2", "tab-1", makeView("v2"));
      registry.clearThread("thread-1");
      const ids = registry.getThreadIds();
      expect(ids).not.toContain("thread-1");
      expect(ids).toContain("thread-2");
    });

    it("清除后 getCount 返回 0、getActiveTabId 返回 undefined", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      registry.clearThread("thread-1");
      expect(registry.getCount("thread-1")).toBe(0);
      expect(registry.getActiveTabId("thread-1")).toBeUndefined();
      expect(registry.getViewIds("thread-1")).toEqual([]);
    });

    it("再次 clearThread 返回空数组", () => {
      registry.set("thread-1", "tab-1", makeView("v1"));
      registry.clearThread("thread-1");
      expect(registry.clearThread("thread-1")).toEqual([]);
    });

    it("clearThread 不存在的 thread 返回空数组", () => {
      expect(registry.clearThread("nonexistent")).toEqual([]);
    });
  });

  describe("getThreadIds", () => {
    it("返回所有有 view 的 Thread ID", () => {
      registry.set("thread-a", "tab-1", makeView("v1"));
      registry.set("thread-b", "tab-1", makeView("v2"));
      registry.set("thread-c", "tab-1", makeView("v3"));
      const ids = registry.getThreadIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain("thread-a");
      expect(ids).toContain("thread-b");
      expect(ids).toContain("thread-c");
    });

    it("无 view 时返回空数组", () => {
      expect(registry.getThreadIds()).toEqual([]);
    });
  });

  describe("多 Thread 隔离", () => {
    it("Thread A 和 Thread B 的 view 独立", () => {
      const va = makeView("va");
      const vb = makeView("vb");
      registry.set("thread-a", "tab-1", va);
      registry.set("thread-b", "tab-1", vb);
      // 同一 tabId 在不同 thread 下指向不同 view
      expect(registry.get("thread-a", "tab-1")).toBe(va);
      expect(registry.get("thread-b", "tab-1")).toBe(vb);
      expect(registry.getCount("thread-a")).toBe(1);
      expect(registry.getCount("thread-b")).toBe(1);
    });

    it("Thread A 和 Thread B 的 active 独立", () => {
      registry.set("thread-a", "tab-1", makeView("va1"));
      registry.set("thread-a", "tab-2", makeView("va2"), false);
      registry.set("thread-b", "tab-1", makeView("vb1"));
      // thread-a active=tab-1，thread-b active=tab-1
      expect(registry.getActiveTabId("thread-a")).toBe("tab-1");
      expect(registry.getActiveTabId("thread-b")).toBe("tab-1");
      // 切换 thread-b 的 active 不影响 thread-a
      registry.setActive("thread-b", "tab-1");
      expect(registry.getActiveTabId("thread-a")).toBe("tab-1");
    });

    it("delete 一个 thread 不影响另一个 thread", () => {
      const va = makeView("va");
      const vb = makeView("vb");
      registry.set("thread-a", "tab-1", va);
      registry.set("thread-b", "tab-1", vb);
      registry.delete("thread-a", "tab-1");
      // thread-b 仍存在
      expect(registry.get("thread-b", "tab-1")).toBe(vb);
      expect(registry.getCount("thread-b")).toBe(1);
      expect(registry.getThreadIds()).toContain("thread-b");
    });

    it("clearThread 一个 thread 不影响另一个 thread", () => {
      const va = makeView("va");
      const vb = makeView("vb");
      registry.set("thread-a", "tab-1", va);
      registry.set("thread-b", "tab-1", vb);
      registry.clearThread("thread-a");
      expect(registry.get("thread-b", "tab-1")).toBe(vb);
      expect(registry.getThreadIds()).toEqual(["thread-b"]);
    });
  });
});
