import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

const retiredPaths = [
  "lib/compatibility",
  "lib/v11/control-plane",
  "lib/v11/runtime/execution-binding-queries.ts",
  "lib/v11/runtime/hosted-route-bootstrap.ts",
] as const;

const stableControlPlaneRoots = [
  "lib/agents",
  "lib/artifacts",
  "lib/executions",
  "lib/publications",
  "lib/routes",
  "lib/runtimes",
] as const;

describe("Agent 控制面稳定路径边界", () => {
  it("删除已被正式模块替代的旧路径与 compatibility 目录", () => {
    const residual = retiredPaths.filter((path) => existsSync(join(repositoryRoot, path)));

    expect(residual).toEqual([]);
  });

  it("正式控制面生产代码不反向依赖 lib/v11 或 lib/compatibility", () => {
    const violations = stableControlPlaneRoots.flatMap((root) =>
      listProductionTypeScriptFiles(join(repositoryRoot, root)).flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return source.includes("@/lib/v11/") || source.includes("@/lib/compatibility/")
          ? [relative(repositoryRoot, file)]
          : [];
      }),
    );

    expect(violations).toEqual([]);
  });
});

function listProductionTypeScriptFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      return entry === "test-support" ? [] : listProductionTypeScriptFiles(path);
    }
    if (!path.endsWith(".ts") || path.endsWith(".test.ts") || path.endsWith(".spec.ts")) return [];
    return [path];
  });
}
