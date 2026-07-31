import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decrypt,
  decryptCicdToken,
  encrypt,
  encryptCicdToken,
  isMasterKeyConfigured,
  loadMasterKey,
} from "./secret-crypto";

/**
 * V3.8 Stage C：AES-256-GCM secret 加密/解密测试。
 *
 * 覆盖：加解密往返 / 密文不含明文 / key 不匹配解密失败 / keyId / fail-closed。
 */

const TEST_KEY_BASE64 = Buffer.alloc(32, 0x42).toString("base64");

beforeEach(() => {
  process.env.SECRET_MASTER_KEY = TEST_KEY_BASE64;
  process.env.SECRET_MASTER_KEY_ID = "test-key-v1";
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.SECRET_MASTER_KEY;
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.SECRET_MASTER_KEY_ID;
});

describe("loadMasterKey", () => {
  it("base64 编码 key 加载成功", () => {
    const key = loadMasterKey();
    expect(key.length).toBe(32);
  });

  it("hex 编码 key 加载成功", () => {
    process.env.SECRET_MASTER_KEY = Buffer.alloc(32, 0x42).toString("hex");
    const key = loadMasterKey();
    expect(key.length).toBe(32);
  });

  it("key 缺失 → 抛错（fail-closed）", () => {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.SECRET_MASTER_KEY;
    expect(() => loadMasterKey()).toThrow(/SECRET_MASTER_KEY 未配置/);
  });

  it("key 长度不正确 → 抛错", () => {
    process.env.SECRET_MASTER_KEY = "too-short";
    expect(() => loadMasterKey()).toThrow(/长度不正确/);
  });
});

describe("isMasterKeyConfigured", () => {
  it("已配置 → true", () => {
    expect(isMasterKeyConfigured()).toBe(true);
  });

  it("未配置 → false", () => {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.SECRET_MASTER_KEY;
    expect(isMasterKeyConfigured()).toBe(false);
  });
});

describe("encrypt / decrypt", () => {
  it("加解密往返", () => {
    const plaintext = "sk-abc-123-secret-key";
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("密文不含明文", () => {
    const plaintext = "super-secret-value-12345";
    const encrypted = encrypt(plaintext);
    expect(encrypted.ciphertext).not.toContain(plaintext);
    // base64 解码后也不含明文
    const decoded = Buffer.from(encrypted.ciphertext, "base64").toString("utf-8");
    expect(decoded).not.toContain(plaintext);
  });

  it("每次加密 IV 不同 → 密文不同", () => {
    const plaintext = "same-value";
    const e1 = encrypt(plaintext);
    const e2 = encrypt(plaintext);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
    // 但都能解密回原值
    expect(decrypt(e1)).toBe(plaintext);
    expect(decrypt(e2)).toBe(plaintext);
  });

  it("keyId 从配置读取", () => {
    const encrypted = encrypt("test");
    expect(encrypted.keyId).toBe("test-key-v1");
  });

  it("密文被篡改 → 解密失败（GCM auth tag）", () => {
    const encrypted = encrypt("secret");
    // 篡改密文：翻转最后一个字节
    const blob = Buffer.from(encrypted.ciphertext, "base64");
    const lastIdx = blob.length - 1;
    blob[lastIdx] = (blob[lastIdx] ?? 0) ^ 0x01;
    const tampered = { ...encrypted, ciphertext: blob.toString("base64") };
    expect(() => decrypt(tampered)).toThrow();
  });

  it("不同 key 加密的密文 → 解密失败", () => {
    const encrypted = encrypt("secret");
    // 换一个不同的 key
    process.env.SECRET_MASTER_KEY = Buffer.alloc(32, 0x99).toString("base64");
    expect(() => decrypt(encrypted)).toThrow();
  });

  it("master key 缺失 → encrypt 抛错（fail-closed）", () => {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.SECRET_MASTER_KEY;
    expect(() => encrypt("secret")).toThrow(/SECRET_MASTER_KEY 未配置/);
  });

  it("master key 缺失 → decrypt 抛错（fail-closed）", () => {
    const encrypted = encrypt("secret");
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.SECRET_MASTER_KEY;
    expect(() => decrypt(encrypted)).toThrow(/SECRET_MASTER_KEY 未配置/);
  });

  it("空明文也能加解密", () => {
    const encrypted = encrypt("");
    expect(decrypt(encrypted)).toBe("");
  });

  it("Unicode 明文加解密", () => {
    const plaintext = "密钥🔑secret";
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it("P1-20: decryptCicdToken 加解密往返", () => {
    const ciphertext = encryptCicdToken("cicd-token-value");
    expect(decryptCicdToken(ciphertext)).toBe("cicd-token-value");
  });

  it("P1-20: decryptCicdToken 拒明文(fail-closed,不再兼容)", () => {
    expect(() => decryptCicdToken("plaintext-token")).toThrow(/非合法密文/);
  });

  it("P1-20: decryptCicdToken 拒被篡改的 JSON(缺 ciphertext)", () => {
    expect(() => decryptCicdToken(JSON.stringify({ keyId: "k1" }))).toThrow(/非合法密文/);
  });

  it("P1-20: decryptCicdToken null/空 → null", () => {
    expect(decryptCicdToken(null)).toBeNull();
    expect(decryptCicdToken(undefined)).toBeNull();
    expect(decryptCicdToken("")).toBeNull();
  });
});
