import { beforeEach, describe, expect, it } from "vitest";
import type { MigrationDb, PreparedStmt } from "../storage/db-interface";
import {
  type PersistedTab,
  TabRestore,
  type ThreadRestoreData,
  persistedTabToMetadata,
} from "./tab-restore";
import type { TabMetadata } from "./tab-store";

/**
 * V10 Phase 4：Tab 惰性恢复单元测试。
 *
 * 使用 mock MigrationDb 模拟 thread_tabs 表的 CRUD 操作，
 * 验证 persistedTabToMetadata 转换、TabRestore 的恢复/持久化/删除/查询逻辑。
 */

/** mock 行：键为 SQL 列名（snake_case） */
type MockRow = Record<string, unknown>;

/**
 * 创建 mock MigrationDb，模拟 thread_tabs 表的 CRUD 操作。
 *
 * 支持 SELECT（带 WHERE/ORDER BY）、SELECT DISTINCT、INSERT、DELETE。
 * transaction 在 fn 抛错时回滚到快照，模拟 better-sqlite3 的 ROLLBACK 行为。
 */
function createMockDb(): MigrationDb & {
  tables: Map<string, MockRow[]>;
  transactionCalls: { committed: number; rolledBack: number };
} {
  const tables = new Map<string, MockRow[]>();
  tables.set("thread_tabs", []);

  const transactionCalls = { committed: 0, rolledBack: 0 };

  function getTable(name: string): MockRow[] {
    let t = tables.get(name);
    if (!t) {
      t = [];
      tables.set(name, t);
    }
    return t;
  }

  return {
    tables,
    transactionCalls,
    exec(_sql: string): void {
      // mock：CREATE TABLE 等不实际执行
    },
    prepare<T = unknown>(sql: string): PreparedStmt<T> {
      const trimmed = sql.trim();
      const upper = trimmed.toUpperCase();

      // INSERT INTO <table> (cols) VALUES (?, ?, ...)
      if (upper.startsWith("INSERT INTO")) {
        const tableMatch = trimmed.match(/INSERT\s+INTO\s+(\w+)/i);
        const colsMatch = trimmed.match(/\(([^)]+)\)\s*VALUES/i);
        const tableName = tableMatch?.[1] ?? "thread_tabs";
        const cols = (colsMatch?.[1] ?? "").split(",").map((c) => c.trim());
        const table = getTable(tableName);
        return {
          get: () => undefined,
          all: () => [],
          run: (...params: unknown[]) => {
            const row: MockRow = {};
            for (let i = 0; i < cols.length; i++) {
              const col = cols[i];
              if (col) row[col] = params[i];
            }
            table.push(row);
            return { changes: 1, lastInsertRowid: table.length };
          },
        };
      }

      // DELETE FROM <table> WHERE <col> = ?
      if (upper.startsWith("DELETE FROM")) {
        const tableMatch = trimmed.match(/DELETE\s+FROM\s+(\w+)/i);
        const whereMatch = trimmed.match(/WHERE\s+(\w+)\s*=\s*\?/i);
        const tableName = tableMatch?.[1] ?? "thread_tabs";
        const whereCol = whereMatch?.[1];
        const table = getTable(tableName);
        return {
          get: () => undefined,
          all: () => [],
          run: (...params: unknown[]) => {
            const before = table.length;
            const keep: MockRow[] = [];
            for (const row of table) {
              if (whereCol && row[whereCol] === params[0]) continue;
              keep.push(row);
            }
            tables.set(tableName, keep);
            return { changes: before - keep.length, lastInsertRowid: 0 };
          },
        };
      }

      // SELECT DISTINCT <col> FROM <table>
      if (upper.includes("SELECT DISTINCT")) {
        const tableMatch = trimmed.match(/FROM\s+(\w+)/i);
        const colMatch = trimmed.match(/SELECT\s+DISTINCT\s+(\w+)/i);
        const tableName = tableMatch?.[1] ?? "thread_tabs";
        const col = colMatch?.[1] ?? "thread_id";
        const table = getTable(tableName);
        return {
          get: () => undefined,
          all: () => {
            const seen = new Set<unknown>();
            const result: MockRow[] = [];
            for (const row of table) {
              const val = row[col];
              if (!seen.has(val)) {
                seen.add(val);
                result.push({ [col]: val });
              }
            }
            return result as unknown as T[];
          },
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
        };
      }

      // SELECT <cols> FROM thread_tabs WHERE thread_id = ? [ORDER BY <col> ASC|DESC]
      if (upper.startsWith("SELECT") && upper.includes("FROM THREAD_TABS")) {
        const colsMatch = trimmed.match(/SELECT\s+(.+?)\s+FROM/i);
        const colsStr = colsMatch?.[1] ?? "*";
        const cols = colsStr === "*" ? [] : colsStr.split(",").map((c) => c.trim());
        const whereMatch = trimmed.match(/WHERE\s+(\w+)\s*=\s*\?/i);
        const whereCol = whereMatch?.[1];
        const orderMatch = trimmed.match(/ORDER\s+BY\s+(\w+)\s+(ASC|DESC)/i);
        const orderCol = orderMatch?.[1];
        const orderDir = orderMatch?.[2]?.toUpperCase() ?? "ASC";
        const table = getTable("thread_tabs");
        return {
          get: () => undefined,
          all: (...params: unknown[]) => {
            let rows = table;
            if (whereCol) {
              const filtered: MockRow[] = [];
              for (const row of rows) {
                if (row[whereCol] === params[0]) filtered.push(row);
              }
              rows = filtered;
            }
            if (orderCol) {
              const sorted = [...rows];
              sorted.sort((a, b) => {
                const av = (a[orderCol] as number) ?? 0;
                const bv = (b[orderCol] as number) ?? 0;
                return orderDir === "ASC" ? av - bv : bv - av;
              });
              rows = sorted;
            }
            const result = rows.map((r) => {
              if (cols.length === 0) return { ...r };
              const out: MockRow = {};
              for (const c of cols) {
                out[c] = r[c];
              }
              return out;
            });
            return result as unknown as T[];
          },
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
        };
      }

      // 默认空语句
      return {
        get: () => undefined,
        all: () => [],
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    },
    transaction<T>(fn: () => T): T {
      // 快照当前状态，用于回滚
      const snapshot = new Map<string, MockRow[]>();
      for (const [k, v] of tables) {
        snapshot.set(
          k,
          v.map((r) => ({ ...r })),
        );
      }
      try {
        const result = fn();
        transactionCalls.committed++;
        return result;
      } catch (err) {
        // 回滚：恢复到快照
        tables.clear();
        for (const [k, v] of snapshot) {
          tables.set(
            k,
            v.map((r) => ({ ...r })),
          );
        }
        transactionCalls.rolledBack++;
        throw err;
      }
    },
  };
}

