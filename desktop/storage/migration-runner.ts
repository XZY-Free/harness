/**
 * V10 Phase 3：SQLite migration 执行器。
 *
 * 读取指定目录下的 .sql 文件，按文件名排序后依次执行。
 * 已执行的 migration（记录在 _migrations 表中）不重复执行。
 * 在单个 transaction 内执行未执行的 migration，失败时自动回滚。
 *
 * 不直接依赖 better-sqlite3，通过 MigrationDb 接口解耦，便于测试 mock。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DesktopErrorCode, desktopError } from "../../lib/desktop/errors";
import type { MigrationDb, MigrationRow } from "./db-interface";

/** _migrations 表的创建 SQL。 */
const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/**
 * 执行 migration。
 *
 * 步骤：
 * 1. 创建 _migrations 表（如果不存在）。
 * 2. 查询已执行的 migration 文件名。
 * 3. 读取 migrationsDir 下的 .sql 文件，按文件名排序。
 * 4. 在 transaction 中执行未执行的 SQL 文件，并记录到 _migrations 表。
 * 5. 返回所有已执行的 migration 记录。
 *
 * @param db MigrationDb 实例
 * @param migrationsDir 存放 .sql 文件的目录
 * @returns 所有已执行的 migration 记录
 */
export async function runMigrations(
  db: MigrationDb,
  migrationsDir: string,
): Promise<MigrationRow[]> {
  // 创建 _migrations 表
  db.exec(CREATE_MIGRATIONS_TABLE);

  // 查询已执行的 migration 文件名
  const existingStmt = db.prepare<{ filename: string }>("SELECT filename FROM _migrations");
  const existingRows = existingStmt.all();
  const existing = new Set(existingRows.map((r) => r.filename));

  // 读取 migrationsDir 下的 .sql 文件，按文件名排序
  let entries: string[];
  try {
    entries = await readdir(migrationsDir);
  } catch (err) {
    throw desktopError(
      DesktopErrorCode.MIGRATION_FAILED,
      `读取 migration 目录失败: ${migrationsDir}`,
      {
        migrationsDir,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
  const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();

  if (sqlFiles.length === 0) {
    return queryAllMigrations(db);
  }

  // 预读所有未执行的 SQL 文件内容（readFile 为 async，需在 transaction 外完成）
  const toApply: { filename: string; sql: string }[] = [];
  for (const filename of sqlFiles) {
    if (existing.has(filename)) {
      continue;
    }
    let sql: string;
    try {
      sql = await readFile(join(migrationsDir, filename), "utf8");
    } catch (err) {
      throw desktopError(
        DesktopErrorCode.MIGRATION_FAILED,
        `读取 migration 文件失败: ${filename}`,
        {
          filename,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    toApply.push({ filename, sql });
  }

  if (toApply.length === 0) {
    return queryAllMigrations(db);
  }

  // 在 transaction 中执行未执行的 SQL 文件
  const insertStmt = db.prepare("INSERT INTO _migrations (filename) VALUES (?)");
  try {
    db.transaction(() => {
      for (const { filename, sql } of toApply) {
        db.exec(sql);
        insertStmt.run(filename);
      }
    });
  } catch (err) {
    // transaction 自动回滚，包装为 DesktopError
    throw desktopError(DesktopErrorCode.MIGRATION_FAILED, "migration 执行失败", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return queryAllMigrations(db);
}

/** 查询 _migrations 表所有记录（按 id 排序）。 */
function queryAllMigrations(db: MigrationDb): MigrationRow[] {
  const stmt = db.prepare<MigrationRow>(
    "SELECT id, filename, applied_at FROM _migrations ORDER BY id",
  );
  return stmt.all();
}
