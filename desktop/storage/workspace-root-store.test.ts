import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { MigrationDb, PreparedStmt } from "./db-interface";
import { WorkspaceRootStore } from "./workspace-root-store";

function createDb(): { raw: Database.Database; db: MigrationDb } {
  const raw = new Database(":memory:");
  raw.exec(`CREATE TABLE workspace_roots (
    binding_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    display_name TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return {
    raw,
    db: {
      exec: (sql) => raw.exec(sql),
      prepare: <T = unknown>(sql: string) => raw.prepare(sql) as unknown as PreparedStmt<T>,
      transaction: <T>(fn: () => T) => raw.transaction(fn)(),
    },
  };
}

describe("WorkspaceRootStore", () => {
  it("按 binding id 保存并更新只留在本机的绝对路径", () => {
    const { raw, db } = createDb();
    const store = new WorkspaceRootStore(db);

    store.upsert({
      bindingId: "binding-1",
      workspaceId: "workspace-1",
      absolutePath: "/Users/test/project-a",
      displayName: "project-a",
    });
    expect(store.get("binding-1")).toMatchObject({ absolutePath: "/Users/test/project-a" });

    store.upsert({
      bindingId: "binding-1",
      workspaceId: "workspace-1",
      absolutePath: "/Volumes/code/project-a",
      displayName: "project-a",
    });
    expect(store.get("binding-1")).toMatchObject({ absolutePath: "/Volumes/code/project-a" });
    raw.close();
  });
});
