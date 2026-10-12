import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_ENV_FLAG_KEYS,
  FORBIDDEN_ENV_FLAG_PREFIXES,
  RUNTIME_SETTINGS_ENV_KEYS,
  RuntimeSettingsSchema,
  assertNoArchitectureFlags,
  assertRuntimeSettingsInvariants,
  assertRuntimeSettingsValid,
  findForbiddenArchitectureFlags,
  loadRuntimeSettings,
} from "./runtime-settings";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const MINIMAL_VALID_ENV: Record<string, string> = {
  WORKLOAD_SIGNING_KEY_ID: "key-2026-09",
};

function envWith(overrides: Record<string, string>): Record<string, string> {
  return { ...MINIMAL_VALID_ENV, ...overrides };
}

// ─── Forbidden architecture flags ──────────────────────────────────────────

describe("findForbiddenArchitectureFlags (§十 / §四十八 / residual-removal §14)", () => {
  it("空环境返回空数组", () => {
    expect(findForbiddenArchitectureFlags({})).toEqual([]);
  });

  it("合规 Runtime 参数不触发", () => {
    expect(findForbiddenArchitectureFlags(MINIMAL_VALID_ENV)).toEqual([]);
  });

  it("命中 USE_NEW_* 前缀", () => {
    expect(findForbiddenArchitectureFlags({ USE_NEW_OWNERSHIP: "1" })).toEqual([
      "USE_NEW_OWNERSHIP",
    ]);
    expect(findForbiddenArchitectureFlags({ USE_NEW_WORKSPACE: "true" })).toEqual([
      "USE_NEW_WORKSPACE",
    ]);
  });

  it("命中 ENABLE_V3_* 前缀", () => {
    expect(findForbiddenArchitectureFlags({ ENABLE_V3_RUNTIME: "true" })).toEqual([
      "ENABLE_V3_RUNTIME",
    ]);
  });

  it("命中 LEGACY_* 前缀", () => {
    expect(findForbiddenArchitectureFlags({ LEGACY_RUNTIME_ENABLED: "1" })).toEqual([
      "LEGACY_RUNTIME_ENABLED",
    ]);
  });

  it("命中精确 key RUNTIME_PROTOCOL_VERSION（协议版本是机器事实，不能作为可切换 env）", () => {
    expect(findForbiddenArchitectureFlags({ RUNTIME_PROTOCOL_VERSION: "2" })).toEqual([
      "RUNTIME_PROTOCOL_VERSION",
    ]);
  });

  it("undefined 值不算命中（未设置）", () => {
    expect(findForbiddenArchitectureFlags({ USE_NEW_OWNERSHIP: undefined })).toEqual([]);
  });

  it("多个命中一次性全部返回", () => {
    const hits = findForbiddenArchitectureFlags({
      USE_NEW_OWNERSHIP: "1",
      ENABLE_V3_RUNTIME: "1",
      LEGACY_RUNTIME_ENABLED: "1",
      WORKLOAD_SIGNING_KEY_ID: "key-1",
    });
    expect(hits.sort()).toEqual(
      ["ENABLE_V3_RUNTIME", "LEGACY_RUNTIME_ENABLED", "USE_NEW_OWNERSHIP"].sort(),
    );
  });

  it("禁止清单包含全部 §四十八 残留搜索目标前缀", () => {
    const prefixes = FORBIDDEN_ENV_FLAG_PREFIXES as readonly string[];
    expect(prefixes).toContain("USE_NEW_");
    expect(prefixes).toContain("ENABLE_V3_");
    expect(prefixes).toContain("LEGACY_");
    expect(prefixes).toContain("COMPAT_");
    expect(prefixes).toContain("COMPATIBILITY_");
    expect(prefixes).toContain("DEPRECATED_");
  });

  it("精确 key 清单包含常见错误配置名", () => {
    const keys = FORBIDDEN_ENV_FLAG_KEYS as readonly string[];
    expect(keys).toContain("USE_NEW_OWNERSHIP");
    expect(keys).toContain("ENABLE_V3_RUNTIME");
    expect(keys).toContain("RUNTIME_PROTOCOL_VERSION");
  });
});

describe("assertNoArchitectureFlags", () => {
  it("合规环境不抛", () => {
    expect(() => assertNoArchitectureFlags(MINIMAL_VALID_ENV)).not.toThrow();
  });

  it("含禁止 Flag 即抛错，消息含具体 key", () => {
    expect(() => assertNoArchitectureFlags({ USE_NEW_OWNERSHIP: "1" })).toThrowError(
      /USE_NEW_OWNERSHIP/,
    );
    expect(() => assertNoArchitectureFlags({ ENABLE_V3_RUNTIME: "true" })).toThrowError(
      /ENABLE_V3_RUNTIME/,
    );
  });

  it("错误消息明确表达'不接受运行时切换'", () => {
    expect(() => assertNoArchitectureFlags({ LEGACY_X: "1" })).toThrowError(/不接受 USE_NEW_/);
  });
});

