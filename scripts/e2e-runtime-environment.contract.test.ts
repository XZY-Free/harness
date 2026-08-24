import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * E2E 运行环境契约：`.env.test` 必须显式声明 `RUNTIME_DEFAULT=host`。
 *
 * 背景（docs/V12/01 Topic01 收口方案）：
 * - scripts/e2e-start.mts 显式加载 .env.test，然后 `next build` + `next start`；
 * - `next start` 令 NODE_ENV=production；
 * - lib/config.ts 的 runtimeConfig.defaultType 在 NODE_ENV=production 且未设置
 *   RUNTIME_DEFAULT 时默认 container，并 fail-closed（不降级 host）；
 * - CI desktop-e2e 真实日志：RUNTIME_DEFAULT=container 但 docker 不可用，拒绝降级。
 *
 * 业务不变量：E2E 的 .env.test 必须显式声明 RUNTIME_DEFAULT=host，使 next start 的
 * production NODE_ENV 不会悄悄改变测试 Runtime 选择；禁止以允许降级或修改生产默认值绕过。
 *
 * 断言强度（防止弱断言 / 字符串任意出现）：
 * - 按仓库根 .env.test 逐行解析，仅接受有效 KEY=VALUE 行（忽略空行与 # 注释）；
 * - 精确要求恰好一次有效 RUNTIME_DEFAULT 且其值为精确 "host"；
 * - 缺失、重复定义、container、空值一律拒绝。
 */

const ROOT = process.cwd();
const ENV_TEST_PATH = join(ROOT, ".env.test");

/** KEY -> 全部取值（保留重复定义，便于计数）。 */
type Vars = Map<string, string[]>;

/**
 * 解析 .env 源码为 KEY->取值列表。
 * - 忽略空行；
 * - 忽略 `#` 注释行（首非空白字符为 `#`）；
 * - 仅接受含 `=` 分隔符且 key 非空的行；value 取 `=` 后并 trim。
 * 不做 dotenv 内联注释剥离，保持语义简单可预期。
 */
function parseEnvVars(source: string): Vars {
  const vars: Vars = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (line.length === 0) continue; // 空行
    if (line.startsWith("#")) continue; // 注释行
    const sep = line.indexOf("=");
    if (sep === -1) continue; // 非 KEY=VALUE
    const key = line.slice(0, sep).trim();
    if (key.length === 0) continue; // 无 key
    const value = line.slice(sep + 1).trim();
    const list = vars.get(key) ?? [];
    list.push(value);
    vars.set(key, list);
  }
  return vars;
}

/** 精确断言某份 .env 源码恰好声明一次 RUNTIME_DEFAULT 且值为 "host"。 */
function assertRuntimeDefaultHost(source: string, context: string): void {
  const vars = parseEnvVars(source);
  const entries = vars.get("RUNTIME_DEFAULT") ?? [];
  expect(
    entries.length,
    `[${context}] .env 必须恰好声明一次有效 RUNTIME_DEFAULT（当前 ${entries.length} 次；缺失与重复定义都违反契约）`,
  ).toBe(1);
  expect(
    entries[0],
    `[${context}] 唯一有效 RUNTIME_DEFAULT 的值必须精确为 "host"（container/空值均违反契约）`,
  ).toBe("host");
}

describe("E2E 运行环境契约：.env.test 必须显式声明 RUNTIME_DEFAULT=host", () => {
  const envTest = readFileSync(ENV_TEST_PATH, "utf8");

  it("仓库根 .env.test 恰好声明一次有效 RUNTIME_DEFAULT 且值为 host", () => {
    assertRuntimeDefaultHost(envTest, ".env.test");
  });

  describe("断言语义：缺失 / 重复 / container / 空值都必须拒绝（防止弱断言绕过）", () => {
    it("缺失 RUNTIME_DEFAULT 必须失败", () => {
      expect(() =>
        assertRuntimeDefaultHost("DATABASE_URL=mysql://x\n# 注释\n\n", "缺失"),
      ).toThrow();
    });

    it("重复定义 RUNTIME_DEFAULT 必须失败", () => {
      expect(() =>
        assertRuntimeDefaultHost("RUNTIME_DEFAULT=host\nRUNTIME_DEFAULT=host\n", "重复定义"),
      ).toThrow();
    });

    it("RUNTIME_DEFAULT=container 必须失败", () => {
      expect(() => assertRuntimeDefaultHost("RUNTIME_DEFAULT=container\n", "container")).toThrow();
    });

    it("RUNTIME_DEFAULT 空值必须失败", () => {
      expect(() => assertRuntimeDefaultHost("RUNTIME_DEFAULT=\n", "空值")).toThrow();
    });
  });
});
