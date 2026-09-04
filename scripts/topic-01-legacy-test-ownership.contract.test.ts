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
 * - 机器清单把正式路径唯一归入 db project（串行真实 MySQL）。
 *
 * 语义化检查：配置必须消费机器清单，归属结论直接读取同一份清单，
 * 不再解析 vitest.config.ts 的排版细节。
 */

const ROOT = process.cwd();
const CONFIG_PATH = join(ROOT, "vitest.config.ts");
const AUDIT_PATH = join(
  ROOT,
  "docs/implementation/topic-01-final-closure/72-test-collection-audit.json",
);
const LEGACY_DB_TEST = "lib/db/studio-queries.test.ts";
const LEGACY_POLICY_TEST = "lib/policy/config.test.ts";
const CANONICAL_DB_TEST = "lib/capability/skill-studio-queries.test.ts";
const LEGACY_IDENTIFIER = "LEGACY_B1_DB_TESTS";

type CollectionEntry = { file: string; group: string; needsDB: boolean; serial: boolean };

/** 去除全部空白，使排版差异不影响语义判断。 */
function normalize(source: string): string {
  return source.replace(/\s+/g, "");
}

describe("Topic01 legacy vitest exclusion cleanup contract", () => {
  const config = normalize(readFileSync(CONFIG_PATH, "utf8"));
  const audit = JSON.parse(readFileSync(AUDIT_PATH, "utf8")) as {
    tests: CollectionEntry[];
  };

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

  it("机器清单把正式路径唯一归入串行真实 MySQL db project", () => {
    expect(config).toContain("72-test-collection-audit.json");
    const entries = audit.tests.filter((test) => test.file === CANONICAL_DB_TEST);
    expect(entries).toEqual([
      expect.objectContaining({
        file: CANONICAL_DB_TEST,
        group: "db",
        needsDB: true,
        serial: true,
      }),
    ]);
  });
});
