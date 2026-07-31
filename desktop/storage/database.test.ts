import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDesktopDatabase } from "./database";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("openDesktopDatabase", () => {
  it("在真实 SQLite 文件执行 migration 并可持久化 tab", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snow-desktop-db-"));
    tempDirs.push(dir);
    const database = await openDesktopDatabase(
      join(dir, "desktop.sqlite"),
      resolve("desktop/storage/migrations"),
    );

    database.tabRestore.persistTabs(
      "thread-1",
      [
        {
          id: "tab-1",
          threadId: "thread-1",
          url: "https://example.com",
          title: "Example",
          favicon: null,
          loadState: "loaded",
          canGoBack: false,
          canGoForward: false,
          incognito: false,
          createdAt: 1,
          updatedAt: 2,
          error: null,
        },
      ],
      "tab-1",
    );

    expect(database.tabRestore.restoreThread("thread-1").activeTabId).toBe("tab-1");
    database.close();
  });
});
