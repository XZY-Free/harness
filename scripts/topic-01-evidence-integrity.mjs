#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const required = [
  "00-baseline.md",
  "01-current-production-path-map.md",
  "02-existing-reliability-primitives.md",
  "03-acceptance-contract.md",
  "10-batch-01-evidence.md",
  "20-batch-02-evidence.md",
  "30-batch-03-evidence.md",
  "40-batch-04-evidence.md",
  "50-batch-05-evidence.md",
  "60-batch-06-evidence.md",
  "70-schema-table-inventory.md",
  "70-schema-table-inventory.json",
  "70-schema-table-inventory.schema.json",
  "71-final-schema-manifest.json",
  "72-test-collection-audit.json",
  "73-verification-plan.json",
  "91-final-review-checklist.md",
];
const base = "docs/implementation/topic-01-final-closure";
const missing = required.filter((file) => !existsSync(`${base}/${file}`));
if (missing.length > 0) throw new Error(`最终证据缺失：${missing.join(", ")}`);
for (const file of required.filter((name) => name.endsWith(".json"))) {
  JSON.parse(readFileSync(`${base}/${file}`, "utf8"));
}
const resultPath = `${base}/90-final-acceptance.json`;
if (!existsSync(resultPath)) throw new Error("验收执行结果不存在");
const result = JSON.parse(readFileSync(resultPath, "utf8"));
const preceding = result.stages.filter((stage) => stage.id !== "evidence-integrity");
if (preceding.length !== 12 || preceding.some((stage) => stage.status !== "passed")) {
  throw new Error("证据完整性检查前的 12 个阶段未全部通过");
}
console.log(`Evidence integrity OK: ${required.length} required artifacts + 12 passed stages`);
