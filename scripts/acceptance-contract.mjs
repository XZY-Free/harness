#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EVIDENCE_BASE = "docs/topic-01/evidence";
export const PLAN_PATH = `${EVIDENCE_BASE}/verification-plan.json`;
export const MATRIX_PATH = `${EVIDENCE_BASE}/acceptance-matrix.json`;
export const RESULT_PATH = `${EVIDENCE_BASE}/acceptance-result.json`;
export const REQUIRED_ACCEPTANCE_IDS = [
  "KNOWLEDGE-SUBJECT-ACL",
  "AGENT-SCENARIO-AUTHORITY",
  "TOOL-PERMISSION-AUTHORITY",
  "TOOL-PROVIDER-CLOSURE",
  "HOSTED-RESUME-DURABILITY",
  "HOSTED-CANCEL-STEER",
  "EXTERNAL-RUNTIME-HTTP",
  "RUNTIME-RETRY-DEFAULT-WIRING",
  "DURABLE-WORKER-TOPOLOGY",
  "SCHEMA-EVIDENCE-INTEGRITY",
];
export const REQUIRED_STAGE_IDS = [
  "static-architecture",
  "schema-authority",
  "vitest",
  "production-wiring",
  "fresh-db",
  "web-build",
  "desktop-build",
  "e2e-web",
  "e2e-desktop",
  "e2e-cross-client",
  "acceptance-matrix",
  "worktree-cleanliness",
  "final-evidence-integrity",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertString(value, label) {
  assert(typeof value === "string" && value.trim().length > 0, `${label} 必须是非空字符串`);
}

function assertStringArray(value, label) {
  assert(Array.isArray(value) && value.length > 0, `${label} 必须是非空数组`);
  for (const entry of value) assertString(entry, label);
}

function repositoryPath(reference) {
  return reference.split("#", 1)[0].split(":", 1)[0];
}

export function validateAcceptanceMatrix(matrix, root = process.cwd()) {
  assert(matrix?.schemaVersion === 2, "acceptance matrix schemaVersion 必须为 2");
  assert(Array.isArray(matrix.items), "acceptance matrix items 缺失");
  const ids = matrix.items.map((item) => item.id);
  assert(
    JSON.stringify(ids) === JSON.stringify(REQUIRED_ACCEPTANCE_IDS),
    "acceptance IDs 缺失、重复或顺序漂移",
  );
  for (const item of matrix.items) {
    assertString(item.requirement, `${item.id}.requirement`);
    assertStringArray(item.productionEntry, `${item.id}.productionEntry`);
    assertStringArray(item.authority, `${item.id}.authority`);
    assertStringArray(item.machineGate, `${item.id}.machineGate`);
    assertStringArray(item.testEvidence, `${item.id}.testEvidence`);
    assertStringArray(item.evidenceArtifact, `${item.id}.evidenceArtifact`);
    assertString(item.passCondition, `${item.id}.passCondition`);
    assert(
      !/^文件存在|exists$/i.test(item.passCondition.trim()),
      `${item.id} passCondition 不能只是文件存在`,
    );
    for (const reference of [
      ...item.productionEntry,
      ...item.authority,
      ...item.machineGate,
      ...item.testEvidence,
      ...item.evidenceArtifact,
    ]) {
      const path = repositoryPath(reference);
      assert(existsSync(`${root}/${path}`), `${item.id} 引用了不存在的仓库路径：${path}`);
    }
    for (const entry of item.productionEntry) {
      assert(
        !/\.test\.|\.spec\.|(?:^|\/)(?:test|tests|__tests__|fixtures?)(?:\/|$)/.test(entry),
        `${item.id} productionEntry 不能指向测试：${entry}`,
      );
    }
  }
  return matrix;
}

export function validateVerificationPlan(plan) {
  assert(plan?.schemaVersion === 2, "verification plan schemaVersion 必须为 2");
  assert(plan.authority === PLAN_PATH, "verification plan authority 必须指向 canonical path");
  assert(plan.resultPath === RESULT_PATH, "verification plan resultPath 必须指向 canonical path");
  assert(Array.isArray(plan.stages), "verification plan stages 缺失");
  const ids = plan.stages.map((stage) => stage.id);
  assert(new Set(ids).size === ids.length, "verification plan stage id 重复");
  for (const required of REQUIRED_STAGE_IDS)
    assert(ids.includes(required), `verification plan 缺少 ${required}`);
  for (const stage of plan.stages) {
    assertString(stage.name, `${stage.id}.name`);
    assert(
      Array.isArray(stage.commands) && stage.commands.length > 0,
      `${stage.id}.commands 不能为空`,
    );
    for (const command of stage.commands) assertStringArray(command, `${stage.id}.commands[]`);
  }
  for (const [profile, selected] of Object.entries(plan.profiles ?? {})) {
    assert(Array.isArray(selected) && selected.length > 0, `profile ${profile} 不能为空`);
    for (const id of selected)
      assert(ids.includes(id), `profile ${profile} 引用了未知 stage ${id}`);
  }
  assert(
    JSON.stringify(plan.profiles.acceptance) === JSON.stringify(plan.profiles.verify),
    "acceptance 与 verify 必须共用完整阶段",
  );
  return plan;
}

/**
 * @param {any} plan
 * @param {string} profile
 * @param {string | null} requestedStage
 */
export function selectVerificationStages(plan, profile, requestedStage = null) {
  validateVerificationPlan(plan);
  const selectedIds = requestedStage ? [requestedStage] : plan.profiles[profile];
  assert(Array.isArray(selectedIds), `未知验证 profile：${profile}`);
  return selectedIds.map((id) => {
    const stage = plan.stages.find((candidate) => candidate.id === id);
    assert(stage, `验证计划缺少 stage：${id}`);
    return stage;
  });
}

export function validateAcceptanceResult(result, { requireClosed = false } = {}) {
  assert(result?.schemaVersion === 2, "acceptance result schemaVersion 必须为 2");
  assertString(result.baselineSha, "baselineSha");
  assertString(result.localAcceptanceSha, "localAcceptanceSha");
  assert(["pending", "passed", "failed"].includes(result.githubCi), "githubCi 非法");
  assert(
    result.remoteHeadSha === null || typeof result.remoteHeadSha === "string",
    "remoteHeadSha 非法",
  );
  assert(Array.isArray(result.skippedTests), "skippedTests 缺失");
  for (const [index, skipped] of result.skippedTests.entries()) {
    for (const field of ["file", "testName", "reason", "acceptanceImpact"]) {
      assertString(skipped[field], `skippedTests[${index}].${field}`);
    }
  }
  if (requireClosed || result.status === "closed") {
    assert(result.githubCi === "passed", "CLOSED 要求 GitHub CI passed");
    assert(
      result.remoteHeadSha === result.localAcceptanceSha,
      "CLOSED 要求 remote/local exact SHA 相等",
    );
    assert(result.fullLocalAcceptance === "passed", "CLOSED 要求本地完整验收 passed");
  }
  return result;
}

export function loadCanonicalContracts(root = process.cwd()) {
  const plan = validateVerificationPlan(JSON.parse(readFileSync(`${root}/${PLAN_PATH}`, "utf8")));
  const matrix = validateAcceptanceMatrix(
    JSON.parse(readFileSync(`${root}/${MATRIX_PATH}`, "utf8")),
    root,
  );
  return { plan, matrix };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { plan, matrix } = loadCanonicalContracts();
  console.log(
    `Topic01 contracts OK: ${plan.stages.length} stages, ${matrix.items.length} acceptance IDs`,
  );
}
