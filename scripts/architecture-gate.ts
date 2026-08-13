#!/usr/bin/env npx tsx
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const ROOT = process.cwd();
const SOURCE_ROOTS = ["app", "components", "desktop", "lib", "scripts", "docs"];
const RETIRED_VERSION = `v${11}`;
const RETIRED_PATTERNS = [
  new RegExp(`/${RETIRED_VERSION}/`, "i"),
  new RegExp(`/${RETIRED_VERSION.toUpperCase()}/`),
  new RegExp(`${RETIRED_VERSION}-`, "i"),
  new RegExp(`use${RETIRED_VERSION.toUpperCase()}`),
  new RegExp(`build${RETIRED_VERSION.toUpperCase()}`),
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".json", ".md", ".py"]);
const TOPIC_DEPRECATION_ALLOWLIST = new Set([
  "lib/routes/application/backfill-route-group-fields.ts",
  "lib/external/docs.ts",
  // CycloneDX 1.6 官方规范原文，外部标准不可改写。
  "lib/artifacts/verification/schemas/cyclonedx-1.6.schema.json",
]);

let failures = 0;

function fail(message: string): void {
  console.error(`FAIL: ${message}`);
  failures++;
}

function pass(message: string): void {
  console.log(`PASS: ${message}`);
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => {
    if ([".git", ".next", "build", "dist", "node_modules", "__pycache__"].includes(entry)) {
      return [];
    }
    return filesUnder(resolve(path, entry));
  });
}

function sourceFiles(): string[] {
  return SOURCE_ROOTS.flatMap((root) => filesUnder(resolve(ROOT, root))).filter((file) => {
    const extension = file.slice(file.lastIndexOf("."));
    return SOURCE_EXTENSIONS.has(extension);
  });
}

function checkMigrationJournal(): void {
  const journalPath = resolve(ROOT, "drizzle/meta/_journal.json");
  try {
    const entries = JSON.parse(readFileSync(journalPath, "utf8")).entries as Array<{
      idx: number;
      tag: string;
    }>;
    const invalid = entries.filter(
      (entry, index) =>
        entry.idx !== index || !existsSync(resolve(ROOT, `drizzle/${entry.tag}.sql`)),
    );
    if (invalid.length > 0) {
      fail(`migration journal 不连续或 SQL 缺失：${invalid.map((entry) => entry.tag).join(", ")}`);
      return;
    }
    pass(`migration journal 完整：${entries.length} 条`);
  } catch (error) {
    fail(`无法读取 migration journal：${String(error)}`);
  }
}

function checkRetiredNaming(): void {
  const violations = sourceFiles().flatMap((file) => {
    const repositoryPath = relative(ROOT, file);
    const source = readFileSync(file, "utf8");
    return RETIRED_PATTERNS.some(
      (pattern) => pattern.test(`/${repositoryPath}`) || pattern.test(source),
    )
      ? [repositoryPath]
      : [];
  });
  if (violations.length > 0) {
    fail(`发现已退役版本命名：${violations.join(", ")}`);
    return;
  }
  pass("已退役版本命名归零");
}

function checkAbsent(paths: readonly string[], title: string): void {
  const residual = paths.filter((path) => existsSync(resolve(ROOT, path)));
  if (residual.length > 0) {
    fail(`${title}仍存在：${residual.join(", ")}`);
    return;
  }
  pass(`${title}已删除`);
}

function checkControlPlaneClient(): void {
  const consumers = ["app", "components", "desktop"]
    .flatMap((root) => filesUnder(resolve(ROOT, root)))
    .filter((file) => {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return false;
      return readFileSync(file, "utf8").includes("@/lib/control-plane-client");
    });
  if (consumers.length === 0) {
    fail("没有 Web 或 Admin 入口实际使用 control-plane client");
    return;
  }
  pass(`control-plane client 有 ${consumers.length} 个 App 消费者`);
}

function checkDeprecatedArchitecture(): void {
  const deprecated = /@deprecated|\blegacy\b|\bcutover\b|\bshadow\b|fallback legacy/i;
  const violations = sourceFiles().flatMap((file) => {
    const path = relative(ROOT, file);
    if (
      !/^(lib\/(agents|artifacts|executions|publications|routes|runtime)\/|app\/admin\/api\/v1\/)/.test(
        path,
      )
    ) {
      return [];
    }
    // 测试代码与测试夹具不属于正式源码，与 .test.ts 同类排除。
    if (
      path.endsWith(".test.ts") ||
      path.endsWith(".test.tsx") ||
      path.includes("/test-support/") ||
      TOPIC_DEPRECATION_ALLOWLIST.has(path)
    ) {
      return [];
    }
    return deprecated.test(readFileSync(file, "utf8")) ? [path] : [];
  });
  if (violations.length > 0) {
    fail(`发现未登记的已废弃架构表述：${violations.join(", ")}`);
    return;
  }
  pass("未发现未登记的已废弃架构表述");
}

function main(): void {
  checkMigrationJournal();
  checkRetiredNaming();
  checkAbsent(
    [
      "app/api/chat/route.ts",
      "components/workspace.tsx",
      "components/chat-panel.tsx",
      "lib/chat/sse-transport.ts",
    ],
    "旧 Web 执行入口",
  );
  checkAbsent(["lib/runtimes"], "旧 Runtime 目录");
  if (existsSync(resolve(ROOT, "lib/runtime"))) pass("正式 Runtime 目录存在");
  else fail("正式 Runtime 目录不存在");
  checkAbsent(
    [
      "lib/routes/application/upsert-deployment-route.ts",
      "lib/routes/application/disable-deployment-route.ts",
    ],
    "单 Route 兼容写入口",
  );
  checkControlPlaneClient();
  const placeholder = `sha256:${"0".repeat(64)}`;
  const placeholderUses = sourceFiles().filter((file) => {
    const path = relative(ROOT, file);
    return (
      (path.startsWith("app/") ||
        path.startsWith("components/") ||
        path.startsWith("desktop/") ||
        path.startsWith("lib/") ||
        path.startsWith("scripts/")) &&
      !path.includes("test-support") &&
      !path.includes(".test.") &&
      readFileSync(file, "utf8").includes(placeholder)
    );
  });
  if (placeholderUses.length > 0) fail(`正式源码存在占位摘要：${placeholderUses.join(", ")}`);
  else pass("正式源码不存在占位摘要");
  if (
    existsSync(resolve(ROOT, "docs/contracts/openapi.json")) &&
    existsSync(resolve(ROOT, "scripts/contracts.mjs"))
  ) {
    pass("正式机器合同与校验入口存在");
  } else {
    fail("机器合同或校验入口缺失");
  }
  checkDeprecatedArchitecture();
  if (failures > 0) process.exitCode = 1;
}

main();
