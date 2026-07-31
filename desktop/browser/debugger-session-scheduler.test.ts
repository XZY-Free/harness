/**
 * V10 Phase 6：DebuggerSession 调度器测试。
 */
import { describe, expect, it, vi } from "vitest";
import { DebuggerSessionScheduler, type DebuggerSessionTarget } from "./debugger-session-scheduler";

function createMockTarget(): DebuggerSessionTarget & {
  attachCalls: number;
  detachCalls: number;
  sendCommandCalls: Array<{ method: string; params?: unknown }>;
  attached: boolean;
} {
  const mock = {
    attachCalls: 0,
    detachCalls: 0,
    sendCommandCalls: [] as Array<{ method: string; params?: unknown }>,
    attached: false,
    attach() {
      mock.attachCalls += 1;
      mock.attached = true;
    },
    detach() {
      mock.detachCalls += 1;
      mock.attached = false;
    },
    async sendCommand(method: string, params?: unknown) {
      mock.sendCommandCalls.push({ method, params });
      return { ok: true, result: { method, params } };
    },
    isAttached() {
      return mock.attached;
    },
  };
  return mock;
}

describe("DebuggerSessionScheduler", () => {
  describe("acquire", () => {
    it("首次 acquire 创建 session 并 attach", async () => {
      const target = createMockTarget();
      const scheduler = new DebuggerSessionScheduler(() => target);

      const result = await scheduler.acquire("t1", "tab1");

      expect(result).toBe(target);
      expect(target.attachCalls).toBe(1);
      expect(scheduler.hasSession("t1", "tab1")).toBe(true);
      expect(scheduler.getRefCount("t1", "tab1")).toBe(1);
    });

    it("重复 acquire 复用 session，不重复 attach", async () => {
      const target = createMockTarget();
      const scheduler = new DebuggerSessionScheduler(() => target);

      await scheduler.acquire("t1", "tab1");
      const result2 = await scheduler.acquire("t1", "tab1");

      expect(result2).toBe(target);
      expect(target.attachCalls).toBe(1);
      expect(scheduler.getRefCount("t1", "tab1")).toBe(2);
    });

    it("不同 tabId 创建独立 session", async () => {
      const target1 = createMockTarget();
      const target2 = createMockTarget();
      let callCount = 0;
      const scheduler = new DebuggerSessionScheduler(() => {
        callCount += 1;
        return callCount === 1 ? target1 : target2;
      });

      await scheduler.acquire("t1", "tab1");
      await scheduler.acquire("t1", "tab2");

      expect(target1.attachCalls).toBe(1);
      expect(target2.attachCalls).toBe(1);
      expect(scheduler.hasSession("t1", "tab1")).toBe(true);
      expect(scheduler.hasSession("t1", "tab2")).toBe(true);
    });

    it("target 已 attached 时不重复 attach", async () => {
      const target = createMockTarget();
      target.attached = true;
      const scheduler = new DebuggerSessionScheduler(() => target);

      await scheduler.acquire("t1", "tab1");

      expect(target.attachCalls).toBe(0);
    });

    it("factory 返回 null 时 acquire 返回 null", async () => {
      const scheduler = new DebuggerSessionScheduler(() => null);

      const result = await scheduler.acquire("t1", "tab1");

      expect(result).toBeNull();
      expect(scheduler.hasSession("t1", "tab1")).toBe(false);
    });

    it("attach 抛出异常时 acquire 返回 null 且不记录 session", async () => {
      const target = createMockTarget();
      target.attach = () => {
        throw new Error("attach failed");
      };
      const scheduler = new DebuggerSessionScheduler(() => target);

      const result = await scheduler.acquire("t1", "tab1");

      expect(result).toBeNull();
      expect(scheduler.hasSession("t1", "tab1")).toBe(false);
    });
  });

  describe("release", () => {
    it("引用计数归零时 detach 并清理", async () => {
      const target = createMockTarget();
      const scheduler = new DebuggerSessionScheduler(() => target);

      await scheduler.acquire("t1", "tab1");
      scheduler.release("t1", "tab1");

      expect(target.detachCalls).toBe(1);
      expect(scheduler.hasSession("t1", "tab1")).toBe(false);
    });

    it("多次 acquire 需要对应次数 release 才能 detach", async () => {
      const target = createMockTarget();
      const scheduler = new DebuggerSessionScheduler(() => target);

      await scheduler.acquire("t1", "tab1");
      await scheduler.acquire("t1", "tab1");

      scheduler.release("t1", "tab1");
      expect(target.detachCalls).toBe(0);
      expect(scheduler.hasSession("t1", "tab1")).toBe(true);

      scheduler.release("t1", "tab1");
      expect(target.detachCalls).toBe(1);
      expect(scheduler.hasSession("t1", "tab1")).toBe(false);
    });

    it("release 不存在的 session 不抛异常", () => {
      const scheduler = new DebuggerSessionScheduler(() => null);

      expect(() => scheduler.release("t1", "tab1")).not.toThrow();
    });

    it("release 后可重新 acquire", async () => {
      const target = createMockTarget();
      let callCount = 0;
      const scheduler = new DebuggerSessionScheduler(() => {
        callCount += 1;
        return target;
      });

      await scheduler.acquire("t1", "tab1");
      scheduler.release("t1", "tab1");
      const result = await scheduler.acquire("t1", "tab1");

      expect(result).toBe(target);
      expect(target.attachCalls).toBe(2);
    });

    it("detach 抛出异常时仍清理 session", async () => {
      const target = createMockTarget();
      target.detach = () => {
        throw new Error("detach failed");
      };
      const scheduler = new DebuggerSessionScheduler(() => target);

      await scheduler.acquire("t1", "tab1");
      expect(() => scheduler.release("t1", "tab1")).not.toThrow();
      expect(scheduler.hasSession("t1", "tab1")).toBe(false);
    });
  });

  describe("sendCommand", () => {
    it("自动 acquire + release，发送 CDP 命令", async () => {
      const target = createMockTarget();
      const scheduler = new DebuggerSessionScheduler(() => target);

      const result = await scheduler.sendCommand("t1", "tab1", "DOM.getDocument", { depth: 1 });

      expect(result.ok).toBe(true);
      expect(target.sendCommandCalls).toHaveLength(1);
      expect(target.sendCommandCalls[0]).toEqual({
        method: "DOM.getDocument",
        params: { depth: 1 },
      });
      expect(scheduler.hasSession("t1", "tab1")).toBe(false);
    });

    it("tab 不存在时返回 tab_not_found", async () => {
      const scheduler = new DebuggerSessionScheduler(() => null);

      const result = await scheduler.sendCommand("t1", "tab1", "DOM.getDocument");

      expect(result.ok).toBe(false);
      expect(result.error).toBe("tab_not_found");
    });

    it("sendCommand 异常时仍释放 session", async () => {
      const target = createMockTarget();
      target.sendCommand = async () => {
        throw new Error("cdp error");
      };
      const scheduler = new DebuggerSessionScheduler(() => target);

      await expect(scheduler.sendCommand("t1", "tab1", "DOM.getDocument")).rejects.toThrow();
      expect(scheduler.hasSession("t1", "tab1")).toBe(false);
    });
  });

  describe("hasSession / getRefCount", () => {
    it("未 acquire 的 tab 返回 false / 0", () => {
      const scheduler = new DebuggerSessionScheduler(() => null);

      expect(scheduler.hasSession("t1", "tab1")).toBe(false);
      expect(scheduler.getRefCount("t1", "tab1")).toBe(0);
    });
  });

  describe("clearThread", () => {
    it("清理指定 Thread 的所有 session", async () => {
      const target1 = createMockTarget();
      const target2 = createMockTarget();
      let callCount = 0;
      const scheduler = new DebuggerSessionScheduler(() => {
        callCount += 1;
        return callCount === 1 ? target1 : target2;
      });

      await scheduler.acquire("t1", "tab1");
      await scheduler.acquire("t1", "tab2");
      await scheduler.acquire("t2", "tab3");

      const cleared = scheduler.clearThread("t1");

      expect(cleared).toBe(2);
      expect(target1.detachCalls).toBe(1);
      expect(target2.detachCalls).toBe(1);
      expect(scheduler.hasSession("t1", "tab1")).toBe(false);
      expect(scheduler.hasSession("t1", "tab2")).toBe(false);
      expect(scheduler.hasSession("t2", "tab3")).toBe(true);
    });

    it("清理不存在的 Thread 返回 0", () => {
      const scheduler = new DebuggerSessionScheduler(() => null);
      expect(scheduler.clearThread("nonexistent")).toBe(0);
    });
  });

  describe("clearAll", () => {
    it("清理所有 session", async () => {
      const target1 = createMockTarget();
      const target2 = createMockTarget();
      let callCount = 0;
      const scheduler = new DebuggerSessionScheduler(() => {
        callCount += 1;
        return callCount === 1 ? target1 : target2;
      });

      await scheduler.acquire("t1", "tab1");
      await scheduler.acquire("t2", "tab2");

      scheduler.clearAll();

      expect(target1.detachCalls).toBe(1);
      expect(target2.detachCalls).toBe(1);
      expect(scheduler.hasSession("t1", "tab1")).toBe(false);
      expect(scheduler.hasSession("t2", "tab2")).toBe(false);
    });

    it("detach 异常时不影响其他 session 清理", async () => {
      const target1 = createMockTarget();
      target1.detach = () => {
        throw new Error("detach failed");
      };
      const target2 = createMockTarget();
      let callCount = 0;
      const scheduler = new DebuggerSessionScheduler(() => {
        callCount += 1;
        return callCount === 1 ? target1 : target2;
      });

      await scheduler.acquire("t1", "tab1");
      await scheduler.acquire("t1", "tab2");

      expect(() => scheduler.clearAll()).not.toThrow();
      expect(target2.detachCalls).toBe(1);
      expect(scheduler.hasSession("t1", "tab1")).toBe(false);
      expect(scheduler.hasSession("t1", "tab2")).toBe(false);
    });
  });

  describe("跨 Thread 隔离", () => {
    it("不同 Thread 的 session 互不影响", async () => {
      const target1 = createMockTarget();
      const target2 = createMockTarget();
      let callCount = 0;
      const scheduler = new DebuggerSessionScheduler(() => {
        callCount += 1;
        return callCount === 1 ? target1 : target2;
      });

      await scheduler.acquire("t1", "tab1");
      await scheduler.acquire("t2", "tab1");

      scheduler.release("t1", "tab1");

      expect(target1.detachCalls).toBe(1);
      expect(target2.detachCalls).toBe(0);
      expect(scheduler.hasSession("t1", "tab1")).toBe(false);
      expect(scheduler.hasSession("t2", "tab1")).toBe(true);
    });
  });
});
