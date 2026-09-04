import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MATRIX_PATH,
  PLAN_PATH,
  REQUIRED_ACCEPTANCE_IDS,
  selectVerificationStages,
  validateAcceptanceMatrix,
  validateAcceptanceResult,
  validateVerificationPlan,
} from "./topic-01-acceptance-contract.mjs";

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Topic01 canonical acceptance contracts", () => {
  it("canonical plan 可按 profile 和单 stage 选择且不引用旧工程包", () => {
    const plan = validateVerificationPlan(json(PLAN_PATH));
    expect(
      selectVerificationStages(plan, "quick").map((stage: { id: string }) => stage.id),
    ).toEqual(plan.profiles.quick);
    expect(selectVerificationStages(plan, "acceptance", "schema-authority")).toHaveLength(1);
    expect(JSON.stringify(plan)).not.toContain("docs/V12/01");
    expect(JSON.stringify(plan)).not.toMatch(/7[0-3]-|90-final/);
  });

  it("matrix 精确覆盖十个阻断项并引用生产入口、门禁、测试和证据", () => {
    const matrix = validateAcceptanceMatrix(json(MATRIX_PATH));
    expect(matrix.items.map((item: { id: string }) => item.id)).toEqual(REQUIRED_ACCEPTANCE_IDS);
    for (const item of matrix.items as Array<{
      productionEntry: string[];
      machineGate: string[];
      testEvidence: string[];
      evidenceArtifact: string[];
    }>) {
      expect(item.productionEntry.length).toBeGreaterThan(0);
      expect(item.machineGate.length).toBeGreaterThan(0);
      expect(item.testEvidence.length).toBeGreaterThan(0);
      expect(item.evidenceArtifact.length).toBeGreaterThan(0);
    }
  });

  it("CLOSED 必须同时满足本地完整通过、远端 exact SHA 与 GitHub CI", () => {
    const base = {
      schemaVersion: 2,
      baselineSha: "a".repeat(40),
      localAcceptanceSha: "b".repeat(40),
      remoteHeadSha: "b".repeat(40),
      githubCi: "passed",
      fullLocalAcceptance: "passed",
      status: "closed",
      skippedTests: [],
    };
    expect(validateAcceptanceResult(base, { requireClosed: true })).toBe(base);
    expect(() =>
      validateAcceptanceResult({ ...base, remoteHeadSha: "c".repeat(40) }, { requireClosed: true }),
    ).toThrow("exact SHA");
    expect(() =>
      validateAcceptanceResult({ ...base, githubCi: "pending" }, { requireClosed: true }),
    ).toThrow("GitHub CI passed");
  });
});
