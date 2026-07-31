import { describe, expect, it, vi } from "vitest";
import {
  type ScopedWorkspaceStore,
  WriteScopeError,
  pathInWriteScope,
} from "./scoped-workspace-store";
import type { WorkspaceStore } from "./types";

/**
 * V3.5 Stage B：ScopedWorkspaceStore 写范围收窄测试。
 *
 * 用 fake inner store 验证：write/delete 在 writeScope 内允许、外则 throw；
 * read/stat/list/glob/grep 不受 writeScope 限制；null scope = 只读（写一律拒）。
 */

function fakeInner(): WorkspaceStore {
  return {
    root: vi.fn(() => "/ws"),
    safeJoin: vi.fn((p: string) => `/ws/${p}`),
    read: vi.fn(async () => "content"),
    write: vi.fn(async (p: string) => p),
    delete: vi.fn(async () => true),
    stat: vi.fn(async () => ({ size: 1, mtime: new Date(), isDirectory: false })),
    list: vi.fn(async () => ["a.ts"]),
    glob: vi.fn(async () => ["a.ts"]),
    grep: vi.fn(async () => ({ matches: [], truncated: false })),
    mountTarget: vi.fn(() => "/workspace"),
  };
}

// 动态导入以便类型生效
const { ScopedWorkspaceStore: SWS } = await import("./scoped-workspace-store");

describe("pathInWriteScope", () => {
  it("null/空 scope = 只读，恒 false", () => {
    expect(pathInWriteScope("src/a.ts", null)).toBe(false);
    expect(pathInWriteScope("src/a.ts", [])).toBe(false);
  });

  it("精确路径 glob 命中", () => {
    expect(pathInWriteScope("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(pathInWriteScope("src/b.ts", ["src/a.ts"])).toBe(false);
  });

  it("** 递归 glob 命中子目录", () => {
    expect(pathInWriteScope("src/sub/a.ts", ["src/**"])).toBe(true);
    expect(pathInWriteScope("docs/a.ts", ["src/**"])).toBe(false);
  });

  it("路径前导 ./ 与 / 被规范化", () => {
    expect(pathInWriteScope("./src/a.ts", ["src/**"])).toBe(true);
    expect(pathInWriteScope("/src/a.ts", ["src/**"])).toBe(true);
  });
});

describe("ScopedWorkspaceStore write/delete 收窄", () => {
  it("writeScope 内 write 放行", async () => {
    const inner = fakeInner();
    const store = new SWS(inner, ["src/**"]);
    await store.write("src/a.ts", "x");
    expect(inner.write).toHaveBeenCalledWith("src/a.ts", "x");
  });

  it("writeScope 外 write → throw WriteScopeError，不调 inner.write", async () => {
    const inner = fakeInner();
    const store = new SWS(inner, ["src/**"]);
    await expect(store.write("docs/a.ts", "x")).rejects.toBeInstanceOf(WriteScopeError);
    expect(inner.write).not.toHaveBeenCalled();
  });

  it("writeScope 外 delete → throw", async () => {
    const inner = fakeInner();
    const store = new SWS(inner, ["src/**"]);
    await expect(store.delete("docs/a.ts")).rejects.toBeInstanceOf(WriteScopeError);
    expect(inner.delete).not.toHaveBeenCalled();
  });

  it("writeScope 内 delete 放行", async () => {
    const inner = fakeInner();
    const store = new SWS(inner, ["src/**"]);
    await store.delete("src/a.ts");
    expect(inner.delete).toHaveBeenCalledWith("src/a.ts");
  });

  it("null writeScope = 只读：write/delete 一律 throw", async () => {
    const inner = fakeInner();
    const store = new SWS(inner, null);
    await expect(store.write("src/a.ts", "x")).rejects.toBeInstanceOf(WriteScopeError);
    await expect(store.delete("src/a.ts")).rejects.toBeInstanceOf(WriteScopeError);
  });
});

describe("ScopedWorkspaceStore 读操作不限", () => {
  it("read/stat/list/glob/grep 不受 writeScope 限制（null scope 仍可读）", async () => {
    const inner = fakeInner();
    const store: ScopedWorkspaceStore = new SWS(inner, null);
    await store.read("docs/a.ts");
    await store.stat("docs/a.ts");
    await store.list();
    await store.glob("**/*.ts");
    await store.grep("foo");
    expect(inner.read).toHaveBeenCalledWith("docs/a.ts");
    expect(inner.stat).toHaveBeenCalledWith("docs/a.ts");
    expect(inner.list).toHaveBeenCalled();
    expect(inner.glob).toHaveBeenCalled();
    expect(inner.grep).toHaveBeenCalled();
  });

  it("root/safeJoin/mountTarget 透传 inner", () => {
    const inner = fakeInner();
    const store = new SWS(inner, ["src/**"]);
    expect(store.root()).toBe("/ws");
    expect(store.safeJoin("a.ts")).toBe("/ws/a.ts");
    expect(store.mountTarget()).toBe("/workspace");
  });
});
