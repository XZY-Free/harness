import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runtimeConformanceConfig } from "./config";

/**
 * Runtime Conformance 配置 fail-closed 测试。
 */

const ORIG_RUNNER_SIGNING_IDENTITIES = process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON;
const ORIG_LEGACY_RUNNERS = process.env.SNOW_RUNTIME_CONFORMANCE_ALLOWED_RUNNERS;
const ORIG_LEGACY_KEYS = process.env.SNOW_RUNTIME_CONFORMANCE_TRUSTED_KEYS_JSON;
const ORIG_ACTIVE_EXTERNAL_SIGNER = process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON;

beforeEach(() => {
  // 清空 env（用 undefined 赋值，避免 delete 操作符）
  process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = undefined;
  process.env.SNOW_RUNTIME_CONFORMANCE_ALLOWED_RUNNERS = undefined;
  process.env.SNOW_RUNTIME_CONFORMANCE_TRUSTED_KEYS_JSON = undefined;
  process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = undefined;
});

afterEach(() => {
  // 还原原值
  process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = ORIG_RUNNER_SIGNING_IDENTITIES;
  process.env.SNOW_RUNTIME_CONFORMANCE_ALLOWED_RUNNERS = ORIG_LEGACY_RUNNERS;
  process.env.SNOW_RUNTIME_CONFORMANCE_TRUSTED_KEYS_JSON = ORIG_LEGACY_KEYS;
  process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = ORIG_ACTIVE_EXTERNAL_SIGNER;
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

describe("runtimeConformanceConfig.activeExternalConformanceSigner", () => {
  const signer = {
    keyId: "runner-key-1",
    runnerIdentity: "ci/runtime-conformance",
    privateKeyPkcs8Base64: "MC4CAQAwBQYDK2VwBCIEIKK4J5hL1fS4YyL+2XnC1o0wPvfFjL0eQ0Q0Q0Q0Q0Q",
  };

  it("只从 SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON 读取完整 signer 对象", () => {
    process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = JSON.stringify(signer);

    expect(runtimeConformanceConfig.activeExternalConformanceSigner).toEqual(signer);
  });

  it("getter 惰性求值：同一次进程内修改 env 后读取到新值", () => {
    expect(runtimeConformanceConfig.activeExternalConformanceSigner).toBeNull();
    process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = JSON.stringify(signer);
    expect(runtimeConformanceConfig.activeExternalConformanceSigner).toEqual(signer);
  });

  it("合法输入保留原始值（非空白即合法，不静默 trim 身份/私钥）", () => {
    const untrimmed = {
      keyId: " runner-key-1 ",
      runnerIdentity: " ci/runtime-conformance ",
      privateKeyPkcs8Base64: " MC4CAQAwBQYDK2VwBCIEIA== ",
    };
    process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = JSON.stringify(untrimmed);

    expect(runtimeConformanceConfig.activeExternalConformanceSigner).toEqual(untrimmed);
  });

  it.each([
    ["缺失", undefined],
    ["空字符串", ""],
    ["空白字符串", "   "],
    ["非法 JSON", "{"],
    ["非对象（数组）", JSON.stringify([signer])],
    ["非对象（字符串）", JSON.stringify("signer")],
    ["keyId 缺失", JSON.stringify({ ...signer, keyId: undefined })],
    ["keyId 为空串", JSON.stringify({ ...signer, keyId: "" })],
    ["runnerIdentity 缺失", JSON.stringify({ ...signer, runnerIdentity: undefined })],
    ["privateKeyPkcs8Base64 缺失", JSON.stringify({ ...signer, privateKeyPkcs8Base64: undefined })],
    ["privateKeyPkcs8Base64 为空串", JSON.stringify({ ...signer, privateKeyPkcs8Base64: "" })],
    ["未知额外键", JSON.stringify({ ...signer, extra: "forbidden" })],
    ["keyId 纯空白", JSON.stringify({ ...signer, keyId: "   " })],
    ["runnerIdentity 纯空白", JSON.stringify({ ...signer, runnerIdentity: " \t " })],
    ["privateKeyPkcs8Base64 纯空白", JSON.stringify({ ...signer, privateKeyPkcs8Base64: " " })],
  ])("%s 时返回 null 并 fail-closed", (_label, raw) => {
    process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = raw;

    expect(runtimeConformanceConfig.activeExternalConformanceSigner).toBeNull();
  });
});
