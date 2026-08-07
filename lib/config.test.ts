import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbConfig, runtimeConformanceConfig } from "./config";

/**
 * S1（08-P2-5）：ContextSnapshot 独立短保留期 config 测试。
 *
 * 覆盖 dbConfig.snapshotRetentionDays getter：
 * - 默认 7（env 未设）
 * - env SNOW_DB_SNAPSHOT_RETENTION_DAYS 覆盖
 * - 非法值回退默认 7
 * - 0 = 禁用清理（合法值，不回退）
 * - 与 retentionDays(90) 独立互不影响
 */

const ORIG_RETENTION = process.env.SNOW_DB_RETENTION_DAYS;
const ORIG_SNAPSHOT_RETENTION = process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS;
const ORIG_RUNNER_SIGNING_IDENTITIES = process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON;
const ORIG_LEGACY_RUNNERS = process.env.SNOW_RUNTIME_CONFORMANCE_ALLOWED_RUNNERS;
const ORIG_LEGACY_KEYS = process.env.SNOW_RUNTIME_CONFORMANCE_TRUSTED_KEYS_JSON;

beforeEach(() => {
  // 清空 env（用 undefined 赋值，避免 delete 操作符）
  process.env.SNOW_DB_RETENTION_DAYS = undefined;
  process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS = undefined;
  process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = undefined;
  process.env.SNOW_RUNTIME_CONFORMANCE_ALLOWED_RUNNERS = undefined;
  process.env.SNOW_RUNTIME_CONFORMANCE_TRUSTED_KEYS_JSON = undefined;
});

afterEach(() => {
  // 还原原值
  process.env.SNOW_DB_RETENTION_DAYS = ORIG_RETENTION;
  process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS = ORIG_SNAPSHOT_RETENTION;
  process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = ORIG_RUNNER_SIGNING_IDENTITIES;
  process.env.SNOW_RUNTIME_CONFORMANCE_ALLOWED_RUNNERS = ORIG_LEGACY_RUNNERS;
  process.env.SNOW_RUNTIME_CONFORMANCE_TRUSTED_KEYS_JSON = ORIG_LEGACY_KEYS;
});

describe("dbConfig.snapshotRetentionDays (08-P2-5)", () => {
  it("默认 7（env 未设）", () => {
    expect(dbConfig.snapshotRetentionDays).toBe(7);
  });

  it("env SNOW_DB_SNAPSHOT_RETENTION_DAYS=30 → 30", () => {
    process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS = "30";
    expect(dbConfig.snapshotRetentionDays).toBe(30);
  });

  it("env=0 → 0（禁用清理，合法值不回退）", () => {
    process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS = "0";
    expect(dbConfig.snapshotRetentionDays).toBe(0);
  });

  it("非法值（非数字）→ 回退默认 7", () => {
    process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS = "not-a-number";
    expect(dbConfig.snapshotRetentionDays).toBe(7);
  });

  it("非法值（负数）→ 回退默认 7", () => {
    process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS = "-5";
    expect(dbConfig.snapshotRetentionDays).toBe(7);
  });

  it("与 retentionDays 独立：snapshotRetentionDays=7 不影响 retentionDays=90", () => {
    expect(dbConfig.snapshotRetentionDays).toBe(7);
    expect(dbConfig.retentionDays).toBe(90);
  });

  it("retentionDays=30 不影响 snapshotRetentionDays=7", () => {
    process.env.SNOW_DB_RETENTION_DAYS = "30";
    expect(dbConfig.retentionDays).toBe(30);
    expect(dbConfig.snapshotRetentionDays).toBe(7);
  });
});

describe("runtimeConformanceConfig.runnerSigningIdentities", () => {
  const identity = {
    keyId: "runner-key-1",
    publicKey: "base64-public-key",
    runnerIdentity: "ci/runtime-conformance",
    tenantScope: "tenant-1",
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z",
    revokedAt: null,
  };

  it("只从 SNOW_RUNNER_SIGNING_IDENTITIES_JSON 读取完整身份记录", () => {
    process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = JSON.stringify([identity]);

    expect(runtimeConformanceConfig.runnerSigningIdentities).toEqual([identity]);
  });

  it("同一 keyId 配置不同 publicKey 时返回空注册集并 fail-closed", () => {
    process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = JSON.stringify([
      identity,
      {
        ...identity,
        publicKey: "different-public-key",
        runnerIdentity: "ci/other-runtime-conformance",
        tenantScope: "tenant-2",
      },
    ]);

    expect(runtimeConformanceConfig.runnerSigningIdentities).toEqual([]);
  });

  it.each([
    ["缺失", undefined],
    ["空字符串", ""],
    ["非法 JSON", "{"],
    ["非数组", JSON.stringify({ identity })],
    ["空数组", "[]"],
    ["字段缺失", JSON.stringify([{ ...identity, publicKey: undefined }])],
    ["字段类型非法", JSON.stringify([{ ...identity, tenantScope: 42 }])],
    ["时间非法", JSON.stringify([{ ...identity, validFrom: "not-a-date" }])],
  ])("%s 时返回空注册集并 fail-closed", (_label, raw) => {
    process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = raw;

    expect(runtimeConformanceConfig.runnerSigningIdentities).toEqual([]);
  });

  it("旧环境变量单独存在时不生成身份记录，也不再暴露旧配置入口", () => {
    process.env.SNOW_RUNTIME_CONFORMANCE_ALLOWED_RUNNERS = identity.runnerIdentity;
    process.env.SNOW_RUNTIME_CONFORMANCE_TRUSTED_KEYS_JSON = JSON.stringify({
      [identity.keyId]: identity.publicKey,
    });

    expect(runtimeConformanceConfig.runnerSigningIdentities).toEqual([]);
    expect("allowedRunnerIdentities" in runtimeConformanceConfig).toBe(false);
    expect("trustedRunnerKeys" in runtimeConformanceConfig).toBe(false);
  });
});
