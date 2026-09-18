import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ARTIFACTS_BASE,
  MATRIX_PATH,
  PLAN_PATH,
  REQUIRED_ACCEPTANCE_IDS,
  RESULT_PATH,
  SKIPPED_TESTS_PATH,
  selectVerificationStages,
  validateAcceptanceMatrix,
  validateAcceptanceResult,
  validateVerificationPlan,
} from "./acceptance-contract.mjs";

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(args: string[]): { ok: boolean; stdout: string } {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", args, {
        encoding: "utf8",
        // 失败是这些断言的正常分支（路径未跟踪 / 未被忽略），不要把 git 的报错泄到测试输出。
        stdio: ["ignore", "pipe", "ignore"],
      }),
    };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function isTracked(path: string): boolean {
  return git(["ls-files", "--error-unmatch", path]).ok;
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

  it("运行产物不进跟踪，受控基线与允许清单仍受版本管理", () => {
    // 产物目录：验收流程自己重写的位置，必须不在跟踪内，否则 worktree-cleanliness 必然判脏。
    expect(RESULT_PATH.startsWith(`${ARTIFACTS_BASE}/`)).toBe(true);
    expect(SKIPPED_TESTS_PATH.startsWith(`${ARTIFACTS_BASE}/`)).toBe(true);
    for (const artifact of [RESULT_PATH, SKIPPED_TESTS_PATH]) {
      expect(git(["check-ignore", artifact]).ok, `${artifact} 必须被 .gitignore 覆盖`).toBe(true);
      expect(isTracked(artifact), `${artifact} 不得纳入版本管理`).toBe(false);
    }
    // 受控基线（计划 / 矩阵 / 结果 schema / 跳过允许清单）必须仍然跟踪。
    for (const baseline of [
      PLAN_PATH,
      MATRIX_PATH,
      "docs/topic-01/evidence/acceptance-result.schema.json",
      "docs/topic-01/evidence/skipped-test-registry.json",
      "docs/topic-01/evidence/test-collection.json",
      "scripts/acceptance.mjs",
      "scripts/acceptance-contract.mjs",
      "scripts/vitest-stage.mjs",
      "scripts/worktree-cleanliness.mjs",
      "scripts/evidence-integrity.mjs",
    ]) {
      expect(isTracked(baseline), `${baseline} 必须继续版本管理`).toBe(true);
    }
  });

  it("CLOSED 必须同时满足本地完整通过、远端 exact SHA 与 GitHub CI", () => {
    const base = {
      schemaVersion: 2,
      baselineSha: "a".repeat(40),
      localAcceptanceSha: "b".repeat(40),
      runId: `${"b".repeat(12)}-1758000000000-4242`,
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

  it("验收结果必须带运行标识，且运行标识形状受约束", () => {
    const base = {
      schemaVersion: 2,
      baselineSha: "a".repeat(40),
      localAcceptanceSha: "b".repeat(40),
      runId: `${"b".repeat(12)}-1758000000000-4242`,
      remoteHeadSha: null,
      githubCi: "pending",
      profile: "acceptance",
      planPath: PLAN_PATH,
      matrixPath: MATRIX_PATH,
      status: "local-passed",
      fullLocalAcceptance: "passed",
      worktreeCleanBeforeRun: true,
      artifactDigests: {},
      skippedTests: [],
      acceptanceIdResults: [],
      stages: [],
    };
    expect(validateAcceptanceResult(base).runId).toBe(base.runId);
    expect(() => validateAcceptanceResult({ ...base, runId: undefined })).toThrow("runId");
    expect(() => validateAcceptanceResult({ ...base, runId: "not-a-run-id" })).toThrow("runId");
    expect(() => validateAcceptanceResult({ ...base, runId: "" })).toThrow("runId");
  });
});