// ─── RuntimeSettings schema ────────────────────────────────────────────────

describe("RuntimeSettingsSchema", () => {
  it("接受完整合法设置", () => {
    const parsed = RuntimeSettingsSchema.parse({
      heartbeatIntervalMs: 15_000,
      leaseTtlMs: 60_000,
      dispatchDeadlineMs: 300_000,
      executionTimeoutMs: 3_600_000,
      workloadTokenTtlMs: 900_000,
      workloadSigningKeyId: "key-1",
      ingressDeduplicationWindowMs: 86_400_000,
      recoveryWorkerPollIntervalMs: 5_000,
    });
    expect(parsed.heartbeatIntervalMs).toBe(15_000);
  });

  it("拒绝未声明字段（strict）", () => {
    const result = RuntimeSettingsSchema.safeParse({
      heartbeatIntervalMs: 15_000,
      leaseTtlMs: 60_000,
      dispatchDeadlineMs: 300_000,
      executionTimeoutMs: 3_600_000,
      workloadTokenTtlMs: 900_000,
      workloadSigningKeyId: "key-1",
      ingressDeduplicationWindowMs: 86_400_000,
      recoveryWorkerPollIntervalMs: 5_000,
      useNewOwnership: true,
    });
    expect(result.success).toBe(false);
  });

  it("拒绝非正整数", () => {
    const result = RuntimeSettingsSchema.safeParse({
      heartbeatIntervalMs: 0,
      leaseTtlMs: 60_000,
      dispatchDeadlineMs: 300_000,
      executionTimeoutMs: 3_600_000,
      workloadTokenTtlMs: 900_000,
      workloadSigningKeyId: "key-1",
      ingressDeduplicationWindowMs: 86_400_000,
      recoveryWorkerPollIntervalMs: 5_000,
    });
    expect(result.success).toBe(false);
  });

  it("workloadSigningKeyId 必填、非空", () => {
    const result = RuntimeSettingsSchema.safeParse({
      heartbeatIntervalMs: 15_000,
      leaseTtlMs: 60_000,
      dispatchDeadlineMs: 300_000,
      executionTimeoutMs: 3_600_000,
      workloadTokenTtlMs: 900_000,
      workloadSigningKeyId: "",
      ingressDeduplicationWindowMs: 86_400_000,
      recoveryWorkerPollIntervalMs: 5_000,
    });
    expect(result.success).toBe(false);
  });
});

// ─── loadRuntimeSettings ───────────────────────────────────────────────────

describe("loadRuntimeSettings", () => {
  it("最小合法 env：只提供 workloadSigningKeyId，其他走 default", () => {
    const settings = loadRuntimeSettings(MINIMAL_VALID_ENV);
    expect(settings.workloadSigningKeyId).toBe("key-2026-09");
    expect(settings.heartbeatIntervalMs).toBe(15_000);
    expect(settings.leaseTtlMs).toBe(60_000);
    expect(settings.dispatchDeadlineMs).toBe(300_000);
    expect(settings.executionTimeoutMs).toBe(3_600_000);
    expect(settings.workloadTokenTtlMs).toBe(900_000);
    expect(settings.ingressDeduplicationWindowMs).toBe(86_400_000);
    expect(settings.recoveryWorkerPollIntervalMs).toBe(5_000);
  });

  it("env 覆盖 default", () => {
    const settings = loadRuntimeSettings(
      envWith({
        SNOWHARNESS_RUNTIME_HEARTBEAT_INTERVAL_MS: "10000",
        SNOWHARNESS_RUNTIME_LEASE_TTL_MS: "45000",
      }),
    );
    expect(settings.heartbeatIntervalMs).toBe(10_000);
    expect(settings.leaseTtlMs).toBe(45_000);
  });

  it("缺失 workloadSigningKeyId 抛错（fail-closed）", () => {
    expect(() => loadRuntimeSettings({})).toThrowError(/workloadSigningKeyId/);
  });

  it("非整数 env 值抛错并含 env key 名", () => {
    expect(() =>
      loadRuntimeSettings(envWith({ SNOWHARNESS_RUNTIME_HEARTBEAT_INTERVAL_MS: "not-a-number" })),
    ).toThrowError(/SNOWHARNESS_RUNTIME_HEARTBEAT_INTERVAL_MS/);
  });

  it("空字符串视为未设置（走 default）", () => {
    const settings = loadRuntimeSettings(
      envWith({ SNOWHARNESS_RUNTIME_HEARTBEAT_INTERVAL_MS: "" }),
    );
    expect(settings.heartbeatIntervalMs).toBe(15_000);
  });

  it("env key 映射固定（防止悄悄改名）", () => {
    expect(RUNTIME_SETTINGS_ENV_KEYS.workloadSigningKeyId).toBe("WORKLOAD_SIGNING_KEY_ID");
    expect(RUNTIME_SETTINGS_ENV_KEYS.heartbeatIntervalMs).toBe(
      "SNOWHARNESS_RUNTIME_HEARTBEAT_INTERVAL_MS",
    );
    expect(RUNTIME_SETTINGS_ENV_KEYS.leaseTtlMs).toBe("SNOWHARNESS_RUNTIME_LEASE_TTL_MS");
  });
});

