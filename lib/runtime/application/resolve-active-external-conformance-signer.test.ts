/**
 * Active external A2A conformance signer 解析器行为测试（RED）。
 *
 * 冻结的待实现生产 API：
 *   lib/runtime/application/resolve-active-external-conformance-signer.ts
 *   export function resolveActiveExternalConformanceSigner(tenantId: string):
 *     ActiveExternalConformanceSigner
 *
 * 不变量：active external A2A conformance signer 只有在其配置的 Ed25519 私钥
 * 与当前租户 + runner identity 下一条活跃、被授权的 RunnerSigningIdentity
 * 公钥密码学匹配时才可用。任何缺失/冲突/未信任/过期/未生效/撤销/跨租户
 * 一律 fail closed（抛错），且错误信息绝不包含私钥/公钥/完整配置 JSON。
 *
 * 全部使用真实生成的 Ed25519 密钥与真实配置 getter，不 mock crypto/registry。
 */

import { runtimeConformanceConfig } from "@/lib/config";
import {
  generateEd25519SignerKeyPair,
  generateRsaPkcs8PrivateKeyBase64,
} from "@/lib/runtime/test-support/ed25519-signer-keypair";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveActiveExternalConformanceSigner } from "./resolve-active-external-conformance-signer";

const ORIG_SIGNER = process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON;
const ORIG_IDENTITIES = process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON;

const TENANT = "tenant-1";
const NOW_VALID_FROM = "2025-01-01T00:00:00.000Z";

beforeEach(() => {
  process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = undefined;
  process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = undefined;
});

afterEach(() => {
  process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = ORIG_SIGNER;
  process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = ORIG_IDENTITIES;
});

/**
 * 写入真实 env：signer JSON + 注册表 JSON（注册表公钥来自真实密钥派生）。
 *
 * signer 与注册表的 keyId / runnerIdentity 可独立指定（默认一致），
 * 以便构造真正的「同公钥但身份/键不匹配」反例。
 */
function configure(params: {
  privateKeyPkcs8Base64: string;
  registryPublicKeyBase64: string;
  signerKeyId?: string;
  signerRunnerIdentity?: string;
  registryKeyId?: string;
  registryRunnerIdentity?: string;
  tenantScope?: string | null;
  validFrom?: string;
  validUntil?: string | null;
  revokedAt?: string | null;
  signerKeyOverrides?: Record<string, unknown>;
  includeIdentity?: boolean;
}): void {
  const defaultKeyId = "runner-key-1";
  const defaultRunnerIdentity = "ci/hosted-runtime-conformance";
  process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = JSON.stringify({
    keyId: params.signerKeyId ?? defaultKeyId,
    runnerIdentity: params.signerRunnerIdentity ?? defaultRunnerIdentity,
    privateKeyPkcs8Base64: params.privateKeyPkcs8Base64,
    ...params.signerKeyOverrides,
  });
  if (params.includeIdentity === false) return;
  process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = JSON.stringify([
    {
      keyId: params.registryKeyId ?? defaultKeyId,
      publicKey: params.registryPublicKeyBase64,
      runnerIdentity: params.registryRunnerIdentity ?? defaultRunnerIdentity,
      tenantScope: params.tenantScope ?? null,
      validFrom: params.validFrom ?? NOW_VALID_FROM,
      validUntil: params.validUntil ?? null,
      revokedAt: params.revokedAt ?? null,
    },
  ]);
}

