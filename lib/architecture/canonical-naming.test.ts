/**
 * Canonical Naming Guard — Foundation Batch F19 基础版。
 *
 * Authority（工程包 sections/naming-rules.md §2 + sections/residual-removal.md §14 +
 * sections/cleanliness-checklist.md §16 + 任务书 §十 / §四十一 / §四十八）：
 *
 * 本 Guard 锁定 Foundation Batch 已完成的清理成果，防止后续开发回归：
 * 1. scripts/topic-01-* 文件不存在（F1 已 22 个脚本改名）
 * 2. package.json 不含 topic01:* script keys
 * 3. CI 与生产代码不含 TOPIC01_ env 变量
 * 4. 生产代码不含 ChatNewPage 符号（F2 已改名为 ChatComposerPage）
 * 5. /chat/new 路由保持不存在
 * 6. lib/v11/ 等阶段目录保持不存在
 * 7. RuntimeProtocolV2 / V3 / V11 / V3RuntimeClient / runtime-v3.ts 等
 *    开发阶段版本符号不存在（正式类型统一叫 RuntimeProtocol）
 * 8. 架构切换 Feature Flag（USE_NEW_ / ENABLE_V3_ / LEGACY_ / COMPAT_ /
 *    DEPRECATED_ / FALLBACK_ / OWNERSHIP_MODE_ / RUNTIME_PROTOCOL_VERSION
 *    等）不出现在生产 env 读取或配置
 * 9. protocolVersion 常量必须是整数 3（不是字符串 "2" 或 "3"）
 *
 * 完整版 Naming Guard（Route/Schema/Symbol 全量 AST 检查）在 Acceptance Batch
 * 通过 lib/architecture/canonical-{routes,execution-authority-boundaries,
 * schema-contract}.test.ts 与 scripts/check-canonical-naming.mts 交付，
 * 需 F3-F7 Route 树 MOVE 与 Symbol renames 完成后才有意义。
 *
 * 精确例外（§四十一 允许）：
 * - 负向测试中的禁止字符串（例如 expect(x).not.toContain("topic-01-final-closure")）
 * - docs/V12/ 下的工程包与历史交接叙事
 * - docs/topic-01/ 下的 Topic-01 历史归档
 * - docs/implementation/topic-01-<name>/ 下的 Topic-01 历史实施笔记
 * - FINAL_REPORT.md 历史验收报告
 * - NewInvocation / NewRuntimeService 等 InferInsertModel 生成的新记录类型
 *   （`New` 表示新记录输入，非新版架构）
 * - next.config.ts / .next / Next.js 依赖（框架命名）
 * - 第三方 /v1 API 常量（外部协议版本）
 * - DSSE predicateType URI（如 https://snowharness.dev/conformance/runtime/v1，
 *   Conformance suiteRevision 属独立版本域）
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

// ─── 扫描边界 ─────────────────────────────────────────────

/** 生产代码扫描根（不含 docs、不含构建产物、不含依赖）。 */
const PRODUCTION_SCAN_ROOTS = ["app", "components", "desktop", "lib", "scripts", "e2e"] as const;

/** 遍历时跳过的目录名。 */
const SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".next-e2e",
  "dist",
  "build",
  "output",
  ".omc",
  "__pycache__",
]);

/** 源码扩展名。 */
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|mjs|js|json|yml)$/;

/**
 * 允许保留禁止字符串的文件路径前缀（历史归档与设计文档）。
 * 授权依据：sections/naming-inventory.md "文档可保留改造前证据引用"；
 * §四十一 "负向测试中的禁止字符串属于精确例外"。
 */
const DOC_EXCEPTION_PREFIXES = [
  "docs/V12/",
  "docs/topic-01/",
  "docs/implementation/topic-01-",
] as const;

const DOC_EXCEPTION_FILES = new Set(["FINAL_REPORT.md"]);

function isDocException(path: string): boolean {
  if (DOC_EXCEPTION_FILES.has(path)) return true;
  return DOC_EXCEPTION_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function walkSourceFiles(root: string): string[] {
  const absolute = join(ROOT, root);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry)) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.test(full)) continue;
      out.push(relative(ROOT, full));
    }
  };
  if (statSync(absolute).isDirectory()) {
    walk(absolute);
  } else if (SOURCE_EXTENSIONS.test(absolute)) {
    out.push(relative(ROOT, absolute));
  }
  return out;
}

