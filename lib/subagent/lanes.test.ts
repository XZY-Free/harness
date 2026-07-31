import { describe, expect, it } from "vitest";
import { DEFAULT_LANES, type SubagentLaneSpec, getLaneSpec, isLaneReadOnly } from "./lanes";

/** 取 lane spec，缺失则抛（测试断言 lane 存在，避免非空断言）。 */
function lane(role: "explore" | "researcher" | "reviewer" | "verifier"): SubagentLaneSpec {
  const spec = getLaneSpec(role);
  if (!spec) throw new Error(`lane ${role} 应存在`);
  return spec;
}

/**
 * V3.5 Stage D：默认 lane 定义完整性测试。
 *
 * 锁定：四只读 lane（explore/researcher/reviewer/verifier）全部只读、outputSchema 存在、
 * allowedTools 非空。S1（04-G7）起 executor 预置写能力默认 lane（defaultWriteScope=null）。
 */

const WRITE_TOOLS = ["writeFile", "editFile", "multiEditFile", "applyPatch", "deleteFile"];

describe("默认 lane 定义完整性", () => {
  it("explore/researcher/reviewer/verifier 四 lane 存在", () => {
    for (const role of ["explore", "researcher", "reviewer", "verifier"] as const) {
      const spec = getLaneSpec(role);
      expect(spec, `${role} lane 应存在`).not.toBeNull();
    }
  });

  it("S1（04-G7）：executor 预置默认 lane（写能力,含写工具 + 验证工具）", () => {
    const spec = getLaneSpec("executor");
    expect(spec).not.toBeNull();
    if (!spec) return;
    expect(spec.allowedTools).toEqual(
      expect.arrayContaining(["writeFile", "editFile", "runBuild", "runTests"]),
    );
    // defaultWriteScope=null（fail-closed,spawn 时须显式指定）
    expect(spec.defaultWriteScope).toBeNull();
    expect(isLaneReadOnly(spec)).toBe(false); // executor 非只读
    expect((spec.outputSchema as { type?: string }).type).toBe("object");
  });

  it("四 lane 全部只读：无 writeScope + allowedTools 不含写工具", () => {
    for (const role of ["explore", "researcher", "reviewer", "verifier"] as const) {
      const spec = lane(role);
      expect(spec.defaultWriteScope, `${role} 无 writeScope`).toBeNull();
      const writes = spec.allowedTools.filter((t) => WRITE_TOOLS.includes(t));
      expect(writes, `${role} 不应含写工具，实际含 ${writes.join(",")}`).toEqual([]);
      expect(isLaneReadOnly(spec), `${role} 应判定只读`).toBe(true);
    }
  });

  it("四 lane 各自 outputSchema 存在且为 object schema", () => {
    for (const role of ["explore", "researcher", "reviewer", "verifier"] as const) {
      const spec = lane(role);
      expect(spec.outputSchema, `${role} outputSchema`).toBeTruthy();
      expect((spec.outputSchema as { type?: string }).type).toBe("object");
      expect((spec.outputSchema as { required?: unknown[] }).required).toBeTruthy();
    }
  });

  it("explore lane allowedTools 含读搜索工具", () => {
    const spec = lane("explore");
    expect(spec.allowedTools).toEqual(
      expect.arrayContaining(["readFile", "readFileRange", "glob", "grep"]),
    );
  });

  it("researcher lane 含 V3.4 web 工具", () => {
    const spec = lane("researcher");
    expect(spec.allowedTools).toEqual(
      expect.arrayContaining(["webFetch", "webSearch", "searchDocs"]),
    );
  });

  it("verifier lane 含 runTests（退化核查，无 V3.6 截图）", () => {
    const spec = lane("verifier");
    expect(spec.allowedTools).toContain("runTests");
    // V3.6 未落地，不含截图工具
    expect(spec.allowedTools).not.toContain("browserScreenshot");
  });

  it("DEFAULT_LANES 与 getLaneSpec 一致", () => {
    for (const role of ["explore", "researcher", "reviewer", "verifier"] as const) {
      expect(DEFAULT_LANES[role]).toBe(getLaneSpec(role));
    }
  });
});
