/**
 * V10 Phase 3：与 SQLite 驱动解耦的数据库接口定义。
 *
 * 仅描述 migration runner 所需的最小 API 形状（与 better-sqlite3 一致），
 * 便于在测试中传入 mock 实现而不依赖真实数据库。
 */

/** Migration runner 使用的最小 DB 接口（与 better-sqlite3 的 API 形状一致） */
export interface MigrationDb {
  exec(sql: string): void;
  prepare<T = unknown>(sql: string): PreparedStmt<T>;
  transaction<T>(fn: () => T): T;
}

/** 预编译语句接口，对应 better-sqlite3 的 Statement。 */
export interface PreparedStmt<T = unknown> {
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

/** Migration 记录行 */
export interface MigrationRow {
  id: number;
  filename: string;
  applied_at: string;
}
