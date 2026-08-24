import { isMysqlDuplicateEntryError } from "@/lib/db/mysql-error";
import { describe, expect, it } from "vitest";

/**
 * S1（drizzle 0.34.1 → 0.45.2）：MySQL 重复键错误形态 12 项回归测试。
 * Drizzle 0.45 把 mysql2 的 ER_DUP_ENTRY 放进错误对象的 cause，现有生产模块只查
 * 顶层 code/errno，导致并发唯一键误判为普通错误。
 *
 * 本测试锁定一个共享、纯逻辑、与 Drizzle 版本解耦的判定边界：
 *   isMysqlDuplicateEntryError(error: unknown): boolean
 * 后续生产实现位于 lib/db/mysql-error.ts。
 *
 * 只断言行为，不检查源码字符串，不 mock 数据库结论。
 */

function dupErr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: "ER_DUP_ENTRY",
    errno: 1062,
    sqlState: "23000",
    message: "Duplicate entry 'x' for key 'PRIMARY'",
    ...overrides,
  };
}

describe("isMysqlDuplicateEntryError", () => {
  it("顶层 code=ER_DUP_ENTRY → true", () => {
    expect(isMysqlDuplicateEntryError(dupErr())).toBe(true);
  });

  it("顶层 errno=1062（无 code）→ true", () => {
    expect(isMysqlDuplicateEntryError(dupErr({ code: undefined }))).toBe(true);
  });

  it("单层 cause 承载 ER_DUP_ENTRY → true", () => {
    const err = new Error("outer");
    err.cause = dupErr();
    expect(isMysqlDuplicateEntryError(err)).toBe(true);
  });

  it("至少两层 cause 承载 ER_DUP_ENTRY → true", () => {
    const leaf = new Error("drizzle wrap");
    leaf.cause = dupErr();
    const middle = new Error("mapper");
    middle.cause = leaf;
    const outer = new Error("route");
    outer.cause = middle;
    expect(isMysqlDuplicateEntryError(outer)).toBe(true);
  });

  it("非重复 MySQL 错误（code=ER_LOCK_DEADLOCK）→ false", () => {
    expect(isMysqlDuplicateEntryError(dupErr({ code: "ER_LOCK_DEADLOCK", errno: 1213 }))).toBe(
      false,
    );
  });

  it("null → false", () => {
    expect(isMysqlDuplicateEntryError(null)).toBe(false);
  });

  it("undefined → false", () => {
    expect(isMysqlDuplicateEntryError(undefined)).toBe(false);
  });

  it("primitive → false", () => {
    expect(isMysqlDuplicateEntryError("boom")).toBe(false);
    expect(isMysqlDuplicateEntryError(42)).toBe(false);
    expect(isMysqlDuplicateEntryError(true)).toBe(false);
  });

  it("普通对象（无 code/errno/cause）→ false", () => {
    expect(isMysqlDuplicateEntryError({ message: "x" })).toBe(false);
    expect(isMysqlDuplicateEntryError({})).toBe(false);
  });

  it("自引用 cause → 有限终止且 false", () => {
    const err: Record<string, unknown> = { code: "ER_X", errno: 1 };
    err.cause = err;
    expect(isMysqlDuplicateEntryError(err)).toBe(false);
  });

  it("循环 cause 链（无 ER_DUP_ENTRY）→ 有限终止且 false", () => {
    const a: Record<string, unknown> = { code: "ER_X", errno: 1 };
    const b: Record<string, unknown> = { code: "ER_Y", errno: 2 };
    a.cause = b;
    b.cause = a;
    expect(isMysqlDuplicateEntryError(a)).toBe(false);
    expect(isMysqlDuplicateEntryError(b)).toBe(false);
  });

  it("循环 cause 链中存在 ER_DUP_ENTRY → true", () => {
    const a: Record<string, unknown> = { code: "ER_X", errno: 1 };
    const dup: Record<string, unknown> = dupErr();
    const c: Record<string, unknown> = { code: "ER_Y", errno: 2 };
    a.cause = dup;
    dup.cause = c;
    c.cause = a; // 闭环，但链上已含 ER_DUP_ENTRY
    expect(isMysqlDuplicateEntryError(a)).toBe(true);
  });
});
