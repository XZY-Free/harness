#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SKIPPED_TESTS_PATH } from "./acceptance-contract.mjs";
import { collectSkippedTests } from "./vitest-result.mjs";

const allowed = new Set(["unit", "db", "integration", "contract"]);
const groups = process.argv.slice(2);
if (groups.length === 0 || groups.some((group) => !allowed.has(group))) {
  throw new Error(`Vitest 分组非法：${groups.join(", ") || "<empty>"}`);
}

const rawResults = groups.map((group) => `.vitest-result.${group}.json`);
/** 运行产物（不进版本管理）；受控允许清单仍是 `skipped-test-registry.json`。 */
const output = SKIPPED_TESTS_PATH;
const reports = [];
let exitCode = 0;

try {
  for (const [index, group] of groups.entries()) {
    const rawResult = rawResults[index];
    rmSync(rawResult, { force: true });
    const args = [
      "vitest",
      "run",
      "--project",
      group,
      ...(group === "db" ? ["--maxWorkers=1", "--minWorkers=1", "--no-file-parallelism"] : []),
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${rawResult}`,
    ];
    const run = spawnSync("pnpm", args, { stdio: "inherit", env: process.env });
    if (run.status !== 0) {
      exitCode = run.status ?? 1;
      break;
    }
    reports.push(JSON.parse(readFileSync(rawResult, "utf8")));
  }

  if (exitCode === 0) {
    const registry = JSON.parse(
      readFileSync("docs/topic-01/evidence/skipped-test-registry.json", "utf8"),
    );
    const skippedTests = reports.flatMap((report) => collectSkippedTests(report, registry));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(skippedTests, null, 2)}\n`);
    console.log(`Skipped tests recorded: ${skippedTests.length}`);
  }
} finally {
  for (const rawResult of rawResults) rmSync(rawResult, { force: true });
}

if (exitCode !== 0) process.exit(exitCode);
