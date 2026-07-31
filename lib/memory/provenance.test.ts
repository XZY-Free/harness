import { describe, expect, it } from "vitest";
import { normalizeProvenance, summarizeProvenance, validateProvenance } from "./provenance";

describe("normalizeProvenance", () => {
  it("数组：保留合法项，剔除无效项（非法 kind / 空 refId）", () => {
    const out = normalizeProvenance([
      { kind: "tool_run", refId: "tr-1", threadId: "t1" },
      { kind: "invalid", refId: "x" },
      { kind: "message", refId: "" },
      { kind: "user", refId: "u1", summary: "手动" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "tool_run", refId: "tr-1", threadId: "t1" });
    expect(out[1]).toMatchObject({ kind: "user", refId: "u1", summary: "手动" });
  });

  it("单条对象 → 单元素数组", () => {
    expect(normalizeProvenance({ kind: "user", refId: "u1" })).toHaveLength(1);
  });

  it("null / undefined / 非对象 → 空数组", () => {
    expect(normalizeProvenance(null)).toEqual([]);
    expect(normalizeProvenance(undefined)).toEqual([]);
    expect(normalizeProvenance("str")).toEqual([]);
  });
});

describe("validateProvenance", () => {
  it("空数组 → 抛错（provenance 必填）", () => {
    expect(() => validateProvenance([])).toThrow(/必填/);
  });

  it("合法 → 不抛", () => {
    expect(() => validateProvenance([{ kind: "user", refId: "u1" }])).not.toThrow();
  });

  it("含非法 kind → 抛错", () => {
    expect(() => validateProvenance([{ kind: "x" as never, refId: "u1" }])).toThrow(/非法/);
  });

  it("空 refId → 抛错", () => {
    expect(() => validateProvenance([{ kind: "user", refId: "" }])).toThrow(/非法/);
  });
});

describe("summarizeProvenance", () => {
  it("人可读摘要（含 thread + summary）", () => {
    const s = summarizeProvenance([
      { kind: "tool_run", refId: "tr-1234567890", threadId: "t12345678" },
      { kind: "user", refId: "u1", summary: "手动" },
    ]);
    expect(s).toContain("tool_run#");
    expect(s).toContain("@t1234567");
    expect(s).toContain("user#u1:手动");
  });

  it("超长截断到 ≤200 字符", () => {
    const long = Array.from({ length: 50 }, (_, i) => ({
      kind: "user" as const,
      refId: `u${i}`,
    }));
    expect(summarizeProvenance(long).length).toBeLessThanOrEqual(200);
  });
});
