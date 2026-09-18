import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WORKLOAD_SIGNING_KEY_ID_ENV,
  WORKLOAD_TOKEN_SIGNING_SECRET_ENV,
  decodeWorkloadToken,
  issueWorkloadToken,
} from "@/lib/identity/workload-token";
import { loadRuntimeSettings } from "@/lib/runtime/runtime-settings";
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

// ═══════════════════════════════════════════════════════════════════════════
// 第二份契约：.env.test 必须让生产 Runtime 设置加载成功，并具备 Workload
// Token 签发能力。
//
// 背景（真实回归，2026-09-18 完整验收在 e2e-web 阶段暴露）：
// - 2026-09-16 的执行域改动把 Workload Token header 的 keyId 变成签发/验签的
//   硬性要求：RuntimeSettings.workloadSigningKeyId 无 Schema 默认值（§7.3
//   fail-closed），lib/identity/workload-token.ts 的 signingKeyId() 缺失即抛错；
// - 但 .env.test 当时只补了签名密钥、没补 key id；
// - 后果：e2e Web Server 起得来、页面打得开，只在用户**第一次提交消息**时抛
//   WorkloadTokenError（错误藏在服务端日志），前端表现为提交后不跳转
//   /chat/<threadId>，e2e 正式执行链用例只能等到 60s 超时——排查成本极高。
//
// 断言强度（不写死键名清单，直接问生产代码）：
// - 用与 scripts/e2e-start.mts 同构的方式解析仓库根 .env.test；
// - assert 该 env 能通过 loadRuntimeSettings（任何未来新增的必填设置都会自动纳入）；
// - assert 该 env 能真实签发并验签一枚 Workload Token（Turn 接纳路径的真实依赖）；
// - 负向控制：删掉 WORKLOAD_SIGNING_KEY_ID 后，上述两条必须双双失败，
//   证明这三条断言真的能拦住本次回归，而不是恒真。
// ═══════════════════════════════════════════════════════════════════════════

/** KEY -> 最后取值（与 scripts/e2e-start.mts 的 loadEnvFile 折叠结果一致）。 */
function toEnvRecord(vars: Vars): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, list] of vars) {
    const value = list[list.length - 1];
    if (value !== undefined) record[key] = value;
  }
  return record;
}

/** 断言某份 .env 源码恰好声明一次给定键，且取值非空。 */
function assertDeclaredOnce(source: string, key: string, context: string): string {
  const entries = parseEnvVars(source).get(key) ?? [];
  expect(
    entries.length,
    `[${context}] 必须恰好声明一次有效 ${key}（当前 ${entries.length} 次；缺失与重复定义都违反契约）`,
  ).toBe(1);
  const value = entries[0] ?? "";
  expect(value.length, `[${context}] ${key} 不得为空值`).toBeGreaterThan(0);
  return value;
}

/**
 * 在给定 env 下签发并验签一枚 Workload Token。
 * 只临时覆盖 workload 相关的两个键（生产签发函数直接读 process.env），随后恢复。
 */
function issueAndDecodeUnderEnv(env: Readonly<Record<string, string>>): string {
  const keys = [WORKLOAD_SIGNING_KEY_ID_ENV, WORKLOAD_TOKEN_SIGNING_SECRET_ENV] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of keys) {
      const value = env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const now = Date.now();
    const token = issueWorkloadToken({
      contractVersion: 3,
      type: "execution",
      tenantId: "00000000-0000-4000-8000-000000000000",
      invocationId: "00000000-0000-4000-8000-000000000001",
      runtimeRevisionId: "e2e-env-contract-probe",
      attemptId: "00000000-0000-4000-8000-000000000002",
      ownershipId: "00000000-0000-4000-8000-000000000003",
      leaseEpoch: "1",
      sessionBindingId: "00000000-0000-4000-8000-000000000004",
      audience: "runtime",
      expiresAt: now + 60_000,
    });
    return decodeWorkloadToken(token).jti;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("E2E 运行环境契约：.env.test 必须满足生产 Runtime 设置与 Workload Token 签发", () => {
  const envTest = readFileSync(ENV_TEST_PATH, "utf8");
  // 与 e2e-start.mts 的 childEnv 同构：.env.test 基线 + APP_ENV=test。
  const env: Record<string, string> = {
    ...toEnvRecord(parseEnvVars(envTest)),
    APP_ENV: "test",
  };

  it("恰好声明一次非空 WORKLOAD_SIGNING_KEY_ID（RuntimeSettings 无默认值的必填项）", () => {
    assertDeclaredOnce(envTest, WORKLOAD_SIGNING_KEY_ID_ENV, ".env.test");
  });

  it("恰好声明一次非空 SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET（至少 32 字节）", () => {
    const secret = assertDeclaredOnce(envTest, WORKLOAD_TOKEN_SIGNING_SECRET_ENV, ".env.test");
    expect(
      Buffer.byteLength(secret, "utf8"),
      `[.env.test] ${WORKLOAD_TOKEN_SIGNING_SECRET_ENV} 必须 ≥ 32 字节，否则签发时抛「签名密钥长度不足」`,
    ).toBeGreaterThanOrEqual(32);
  });

  it("该 env 必须能加载生产 RuntimeSettings，且 key id 与 .env.test 声明一致", () => {
    const settings = loadRuntimeSettings(env);
    expect(settings.workloadSigningKeyId).toBe(env[WORKLOAD_SIGNING_KEY_ID_ENV]);
  });

  it("该 env 必须能真实签发并验签 Workload Token（Turn 接纳路径的真实依赖）", () => {
    expect(issueAndDecodeUnderEnv(env)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  describe("负向控制：抹掉 WORKLOAD_SIGNING_KEY_ID 后必须失败（证明断言真能拦住本次回归）", () => {
    const { [WORKLOAD_SIGNING_KEY_ID_ENV]: _removed, ...withoutKeyId } = env;

    it("loadRuntimeSettings 必须拒绝缺失 key id 的 env", () => {
      expect(() => loadRuntimeSettings(withoutKeyId)).toThrow();
    });

    it("签发 Workload Token 必须拒绝缺失 key id 的 env", () => {
      expect(() => issueAndDecodeUnderEnv(withoutKeyId)).toThrow();
    });
  });
});
