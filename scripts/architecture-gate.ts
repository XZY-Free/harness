#!/usr/bin/env npx tsx
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  type SourceDocument,
  collectDeprecatedArchitectureViolations,
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

/** 剥离行/块注释，仅剩可执行代码，用于边界规则文本扫描。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * 专题01 §23.2 / §32 最终 Architecture Gate 边界规则。
 *
 * 覆盖：
 * - Thread.primaryAgentId 作为身份字段（Thread 不绑主 Agent）
 * - DEFAULT_AGENT_KEY / seedDefaultAgent（无默认 Agent fallback）
 * - defaultAgentId（新建不默认选中 Agent）
 * - agentKey === "default" fallback
 * - /chat/new、/desktop/new 假 new 路由（§33.7 产品入口）
 * - 客户端 agents.length===0 执行阻断（§35 无 Agent 阻断移除）
 * - 正式 Route union 出现 chat/thread kind 漂移（§23.2）
 *
 * §23.1：test-support 不因路径 blanket 豁免——本函数对全部 sourceFiles
 * 扫描（含 /test-support/），仅排除 .test.* 断言文件（测试可构造旧场景）。
 * 当前 test-support 无边界词；未来若真实 fixture 必须出现某规则词，在此按
 * 文件加窄白名单，而不是整体跳过目录。
 */
function checkTopic01Boundaries(): void {
  // 边界规则只扫生产源码根；docs 是方案说明文档（含被禁词是为了描述检测项），不扫。
  // gate 自身源码含这些标识符（作为检测正则），豁免 scripts/architecture-gate.ts。
  const PRODUCTION_ROOTS = ["app", "components", "desktop", "lib", "scripts"];
  const boundaryPatterns: Array<{ pattern: RegExp; title: string }> = [
    { pattern: /\.primaryAgentId\b|\bprimaryAgentId\s*:/, title: "Thread.primaryAgentId 身份字段" },
    { pattern: /\bDEFAULT_AGENT_KEY\b/, title: "DEFAULT_AGENT_KEY" },
    { pattern: /\bseedDefaultAgent\b/, title: "seedDefaultAgent" },
    { pattern: /\bdefaultAgentId\b/, title: "defaultAgentId" },
    { pattern: /agentKey\s*===?\s*["']default["']/i, title: "agentKey=default fallback" },
    { pattern: /["']\/chat\/new["']/, title: "/chat/new 假 new 路由" },
    { pattern: /["']\/desktop\/new["']/, title: "/desktop/new 假 new 路由" },
    {
      // §35：仅禁止「agents.length===0 执行阻断」（return/throw 阻止创建）。
      // 「暂无可用助手」空态展示（agents.length === 0 && <SelectorMessage>）合法，不匹配。
      pattern: /agents\.length\s*===?\s*0\s*\)\s*(?:return|throw)/,
      title: "客户端 agents.length===0 执行阻断",
    },
  ];
  const violations: string[] = [];
  const files = PRODUCTION_ROOTS.flatMap((root) => filesUnder(resolve(ROOT, root)));
  for (const file of files) {
    const extension = file.slice(file.lastIndexOf("."));
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    const repoPath = relative(ROOT, file);
    if (repoPath === "scripts/architecture-gate.ts") continue;
    if (repoPath.endsWith(".test.ts") || repoPath.endsWith(".test.tsx")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    for (const rule of boundaryPatterns) {
      if (rule.pattern.test(source)) {
        violations.push(`${repoPath} → ${rule.title}`);
      }
    }
    // 正式 Route 系统（lib/routes）不得出现 chat/thread kind 漂移（§23.2/§32）。
    if (repoPath.startsWith("lib/routes/") && /kind\s*[:=]\s*["']chat["']/.test(source)) {
      violations.push(`${repoPath} → 正式 route.kind 与 chat/thread union 漂移`);
    }
  }
  if (violations.length > 0) {
    fail(`专题01 Harness/Agent 边界规则违规：\n  ${violations.join("\n  ")}`);
    return;
  }
  pass("专题01 Harness/Agent 边界规则归零");
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
  if (failures > 0) process.exitCode = 1;
}

main();
