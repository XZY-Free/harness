import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeWorkspaceCommand } from "../bridge/workspace-command";
import type { MigrationDb, PreparedStmt } from "./db-interface";
import { WorkspaceRootStore } from "./workspace-root-store";

/** 探测 sandbox-exec 是否真的可用（嵌套沙箱等环境下 sandbox_apply 会 EPERM）。 */
function sandboxExecAvailable(): boolean {
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/bin/true"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

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
  it.runIf(process.platform === "darwin")(
    "本机命令使用 SQLite 绑定目录和真实沙箱，不能读取工作区外文件",
    async (ctx) => {
      if (!sandboxExecAvailable()) {
        console.warn("[skip] sandbox-exec 在当前运行环境不可用（sandbox_apply EPERM）");
        ctx.skip();
      }
      const { raw, db } = createDb();
      const root = await realpath(await mkdtemp(join(tmpdir(), "snow-native-shell-")));
      const outside = `${root}-outside`;
      await writeFile(outside, "test-only-outside-marker");
      const store = new WorkspaceRootStore(db);
      store.upsert({
        bindingId: "bound",
        workspaceId: "workspace",
        absolutePath: root,
        displayName: "native test",
      });
      try {
        const result = await executeWorkspaceCommand(store, {
          bindingId: "bound",
          command: "/bin/date -u +%Y-%m-%d",
          timeoutMs: 5000,
          logCapBytes: 8192,
        });
        expect(result, JSON.stringify(result)).toMatchObject({
          ok: true,
          exitCode: 0,
          workingDirectory: root,
          stdout: expect.stringMatching(/^\d{4}-\d{2}-\d{2}/),
        });
        const denied = await executeWorkspaceCommand(store, {
          bindingId: "bound",
          command: `/bin/cat '${outside}'`,
          timeoutMs: 5000,
          logCapBytes: 8192,
        });
        expect(denied.ok).toBe(false);
        expect(denied.stdout).not.toContain("test-only-outside-marker");
        await expect(
          executeWorkspaceCommand(store, {
            bindingId: "missing",
            command: "date",
            timeoutMs: 5000,
            logCapBytes: 8192,
          }),
        ).rejects.toThrow();
      } finally {
        raw.close();
        await rm(root, { recursive: true, force: true });
        await rm(outside, { force: true });
      }
    },
  );
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
