#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const ROOT = process.cwd();
const OUTPUT = resolve(
  ROOT,
  "docs/implementation/topic-01-final-closure/72-test-collection-audit.json",
);
const GROUPS = [
  "unit",
  "db",
  "integration",
  "contract",
  "e2e-web",
  "e2e-desktop",
  "e2e-cross-client",
];

function filesUnder(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) =>
    ["node_modules", ".git", ".next", ".next-e2e", "dist", "build"].includes(entry)
      ? []
      : filesUnder(resolve(path, entry)),
  );
}

function needsDatabase(path, source) {
  if (/\.(?:db|mysql)\.test\.[cm]?[jt]sx?$/.test(path)) return true;
  const withoutMockDeclarations = source.replace(/vi\.mock\([\s\S]*?\);/g, "");
  return /resetDatabase|startMySqlHarness|withTestDatabase|ensureTestDatabase|createTestDatabase|seedDatabase|from\s+["']@\/lib\/db\/client["']|\bdb\.(?:insert|select|update|delete|transaction|execute)\b/.test(
    withoutMockDeclarations,
  );
}

function groupFor(path, source, db) {
  if (path.startsWith("e2e/") && path.includes(".spec.")) {
    if (path === "e2e/cross-client.spec.ts") return "e2e-cross-client";
    if (path.includes("desktop")) return "e2e-desktop";
    return "e2e-web";
  }
  if (db) return "db";
  if (
    path.includes(".integration.test.") ||
    /end-to-end|end_to_end/.test(path) ||
    /^(lib\/runtime\/(?:adapters\/hosted-adapter|application\/create-resume-harness-invocation|command-dispatcher|dispatcher|employee-turn-dispatcher|in-process-hosted-runtime)|lib\/control-plane\/events\/invocation-continuation-consumer)\.test\.ts$/.test(
      path,
    )
  ) {
    return "integration";
  }
  if (
    path.startsWith("scripts/") ||
    /(?:contract|conformance|protocol|architecture|manifest|schema-authority|boundary)\.(?:behavior\.)?test\./.test(
      path,
    )
  ) {
    return "contract";
  }
  return "unit";
}

function build() {
  const files = filesUnder(ROOT)
    .map((path) => relative(ROOT, path))
    .filter(
      (path) =>
        /\.(?:test|spec)\.(?:ts|tsx)$/.test(path) &&
        (!path.endsWith(".spec.ts") || path.startsWith("e2e/")),
    )
    .sort();
  const tests = files.map((file) => {
    const source = readFileSync(resolve(ROOT, file), "utf8");
    const needsDB = (file.startsWith("e2e/") && file.includes(".spec.")) || needsDatabase(file, source);
    const group = groupFor(file, source, needsDB);
    return {
      file,
      group,
      command: group.startsWith("e2e-")
        ? `pnpm exec playwright test ${file}`
        : `pnpm vitest run --project ${group}`,
      needsDB,
      serial: needsDB || group.startsWith("e2e-"),
      inFullAcceptance: true,
      batchAcceptanceIds: ["topic01-final-acceptance"],
    };
  });
  const counts = Object.fromEntries(GROUPS.map((group) => [group, tests.filter((test) => test.group === group).length]));
  return {
    generatedAt: "2026-09-04",
    authority: "scripts/topic-01-test-collection-audit.mjs",
    policy: {
      vitest: "每个 .test.ts/.test.tsx 只进入 unit/db/integration/contract 一个 project",
      playwright: "每个 e2e/*.spec.ts 只进入 Web/Desktop/Cross-client 一个阶段",
      duplicateExecution: "完整验收只调用四个 Vitest project 一次，不再追加单文件 Vitest 命令",
    },
    counts,
    total: tests.length,
    tests,
  };
}

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validate(audit) {
  const paths = audit.tests.map((test) => test.file);
  const duplicatePaths = paths.filter((path, index) => paths.indexOf(path) !== index);
  if (duplicatePaths.length > 0) throw new Error(`测试重复收集：${[...new Set(duplicatePaths)].join(", ")}`);
  for (const test of audit.tests) {
    if (!GROUPS.includes(test.group)) throw new Error(`${test.file} 分组非法：${test.group}`);
    if (
      (test.file.startsWith("e2e/") && test.file.includes(".spec.")) !==
      test.group.startsWith("e2e-")
    ) {
      throw new Error(`${test.file} E2E/Vitest 边界错误`);
    }
  }
  const controlPlane = audit.tests.filter(
    (test) => test.file === "lib/control-plane/end-to-end-acceptance.test.ts",
  );
  if (controlPlane.length !== 1) throw new Error("Control Plane 端到端测试不是唯一收集");
  const renderer = audit.tests.filter(
    (test) => test.file === "desktop/main/local-renderer-server.test.ts",
  );
  if (renderer.length !== 1) throw new Error("Desktop Renderer 测试不是唯一收集");
  const config = readFileSync(resolve(ROOT, "vitest.config.ts"), "utf8");
  if (!config.includes("72-test-collection-audit.json")) {
    throw new Error("vitest.config.ts 未使用机器清单");
  }
  const plan = JSON.parse(
    readFileSync(
      resolve(ROOT, "docs/implementation/topic-01-final-closure/73-verification-plan.json"),
      "utf8",
    ),
  );
  const vitestStage = plan.stages.find((stage) => stage.id === "vitest");
  const flattenedVitest = JSON.stringify(vitestStage?.commands ?? []);
  for (const group of ["unit", "db", "integration", "contract"]) {
    if (!flattenedVitest.includes(`\"${group}\"`)) throw new Error(`Vitest 阶段缺少 ${group}`);
  }
  if (/\.test\.[jt]sx?/.test(flattenedVitest)) {
    throw new Error("完整 Vitest 阶段不得追加单文件测试");
  }
  const nonVitestStages = plan.stages.filter((stage) => stage.id !== "vitest");
  if (/\bvitest\b|\.test\.[jt]sx?/.test(JSON.stringify(nonVitestStages))) {
    throw new Error("非 Vitest 阶段重复执行 Vitest 文件");
  }
  if (!process.argv.includes("--write") && readFileSync(OUTPUT, "utf8") !== stable(audit)) {
    throw new Error("72-test-collection-audit.json 未更新");
  }
}

const audit = build();
if (process.argv.includes("--write")) writeFileSync(OUTPUT, stable(audit));
validate(audit);
console.log(
  `Test collection OK: ${audit.total} files; ${Object.entries(audit.counts)
    .map(([group, count]) => `${group}=${count}`)
    .join(", ")}`,
);
