#!/usr/bin/env npx tsx
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { db } from "@/lib/db/client";
import * as canonicalSchema from "@/lib/persistence/schema";
import { Table, getTableName, is } from "drizzle-orm";
import {
  type SourceDocument,
  checkAgentCallFinalizationGate,
  checkAgentCallRuntimeBoundaryGate,
  checkAgentExecutionAuthorityGate,
  checkAgentInvokeAuthorizationGate,
  checkAgentRevisionAuthorityGate,
  checkDispatchRecoveryAuthorityGate,
  checkExternalRuntimeTransportGate,
  checkFinalClosureBoundaryGate,
  checkResumeTruthfulnessGate,
  checkWorkerProductionTopologyGate,
  collectDeprecatedArchitectureViolations,
  collectExecutionBoundaryViolations,
  collectHarnessAgentBoundaryViolations,
  collectImplementationHistoryViolations,
  collectRetiredAgentExecutionViolations,
  collectRetiredModuleDependencyViolations,
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
const PRODUCTION_ROOTS = ["app", "components", "desktop", "hooks", "lib", "scripts"];
const DEPRECATED_ARCHITECTURE_ALLOWLIST = new Set([
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

function productionDocuments(): SourceDocument[] {
  return PRODUCTION_ROOTS.flatMap((root) => filesUnder(resolve(ROOT, root)))
    .filter((file) => SOURCE_EXTENSIONS.has(file.slice(file.lastIndexOf("."))))
    .map((file) => ({ path: relative(ROOT, file), source: readFileSync(file, "utf8") }));
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

function checkSchemaAuthority(): void {
  const migrationFiles = readdirSync(resolve(ROOT, "drizzle"))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
  if (migrationFiles.length !== 1 || migrationFiles[0] !== "0000_initial_schema.sql") {
    fail(`clean initial migration 不唯一：${migrationFiles.join(", ")}`);
    return;
  }

  const migration = readFileSync(resolve(ROOT, "drizzle/0000_initial_schema.sql"), "utf8");
  if (/\b(?:DROP TABLE|DROP COLUMN|RENAME TABLE|RENAME COLUMN)\b/i.test(migration)) {
    fail("clean initial migration 仍含 drop/rename 兼容链");
    return;
  }

  const canonical = (Object.values(canonicalSchema) as unknown[])
    .filter((value) => is(value, Table))
    .map((table) => getTableName(table as Table))
    .sort();
  const runtime = Object.values(db._.schema ?? {})
    .map((table) => table.dbName)
    .sort();
  const migrationTables = Array.from(
    migration.matchAll(/CREATE TABLE `([^`]+)`/g),
    (match) => match[1],
  )
    .filter((name): name is string => Boolean(name))
    .sort();
  const manifest = JSON.parse(
    readFileSync(resolve(ROOT, "docs/topic-01/evidence/schema-manifest.json"), "utf8"),
  ) as {
    counts: { canonical: number; freshDbPlanned: number };
    tables: string[];
  };

  if (
    manifest.counts.canonical !== canonical.length ||
    JSON.stringify(runtime) !== JSON.stringify(canonical) ||
    JSON.stringify(migrationTables) !== JSON.stringify(canonical) ||
    JSON.stringify(manifest.tables) !== JSON.stringify(canonical)
  ) {
    fail(
      `Schema manifest 不一致：Root=${canonical.length}, Runtime=${runtime.length}, Migration=${migrationTables.length}, Fresh=${manifest.counts.freshDbPlanned}`,
    );
    return;
  }
  pass(`Schema Root/Runtime/Migration/Fresh manifest 一致：${canonical.length} 表`);
}

function checkFinalClosureBoundaries(): void {
  const inventory = JSON.parse(
    readFileSync(resolve(ROOT, "docs/topic-01/evidence/schema-inventory.json"), "utf8"),
  ) as { tables: Array<{ schemaDeclaration: string }> };
  const audit = JSON.parse(
    readFileSync(resolve(ROOT, "docs/topic-01/evidence/test-collection.json"), "utf8"),
  ) as { tests: Array<{ file: string; group: string }> };
  const schemaFiles = new Set(
    inventory.tables.map((table) => table.schemaDeclaration.split("#", 1)[0] as string),
  );
  const result = checkFinalClosureBoundaryGate(productionDocuments(), schemaFiles, audit.tests);
  if (result.passed) pass("Topic 01 最终封版边界闭合");
  else fail(`Topic 01 最终封版边界违规：\n  ${result.failures.join("\n  ")}`);
}

function checkExternalRuntimeTransport(): void {
  const result = checkExternalRuntimeTransportGate(productionDocuments());
  if (result.passed) pass("External Runtime 双维度 HTTP Transport 边界闭合");
  else fail(`External Runtime Transport 违规：\n  ${result.failures.join("\n  ")}`);
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
    DEPRECATED_ARCHITECTURE_ALLOWLIST,
  );
  if (violations.length > 0) {
    fail(`发现未登记的已废弃架构表述：${violations.join(", ")}`);
    return;
  }
  pass("未发现未登记的已废弃架构表述");
}

/** Thread、Harness、Agent 与 Route 的互斥 Authority 边界。 */
function checkHarnessAgentBoundaries(): void {
  const violations = collectHarnessAgentBoundaryViolations(productionDocuments());
  if (violations.length > 0) {
    fail(`Harness/Agent 边界规则违规：\n  ${violations.join("\n  ")}`);
    return;
  }
  pass("Harness/Agent 边界规则归零");
}

function checkAgentInvokeAuthorization(): void {
  const result = checkAgentInvokeAuthorizationGate(productionDocuments());
  if (result.passed) pass("Agent 发现与 Turn 调用授权边界闭合");
  else fail(`Agent 调用授权边界违规：\n  ${result.failures.join("\n  ")}`);
}

/** External Agent wire、上下文、恢复与调度真值边界。 */
function checkExecutionBoundaryRules(): void {
  const documents = productionDocuments();

  const boundaryViolations = collectExecutionBoundaryViolations(documents);
  if (boundaryViolations.length > 0) {
    fail(
      `External Agent 执行边界违规：\n  ${boundaryViolations
        .map((v) => `${v.title} → ${v.path}`)
        .join("\n  ")}`,
    );
  } else {
    pass("External Agent 执行边界归零");
  }

  const resume = checkResumeTruthfulnessGate(documents);
  if (resume.passed) pass("Resume 真值 Gate（无 catch 吞错 + 公共 metadata mapper）");
  else fail(`Resume 真值 Gate：\n  ${resume.failures.join("\n  ")}`);

  const dispatchRecovery = checkDispatchRecoveryAuthorityGate(documents);
  if (dispatchRecovery.passed) pass("Dispatch/Recovery Authority 边界闭合");
  else fail(`Dispatch/Recovery Authority 违规：\n  ${dispatchRecovery.failures.join("\n  ")}`);
}

/** Agent execution Authority 不得回流 Runtime 或 parent Invocation。 */
function checkAgentExecutionAuthority(): void {
  const result = checkAgentExecutionAuthorityGate(productionDocuments());
  if (result.passed) pass("Agent execution Authority 边界闭合");
  else fail(`Agent execution Authority 违规：\n  ${result.failures.join("\n  ")}`);
}

function checkAgentCallFinalization(): void {
  const result = checkAgentCallFinalizationGate(productionDocuments());
  if (result.passed) pass("AgentCall 最终事务边界闭合");
  else fail(`AgentCall 最终事务违规：\n  ${result.failures.join("\n  ")}`);
}

function checkAgentCallRuntimeBoundary(): void {
  const result = checkAgentCallRuntimeBoundaryGate(productionDocuments());
  if (result.passed) pass("AgentCall 单次派发与 Runtime 边界闭合");
  else fail(`AgentCall Runtime 边界违规：\n  ${result.failures.join("\n  ")}`);
}

function checkAgentRevisionAuthority(): void {
  const result = checkAgentRevisionAuthorityGate(productionDocuments());
  if (result.passed) pass("AgentRevision / ContractSnapshot Authority 边界闭合");
  else fail(`AgentRevision Authority 违规：\n  ${result.failures.join("\n  ")}`);
}

function checkSourceHistoryAndRetiredDependencies(): void {
  const documents = productionDocuments();
  const historyViolations = collectImplementationHistoryViolations(
    documents,
    DEPRECATED_ARCHITECTURE_ALLOWLIST,
  );
  if (historyViolations.length === 0) pass("Authority 生产源码无施工历史命名");
  else fail(`Authority 生产源码仍含施工历史命名：\n  ${historyViolations.join("\n  ")}`);

  const dependencyViolations = collectRetiredModuleDependencyViolations(documents);
  if (dependencyViolations.length === 0) pass("生产与测试支撑未依赖已删除入口");
  else fail(`仍依赖已删除入口：\n  ${dependencyViolations.join("\n  ")}`);

  const agentExecutionViolations = collectRetiredAgentExecutionViolations(documents);
  if (agentExecutionViolations.length === 0) pass("旧 Required-Agent 执行路径归零");
  else fail(`旧 Required-Agent 执行路径回流：\n  ${agentExecutionViolations.join("\n  ")}`);
}

function checkWorkerProductionTopology(): void {
  const paths = [
    "package.json",
    "Dockerfile",
    "docker/worker/Dockerfile",
    "deploy/production/compose.yaml",
    "scripts/workers/worker-entrypoint.ts",
    "lib/runtime/retry/runtime-dispatch-retry-worker.ts",
  ];
  const documents = paths.map((path) => ({
    path,
    source: existsSync(resolve(ROOT, path)) ? readFileSync(resolve(ROOT, path), "utf8") : "",
  }));
  const result = checkWorkerProductionTopologyGate(documents);
  if (result.passed) pass("Durable worker 生产拓扑闭合");
  else fail(`Durable worker 生产拓扑违规：\n  ${result.failures.join("\n  ")}`);
}

function main(): void {
  checkMigrationJournal();
  checkSchemaAuthority();
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
  checkSourceHistoryAndRetiredDependencies();
  checkHarnessAgentBoundaries();
  checkAgentInvokeAuthorization();
  checkAgentCallFinalization();
  checkAgentCallRuntimeBoundary();
  checkAgentRevisionAuthority();
  checkExecutionBoundaryRules();
  checkAgentExecutionAuthority();
  checkExternalRuntimeTransport();
  checkWorkerProductionTopology();
  checkFinalClosureBoundaries();
  if (failures > 0) process.exitCode = 1;
}

main();
