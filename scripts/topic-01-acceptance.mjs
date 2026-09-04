#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MATRIX_PATH,
  PLAN_PATH,
  RESULT_PATH,
  loadCanonicalContracts,
  selectVerificationStages,
  validateAcceptanceResult,
} from "./topic-01-acceptance-contract.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profile = profileIndex >= 0 ? args[profileIndex + 1] : "acceptance";
const stageIndex = args.indexOf("--stage");
const requestedStage = stageIndex >= 0 ? args[stageIndex + 1] : null;
const { plan, matrix } = loadCanonicalContracts(ROOT);
const stages = selectVerificationStages(plan, profile, requestedStage);
const skippedTestsPath = resolve(ROOT, "docs/topic-01/evidence/vitest-skipped-tests.json");

if (args.includes("--plan")) {
  process.stdout.write(
    `${JSON.stringify({ mode: "plan", profile, planPath: PLAN_PATH, stageCount: stages.length, stages }, null, 2)}\n`,
  );
  process.exit(0);
}

function commandOutput(executable, commandArgs) {
  return execFileSync(executable, commandArgs, { cwd: ROOT, encoding: "utf8" }).trim();
}

function sha256File(repositoryPath) {
  return createHash("sha256")
    .update(readFileSync(resolve(ROOT, repositoryPath)))
    .digest("hex");
}

function readJson(repositoryPath) {
  return JSON.parse(readFileSync(resolve(ROOT, repositoryPath), "utf8"));
}

function readSkippedTests() {
  const path = "docs/topic-01/evidence/vitest-skipped-tests.json";
  return existsSync(resolve(ROOT, path)) ? readJson(path) : [];
}

const worktreeStatus = commandOutput("git", ["status", "--short"]);
if (worktreeStatus) throw new Error(`完整验收开始前工作区不干净：\n${worktreeStatus}`);
const localAcceptanceSha = commandOutput("git", ["rev-parse", "HEAD"]);
commandOutput("git", ["cat-file", "-e", `${plan.baselineSha}^{commit}`]);
const githubCi = process.env.TOPIC01_GITHUB_CI ?? "pending";
const remoteHeadSha = process.env.TOPIC01_REMOTE_HEAD_SHA ?? process.env.GITHUB_SHA ?? null;
const testCollection = readJson("docs/topic-01/evidence/test-collection.json");
const schemaManifest = readJson("docs/topic-01/evidence/schema-manifest.json");
const startedAt = new Date().toISOString();
const resultPath = resolve(ROOT, RESULT_PATH);
if (stages.some((stage) => stage.id === "vitest")) rmSync(skippedTestsPath, { force: true });
const result = {
  schemaVersion: 2,
  baselineSha: plan.baselineSha,
  diffRange: `${plan.baselineSha}..${localAcceptanceSha}`,
  localAcceptanceSha,
  remoteHeadSha,
  githubCi,
  profile,
  planPath: PLAN_PATH,
  matrixPath: MATRIX_PATH,
  startedAt,
  finishedAt: null,
  durationMs: null,
  status: "running",
  fullLocalAcceptance: "running",
  worktreeCleanBeforeRun: true,
  environment: {
    node: process.version,
    pnpm: commandOutput("pnpm", ["--version"]),
    platform: process.platform,
    arch: process.arch,
  },
  informationalCounts: {
    testFiles: testCollection.total,
    testFilesByGroup: testCollection.counts,
    schemaTables: schemaManifest.counts.canonical,
  },
  artifactDigests: {
    verificationPlanSha256: sha256File(PLAN_PATH),
    acceptanceMatrixSha256: sha256File(MATRIX_PATH),
    schemaManifestSha256: sha256File("docs/topic-01/evidence/schema-manifest.json"),
    testCollectionSha256: sha256File("docs/topic-01/evidence/test-collection.json"),
  },
  skippedTests: [],
  acceptanceIdResults: matrix.items.map((item) => ({ id: item.id, result: "pending" })),
  stages: [],
};

function persist() {
  result.skippedTests = readSkippedTests();
  validateAcceptanceResult(result);
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

persist();
for (const stage of stages) {
  const stageStarted = Date.now();
  const stageResult = {
    id: stage.id,
    name: stage.name,
    startedAt: new Date(stageStarted).toISOString(),
    finishedAt: null,
    durationMs: null,
    status: "running",
    commands: [],
  };
  result.stages.push(stageResult);
  persist();
  console.log(`\n[topic01] ${stage.name}`);
  for (const command of stage.commands) {
    const [executable, ...commandArgs] = command;
    const commandStarted = Date.now();
    const commandRecord = {
      command,
      startedAt: new Date(commandStarted).toISOString(),
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      signal: null,
    };
    const run = spawnSync(executable, commandArgs, {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    commandRecord.finishedAt = new Date().toISOString();
    commandRecord.durationMs = Date.now() - commandStarted;
    commandRecord.exitCode = run.status;
    commandRecord.signal = run.signal;
    stageResult.commands.push({
      ...commandRecord,
      recordChecksum: createHash("sha256").update(JSON.stringify(commandRecord)).digest("hex"),
    });
    if (run.status !== 0) {
      stageResult.status = "failed";
      stageResult.finishedAt = new Date().toISOString();
      stageResult.durationMs = Date.now() - stageStarted;
      result.status = "failed";
      result.fullLocalAcceptance = "failed";
      result.finishedAt = new Date().toISOString();
      result.durationMs = Date.now() - Date.parse(startedAt);
      persist();
      process.exit(run.status ?? 1);
    }
    persist();
  }
  stageResult.status = "passed";
  stageResult.finishedAt = new Date().toISOString();
  stageResult.durationMs = Date.now() - stageStarted;
  persist();
}

result.fullLocalAcceptance = requestedStage ? "partial" : "passed";
result.acceptanceIdResults = result.acceptanceIdResults.map((item) => ({
  ...item,
  result: requestedStage ? "pending" : "passed",
}));
result.status =
  !requestedStage && githubCi === "passed" && remoteHeadSha === localAcceptanceSha
    ? "closed"
    : requestedStage
      ? "partial-passed"
      : "local-passed";
result.finishedAt = new Date().toISOString();
result.durationMs = Date.now() - Date.parse(startedAt);
persist();
console.log(`\n[topic01] ${stages.length} 个阶段通过，状态：${result.status}`);
