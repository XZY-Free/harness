/**
 * V10 Phase 7-6：temp-cleanup 测试（真实文件系统，非 mock）。
 *
 * 使用 os.tmpdir() 下创建真实临时文件验证 unlink 行为，
 * 不使用 mock fs——确保生产同构约束。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupAllTempFiles,
  cleanupTempFiles,
  cleanupThreadTempFiles,
  safeUnlink,
} from "./temp-cleanup";
import { TempFileRegistry } from "./temp-file-registry";
import type { TempFileEntry } from "./temp-file-registry";

describe("temp-cleanup", () => {
  const tempFiles: string[] = [];
  const tempDirs: string[] = [];

  /** 创建真实临时文件（mode 0600）。 */
  function createTempFile(content = "test"): string {
    const p = path.join(
      os.tmpdir(),
      `snow-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    fs.writeFileSync(p, content, { mode: 0o600 });
    tempFiles.push(p);
    return p;
  }

  /** 创建临时目录。 */
  function createTempDir(): string {
    const d = path.join(
      os.tmpdir(),
      `snow-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(d, { recursive: true });
    tempDirs.push(d);
    return d;
  }

  function makeEntry(
    filePath: string,
    category: TempFileEntry["category"] = "screenshot",
  ): TempFileEntry {
    return {
      threadId: "t1",
      filePath,
      category,
      registeredAt: Date.now(),
    };
  }

  afterEach(() => {
    for (const p of tempFiles) {
      try {
        fs.unlinkSync(p);
      } catch {
        // 忽略
      }
    }
    for (const d of tempDirs) {
      try {
        fs.rmdirSync(d);
      } catch {
        // 忽略
      }
    }
    tempFiles.length = 0;
    tempDirs.length = 0;
  });

  describe("safeUnlink", () => {
    it("存在的文件被删除，返回 true", async () => {
      const p = createTempFile("hello");
      const result = await safeUnlink(p);
      expect(result).toBe(true);
      expect(fs.existsSync(p)).toBe(false);
    });

    it("文件不存在时返回 true（幂等，不抛 ENOENT）", async () => {
      const result = await safeUnlink(
        path.join(
          os.tmpdir(),
          `snow-not-exist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ),
      );
      expect(result).toBe(true);
    });

    it("路径是目录时返回 false（不抛 EISDIR）", async () => {
      const d = createTempDir();
      const result = await safeUnlink(d);
      expect(result).toBe(false);
      expect(fs.existsSync(d)).toBe(true);
    });

    it("权限不足时返回 false（不抛）", async () => {
      // 创建一个只读目录里的文件
      const d = createTempDir();
      const p = path.join(d, "readonly.tmp");
      fs.writeFileSync(p, "test", { mode: 0o600 });
      tempFiles.push(p);
      // 父目录设为 0o500 (r-x) — unlink 需要写父目录
      // 注意：此测试在 root 用户下可能不生效（root 可绕过权限）
      // 使用 try/finally 确保权限恢复，避免影响后续测试
      fs.chmodSync(d, 0o500);
      try {
        const result = await safeUnlink(p);
        expect(result).toBe(false);
        expect(fs.existsSync(p)).toBe(true);
      } finally {
        // 恢复权限以便 afterEach 清理
        fs.chmodSync(d, 0o700);
      }
    });
  });

  describe("cleanupTempFiles", () => {
    it("空数组返回 0", async () => {
      const count = await cleanupTempFiles([]);
      expect(count).toBe(0);
    });

    it("删除所有条目并返回成功数（含文件不存在的也算成功）", async () => {
      const a = createTempFile("a");
      const b = createTempFile("b");
      const entries: TempFileEntry[] = [
        makeEntry(a, "screenshot"),
        makeEntry(b, "download"),
        makeEntry("/tmp/snow-non-existent-xyz", "artifact"),
      ];
      const count = await cleanupTempFiles(entries);
      // 不存在的文件返回 true（safeUnlink 幂等），所以全部算成功
      expect(count).toBe(3);
      expect(fs.existsSync(a)).toBe(false);
      expect(fs.existsSync(b)).toBe(false);
    });

    it("部分文件是目录时返回真正清理的数量", async () => {
      const a = createTempFile("a");
      const d = createTempDir();
      const entries: TempFileEntry[] = [makeEntry(a, "screenshot"), makeEntry(d, "download")];
      const count = await cleanupTempFiles(entries);
      expect(count).toBe(1);
      expect(fs.existsSync(a)).toBe(false);
      expect(fs.existsSync(d)).toBe(true);
    });

    it("并发 unlink 不互相阻塞", async () => {
      const files = Array.from({ length: 5 }, (_, i) => createTempFile(`file-${i}`));
      const entries = files.map((f) => makeEntry(f, "screenshot"));
      const count = await cleanupTempFiles(entries);
      expect(count).toBe(5);
      for (const f of files) {
        expect(fs.existsSync(f)).toBe(false);
      }
    });
  });

  describe("cleanupThreadTempFiles", () => {
    it("清空 registry 中该 thread 的条目并 unlink 文件", async () => {
      const registry = new TempFileRegistry();
      const a = createTempFile("a");
      const b = createTempFile("b");
      // 干扰条目：t2 的文件不应被清理
      const c = createTempFile("c");
      registry.register("t1", a, "screenshot");
      registry.register("t1", b, "download");
      registry.register("t2", c, "artifact");

      const count = await cleanupThreadTempFiles(registry, "t1");
      expect(count).toBe(2);
      expect(fs.existsSync(a)).toBe(false);
      expect(fs.existsSync(b)).toBe(false);
      expect(fs.existsSync(c)).toBe(true);

      // t1 条目已清空，t2 保留
      expect(registry.listByThread("t1")).toHaveLength(0);
      expect(registry.listByThread("t2")).toHaveLength(1);
    });

    it("不存在的 thread 返回 0，registry 不变", async () => {
      const registry = new TempFileRegistry();
      const count = await cleanupThreadTempFiles(registry, "non-existent");
      expect(count).toBe(0);
    });

    it("部分文件已不存在仍返回已清理数（ENOENT 幂等）", async () => {
      const registry = new TempFileRegistry();
      const a = createTempFile("a");
      // 提前删除 b，模拟孤儿
      registry.register("t1", a, "screenshot");
      registry.register("t1", "/tmp/snow-orphan-xyz", "download");

      const count = await cleanupThreadTempFiles(registry, "t1");
      expect(count).toBe(2); // 不存在也算成功
      expect(fs.existsSync(a)).toBe(false);
      expect(registry.size()).toBe(0);
    });
  });

  describe("cleanupAllTempFiles", () => {
    it("清空 registry 所有 thread 的条目并 unlink 文件", async () => {
      const registry = new TempFileRegistry();
      const a = createTempFile("a");
      const b = createTempFile("b");
      registry.register("t1", a, "screenshot");
      registry.register("t2", b, "download");

      const count = await cleanupAllTempFiles(registry);
      expect(count).toBe(2);
      expect(fs.existsSync(a)).toBe(false);
      expect(fs.existsSync(b)).toBe(false);
      expect(registry.size()).toBe(0);
    });

    it("空 registry 返回 0", async () => {
      const registry = new TempFileRegistry();
      const count = await cleanupAllTempFiles(registry);
      expect(count).toBe(0);
    });
  });
});
