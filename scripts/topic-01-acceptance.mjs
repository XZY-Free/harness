#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const PLAN_PATH = resolve(
  ROOT,
  "docs/implementation/topic-01-final-closure/73-verification-plan.json",
);
const plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profile = profileIndex >= 0 ? args[profileIndex + 1] : "acceptance";
const stageIndex = args.indexOf("--stage");
const requestedStage = stageIndex >= 0 ? args[stageIndex + 1] : null;

if (!Array.isArray(plan.stages) || plan.stages.length < 13) {
  throw new Error("73-verification-plan.json 至少需要 13 个阶段");
}
const stageIds = plan.stages.map((stage) => stage.id);
if (new Set(stageIds).size !== stageIds.length) throw new Error("验证计划存在重复 stage id");
const selectedIds = requestedStage ? [requestedStage] : plan.profiles[profile];
if (!Array.isArray(selectedIds)) throw new Error(`未知验证 profile：${profile}`);
const stages = selectedIds.map((id) => {
  const stage = plan.stages.find((candidate) => candidate.id === id);
  if (!stage) throw new Error(`验证计划缺少 stage：${id}`);
  return stage;
});

if (args.includes("--plan")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "plan",
        profile,
        planPath: "docs/implementation/topic-01-final-closure/73-verification-plan.json",
        stageCount: stages.length,
        stages,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

function commandOutput(executable, commandArgs) {
  return execFileSync(executable, commandArgs, { cwd: ROOT, encoding: "utf8" }).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const worktreeCleanBeforeRun = commandOutput("git", ["status", "--short"]) === "";
if (!worktreeCleanBeforeRun) throw new Error("完整验收开始前工作区不干净");
const audit = JSON.parse(
  readFileSync(
    resolve(ROOT, "docs/implementation/topic-01-final-closure/72-test-collection-audit.json"),
    "utf8",
  ),
);
const schemaManifest = JSON.parse(
  readFileSync(
    resolve(ROOT, "docs/implementation/topic-01-final-closure/71-final-schema-manifest.json"),
    "utf8",
  ),
);
const acceptanceMatrix = JSON.parse(
  readFileSync(
    resolve(
      ROOT,
      "docs/V12/01/SnowHarness-Topic01-Final-Closure-Engineering-Package/acceptance-matrix.json",
    ),
    "utf8",
  ),
);
const knownBatchTitles = new Set([
  "docs(topic-01): freeze final closure contract",
  "feat(harness): bind production capability catalog and tool execution",
  "fix(runtime): preserve trusted execution subject",
  "refactor(agent-call): enforce canonical call authorities",
  "fix(agent-call): centralize ingress state transitions",
  "feat(runtime): resume harness from durable agent continuations",
  "test(topic-01): consolidate gates and schema evidence",
]);
const batchCommits = commandOutput("git", ["log", "--format=%H%x09%s", "-30"])
  .split("\n")
  .map((line) => {
    const [sha, ...titleParts] = line.split("\t");
    return { sha, title: titleParts.join("\t") };
  })
  .filter((commit) => knownBatchTitles.has(commit.title))
  .reverse();
if (batchCommits.length !== 7) throw new Error(`Batch 00—06 提交不完整：${batchCommits.length}/7`);

const startedAt = new Date().toISOString();
const previousResult = (() => {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, plan.resultPath), "utf8"));
  } catch {
    return null;
  }
})();
const result = {
  schemaVersion: 1,
  baselineSha: "704b022735d64c176d9096406ae9a61d2e01eafd",
  finalSha: commandOutput("git", ["rev-parse", "HEAD"]),
  batchCommits,
  profile,
  planPath: "docs/implementation/topic-01-final-closure/73-verification-plan.json",
  startedAt,
  finishedAt: null,
  durationMs: null,
  status: "running",
  environment: {
    node: process.version,
    pnpm: commandOutput("pnpm", ["--version"]),
    platform: process.platform,
    arch: process.arch,
  },
  testCount: { files: audit.total, byGroup: audit.counts },
  finalSchemaCount: schemaManifest.counts.canonical,
  acceptanceIdResults: acceptanceMatrix.items.map((item) => ({ id: item.id, result: "pending" })),
  fullLocalAcceptance: "running",
  githubFullCi: "not_run_not_required",
  worktreeCleanBeforeRun,
  worktreeCleanAfterEvidenceCommit: "pending_evidence_commit",
  artifactChecksums: {
    planSha256: sha256(readFileSync(PLAN_PATH)),
    schemaManifestSha256: sha256(
      readFileSync(resolve(ROOT, "docs/implementation/topic-01-final-closure/71-final-schema-manifest.json")),
    ),
    testAuditSha256: sha256(
      readFileSync(resolve(ROOT, "docs/implementation/topic-01-final-closure/72-test-collection-audit.json")),
    ),
  },
  previousRuns:
    previousResult && previousResult.status === "failed"
      ? [
          ...(previousResult.previousRuns ?? []),
          {
            startedAt: previousResult.startedAt,
            finishedAt: previousResult.finishedAt,
            status: previousResult.status,
            failedStage: previousResult.stages?.find((stage) => stage.status === "failed")?.id ?? null,
          },
        ]
      : [],
  stages: [],
};
const resultPath = resolve(ROOT, plan.resultPath);

function persist() {
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
    const commandStartedAt = new Date(commandStarted).toISOString();
    const run = spawnSync(executable, commandArgs, { cwd: ROOT, stdio: "inherit", env: process.env });
    const commandRecord = {
      command,
      startedAt: commandStartedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - commandStarted,
      exitCode: run.status,
      signal: run.signal,
    };
    stageResult.commands.push({ ...commandRecord, recordChecksum: sha256(JSON.stringify(commandRecord)) });
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
result.status = "passed";
result.fullLocalAcceptance = "passed";
result.acceptanceIdResults = result.acceptanceIdResults.map((item) => ({ ...item, result: "passed" }));
result.finishedAt = new Date().toISOString();
result.durationMs = Date.now() - Date.parse(startedAt);
persist();
console.log(`\n[topic01] ${stages.length} 个阶段全部通过`);
