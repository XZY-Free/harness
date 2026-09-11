import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrandFieldPinnedError,
  BrandValidationError,
  DEFAULT_BRAND,
} from "@/lib/branding/brand-contract";
import type { BrandRow } from "@/lib/branding/brand-queries";
import { createBrandStore } from "@/lib/branding/brand-store";
import { afterEach, describe, expect, it, vi } from "vitest";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "brand-"));
  tmpDirs.push(dir);
  const file = join(dir, "branding.json");
  writeFileSync(file, content, "utf8");
  return file;
}

function row(document: Record<string, unknown>, revision: number): BrandRow {
  return { document, revision, updatedAt: new Date("2026-09-11T08:00:00Z"), updatedBy: "admin" };
}

function storeWith(options: {
  row?: BrandRow | null;
  env?: Record<string, string | undefined>;
  filePath?: string | null;
}) {
  const fetchRow = vi.fn(async () => options.row ?? null);
  const writeRow = vi.fn(async (_input: unknown) => {});
  const store = createBrandStore({
    fetchRow,
    writeRow,
    env: options.env ?? {},
    filePath: options.filePath === undefined ? null : options.filePath,
    startPoll: false,
  });
  return { store, fetchRow, writeRow };
}

describe("BrandStore 解析与 pin 语义", () => {
  it("零配置返回代码默认品牌且无 pin", async () => {
    const { store } = storeWith({});
    const snapshot = await store.get();
    expect(snapshot.contract.name).toBe(DEFAULT_BRAND.name);
    expect(snapshot.contract.revision).toBe(0);
    expect(snapshot.pinned).toEqual({});
  });

  it("DB 文档覆盖默认值并透出 revision 与审计字段", async () => {
    const { store } = storeWith({
      row: row({ schemaVersion: 1, name: "Acme Cloud", tagline: null }, 7),
    });
    const snapshot = await store.get();
    expect(snapshot.contract.name).toBe("Acme Cloud");
    expect(snapshot.contract.tagline).toBeNull();
    expect(snapshot.contract.revision).toBe(7);
    expect(snapshot.contract.updatedBy).toBe("admin");
    expect(snapshot.contract.packaging).toEqual(DEFAULT_BRAND.packaging);
  });

  it("env pin 覆盖 DB 且拒绝接口写入该字段", async () => {
    const { store } = storeWith({
      row: row({ schemaVersion: 1, name: "DbName" }, 3),
      env: { SNOW_BRAND_NAME: "EnvPinned" },
    });
    const snapshot = await store.get();
    expect(snapshot.contract.name).toBe("EnvPinned");
    expect(snapshot.pinned).toEqual({ name: "env" });
    await expect(store.update({ name: "Hacker" }, "admin")).rejects.toThrow(BrandFieldPinnedError);
  });

  it("branding.json pin icon 且 update icon 被拒", async () => {
    const file = tmpFile(JSON.stringify({ icon: "/brand/pinned.png" }));
    const { store } = storeWith({ filePath: file });
    const snapshot = await store.get();
    expect(snapshot.contract.icon).toBe("/brand/pinned.png");
    expect(snapshot.pinned).toEqual({ icon: "file" });
    await expect(store.update({ icon: "/brand/other.png" }, "admin")).rejects.toThrow(
      BrandFieldPinnedError,
    );
  });

  it("branding.json 损坏不击穿服务：回退上一良好 overlay 并继续可读", async () => {
    const file = tmpFile("{ not json");
    const { store } = storeWith({ filePath: file });
    const snapshot = await store.get();
    expect(snapshot.contract.name).toBe(DEFAULT_BRAND.name);
  });
});

describe("BrandStore 写入与事件", () => {
  it("update 事务写入 revision+1 与合并后文档，并扇出快照", async () => {
    let current: BrandRow | null = row({ schemaVersion: 1, name: "Before" }, 4);
    const fetchRow = vi.fn(async () => current);
    const writeRow = vi.fn(
      async (input: {
        document: Record<string, unknown>;
        revision: number;
        revisionBefore: number;
        patch: Record<string, unknown>;
        actor: string | null;
      }) => {
        current = row(input.document, input.revision);
        expect(input.revisionBefore).toBe(4);
        expect(input.actor).toBe("admin");
        expect(input.patch).toEqual({ name: "After" });
      },
    );
    const store = createBrandStore({
      fetchRow,
      writeRow,
      env: {},
      filePath: null,
      startPoll: false,
    });
    const listener = vi.fn();
    store.subscribe(listener);

    const snapshot = await store.update({ name: "After" }, "admin");

    expect(writeRow).toHaveBeenCalledTimes(1);
    const written = writeRow.mock.calls[0]?.[0] as {
      document: Record<string, unknown>;
      revision: number;
    };
    expect(written.revision).toBe(5);
    expect(written.document).toMatchObject({ name: "After" });
    expect(snapshot.contract.name).toBe("After");
    expect(snapshot.contract.revision).toBe(5);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("校验失败的 update 不写库", async () => {
    const { store, writeRow } = storeWith({ row: row({ schemaVersion: 1, name: "Ok" }, 1) });
    await expect(store.update({ icon: "https://evil.example/x.png" }, "admin")).rejects.toThrow(
      BrandValidationError,
    );
    expect(writeRow).not.toHaveBeenCalled();
  });

  it("etag 随 revision 变化，供缓存校验", async () => {
    let current: BrandRow | null = row({ schemaVersion: 1, name: "One" }, 1);
    const store = createBrandStore({
      fetchRow: async () => current,
      writeRow: async (input: { document: Record<string, unknown>; revision: number }) => {
        current = row(input.document, input.revision);
      },
      env: {},
      filePath: null,
      startPoll: false,
    });
    const before = (await store.get()).etag;
    await store.update({ name: "Two" }, "admin");
    const after = (await store.get()).etag;
    expect(before).not.toBe(after);
  });
});