function readProductionSources(): Array<{ path: string; content: string }> {
  const SELF = "lib/architecture/canonical-naming.test.ts";
  // 该规则的负向测试会故意写入被禁止的名称和环境变量。
  const NEGATIVE_FIXTURE = "scripts/architecture-gate-rules.test.ts";
  return PRODUCTION_SCAN_ROOTS.flatMap(walkSourceFiles)
    .filter((path) => !isDocException(path) && path !== SELF && path !== NEGATIVE_FIXTURE)
    .map((path) => ({ path, content: readFileSync(join(ROOT, path), "utf8") }));
}

// ─── Guard 1: scripts/topic-01-* 与 topic01: package keys ─

describe("Canonical Naming Guard (Foundation basics)", () => {
  it("scripts/topic-01-* 文件全部消失（F1 已 22 个脚本改名为职责命名）", () => {
    const scripts = readdirSync(join(ROOT, "scripts"));
    const offenders = scripts.filter((name) => name.startsWith("topic-01-"));
    expect(offenders).toEqual([]);
  });

  it("package.json 不含 topic01:* script keys，只使用职责命名", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const badKeys = Object.keys(pkg.scripts).filter((k) => k.startsWith("topic01:"));
    expect(badKeys).toEqual([]);
    // 正向断言：canonical keys 存在
    expect(pkg.scripts["schema:verify"]).toBeDefined();
    expect(pkg.scripts["tests:audit"]).toBeDefined();
    expect(pkg.scripts.acceptance).toBeDefined();
    // script 值不含 topic-01 路径
    const badValues = Object.entries(pkg.scripts).filter(([, v]) => v.includes("topic-01-"));
    expect(badValues).toEqual([]);
  });

  it("生产代码不含 TOPIC01_ 环境变量引用（F1 已迁至 ACCEPTANCE_*）", () => {
    const offenders = readProductionSources().filter(({ content }) => /TOPIC01_/.test(content));
    expect(offenders.map((o) => o.path)).toEqual([]);
  });

  // ─── Guard 2: ChatNewPage / /chat/new ────────────────────

  it("ChatNewPage 符号消失（F2 已改名为 ChatComposerPage）", () => {
    const offenders = readProductionSources().filter(({ content }) =>
      /\bChatNewPage\b/.test(content),
    );
    expect(offenders.map((o) => o.path)).toEqual([]);
  });

  it("ChatComposerPage 是 /chat 唯一 page 组件", () => {
    const chatPage = readFileSync(join(ROOT, "app/chat/page.tsx"), "utf8");
    expect(chatPage).toContain("ChatComposerPage");
    expect(chatPage).not.toContain("ChatNewPage");
  });

  it("/chat/new 路由保持不存在（无 redirect、无 alias）", () => {
    expect(existsSync(join(ROOT, "app/chat/new"))).toBe(false);
    expect(existsSync(join(ROOT, "app/chat/new/page.tsx"))).toBe(false);
  });

  // ─── Guard 3: 阶段版本目录与符号 ─────────────────────────

  it("lib/v11/ 等阶段目录保持不存在", () => {
    expect(existsSync(join(ROOT, "lib/v11"))).toBe(false);
    expect(existsSync(join(ROOT, "lib/v2"))).toBe(false);
    expect(existsSync(join(ROOT, "lib/v3"))).toBe(false);
    expect(existsSync(join(ROOT, "app/v11"))).toBe(false);
  });

  it("RuntimeProtocolV2/V3/V11 与 V3RuntimeClient 等开发阶段版本符号不存在", () => {
    const forbiddenSymbols = [
      /\bRuntimeProtocolV2\b/,
      /\bRuntimeProtocolV3\b/,
      /\bRuntimeProtocolV11\b/,
      /\bV2RuntimeClient\b/,
      /\bV3RuntimeClient\b/,
      /\bV11RuntimeClient\b/,
      /\bRuntimeHeartbeatV3\b/,
      /\bWorkloadTokenV3\b/,
      // NewRuntimeService 是合法 InferInsertModel 记录类型；AST gate 才区分声明语义。
      /\bNewOwnershipMode\b/,
      /\bLegacyRuntime\b/,
    ];
    const offenders = readProductionSources().flatMap(({ path, content }) =>
      forbiddenSymbols.filter((re) => re.test(content)).map((re) => ({ path, pattern: re.source })),
    );
    expect(offenders).toEqual([]);
  });

  it("runtime-v3.ts / runtime-v2.ts 等版本命名文件不存在", () => {
    const offenders = readProductionSources()
      .map((s) => s.path)
      .filter((path) => /(?:^|\/)runtime-v\d+\.(?:ts|tsx|mts|mjs|js)$/.test(path));
    expect(offenders).toEqual([]);
  });

  // ─── Guard 4: 架构切换 Feature Flag ──────────────────────

  it("生产代码不读取架构切换 Feature Flag（USE_NEW_* / ENABLE_V3_* / LEGACY_* 等）", () => {
    // 与 lib/runtime/runtime-settings.ts FORBIDDEN_ENV_FLAG_PREFIXES 保持一致
    const forbiddenPrefixes = [
      "USE_NEW_",
      "ENABLE_V3_",
      "ENABLE_V2_",
      "LEGACY_",
      "COMPAT_",
      "COMPATIBILITY_",
      "DEPRECATED_",
      "FALLBACK_",
      "RUNTIME_PROTOCOL_VERSION_OVERRIDE",
      "OWNERSHIP_MODE_",
      "WORKSPACE_MODE_OVERRIDE",
      "ENVIRONMENT_MODE_OVERRIDE",
    ];
    const forbiddenKeys = [
      "USE_NEW_OWNERSHIP",
      "USE_NEW_RUNTIME",
      "USE_NEW_WORKSPACE",
      "USE_NEW_ENVIRONMENT",
      "ENABLE_V3_RUNTIME",
      "ENABLE_LEGACY_RUNTIME",
      "ENABLE_RUNTIME_V2",
      "RUNTIME_PROTOCOL_VERSION",
    ];
    const patterns = [
      ...forbiddenPrefixes.map((p) => new RegExp(`process\\.env\\.${p}\\w*`)),
      ...forbiddenKeys.map((k) => new RegExp(`process\\.env\\.${k}\\b`)),
    ];
    const offenders = readProductionSources().flatMap(({ path, content }) =>
      patterns.filter((re) => re.test(content)).map((re) => ({ path, pattern: re.source })),
    );
    expect(offenders).toEqual([]);
  });

  it("runtime-settings.ts 提供 assertNoArchitectureFlags fail-fast Guard", () => {
    const source = readFileSync(join(ROOT, "lib/runtime/runtime-settings.ts"), "utf8");
    expect(source).toContain("assertNoArchitectureFlags");
    expect(source).toContain("FORBIDDEN_ENV_FLAG_PREFIXES");
    expect(source).toContain("FORBIDDEN_ENV_FLAG_KEYS");
  });

  // ─── Guard 5: RuntimeProtocol 版本事实 ───────────────────

  it("lib/runtime/runtime-protocol.ts 冻结 PROTOCOL_VERSION = 3 为整数", () => {
    const source = readFileSync(join(ROOT, "lib/runtime/runtime-protocol.ts"), "utf8");
    expect(source).toMatch(/export\s+const\s+PROTOCOL_VERSION\s*=\s*3\s+as\s+const/);
    // 不允许字符串 "3" 或 "2"
    expect(source).not.toMatch(/export\s+const\s+PROTOCOL_VERSION\s*=\s*["']/);
  });

  it("runtime-protocol.ts 不含开发阶段版本命名（V3 / v3 别名）", () => {
    const source = readFileSync(join(ROOT, "lib/runtime/runtime-protocol.ts"), "utf8");
    expect(source).not.toMatch(/\bRuntimeProtocolV\d+\b/);
    expect(source).not.toMatch(/\bV\d+RuntimeClient\b/);
  });

  // ─── Guard 6: 旧 runtime-client.ts RUNTIME_PROTOCOL_VERSION = "2" ─

  it("旧 RUNTIME_PROTOCOL_VERSION 常量不得扩散到白名单之外的新代码（F7 完成后白名单必须清空）", () => {
    // F7 (Symbol renames) 完成前的中间态白名单。这些文件在 F7 中会被 REPLACE：
    // - runtime-client.ts: RUNTIME_PROTOCOL_VERSION = "2" 旧定义（F7 删除）
    // - app/runtime/capabilities/route.ts: 旧 capabilities handler（F3-F6 MOVE + F7 更新）
    // - lib/runtime/application/build-runtime-start-request.ts: 旧 Start request builder（F7 更新）
    // - lib/runtime/runtime-settings.ts: 本 Guard 的 FORBIDDEN_ENV_FLAG_PREFIXES 黑名单
    //   含 "RUNTIME_PROTOCOL_VERSION_OVERRIDE"，字符串包含 RUNTIME_PROTOCOL_VERSION 子串
    //   属合法负向引用，不视为扩散
    // F7 完成后，白名单必须收缩为空数组；此时应把本断言改为
    // `expect(offenders).toEqual([])` 无白名单版本。
    const WHITELIST = new Set([
      "lib/runtime/runtime-client.ts",
      "app/runtime/capabilities/route.ts",
      "lib/runtime/application/build-runtime-start-request.ts",
      "lib/runtime/runtime-settings.ts",
    ]);
    const offenders = readProductionSources()
      .filter(
        ({ path, content }) =>
          /RUNTIME_PROTOCOL_VERSION/.test(content) &&
          !WHITELIST.has(path) &&
          // 允许测试文件引用旧常量：现有测试运行 pre-F7 代码路径，
          // 与 F7 Symbol renames 同批更新
          !path.endsWith(".test.ts") &&
          !path.endsWith(".integration.test.ts"),
      )
      .map((o) => o.path);
    expect(offenders).toEqual([]);
  });

  // ─── Guard 7: 已改名的 canonical 脚本存在性 ─────────────

  it("F1 canonical 脚本文件全部存在", () => {
    const required = [
      "scripts/acceptance.mjs",
      "scripts/acceptance-contract.mjs",
      "scripts/schema-evidence.mts",
      "scripts/schema-evidence-core.mts",
      "scripts/test-collection-audit.mjs",
      "scripts/evidence-integrity.mjs",
      "scripts/vitest-stage.mjs",
      "scripts/vitest-result.mjs",
      "scripts/playwright-stage.mjs",
      "scripts/worktree-cleanliness.mjs",
      "scripts/db-test-ownership.contract.test.ts",
    ];
    for (const path of required) {
      expect(existsSync(join(ROOT, path)), `${path} 必须存在`).toBe(true);
    }
  });

  // ─── Guard 8: F11/F12 Schema 权威 ───────────────────────

  it("EnvironmentDefinitionRevision schema 文件存在（F11 唯一新增一等持久领域对象）", () => {
    expect(
      existsSync(join(ROOT, "lib/persistence/schema/environment-definition-revision.ts")),
    ).toBe(true);
    const source = readFileSync(
      join(ROOT, "lib/persistence/schema/environment-definition-revision.ts"),
      "utf8",
    );
    expect(source).toContain('mysqlTable(\n  "EnvironmentDefinitionRevision"');
    expect(source).toContain("semanticDigest");
    expect(source).toContain("executionTarget");
    expect(source).toContain("requiredCapabilities");
  });

  it("InvocationCommand 只在 executions.ts 定义（F12 唯一 Schema 出口）", () => {
    const executions = readFileSync(join(ROOT, "lib/persistence/schema/executions.ts"), "utf8");
    const conversation = readFileSync(join(ROOT, "lib/persistence/schema/conversation.ts"), "utf8");
    expect(executions).toContain('mysqlTable(\n  "InvocationCommand"');
    expect(executions).toContain("export const invocationCommandTable");
    // conversation.ts 不得再持有 InvocationCommand 表定义（可以有指向 executions.ts 的注释）
    expect(conversation).not.toContain('mysqlTable(\n  "InvocationCommand"');
    expect(conversation).not.toContain("export const invocationCommandTable");
  });
});
