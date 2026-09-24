import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_ROOTS = [
  "app",
  "components",
  "desktop",
  "lib",
  "scripts",
  "docs",
  "tests",
  "e2e",
  "playwright.config.ts",
];
const retiredVersion = `v${11}`;
const forbidden = new RegExp(
  [
    `/${retiredVersion}/`,
    `/${retiredVersion.toUpperCase()}/`,
    `(?:^|[^A-Za-z0-9])${retiredVersion}-`,
    `use${retiredVersion.toUpperCase()}`,
    `build${retiredVersion.toUpperCase()}`,
  ].join("|"),
);

/**
 * 允许保留退役命名原文的精确文件清单。
 *
 * 授权依据：
 * - sections/naming-inventory.md：文档可保留改造前证据引用；生产注释改成当前
 *   职责/不变量，不再引用"某阶段新实现""专题01完成版"等历史叙事。
 * - §四十一：负向测试中的禁止字符串属于精确例外。工程包正文与设计文档在讨论
 *   "v11 目录必须不存在"等清理目标时必须写出禁止字符串本身；Naming Guard
 *   测试文件（lib/architecture/*.test.ts）整体职责就是断言禁止字符串不出现，
 *   必须持有这些字符串作为 regex/常量。
 *
 * 精确白名单，不允许通配。生产代码路径（app/components/desktop/lib/scripts/
 * tests/e2e/ 的非 Guard 部分）不在此列，仍按 forbidden 正则严格扫描。
 */
const NAMING_GUARD_EXACT_FILES = new Set([
  "docs/V12/02/snowharness-execution-design/source-manifest.json",
  "docs/V12/02/snowharness-execution-design/engineering-design.md",
  "docs/V12/02/snowharness-execution-design/test-matrix.json",
  "docs/V12/02/snowharness-execution-design/sections/naming-inventory.md",
  "docs/V12/02/snowharness-execution-design/sections/residual-removal.md",
  "docs/V12/02/snowharness-execution-design/sections/cleanliness-checklist.md",
  "docs/V12/02/snowharness-execution-design/sections/test-matrix.md",
  "docs/V12/02/snowharness-execution-design/sections/naming-rules.md",
  "lib/architecture/canonical-naming.test.ts",
  "lib/architecture/canonical-routes.test.ts",
]);
const FROZEN_HISTORICAL_NAMING_FILES = new Set([
  "docs/topic02/专题02固定关闭检查表/固定检查表.md",
  "docs/topic02/专题02固定关闭检查表/固定检查表.json",
  "docs/topic02/专题02固定关闭检查表/sources/原专题02基础验收矩阵.json",
]);

function isDocException(path: string): boolean {
  return FROZEN_HISTORICAL_NAMING_FILES.has(path) || NAMING_GUARD_EXACT_FILES.has(path);
}

function sourceFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => {
    if (["node_modules", ".git", ".next", "build", "dist", "__pycache__"].includes(entry)) {
      return [];
    }
    return sourceFiles(join(path, entry));
  });
}

describe("repository architecture naming contract", () => {
  it("CLEAN-08: exceptions do not exempt sibling files or filename suffixes", () => {
    expect(
      isDocException("docs/V12/02/snowharness-execution-design/sections/naming-rules.md"),
    ).toBe(true);
    expect(
      isDocException("docs/V12/02/snowharness-execution-design/sections/unreviewed-v11.md"),
    ).toBe(false);
    expect(
      isDocException("docs/V12/02/snowharness-execution-design/sections/naming-rules.md.old"),
    ).toBe(false);
    expect(isDocException("lib/architecture/unreviewed-v11.ts")).toBe(false);
    expect(forbidden.test("env11-binding-mismatch.log")).toBe(false);
    expect(forbidden.test(`runtime-v${11}-legacy.ts`)).toBe(true);
  });

  it("contains no retired version file names or source symbols", () => {
    const violations = SCAN_ROOTS.flatMap((root) => sourceFiles(join(ROOT, root)))
      .filter((file) => !file.endsWith(".DS_Store"))
      .flatMap((file) => {
        const path = relative(ROOT, file);
        if (isDocException(path)) return [];
        const source = readFileSync(file, "utf8");
        return forbidden.test(`/${path}`) || forbidden.test(source) ? [path] : [];
      });
    expect(violations).toEqual([]);
  });

  it("keeps permanent contracts and validation entry points", () => {
    for (const document of [
      "agent-control-plane.md",
      "runtime-control-plane.md",
      "artifact-trust.md",
      "publication.md",
      "routing.md",
      "execution-binding.md",
      "hosted-provisioning.md",
      "conversations.md",
      "api-and-events.md",
      "security.md",
      "persistence.md",
    ]) {
      expect(existsSync(join(ROOT, "docs", "architecture", document))).toBe(true);
    }
    expect(existsSync(join(ROOT, "docs/contracts/openapi.json"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts/contracts.mjs"))).toBe(true);
    expect(existsSync(join(ROOT, `scripts/${retiredVersion}-contracts.mjs`))).toBe(false);
  });
});
