import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Topic01 Legacy Vitest 排除清理契约（docs/V12/01 §29 H）。
 *
 * 不变式：正式 skill-studio-queries 测试重新纳入真实 MySQL db project，
 * 旧 legacy 路径与 LEGACY_B1_DB_TESTS 全部消失，不允许长期 exclude。
 *
 * 目标（冻结）：
 * - 正式测试路径 lib/capability/skill-studio-queries.test.ts；
 * - 旧 lib/db/studio-queries.test.ts 与 lib/policy/config.test.ts 及
 *   LEGACY_B1_DB_TESTS 标识符全部消失；
 * - db project 明确 include 正式路径（串行真实 MySQL），
 *   unit project 明确 exclude 同一路径（不重复运行）。
 *
 * 语义化检查：读取 vitest.config.ts 源码做稳定的模块路径断言，
 * 去空白后按 project 块定位 include/exclude，不依赖行号/排版。
 */

const ROOT = process.cwd();
const CONFIG_PATH = join(ROOT, "vitest.config.ts");
const LEGACY_DB_TEST = "lib/db/studio-queries.test.ts";
const LEGACY_POLICY_TEST = "lib/policy/config.test.ts";
const CANONICAL_DB_TEST = "lib/capability/skill-studio-queries.test.ts";
const LEGACY_IDENTIFIER = "LEGACY_B1_DB_TESTS";

/** 去除全部空白，使排版差异不影响语义判断。 */
function normalize(source: string): string {
  return source.replace(/\s+/g, "");
}

/** 返回从 startMarker 起、到 endMarker 前的子串；任一缺失返回 null。 */
function sliceBetween(source: string, startMarker: string, endMarker: string): string | null {
  const start = source.indexOf(startMarker);
  if (start === -1) return null;
  const end = endMarker ? source.indexOf(endMarker, start) : source.length;
  if (end === -1) return null;
  return source.slice(start + startMarker.length, end);
}

/** 读取 project 块内的数组属性；配置不存在该属性时返回 null。 */
function readArrayProperty(source: string, property: string): string | null {
  return source.match(new RegExp(`${property}:\\[(.*?)\\]`))?.[1] ?? null;
}

describe("Topic01 legacy vitest exclusion cleanup contract", () => {
  const config = normalize(readFileSync(CONFIG_PATH, "utf8"));

  it("vitest.config.ts 不再包含 LEGACY_B1_DB_TESTS 标识符", () => {
    expect(
      config,
      "LEGACY_B1_DB_TESTS 标识符必须从 vitest.config.ts 中消失（不允许长期 exclude）",
    ).not.toContain(LEGACY_IDENTIFIER);
  });

  it("vitest.config.ts 不再引用旧 legacy 测试路径", () => {
    expect(config, "不得再引用旧 lib/db/studio-queries.test.ts（应删除）").not.toContain(
      LEGACY_DB_TEST,
    );
    expect(config, "不得再引用旧 lib/policy/config.test.ts（文件已不存在）").not.toContain(
      LEGACY_POLICY_TEST,
    );
  });

  it("旧 lib/db/studio-queries.test.ts 必须物理不存在", () => {
    expect(
      existsSync(join(ROOT, LEGACY_DB_TEST)),
      "旧 lib/db/studio-queries.test.ts 必须迁出（无旧路径兼容壳）",
    ).toBe(false);
  });

  it("正式 lib/capability/skill-studio-queries.test.ts 必须存在", () => {
    expect(
      existsSync(join(ROOT, CANONICAL_DB_TEST)),
      "正式测试必须落位 lib/capability/skill-studio-queries.test.ts",
    ).toBe(true);
  });

  it("db project 明确 include 正式路径（串行真实 MySQL），unit project 明确排除同一路径", () => {
    // 按 project 块切分：db 块从 name:"db" 到 name:"unit"，unit 块到配置末尾。
    const dbBlock = sliceBetween(config, `name:"db"`, `name:"unit"`);
    const unitBlock = sliceBetween(config, `name:"unit"`, "");

    expect(dbBlock, "vitest.config.ts 必须存在 db project 块").not.toBeNull();
    expect(unitBlock, "vitest.config.ts 必须存在 unit project 块").not.toBeNull();
    if (!dbBlock || !unitBlock) return;

    // db 块：include 段必须包含正式路径；若存在 exclude 段则不得包含它。
    const dbInclude = readArrayProperty(dbBlock, "include");
    const dbExclude = readArrayProperty(dbBlock, "exclude");
    expect(dbInclude, "db project 必须有 include 段").not.toBeNull();
    expect(
      dbInclude,
      "db project 的 include 必须纳入正式 lib/capability/skill-studio-queries.test.ts（真实 MySQL 串行）",
    ).toContain(CANONICAL_DB_TEST);
    if (dbExclude !== null) {
      expect(
        dbExclude,
        "db project 的 exclude 不得排除正式测试路径（必须真实串行运行）",
      ).not.toContain(CANONICAL_DB_TEST);
    }

    // unit 块：exclude 段必须包含正式路径（避免在 unit 并发里重复 resetDatabase）。
    const unitExclude = readArrayProperty(unitBlock, "exclude");
    expect(unitExclude, "unit project 必须有 exclude 段").not.toBeNull();
    expect(
      unitExclude,
      "unit project 的 exclude 必须排除正式 lib/capability/skill-studio-queries.test.ts（防重复运行）",
    ).toContain(CANONICAL_DB_TEST);
  });
});