// ─── Cross-field invariants ────────────────────────────────────────────────

describe("assertRuntimeSettingsInvariants", () => {
  const baseSettings = loadRuntimeSettings(MINIMAL_VALID_ENV);

  it("默认值全部合规", () => {
    expect(() => assertRuntimeSettingsInvariants(baseSettings)).not.toThrow();
  });

  it("leaseTtlMs < 3 * heartbeatIntervalMs 抛错", () => {
    expect(() =>
      assertRuntimeSettingsInvariants({
        ...baseSettings,
        heartbeatIntervalMs: 15_000,
        leaseTtlMs: 30_000, // < 45_000
      }),
    ).toThrowError(/leaseTtlMs.*3 \* heartbeatIntervalMs/);
  });

  it("workloadTokenTtlMs < heartbeatIntervalMs 抛错", () => {
    expect(() =>
      assertRuntimeSettingsInvariants({
        ...baseSettings,
        heartbeatIntervalMs: 15_000,
        workloadTokenTtlMs: 10_000,
      }),
    ).toThrowError(/workloadTokenTtlMs.*heartbeatIntervalMs/);
  });

  it("dispatchDeadlineMs > executionTimeoutMs 抛错", () => {
    expect(() =>
      assertRuntimeSettingsInvariants({
        ...baseSettings,
        dispatchDeadlineMs: 5_000_000,
        executionTimeoutMs: 3_600_000,
      }),
    ).toThrowError(/dispatchDeadlineMs.*executionTimeoutMs/);
  });

  it("recoveryWorkerPollIntervalMs > leaseTtlMs 抛错", () => {
    expect(() =>
      assertRuntimeSettingsInvariants({
        ...baseSettings,
        leaseTtlMs: 60_000,
        recoveryWorkerPollIntervalMs: 120_000,
      }),
    ).toThrowError(/recoveryWorkerPollIntervalMs.*leaseTtlMs/);
  });

  it("多个违反一次性全部列出", () => {
    let caught: Error | null = null;
    try {
      assertRuntimeSettingsInvariants({
        ...baseSettings,
        heartbeatIntervalMs: 30_000,
        leaseTtlMs: 60_000, // < 3*30_000 = 90_000
        workloadTokenTtlMs: 15_000, // < 30_000
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toMatch(/leaseTtlMs/);
    expect(caught?.message).toMatch(/workloadTokenTtlMs/);
  });
});

// ─── assertRuntimeSettingsValid（instrumentation.register 唯一入口）─────────

describe("assertRuntimeSettingsValid", () => {
  it("合规环境返回设置对象", () => {
    const settings = assertRuntimeSettingsValid(MINIMAL_VALID_ENV);
    expect(settings.workloadSigningKeyId).toBe("key-2026-09");
  });

  it("含禁止 Flag 优先抛错（先架构 Flag 后参数校验）", () => {
    expect(() =>
      assertRuntimeSettingsValid({
        USE_NEW_OWNERSHIP: "1",
        WORKLOAD_SIGNING_KEY_ID: "key-1",
      }),
    ).toThrowError(/USE_NEW_OWNERSHIP/);
  });

  it("缺失 workloadSigningKeyId 抛错", () => {
    expect(() => assertRuntimeSettingsValid({})).toThrowError(/workloadSigningKeyId/);
  });

  it("参数违反跨字段不变量抛错", () => {
    expect(() =>
      assertRuntimeSettingsValid(
        envWith({
          SNOWHARNESS_RUNTIME_HEARTBEAT_INTERVAL_MS: "30000",
          SNOWHARNESS_RUNTIME_LEASE_TTL_MS: "60000",
        }),
      ),
    ).toThrowError(/leaseTtlMs/);
  });
});
