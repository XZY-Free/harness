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
    `${retiredVersion}-`,
    `use${retiredVersion.toUpperCase()}`,
    `build${retiredVersion.toUpperCase()}`,
  ].join("|"),
);

/**
 * 允许保留 v11/V11 等禁止字符串的历史归档与设计文档路径（前缀匹配）。
 *
 * 授权依据：
 * - sections/naming-inventory.md：文档可保留改造前证据引用；生产注释改成当前
 *   职责/不变量，不再引用"某阶段新实现""专题01完成版"等历史叙事。
 * - §四十一：负向测试中的禁止字符串属于精确例外。工程包正文与设计文档在讨论
 *   "v11 目录必须不存在"等清理目标时必须写出禁止字符串本身，属于负向引用。
 *
 * 精确白名单，不允许通配。生产代码路径（app/components/desktop/lib/scripts/
 * tests/e2e/）不在此列，仍按 forbidden 正则严格扫描。
 */
const DOC_EXCEPTION_PREFIXES = [
  "docs/V12/", // 专题工程包与历史交接叙事（工程包正文引用 v11/v12 作为清理目标）
  "docs/topic-01/", // Topic-01 历史归档（LIVE 生产 manifest 位于 evidence/，但历史叙述允许保留旧引用）
  "docs/implementation/topic-01-", // Topic-01 历史实施笔记
];

function isDocException(path: string): boolean {
  return DOC_EXCEPTION_PREFIXES.some((prefix) => path.startsWith(prefix));
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