/** 断言 fail closed：抛错且错误信息不含任何密钥材料。 */
function expectRejected(params: { privateKeyPkcs8Base64: string; publicKeyBase64: string }) {
  let error: unknown;
  try {
    resolveActiveExternalConformanceSigner(TENANT);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  const message = `${(error as Error).message} ${JSON.stringify((error as Error).message)}`;
  expect(message).not.toContain(params.privateKeyPkcs8Base64);
  expect(message).not.toContain(params.publicKeyBase64);
  // 完整配置 JSON 也不得泄露。
  expect(message).not.toContain("privateKeyPkcs8Base64");
}

describe("resolveActiveExternalConformanceSigner", () => {
  it("匹配的全局（tenantScope=null）授权身份 → 精确返回 signer 描述符", () => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
      tenantScope: null,
    });

    expect(resolveActiveExternalConformanceSigner(TENANT)).toEqual({
      keyId: "runner-key-1",
      runnerIdentity: "ci/hosted-runtime-conformance",
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
    });
  });

  it("匹配的租户范围（tenantScope=当前租户）授权身份 → 精确返回 signer 描述符", () => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
      tenantScope: TENANT,
    });

    expect(resolveActiveExternalConformanceSigner(TENANT)).toEqual({
      keyId: "runner-key-1",
      runnerIdentity: "ci/hosted-runtime-conformance",
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
    });
  });

  it("跨租户授权（tenantScope=其他租户）→ fail closed", () => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
      tenantScope: "tenant-other",
    });

    expectRejected(keyPair);
  });

  it("授权未生效（validFrom 在未来）→ fail closed", () => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
      validFrom: "2999-01-01T00:00:00.000Z",
    });

    expectRejected(keyPair);
  });

  it("授权已过期（validUntil 在过去）→ fail closed", () => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
      validUntil: "2020-01-01T00:00:00.000Z",
    });

    expectRejected(keyPair);
  });

  it("已撤销（revokedAt 非空）→ fail closed", () => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
      revokedAt: "2025-06-01T00:00:00.000Z",
    });

    expectRejected(keyPair);
  });

  it("signer 的 runnerIdentity 与注册记录不一致（同 keyId 同公钥）→ fail closed", () => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
      signerRunnerIdentity: "ci/attacker-other-runner",
    });

    expectRejected(keyPair);
  });

  it("keyId 未注册（signer keyId 与注册表 keyId 不同）→ fail closed", () => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
      signerKeyId: "untrusted-key",
    });

    expectRejected(keyPair);
  });

  it("同一 keyId + 同一 runnerIdentity 但注册表公钥是另一把密钥的公钥（私钥不匹配）→ fail closed", () => {
    const signerKeyPair = generateEd25519SignerKeyPair();
    const otherKeyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: signerKeyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: otherKeyPair.publicKeyBase64,
    });

    expectRejected(signerKeyPair);
  });

  it("更换私钥但保留受信任 keyId → 密码学拒绝", () => {
    const originalKeyPair = generateEd25519SignerKeyPair();
    const rotatedKeyPair = generateEd25519SignerKeyPair();
    // 注册表仍信任原公钥。
    configure({
      privateKeyPkcs8Base64: originalKeyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: originalKeyPair.publicKeyBase64,
    });
    expect(resolveActiveExternalConformanceSigner(TENANT)).toEqual({
      keyId: "runner-key-1",
      runnerIdentity: "ci/hosted-runtime-conformance",
      privateKeyPkcs8Base64: originalKeyPair.privateKeyPkcs8Base64,
    });
    // 只替换 signer 私钥（同 keyId）后必须密码学失败。
    process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = JSON.stringify({
      keyId: "runner-key-1",
      runnerIdentity: "ci/hosted-runtime-conformance",
      privateKeyPkcs8Base64: rotatedKeyPair.privateKeyPkcs8Base64,
    });

    expectRejected(rotatedKeyPair);
  });

  it("注册表缺失（identities env 未配置）→ fail closed", () => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
      includeIdentity: false,
    });

    expectRejected(keyPair);
  });

  it.each([
    ["signer env 缺失", () => undefined],
    ["signer env 为空字符串", () => ""],
    ["signer env 非法 JSON", () => "{"],
  ])("%s → fail closed", (_label, raw) => {
    const keyPair = generateEd25519SignerKeyPair();
    process.env.SNOW_RUNNER_SIGNING_IDENTITIES_JSON = JSON.stringify([
      {
        keyId: "runner-key-1",
        publicKey: keyPair.publicKeyBase64,
        runnerIdentity: "ci/hosted-runtime-conformance",
        tenantScope: null,
        validFrom: NOW_VALID_FROM,
        validUntil: null,
        revokedAt: null,
      },
    ]);
    process.env.SNOW_ACTIVE_EXTERNAL_CONFORMANCE_SIGNER_JSON = raw();

    expectRejected(keyPair);
  });

  it("signer JSON 含未知额外键 → fail closed", () => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
      signerKeyOverrides: { extra: "forbidden" },
    });

    expectRejected(keyPair);
  });

  it("signer JSON 缺 privateKeyPkcs8Base64 键 → fail closed", () => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
      signerKeyOverrides: { privateKeyPkcs8Base64: undefined },
    });

    expectRejected(keyPair);
  });

  it("私钥非 Ed25519（RSA PKCS8）→ fail closed", () => {
    const keyPair = generateEd25519SignerKeyPair();
    const rsaPrivate = generateRsaPkcs8PrivateKeyBase64();
    configure({
      privateKeyPkcs8Base64: rsaPrivate,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
    });

    let error: unknown;
    try {
      resolveActiveExternalConformanceSigner(TENANT);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain(rsaPrivate);
    expect(message).not.toContain(keyPair.publicKeyBase64);
    expect(message).not.toContain("privateKeyPkcs8Base64");
  });

  it.each([
    ["空字符串", ""],
    ["纯空白", "   "],
  ])("tenantId 为 %s → fail closed", (_label, tenantId) => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
    });

    let error: unknown;
    try {
      resolveActiveExternalConformanceSigner(tenantId);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain(keyPair.privateKeyPkcs8Base64);
    expect(message).not.toContain(keyPair.publicKeyBase64);
  });

  it("注册表公钥与配置 getter 真实联动（不 mock 注册表结论）", () => {
    const keyPair = generateEd25519SignerKeyPair();
    configure({
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
      registryPublicKeyBase64: keyPair.publicKeyBase64,
    });

    // 配置 getter 返回的是同一条真实注册记录。
    expect(runtimeConformanceConfig.runnerSigningIdentities).toHaveLength(1);
    expect(runtimeConformanceConfig.runnerSigningIdentities[0]?.publicKey).toBe(
      keyPair.publicKeyBase64,
    );
    expect(resolveActiveExternalConformanceSigner(TENANT)).toEqual({
      keyId: "runner-key-1",
      runnerIdentity: "ci/hosted-runtime-conformance",
      privateKeyPkcs8Base64: keyPair.privateKeyPkcs8Base64,
    });
  });
});