/** 创建测试用的 PersistedTab */
function makePersistedTab(overrides: Partial<PersistedTab> = {}): PersistedTab {
  return {
    id: "tab-1",
    threadId: "thread-1",
    url: "https://example.com",
    title: "Example",
    position: 0,
    incognito: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

/** 创建测试用的 TabMetadata */
function makeTabMetadata(overrides: Partial<TabMetadata> = {}): TabMetadata {
  return {
    id: "tab-1",
    threadId: "thread-1",
    url: "https://example.com",
    title: "Example",
    favicon: null,
    loadState: "idle",
    canGoBack: false,
    canGoForward: false,
    incognito: false,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    error: null,
    ...overrides,
  };
}

/** 向 mock 的 thread_tabs 表直接插入行 */
function insertMockRow(db: ReturnType<typeof createMockDb>, row: MockRow): void {
  const table = db.tables.get("thread_tabs");
  if (table) table.push(row);
}

describe("persistedTabToMetadata (V10 Phase 4)", () => {
  it("incognito=1 转换为 true", () => {
    const tab = makePersistedTab({ incognito: 1 });
    const meta = persistedTabToMetadata(tab);
    expect(meta.incognito).toBe(true);
  });

  it("incognito=0 转换为 false", () => {
    const tab = makePersistedTab({ incognito: 0 });
    const meta = persistedTabToMetadata(tab);
    expect(meta.incognito).toBe(false);
  });

  it("loadState 初始为 idle", () => {
    const meta = persistedTabToMetadata(makePersistedTab());
    expect(meta.loadState).toBe("idle");
  });

  it("canGoBack 初始为 false", () => {
    const meta = persistedTabToMetadata(makePersistedTab());
    expect(meta.canGoBack).toBe(false);
  });

  it("canGoForward 初始为 false", () => {
    const meta = persistedTabToMetadata(makePersistedTab());
    expect(meta.canGoForward).toBe(false);
  });

  it("favicon 初始为 null", () => {
    const meta = persistedTabToMetadata(makePersistedTab());
    expect(meta.favicon).toBe(null);
  });

  it("error 初始为 null", () => {
    const meta = persistedTabToMetadata(makePersistedTab());
    expect(meta.error).toBe(null);
  });

  it("保留 id/threadId/url/title/createdAt/updatedAt", () => {
    const tab = makePersistedTab({
      id: "tab-x",
      threadId: "thread-y",
      url: "https://test.com",
      title: "Test",
      createdAt: 123,
      updatedAt: 456,
    });
    const meta = persistedTabToMetadata(tab);
    expect(meta.id).toBe("tab-x");
    expect(meta.threadId).toBe("thread-y");
    expect(meta.url).toBe("https://test.com");
    expect(meta.title).toBe("Test");
    expect(meta.createdAt).toBe(123);
    expect(meta.updatedAt).toBe(456);
  });
});

describe("TabRestore.restoreThread (V10 Phase 4)", () => {
  let db: ReturnType<typeof createMockDb>;
  let restore: TabRestore;

  beforeEach(() => {
    db = createMockDb();
    restore = new TabRestore(db);
  });

  it("无 tabs 返回空列表 + activeTabId=null", () => {
    const data = restore.restoreThread("thread-1");
    expect(data.threadId).toBe("thread-1");
    expect(data.tabs).toEqual([]);
    expect(data.activeTabId).toBe(null);
  });

  it("有 tabs 按 position 排序", () => {
    // 直接向 mock 表插入乱序数据，验证 restoreThread 按 position ASC 排序
    insertMockRow(db, {
      tab_id: "tab-c",
      thread_id: "thread-1",
      url: "https://c.com",
      title: "",
      position: 2,
      is_active: 0,
      is_incognito: 0,
      created_at: 1,
      updated_at: 1,
    });
    insertMockRow(db, {
      tab_id: "tab-a",
      thread_id: "thread-1",
      url: "https://a.com",
      title: "",
      position: 0,
      is_active: 0,
      is_incognito: 0,
      created_at: 1,
      updated_at: 1,
    });
    insertMockRow(db, {
      tab_id: "tab-b",
      thread_id: "thread-1",
      url: "https://b.com",
      title: "",
      position: 1,
      is_active: 0,
      is_incognito: 0,
      created_at: 1,
      updated_at: 1,
    });

    const data = restore.restoreThread("thread-1");
    expect(data.tabs).toHaveLength(3);
    expect(data.tabs.map((t) => t.id)).toEqual(["tab-a", "tab-b", "tab-c"]);
    expect(data.tabs.map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it("有 activeTabId（is_active=1 的行）", () => {
    insertMockRow(db, {
      tab_id: "tab-1",
      thread_id: "thread-1",
      url: "https://a.com",
      title: "",
      position: 0,
      is_active: 1,
      is_incognito: 0,
      created_at: 1,
      updated_at: 1,
    });
    insertMockRow(db, {
      tab_id: "tab-2",
      thread_id: "thread-1",
      url: "https://b.com",
      title: "",
      position: 1,
      is_active: 0,
      is_incognito: 0,
      created_at: 1,
      updated_at: 1,
    });

    const data = restore.restoreThread("thread-1");
    expect(data.activeTabId).toBe("tab-1");
  });

  it("activeTabId 不存在（无 is_active=1 的行）返回 null", () => {
    insertMockRow(db, {
      tab_id: "tab-1",
      thread_id: "thread-1",
      url: "https://a.com",
      title: "",
      position: 0,
      is_active: 0,
      is_incognito: 0,
      created_at: 1,
      updated_at: 1,
    });

    const data = restore.restoreThread("thread-1");
    expect(data.tabs).toHaveLength(1);
    expect(data.activeTabId).toBe(null);
  });
});

describe("TabRestore.persistTabs (V10 Phase 4)", () => {
  let db: ReturnType<typeof createMockDb>;
  let restore: TabRestore;

  beforeEach(() => {
    db = createMockDb();
    restore = new TabRestore(db);
  });

  it("删除旧记录后插入新记录", () => {
    // 预先插入旧数据
    insertMockRow(db, {
      tab_id: "old-tab",
      thread_id: "thread-1",
      url: "https://old.com",
      title: "Old",
      position: 0,
      is_active: 1,
      is_incognito: 0,
      created_at: 1,
      updated_at: 1,
    });

    const tabs = [
      makeTabMetadata({ id: "new-tab-1", url: "https://new1.com", title: "New1" }),
      makeTabMetadata({ id: "new-tab-2", url: "https://new2.com", title: "New2" }),
    ];
    restore.persistTabs("thread-1", tabs, "new-tab-1");

    const data = restore.restoreThread("thread-1");
    expect(data.tabs).toHaveLength(2);
    expect(data.tabs.find((t) => t.id === "old-tab")).toBeUndefined();
    expect(data.tabs.map((t) => t.id)).toEqual(["new-tab-1", "new-tab-2"]);
  });

  it("只持久化普通 tab，隐身 tab 不写入磁盘", () => {
    const original: TabMetadata[] = [
      makeTabMetadata({
        id: "tab-a",
        url: "https://a.com",
        title: "A",
        incognito: false,
        createdAt: 1000,
        updatedAt: 2000,
      }),
      makeTabMetadata({
        id: "tab-b",
        url: "https://b.com",
        title: "B",
        incognito: true,
        createdAt: 3000,
        updatedAt: 4000,
      }),
    ];

    restore.persistTabs("thread-1", original, "tab-b");

    const data: ThreadRestoreData = restore.restoreThread("thread-1");
    expect(data.tabs).toHaveLength(1);

    // 验证每个字段往返一致
    const restoredA = data.tabs.find((t) => t.id === "tab-a");
    expect(restoredA).toBeDefined();
    expect(restoredA?.threadId).toBe("thread-1");
    expect(restoredA?.url).toBe("https://a.com");
    expect(restoredA?.title).toBe("A");
    expect(restoredA?.incognito).toBe(0);
    expect(restoredA?.createdAt).toBe(1000);
    expect(restoredA?.updatedAt).toBe(2000);

    expect(data.tabs.find((t) => t.id === "tab-b")).toBeUndefined();
    expect(data.activeTabId).toBe(null);
  });

  it("activeTabId 存储到 thread_tabs 的 is_active 列", () => {
    const tabs = [makeTabMetadata({ id: "tab-1" }), makeTabMetadata({ id: "tab-2" })];
    restore.persistTabs("thread-1", tabs, "tab-2");

    // 直接检查 mock 表中的 is_active 标记
    const table = db.tables.get("thread_tabs");
    expect(table).toBeDefined();
    if (!table) return;
    const activeRow = table.find((r) => r.is_active === 1);
    expect(activeRow).toBeDefined();
    expect(activeRow?.tab_id).toBe("tab-2");
    // 其余行 is_active=0
    const inactiveRow = table.find((r) => r.tab_id === "tab-1");
    expect(inactiveRow?.is_active).toBe(0);
  });

  it("activeTabId=null 时无 is_active=1 行", () => {
    const tabs = [makeTabMetadata({ id: "tab-1" }), makeTabMetadata({ id: "tab-2" })];
    restore.persistTabs("thread-1", tabs, null);

    const table = db.tables.get("thread_tabs");
    expect(table).toBeDefined();
    if (!table) return;
    for (const row of table) {
      expect(row.is_active).toBe(0);
    }

    const data = restore.restoreThread("thread-1");
    expect(data.activeTabId).toBe(null);
  });

  it("空 tabs 列表只删除不插入", () => {
    // 预先插入数据
    insertMockRow(db, {
      tab_id: "tab-1",
      thread_id: "thread-1",
      url: "https://a.com",
      title: "",
      position: 0,
      is_active: 1,
      is_incognito: 0,
      created_at: 1,
      updated_at: 1,
    });

    restore.persistTabs("thread-1", [], null);

    const table = db.tables.get("thread_tabs");
    expect(table).toBeDefined();
    if (!table) return;
    expect(table).toHaveLength(0);

    const data = restore.restoreThread("thread-1");
    expect(data.tabs).toEqual([]);
    expect(data.activeTabId).toBe(null);
  });

  it("position 按 tabs 数组顺序", () => {
    const tabs = [
      makeTabMetadata({ id: "tab-3" }),
      makeTabMetadata({ id: "tab-1" }),
      makeTabMetadata({ id: "tab-2" }),
    ];
    restore.persistTabs("thread-1", tabs, "tab-3");

    const data = restore.restoreThread("thread-1");
    expect(data.tabs.map((t) => t.id)).toEqual(["tab-3", "tab-1", "tab-2"]);
    expect(data.tabs.map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it("使用 transaction 包裹删除和插入", () => {
    const tabs = [makeTabMetadata({ id: "tab-1" })];
    restore.persistTabs("thread-1", tabs, "tab-1");
    expect(db.transactionCalls.committed).toBeGreaterThanOrEqual(1);
    expect(db.transactionCalls.rolledBack).toBe(0);
  });

  it("activeTabId 不匹配任何 tab 时无 is_active=1 行", () => {
    const tabs = [makeTabMetadata({ id: "tab-1" }), makeTabMetadata({ id: "tab-2" })];
    restore.persistTabs("thread-1", tabs, "tab-nonexistent");

    const table = db.tables.get("thread_tabs");
    expect(table).toBeDefined();
    if (!table) return;
    const activeRow = table.find((r) => r.is_active === 1);
    expect(activeRow).toBeUndefined();

    const data = restore.restoreThread("thread-1");
    expect(data.activeTabId).toBe(null);
  });
});

describe("TabRestore.deleteThread (V10 Phase 4)", () => {
  let db: ReturnType<typeof createMockDb>;
  let restore: TabRestore;

  beforeEach(() => {
    db = createMockDb();
    restore = new TabRestore(db);
  });

  it("删除所有 tabs（含 active 标记）", () => {
    const tabs = [makeTabMetadata({ id: "tab-1" }), makeTabMetadata({ id: "tab-2" })];
    restore.persistTabs("thread-1", tabs, "tab-1");

    restore.deleteThread("thread-1");

    const data = restore.restoreThread("thread-1");
    expect(data.tabs).toEqual([]);
    expect(data.activeTabId).toBe(null);
  });

  it("返回删除数量", () => {
    const tabs = [
      makeTabMetadata({ id: "tab-1" }),
      makeTabMetadata({ id: "tab-2" }),
      makeTabMetadata({ id: "tab-3" }),
    ];
    restore.persistTabs("thread-1", tabs, "tab-1");

    const changes = restore.deleteThread("thread-1");
    expect(changes).toBe(3);
  });

  it("不存在返回 0", () => {
    const changes = restore.deleteThread("thread-nonexistent");
    expect(changes).toBe(0);
  });
});

describe("TabRestore.getRestorableThreadIds (V10 Phase 4)", () => {
  let db: ReturnType<typeof createMockDb>;
  let restore: TabRestore;

  beforeEach(() => {
    db = createMockDb();
    restore = new TabRestore(db);
  });

  it("返回不重复的 thread_id 列表", () => {
    restore.persistTabs("thread-1", [makeTabMetadata({ id: "tab-1" })], "tab-1");
    restore.persistTabs("thread-2", [makeTabMetadata({ id: "tab-2" })], "tab-2");
    restore.persistTabs("thread-3", [makeTabMetadata({ id: "tab-3" })], "tab-3");

    const ids = restore.getRestorableThreadIds();
    expect(ids).toHaveLength(3);
    expect(ids).toContain("thread-1");
    expect(ids).toContain("thread-2");
    expect(ids).toContain("thread-3");
  });

  it("无 tabs 返回空数组", () => {
    const ids = restore.getRestorableThreadIds();
    expect(ids).toEqual([]);
  });
});

describe("TabRestore 多 Thread 独立存储 (V10 Phase 4)", () => {
  it("不同 Thread 的 tabs 互不影响", () => {
    const db = createMockDb();
    const restore = new TabRestore(db);

    restore.persistTabs(
      "thread-1",
      [
        makeTabMetadata({ id: "t1-a", threadId: "thread-1", url: "https://1a.com" }),
        makeTabMetadata({ id: "t1-b", threadId: "thread-1", url: "https://1b.com" }),
      ],
      "t1-a",
    );
    restore.persistTabs(
      "thread-2",
      [
        makeTabMetadata({ id: "t2-a", threadId: "thread-2", url: "https://2a.com" }),
        makeTabMetadata({ id: "t2-b", threadId: "thread-2", url: "https://2b.com" }),
      ],
      "t2-b",
    );

    // 删除 thread-1 不影响 thread-2
    const deleted = restore.deleteThread("thread-1");
    expect(deleted).toBe(2);

    const data1 = restore.restoreThread("thread-1");
    expect(data1.tabs).toEqual([]);

    const data2 = restore.restoreThread("thread-2");
    expect(data2.tabs).toHaveLength(2);
    expect(data2.tabs.map((t) => t.id)).toEqual(["t2-a", "t2-b"]);
    expect(data2.activeTabId).toBe("t2-b");

    // getRestorableThreadIds 只剩 thread-2
    const ids = restore.getRestorableThreadIds();
    expect(ids).toEqual(["thread-2"]);
  });

  it("同一 Thread 多次 persistTabs 覆盖旧数据", () => {
    const db = createMockDb();
    const restore = new TabRestore(db);

    // 第一次持久化 3 个 tab
    restore.persistTabs(
      "thread-1",
      [
        makeTabMetadata({ id: "tab-1" }),
        makeTabMetadata({ id: "tab-2" }),
        makeTabMetadata({ id: "tab-3" }),
      ],
      "tab-1",
    );

    // 第二次持久化 1 个 tab（覆盖）
    restore.persistTabs("thread-1", [makeTabMetadata({ id: "tab-new" })], "tab-new");

    const data = restore.restoreThread("thread-1");
    expect(data.tabs).toHaveLength(1);
    expect(data.tabs[0]?.id).toBe("tab-new");
    expect(data.activeTabId).toBe("tab-new");
  });
});
