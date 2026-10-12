#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** 受版本管理的受控基线（plan / matrix / schema / 允许清单）所在目录。 */
export const EVIDENCE_BASE = "docs/topic-01/evidence";
/**
 * 运行产物目录：由验收与测试流程在本机生成，**不进版本管理**
 * （见 .gitignore 的 `docs/topic-01/evidence/artifacts/`）。
 *
 * 分离理由：产物在每次运行中被流程自身重写，若纳入跟踪则 `worktree-cleanliness`
 * 必然判脏，门禁只能靠放宽来通过——那是掩盖问题，不是修复。
 */
export const ARTIFACTS_BASE = `${EVIDENCE_BASE}/artifacts`;
export const PLAN_PATH = `${EVIDENCE_BASE}/verification-plan.json`;
export const MATRIX_PATH = `${EVIDENCE_BASE}/acceptance-matrix.json`;
export const RESULT_PATH = `${ARTIFACTS_BASE}/acceptance-result.json`;
/** `vitest-stage.mjs` 写、`acceptance.mjs` 读的跳过用例记录（运行产物）。 */
export const SKIPPED_TESTS_PATH = `${ARTIFACTS_BASE}/vitest-skipped-tests.json`;
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
  assertString(result.runId, "runId");
  assert(
    /^[0-9a-f]{12}-\d+-\d+$/.test(result.runId),
    "runId 必须是 <sha12>-<epochMs>-<pid>，一次运行一个标识",
  );
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
  // 阶段证据必须完整记录：实际命令、**退出码**、起止时刻与记录校验和缺一不可。
  // `stages` 一直是 `acceptance-result.schema.json` 的必填项，此前只是校验器没读它。
  // 规则对运行中的中间态同样成立：`acceptance.mjs` 先把阶段落成 running + 空命令集，
  // 只有命令全部以 0 退出才置 passed —— 所以「声称 passed」等价于「确实全绿」。
  assert(Array.isArray(result.stages), "stages 缺失");
  for (const [stageIndex, stage] of result.stages.entries()) {
    const label = `stages[${stageIndex}]`;
    assertString(stage.id, `${label}.id`);
    assert(["running", "passed", "failed"].includes(stage.status), `${label}.status 非法`);
    assert(Array.isArray(stage.commands), `${label}.commands 缺失`);
    for (const [commandIndex, entry] of stage.commands.entries()) {
      const commandLabel = `${label}.commands[${commandIndex}]`;
      assertStringArray(entry.command, `${commandLabel}.command`);
      assert(
        entry.exitCode === null || Number.isInteger(entry.exitCode),
        `${commandLabel}.exitCode 必须是整数或 null`,
      );
      assertString(entry.startedAt, `${commandLabel}.startedAt`);
      assertString(entry.finishedAt, `${commandLabel}.finishedAt`);
      assertString(entry.recordChecksum, `${commandLabel}.recordChecksum`);
    }
    if (stage.status === "passed") {
      assert(stage.commands.length > 0, `${label} 声称 passed 却没有任何命令记录`);
      for (const entry of stage.commands) {
        assert(
          entry.exitCode === 0,
          `${label} 声称 passed，但 ${entry.command.join(" ")} 的退出码是 ${entry.exitCode}`,
        );
      }
    }
  }
  // 「未运行不得 PASS」：声称完整本地验收通过，就必须留下真实阶段记录。
  if (result.fullLocalAcceptance === "passed") {
    assert(result.stages.length > 0, "fullLocalAcceptance 为 passed 但没有任何阶段记录");
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
