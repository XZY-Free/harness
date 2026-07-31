import { describe, expect, it } from "vitest";
import { buildGlobArgs, buildGrepArgs } from "./workspace-store";

/**
 * V3.3b Stage 0 #5：grep/glob 必须显式 workspace root、不挂 stdin。
 *
 * rg 无路径参数时会从 stdin 读入并挂住工具调用（V3.1 已修：显式传 "."）。
 * 本契约守护该修复不被回退——buildGrepArgs 必须以 "." 结尾。
 * 限时（30s timeout）/限量（maxResults/maxBuffer）见 workspace-store 实现 + 集成测试。
 */

describe("Stage 0 #5：grep/glob 显式 workspace root，不挂 stdin", () => {
  it("buildGrepArgs 显式以 '.' 结尾（不从 stdin 读，不挂死）", () => {
    const args = buildGrepArgs("foo");
    expect(args[args.length - 1]).toBe(".");
    expect(args[args.length - 2]).toBe("foo");
    expect(args).toContain("--json");
    expect(args).toContain("-n");
  });

  it("buildGrepArgs 透传 glob / caseInsensitive / context 选项", () => {
    const args = buildGrepArgs("foo", { glob: "*.ts", caseInsensitive: true, context: 2 });
    expect(args).toContain("-g");
    expect(args).toContain("*.ts");
    expect(args).toContain("-i");
    expect(args).toContain("-C");
    expect(args).toContain("2");
    // 仍以 '.' 结尾
    expect(args[args.length - 1]).toBe(".");
  });

  it("buildGlobArgs：--files -g pattern；includeIgnored → --no-ignore", () => {
    expect(buildGlobArgs("**/*.ts")).toEqual(["--files", "-g", "**/*.ts"]);
    expect(buildGlobArgs("**/*.ts", { includeIgnored: true })).toContain("--no-ignore");
  });
});
