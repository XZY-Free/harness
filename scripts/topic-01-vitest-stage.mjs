#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { collectSkippedTests } from "./topic-01-vitest-result.mjs";

const allowed = new Set(["unit", "db", "integration", "contract"]);
const groups = process.argv.slice(2);
if (groups.length === 0 || groups.some((group) => !allowed.has(group))) {
  throw new Error(`Vitest 分组非法：${groups.join(", ") || "<empty>"}`);
}

const rawResult = ".topic01-vitest-result.json";
const output = "docs/topic-01/evidence/vitest-skipped-tests.json";
const args = [
  "vitest",
  "run",
  ...groups.flatMap((group) => ["--project", group]),
  "--reporter=default",
  "--reporter=json",
  `--outputFile.json=${rawResult}`,
];
const run = spawnSync("pnpm", args, { stdio: "inherit", env: process.env });
if (run.status !== 0) process.exit(run.status ?? 1);

try {
  const report = JSON.parse(readFileSync(rawResult, "utf8"));
  const registry = JSON.parse(
    readFileSync("docs/topic-01/evidence/skipped-test-registry.json", "utf8"),
  );
  const skippedTests = collectSkippedTests(report, registry);
  writeFileSync(output, `${JSON.stringify(skippedTests, null, 2)}\n`);
  console.log(`Skipped tests recorded: ${skippedTests.length}`);
} finally {
  rmSync(rawResult, { force: true });
}
