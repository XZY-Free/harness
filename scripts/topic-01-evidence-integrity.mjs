#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  MATRIX_PATH,
  PLAN_PATH,
  RESULT_PATH,
  loadCanonicalContracts,
  validateAcceptanceResult,
} from "./topic-01-acceptance-contract.mjs";

const REQUIRED_ARTIFACTS = [
  MATRIX_PATH,
  PLAN_PATH,
  "docs/topic-01/evidence/acceptance-result.schema.json",
  "docs/topic-01/evidence/schema-inventory.json",
  "docs/topic-01/evidence/schema-inventory.md",
  "docs/topic-01/evidence/schema-inventory.schema.json",
  "docs/topic-01/evidence/schema-manifest.json",
  "docs/topic-01/evidence/test-collection.json",
  "docs/topic-01/evidence/skipped-test-registry.json",
  "docs/topic-01/remediation/capability-and-knowledge.md",
  "docs/topic-01/remediation/tool-authority-and-execution.md",
  "docs/topic-01/remediation/hosted-control-and-resume.md",
  "docs/topic-01/remediation/external-runtime-transport.md",
  "docs/topic-01/remediation/runtime-retry-worker-topology.md",
];

function digest(root, path) {
  return createHash("sha256")
    .update(readFileSync(`${root}/${path}`))
    .digest("hex");
}

export function checkEvidenceIntegrity(root = process.cwd(), { requireResult = true } = {}) {
  const missing = REQUIRED_ARTIFACTS.filter((path) => !existsSync(`${root}/${path}`));
  if (missing.length > 0) throw new Error(`canonical evidence 缺失：${missing.join(", ")}`);
  for (const path of REQUIRED_ARTIFACTS.filter((name) => name.endsWith(".json"))) {
    JSON.parse(readFileSync(`${root}/${path}`, "utf8"));
  }
  const { plan } = loadCanonicalContracts(root);
  if (!requireResult) return { artifactCount: REQUIRED_ARTIFACTS.length, result: null };
  if (!existsSync(`${root}/${RESULT_PATH}`)) throw new Error("acceptance-result.json 不存在");
  const result = validateAcceptanceResult(
    JSON.parse(readFileSync(`${root}/${RESULT_PATH}`, "utf8")),
  );
  const currentHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (result.localAcceptanceSha !== currentHead) {
    throw new Error("acceptance result localAcceptanceSha 不是当前 HEAD");
  }
  if (result.planPath !== PLAN_PATH || result.matrixPath !== MATRIX_PATH) {
    throw new Error("acceptance result 没有绑定 canonical plan/matrix");
  }
  const expectedStages = plan.profiles[result.profile];
  const priorStages = result.stages.filter((stage) => stage.id !== "final-evidence-integrity");
  const expectedPrior = expectedStages.filter((id) => id !== "final-evidence-integrity");
  if (
    JSON.stringify(priorStages.map((stage) => stage.id)) !== JSON.stringify(expectedPrior) ||
    priorStages.some((stage) => stage.status !== "passed")
  ) {
    throw new Error("final evidence integrity 前的阶段未按 canonical plan 全部通过");
  }
  const expectedDigests = {
    verificationPlanSha256: digest(root, PLAN_PATH),
    acceptanceMatrixSha256: digest(root, MATRIX_PATH),
    schemaManifestSha256: digest(root, "docs/topic-01/evidence/schema-manifest.json"),
    testCollectionSha256: digest(root, "docs/topic-01/evidence/test-collection.json"),
  };
  if (JSON.stringify(result.artifactDigests) !== JSON.stringify(expectedDigests)) {
    throw new Error("acceptance result artifact digest 与当前 canonical evidence 不一致");
  }
  return { artifactCount: REQUIRED_ARTIFACTS.length, result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checked = checkEvidenceIntegrity();
  console.log(
    `Evidence integrity OK: ${checked.artifactCount} canonical artifacts + ${checked.result.stages.length - 1} prior stages`,
  );
}
