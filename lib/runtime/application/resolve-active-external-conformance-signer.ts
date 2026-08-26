/**
 * Active external A2A conformance signer 信任解析器。
 *
 * 冻结不变量：active external A2A conformance signer 只有在其配置的 Ed25519
 * 私钥与当前租户 + runner identity 下一条活跃、被授权的 RunnerSigningIdentity
 * 公钥密码学匹配时才可用。
 *
 * 校验链（全部 fail closed，任一步失败抛 ActiveExternalConformanceSignerError）：
 * 1) tenantId 非空；
 * 2) signer 配置存在（严格三键 JSON，由 config getter 保证）；
 * 3) PKCS8 base64 严格 + 合法 Ed25519 私钥；
 * 4) 从私钥派生 raw 32 字节公钥，与注册表记录公钥精确相等（授权 ≠ 密钥匹配）；
 * 5) RunnerSigningIdentityRegistry 授权：keyId + runnerIdentity + 租户范围 +
 *    有效期 + 未撤销。
 *
 * 错误信息绝不包含私钥/公钥字节或含密钥的配置字段名。无密钥生成、无缺省身份、
 * 无缓存（env 每次读取）。
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { runtimeConformanceConfig } from "@/lib/config";
import { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";
import type { ActiveExternalConformanceSigner } from "./build-active-external-conformance";

/** fail-closed 错误类别（内部区分配置非法与信任未通过，对外不泄露密钥材料）。 */
export type ActiveExternalConformanceSignerErrorKind =
  | "signer_config_invalid" // signer 缺失/JSON 非法/键集不严格
  | "signer_key_invalid" // base64/PKCS8/Ed25519/公钥派生非法
  | "signer_untrusted"; // 注册表授权或公钥匹配未通过

export class ActiveExternalConformanceSignerError extends Error {
  constructor(
    public readonly kind: ActiveExternalConformanceSignerErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ActiveExternalConformanceSignerError";
  }
}

function fail(kind: ActiveExternalConformanceSignerErrorKind, message: string): never {
  throw new ActiveExternalConformanceSignerError(kind, message);
}

/** 严格 base64：解码后回编码必须一致（拒绝非法字符/非规范编码）。 */
function decodeStrictBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    fail("signer_key_invalid", "signer 私钥不是合法 base64");
  }
  return decoded;
}

/**
 * 解析 active external conformance signer（生产入口）。
 *
 * 返回 builder 直接接受的 signer 描述符；任何配置/密钥/信任问题一律抛
 * ActiveExternalConformanceSignerError（fail closed）。私钥仅内存使用，绝不序列化。
 */
export function resolveActiveExternalConformanceSigner(
  tenantId: string,
): ActiveExternalConformanceSigner {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    fail("signer_config_invalid", "tenantId 必须是非空字符串");
  }

  // 1) signer 配置（严格三键 JSON；getter 已做全部形状校验）。
  const signer = runtimeConformanceConfig.activeExternalConformanceSigner;
  if (signer === null) {
    fail("signer_config_invalid", "active external conformance signer 未配置或配置非法");
  }

  // 2) PKCS8 base64 + Ed25519 私钥。
  const pkcs8 = decodeStrictBase64(signer.privateKeyPkcs8Base64);
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  } catch {
    return fail("signer_key_invalid", "signer 私钥不是合法 PKCS8");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    fail("signer_key_invalid", "signer 私钥必须是 Ed25519");
  }

  // 3) 从私钥派生 raw 32 字节公钥（SPKI 尾部 32 字节）。
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" }) as Buffer;
  if (spki.length !== 44) {
    fail("signer_key_invalid", "signer 公钥派生形状非法");
  }
  const derivedPublicKeyBase64 = Buffer.from(spki.subarray(spki.length - 32)).toString("base64");

  // 4) 注册表授权 + 公钥精确匹配（授权结论与密钥匹配均来自真实配置，不 mock）。
  const registry = new RunnerSigningIdentityRegistry(
    runtimeConformanceConfig.runnerSigningIdentities,
  );
  const validation = registry.validate({
    keyId: signer.keyId,
    runnerIdentity: signer.runnerIdentity,
    tenantId,
    now: new Date(),
  });
  if (!validation.ok) {
    fail(
      "signer_untrusted",
      `active external conformance signer 信任校验未通过:${validation.failureReason}`,
    );
  }
  if (validation.entry.publicKey !== derivedPublicKeyBase64) {
    fail("signer_untrusted", "active external conformance signer 公钥与私钥不匹配");
  }

  return {
    keyId: signer.keyId,
    runnerIdentity: signer.runnerIdentity,
    privateKeyPkcs8Base64: signer.privateKeyPkcs8Base64,
  };
}
