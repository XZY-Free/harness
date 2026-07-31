import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrationDb, MigrationRow, PreparedStmt } from "./db-interface";

/**
 * V10 Phase 3：SQLite migration runner 单元测试。
 *
 * mock MigrationDb 和 node:fs/promises，验证：
 * - 无 migration 文件时只创建 _migrations 表
 * - 有 3 个 SQL 文件时按序执行
 * - 已执行的 migration 不重复执行
 * - SQL 文件执行失败时回滚并抛出 MIGRATION_FAILED 错误
 * - 文件名排序正确
 * - 返回已执行记录列表
 */

// 使用 vi.hoisted 创建 fs mock 函数，确保在模块导入前绑定
const { mockReaddir, mockReadFile } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
}));

import { runMigrations } from "./migration-runner";

/**
 * 创建 mock MigrationDb，记录 exec 调用并支持 transaction 回滚。
 *
 * transaction 在 fn 抛错时回滚（恢复 execCalls 和 appliedMigrations 到快照），
 * 模拟 better-sqlite3 的 ROLLBACK 行为。
 */
function createMockDb(): MigrationDb & {
  execCalls: string[];
  appliedMigrations: Set<string>;
} {
  const execCalls: string[] = [];
  const appliedMigrations = new Set<string>();

  return {
    execCalls,
    appliedMigrations,
    exec(sql: string): void {
      execCalls.push(sql);
    },
    prepare<T = unknown>(sql: string): PreparedStmt<T> {
      return {
        get: (): T | undefined => undefined,
        all: (): T[] => {
          // 查询已执行 migration 的文件名
          if (sql.includes("filename FROM _migrations")) {
            return Array.from(appliedMigrations).map((filename) => ({
              filename,
            })) as unknown as T[];
          }
          // 查询所有 migration 记录（SELECT id, filename, applied_at）
          if (sql.includes("FROM _migrations")) {
            return Array.from(appliedMigrations).map((filename, i) => ({
              id: i + 1,
              filename,
              applied_at: "2026-01-01 00:00:00",
            })) as unknown as T[];
          }
          return [];
        },
        run: (...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } => {
          // 插入 _migrations 记录
          if (sql.includes("INSERT INTO _migrations")) {
            const filename = params[0];
            if (typeof filename === "string") {
              appliedMigrations.add(filename);
            }
            return { changes: 1, lastInsertRowid: appliedMigrations.size };
          }
          return { changes: 0, lastInsertRowid: 0 };
        },
      };
    },
    transaction<T>(fn: () => T): T {
      // 快照当前状态，用于回滚
      const execSnapshot = [...execCalls];
      const appliedSnapshot = new Set(appliedMigrations);
      try {
        return fn();
      } catch (err) {
        // 回滚：恢复到快照
        execCalls.length = 0;
        execCalls.push(...execSnapshot);
        appliedMigrations.clear();
        for (const m of appliedSnapshot) {
          appliedMigrations.add(m);
        }
        throw err;
      }
    },
  };
}

