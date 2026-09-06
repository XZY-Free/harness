#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { collectSkippedTests } from "./topic-01-vitest-result.mjs";

const allowed = new Set(["unit", "db", "integration", "contract"]);
const groups = process.argv.slice(2);
if (groups.length === 0 || groups.some((group) => !allowed.has(group))) {
  throw new Error(`Vitest 分组非法：${groups.join(", ") || "<empty>"}`);
}

const rawResults = groups.map((group) => `.topic01-vitest-result.${group}.json`);
const output = "docs/topic-01/evidence/vitest-skipped-tests.json";
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
    writeFileSync(output, `${JSON.stringify(skippedTests, null, 2)}\n`);
    console.log(`Skipped tests recorded: ${skippedTests.length}`);
  }
} finally {
  for (const rawResult of rawResults) rmSync(rawResult, { force: true });
}

if (exitCode !== 0) process.exit(exitCode);
