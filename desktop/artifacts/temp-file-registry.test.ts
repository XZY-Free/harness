/**
 * V10 Phase 7-6：TempFileRegistry 单元测试。
 *
 * 纯逻辑模块——不接触文件系统，只管理内存中的注册表。
 * 测试覆盖：register/unregister/has/listByThread/clearThread/clearAll/幂等/隔离。
 */
import { describe, expect, it } from "vitest";
import { TempFileRegistry } from "./temp-file-registry";

describe("TempFileRegistry", () => {
  describe("register", () => {
    it("注册后可通过 listByThread 查询到，含 threadId/filePath/category/registeredAt", () => {
      const registry = new TempFileRegistry();
      const entry = registry.register("t1", "/tmp/a.png", "screenshot");
      expect(entry.threadId).toBe("t1");
      expect(entry.filePath).toBe("/tmp/a.png");
      expect(entry.category).toBe("screenshot");
      expect(typeof entry.registeredAt).toBe("number");

      const list = registry.listByThread("t1");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(entry);
    });

    it("幂等：同 filePath 重复注册只保留一条（更新 category）", () => {
      const registry = new TempFileRegistry();
      registry.register("t1", "/tmp/a.png", "screenshot");
      const updated = registry.register("t1", "/tmp/a.png", "artifact");

      expect(registry.size()).toBe(1);
      expect(updated.category).toBe("artifact");
      expect(updated.filePath).toBe("/tmp/a.png");
    });

    it("同 filePath 不同 threadId 时更新为新 threadId（文件归属变更）", () => {
      const registry = new TempFileRegistry();
      registry.register("t1", "/tmp/a.png", "screenshot");
      registry.register("t2", "/tmp/a.png", "screenshot");

      expect(registry.listByThread("t1")).toHaveLength(0);
      expect(registry.listByThread("t2")).toHaveLength(1);
    });

    it("支持全部三种 category（screenshot/download/artifact）", () => {
      const registry = new TempFileRegistry();
      registry.register("t1", "/tmp/a.png", "screenshot");
      registry.register("t1", "/tmp/b.bin", "download");
      registry.register("t1", "/tmp/c.json", "artifact");

      const list = registry.listByThread("t1");
      expect(list.map((e) => e.category).sort()).toEqual(["artifact", "download", "screenshot"]);
    });
  });

  describe("unregister", () => {
    it("已注册路径可移除，返回被移除的条目", () => {
      const registry = new TempFileRegistry();
      registry.register("t1", "/tmp/a.png", "screenshot");
      const removed = registry.unregister("/tmp/a.png");

      expect(removed).toBeDefined();
      expect(removed?.filePath).toBe("/tmp/a.png");
      expect(registry.has("/tmp/a.png")).toBe(false);
      expect(registry.listByThread("t1")).toHaveLength(0);
    });

    it("未注册路径返回 undefined，不抛出", () => {
      const registry = new TempFileRegistry();
      expect(registry.unregister("/tmp/non-existent")).toBeUndefined();
    });
  });

  describe("has", () => {
    it("未注册返回 false，已注册返回 true", () => {
      const registry = new TempFileRegistry();
      expect(registry.has("/tmp/a.png")).toBe(false);
      registry.register("t1", "/tmp/a.png", "screenshot");
      expect(registry.has("/tmp/a.png")).toBe(true);
    });
  });

  describe("listByThread", () => {
    it("仅返回该 thread 的条目，按注册时间升序", () => {
      const registry = new TempFileRegistry();
      registry.register("t1", "/tmp/a.png", "screenshot");
      registry.register("t2", "/tmp/b.bin", "download");
      registry.register("t1", "/tmp/c.json", "artifact");

      const list = registry.listByThread("t1");
      expect(list).toHaveLength(2);
      expect(list[0].filePath).toBe("/tmp/a.png");
      expect(list[1].filePath).toBe("/tmp/c.json");
    });

    it("不存在的 thread 返回空数组", () => {
      const registry = new TempFileRegistry();
      expect(registry.listByThread("non-existent")).toEqual([]);
    });

    it("返回值是只读快照，修改不影响内部状态", () => {
      const registry = new TempFileRegistry();
      registry.register("t1", "/tmp/a.png", "screenshot");
      const list = registry.listByThread("t1");
      // 修改返回的数组不应影响 registry 内部状态
      list.length = 0;
      expect(registry.listByThread("t1")).toHaveLength(1);
    });
  });

  describe("clearThread", () => {
    it("移除并返回该 thread 的所有条目", () => {
      const registry = new TempFileRegistry();
      registry.register("t1", "/tmp/a.png", "screenshot");
      registry.register("t2", "/tmp/b.bin", "download");
      registry.register("t1", "/tmp/c.json", "artifact");

      const removed = registry.clearThread("t1");
      expect(removed).toHaveLength(2);
      expect(removed.map((e) => e.filePath).sort()).toEqual(["/tmp/a.png", "/tmp/c.json"]);

      expect(registry.listByThread("t1")).toHaveLength(0);
      // 其他 thread 不受影响
      expect(registry.listByThread("t2")).toHaveLength(1);
    });

    it("不存在的 thread 返回空数组，不抛出", () => {
      const registry = new TempFileRegistry();
      expect(registry.clearThread("non-existent")).toEqual([]);
    });

    it("多次调用同一 thread，第二次返回空数组", () => {
      const registry = new TempFileRegistry();
      registry.register("t1", "/tmp/a.png", "screenshot");
      registry.clearThread("t1");
      expect(registry.clearThread("t1")).toEqual([]);
    });
  });

  describe("clearAll", () => {
    it("移除并返回所有 thread 的所有条目", () => {
      const registry = new TempFileRegistry();
      registry.register("t1", "/tmp/a.png", "screenshot");
      registry.register("t2", "/tmp/b.bin", "download");
      registry.register("t1", "/tmp/c.json", "artifact");

      const removed = registry.clearAll();
      expect(removed).toHaveLength(3);
      expect(registry.size()).toBe(0);
    });

    it("空注册表返回空数组", () => {
      const registry = new TempFileRegistry();
      expect(registry.clearAll()).toEqual([]);
    });
  });

  describe("size", () => {
    it("返回所有 thread 的总条目数", () => {
      const registry = new TempFileRegistry();
      expect(registry.size()).toBe(0);
      registry.register("t1", "/tmp/a.png", "screenshot");
      registry.register("t1", "/tmp/b.bin", "download");
      registry.register("t2", "/tmp/c.json", "artifact");
      expect(registry.size()).toBe(3);
    });

    it("幂等 register 不增加 size", () => {
      const registry = new TempFileRegistry();
      registry.register("t1", "/tmp/a.png", "screenshot");
      registry.register("t1", "/tmp/a.png", "artifact");
      expect(registry.size()).toBe(1);
    });
  });
});