/** mock fs/promises readdir 和 readFile。files 映射文件名到 SQL 内容。 */
function mockFs(files: Record<string, string>): void {
  mockReaddir.mockResolvedValue(Object.keys(files));
  mockReadFile.mockImplementation(async (filepath: string) => {
    // 从完整路径提取文件名（兼容 / 和 \ 分隔符）
    const parts = filepath.split(/[\\/]/);
    const filename = parts[parts.length - 1];
    if (filename !== undefined && filename in files) {
      return files[filename];
    }
    const err = new Error(`ENOENT: ${filepath}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
}

describe("runMigrations (V10 Phase 3)", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
    vi.clearAllMocks();
  });

  it("无 migration 文件时只创建 _migrations 表", async () => {
    mockFs({});
    const result = await runMigrations(db, "/mock/migrations");

    // 只有一条 CREATE TABLE 调用
    expect(db.execCalls).toHaveLength(1);
    expect(db.execCalls[0]).toContain("CREATE TABLE IF NOT EXISTS _migrations");
    // 无 migration 记录
    expect(result).toEqual([]);
    expect(db.appliedMigrations.size).toBe(0);
  });

  it("有 3 个 SQL 文件时按序执行", async () => {
    const files: Record<string, string> = {
      "001_a.sql": "CREATE TABLE a (id INTEGER);",
      "002_b.sql": "CREATE TABLE b (id INTEGER);",
      "003_c.sql": "CREATE TABLE c (id INTEGER);",
    };
    mockFs(files);
    const result = await runMigrations(db, "/mock/migrations");

    // 每个文件都执行了 exec
    expect(db.execCalls).toContain("CREATE TABLE a (id INTEGER);");
    expect(db.execCalls).toContain("CREATE TABLE b (id INTEGER);");
    expect(db.execCalls).toContain("CREATE TABLE c (id INTEGER);");
    // 3 个 migration 都记录到 _migrations
    expect(db.appliedMigrations.size).toBe(3);
    expect(db.appliedMigrations.has("001_a.sql")).toBe(true);
    expect(db.appliedMigrations.has("002_b.sql")).toBe(true);
    expect(db.appliedMigrations.has("003_c.sql")).toBe(true);
    // 返回 3 条记录
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.filename)).toEqual(["001_a.sql", "002_b.sql", "003_c.sql"]);
  });

  it("已执行的 migration 不重复执行", async () => {
    // 预设 001_a.sql 已执行
    db.appliedMigrations.add("001_a.sql");
    const files: Record<string, string> = {
      "001_a.sql": "CREATE TABLE a (id INTEGER);",
      "002_b.sql": "CREATE TABLE b (id INTEGER);",
    };
    mockFs(files);
    const result = await runMigrations(db, "/mock/migrations");

    // 001_a.sql 不应重复 exec
    const execCountForA = db.execCalls.filter((s) => s.includes("CREATE TABLE a")).length;
    expect(execCountForA).toBe(0);
    // 002_b.sql 应执行
    expect(db.execCalls).toContain("CREATE TABLE b (id INTEGER);");
    // 002_b.sql 应被记录
    expect(db.appliedMigrations.has("002_b.sql")).toBe(true);
    // 返回 2 条记录（001_a + 002_b）
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.filename)).toContain("001_a.sql");
    expect(result.map((r) => r.filename)).toContain("002_b.sql");
  });

  it("SQL 文件执行失败时回滚并抛出 MIGRATION_FAILED 错误", async () => {
    const files: Record<string, string> = {
      "001_ok.sql": "CREATE TABLE ok (id INTEGER);",
      "002_fail.sql": "INVALID SQL SYNTAX;",
      "003_after.sql": "CREATE TABLE after (id INTEGER);",
    };
    mockFs(files);

    // 让 exec 在遇到 "INVALID SQL" 时抛错
    const originalExec = db.exec.bind(db);
    db.exec = (sql: string): void => {
      if (sql.includes("INVALID SQL")) {
        throw new Error("SQL 执行失败：语法错误");
      }
      originalExec(sql);
    };

    await expect(runMigrations(db, "/mock/migrations")).rejects.toMatchObject({
      ok: false,
      code: "migration_failed",
    });

    // 回滚后 _migrations 表不应有任何新增记录（001_ok 也回滚）
    expect(db.appliedMigrations.size).toBe(0);
    // 003_after.sql 不应被执行（002_fail 抛错后中止）
    expect(db.execCalls.some((s) => s.includes("CREATE TABLE after"))).toBe(false);
  });

  it("文件名排序正确（001 < 010 < 100）", async () => {
    // 故意以乱序提供文件
    const files: Record<string, string> = {
      "100_last.sql": "CREATE TABLE last (id INTEGER);",
      "001_first.sql": "CREATE TABLE first (id INTEGER);",
      "010_mid.sql": "CREATE TABLE mid (id INTEGER);",
    };
    mockFs(files);
    const result = await runMigrations(db, "/mock/migrations");

    // 验证执行顺序：按文件名升序
    expect(result.map((r) => r.filename)).toEqual(["001_first.sql", "010_mid.sql", "100_last.sql"]);
    // 验证 exec 顺序也一致（排除 _migrations 表创建语句）
    const execOrder = db.execCalls
      .filter((s) => s.includes("CREATE TABLE") && !s.includes("_migrations"))
      .map((s) => {
        const match = s.match(/CREATE TABLE (\w+)/);
        return match?.[1] ?? "";
      });
    expect(execOrder).toEqual(["first", "mid", "last"]);
  });

  it("返回已执行记录列表", async () => {
    const files: Record<string, string> = {
      "001_init.sql": "CREATE TABLE init (id INTEGER);",
      "002_next.sql": "CREATE TABLE next (id INTEGER);",
    };
    mockFs(files);
    const result = (await runMigrations(db, "/mock/migrations")) as MigrationRow[];

    expect(result).toHaveLength(2);
    for (const row of result) {
      expect(row).toHaveProperty("id");
      expect(row).toHaveProperty("filename");
      expect(row).toHaveProperty("applied_at");
      expect(typeof row.id).toBe("number");
      expect(typeof row.filename).toBe("string");
      expect(typeof row.applied_at).toBe("string");
    }
    // id 从 1 递增
    expect(result.map((r) => r.id)).toEqual([1, 2]);
  });
});
