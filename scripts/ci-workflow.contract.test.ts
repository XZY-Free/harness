import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const plan = JSON.parse(
  readFileSync("docs/implementation/topic-01-final-closure/73-verification-plan.json", "utf8"),
) as { stages: Array<{ id: string }> };

describe("final CI workflow contract", () => {
  it("CI、verify 与完整验收共用机器验证计划", () => {
    expect(workflow).toContain("run: pnpm topic01:acceptance");
    expect(packageJson.scripts.verify).toContain("topic-01-acceptance.mjs --profile verify");
    expect(packageJson.scripts["topic01:acceptance"]).toBe("node scripts/topic-01-acceptance.mjs");
    expect(plan.stages).toHaveLength(13);
  });

  it("本地确定性安全门禁不依赖外部 audit 端点", () => {
    expect(packageJson.scripts["security:check"]).toBe("pnpm security:license");
    expect(packageJson.scripts["security:audit"]).toBe("pnpm audit --audit-level moderate");
  });

  it("Workflow 不再复制阶段命令或追加单文件测试", () => {
    for (const duplicate of [
      "pnpm contracts:verify",
      "pnpm architecture:gate",
      "pnpm typecheck",
      "pnpm test",
      "pnpm test:e2e",
      "lib/control-plane/end-to-end-acceptance.test.ts",
      "desktop/main/local-renderer-server.test.ts",
    ]) {
      expect(workflow).not.toContain(duplicate);
    }
  });
});
