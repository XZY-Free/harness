import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkEvidenceIntegrity } from "./topic-01-evidence-integrity.mjs";

describe("Topic01 evidence integrity structure", () => {
  it("canonical evidence 可独立校验且脚本不依赖旧编号或 V12 工程包", () => {
    expect(checkEvidenceIntegrity(process.cwd(), { requireResult: false }).artifactCount).toBe(14);
    const source = readFileSync("scripts/topic-01-evidence-integrity.mjs", "utf8");
    expect(source).not.toContain("docs/implementation/topic-01-final-closure");
    expect(source).not.toContain("docs/V12/01");
    expect(source).not.toMatch(/7[0-3]-|90-final/);
  });
});
