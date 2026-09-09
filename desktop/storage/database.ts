import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { TabRestore } from "../browser/tab-restore";
import type { MigrationDb, PreparedStmt } from "./db-interface";
import { runMigrations } from "./migration-runner";
import { WorkspaceRootStore } from "./workspace-root-store";

export interface DesktopDatabase {
  tabRestore: TabRestore;
  workspaceRoots: WorkspaceRootStore;
  close(): void;
}

export async function openDesktopDatabase(
  databasePath: string,
  migrationsPath: string,
): Promise<DesktopDatabase> {
  await mkdir(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  const migrationDb: MigrationDb = {
    exec: (sql) => database.exec(sql),
    prepare: <T = unknown>(sql: string) => database.prepare(sql) as unknown as PreparedStmt<T>,
    transaction: <T>(fn: () => T) => database.transaction(fn)(),
  };
  await runMigrations(migrationDb, migrationsPath);
  return {
    tabRestore: new TabRestore(migrationDb),
    workspaceRoots: new WorkspaceRootStore(migrationDb),
    close: () => database.close(),
  };
}
