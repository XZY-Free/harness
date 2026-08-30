#!/usr/bin/env npx tsx
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  type SourceDocument,
  checkAgentCallFinalizationGate,
  checkAgentCallRuntimeBoundaryGate,
  checkAgentInvokeAuthorizationGate,
  checkNineIssueCloseoutGate,
  checkResumeTruthfulnessGate,
  checkTopic01FinalCloseoutGate,
  collectCloseoutBoundaryViolations,
  collectDeprecatedArchitectureViolations,
  collectTopic01BoundaryViolations,
} from "./architecture-gate-rules";

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
  const documents: SourceDocument[] = sourceFiles().flatMap((file) => {
    const path = relative(ROOT, file);
    return [{ path, source: readFileSync(file, "utf8") }];
  });
  const violations = collectDeprecatedArchitectureViolations(
    documents,
    TOPIC_DEPRECATION_ALLOWLIST,
  );
  if (violations.length > 0) {
    fail(`发现未登记的已废弃架构表述：${violations.join(", ")}`);
    return;
  }
  pass("未发现未登记的已废弃架构表述");
}

/**
 * 专题01 §23.2 / §32 最终 Architecture Gate 边界规则。
 *
 * 纯规则实现位于 architecture-gate-rules.collectTopic01BoundaryViolations，
 * 本处仅构造 SourceDocument 并调用，失败信息列出违规路径。
 * 作用域与精确排除（含 .test.* 与规则定义文件 scripts/architecture-gate.ts、
 * scripts/architecture-gate-rules.ts）由纯规则模块负责，此处不重复正则。
 */
function checkTopic01Boundaries(): void {
  const PRODUCTION_ROOTS = ["app", "components", "desktop", "lib", "scripts"];
  const documents: SourceDocument[] = PRODUCTION_ROOTS.flatMap((root) =>
    filesUnder(resolve(ROOT, root)),
  )
    .filter((file) => SOURCE_EXTENSIONS.has(file.slice(file.lastIndexOf("."))))
    .map((file) => ({ path: relative(ROOT, file), source: readFileSync(file, "utf8") }));
  const violations = collectTopic01BoundaryViolations(documents);
  if (violations.length > 0) {
    fail(`专题01 Harness/Agent 边界规则违规：\n  ${violations.join("\n  ")}`);
    return;
  }
  pass("专题01 Harness/Agent 边界规则归零");
}

function checkAgentInvokeAuthorization(): void {
  const documents: SourceDocument[] = ["app", "components", "desktop", "lib", "scripts"]
    .flatMap((root) => filesUnder(resolve(ROOT, root)))
    .filter((file) => SOURCE_EXTENSIONS.has(file.slice(file.lastIndexOf("."))))
    .map((file) => ({ path: relative(ROOT, file), source: readFileSync(file, "utf8") }));
  const result = checkAgentInvokeAuthorizationGate(documents);
  if (result.passed) pass("Agent 发现与 Turn 调用授权边界闭合");
  else fail(`Agent 调用授权边界违规：\n  ${result.failures.join("\n  ")}`);
}

/** 剩余代码收口（V12/01 08 专项）边界规则 E1-E4 + Registration 证据 + Resume 门禁。 */
function checkCloseoutRules(): void {
  const PRODUCTION_ROOTS = ["app", "components", "desktop", "lib", "scripts"];
  const documents: SourceDocument[] = PRODUCTION_ROOTS.flatMap((root) =>
    filesUnder(resolve(ROOT, root)),
  )
    .filter((file) => SOURCE_EXTENSIONS.has(file.slice(file.lastIndexOf("."))))
    .map((file) => ({ path: relative(ROOT, file), source: readFileSync(file, "utf8") }));

  const boundaryViolations = collectCloseoutBoundaryViolations(documents);
  if (boundaryViolations.length > 0) {
    fail(
      `收口边界规则违规（E1-E4）：\n  ${boundaryViolations
        .map((v) => `${v.title} → ${v.path}`)
        .join("\n  ")}`,
    );
  } else {
    pass("收口边界规则 E1-E4 归零");
  }

  const resume = checkResumeTruthfulnessGate(documents);
  if (resume.passed) pass("Resume 真值 Gate（无 catch 吞错 + 公共 metadata mapper）");
  else fail(`Resume 真值 Gate：\n  ${resume.failures.join("\n  ")}`);

  const nineIssue = checkNineIssueCloseoutGate(documents);
  if (nineIssue.passed)
    pass("九项收口 Gate F1-F8（retry owner/recovery/resume switch/capability/contract）");
  else fail(`九项收口 Gate F1-F8：\n  ${nineIssue.failures.join("\n  ")}`);
}

/** Batch9 最终收口 Gate（§四 15 条红线：ExecutionBinding/RuntimeSessionBinding/RuntimeRevision schema、start request、HostedAgentLoop、agent_message、单一 Resolver、AgentCall child、A2A lifecycle）。 */
function checkFinalCloseout(): void {
  const PRODUCTION_ROOTS = ["app", "components", "desktop", "lib", "scripts"];
  const documents: SourceDocument[] = PRODUCTION_ROOTS.flatMap((root) =>
    filesUnder(resolve(ROOT, root)),
  )
    .filter((file) => SOURCE_EXTENSIONS.has(file.slice(file.lastIndexOf("."))))
    .map((file) => ({ path: relative(ROOT, file), source: readFileSync(file, "utf8") }));

  const result = checkTopic01FinalCloseoutGate(documents);
  if (result.passed)
    pass("Batch9 最终收口 Gate R1-R8（旧 Authority 归零 + 单一 Resolver + AgentCall child）");
  else fail(`Batch9 最终收口 Gate R1-R8：\n  ${result.failures.join("\n  ")}`);
}

function checkAgentCallFinalization(): void {
  const documents: SourceDocument[] = ["app", "components", "desktop", "lib", "scripts"]
    .flatMap((root) => filesUnder(resolve(ROOT, root)))
    .filter((file) => SOURCE_EXTENSIONS.has(file.slice(file.lastIndexOf("."))))
    .map((file) => ({ path: relative(ROOT, file), source: readFileSync(file, "utf8") }));
  const result = checkAgentCallFinalizationGate(documents);
  if (result.passed) pass("Package03 AgentCall 最终事务 Gate");
  else fail(`Package03 AgentCall 最终事务 Gate：\n  ${result.failures.join("\n  ")}`);
}

function checkAgentCallRuntimeBoundary(): void {
  const documents: SourceDocument[] = ["app", "components", "desktop", "lib", "scripts"]
    .flatMap((root) => filesUnder(resolve(ROOT, root)))
    .filter((file) => SOURCE_EXTENSIONS.has(file.slice(file.lastIndexOf("."))))
    .map((file) => ({ path: relative(ROOT, file), source: readFileSync(file, "utf8") }));
  const result = checkAgentCallRuntimeBoundaryGate(documents);
  if (result.passed) pass("Package04 AgentCall durable handoff 与 Runtime 边界 Gate");
  else fail(`Package04 AgentCall 运行边界 Gate：\n  ${result.failures.join("\n  ")}`);
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
  checkTopic01Boundaries();
  checkAgentInvokeAuthorization();
  checkAgentCallFinalization();
  checkAgentCallRuntimeBoundary();
  checkCloseoutRules();
  checkFinalCloseout();
  if (failures > 0) process.exitCode = 1;
}

main();
