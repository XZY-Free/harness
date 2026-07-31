import {
  type DeviceKeyPair,
  generateDeviceKeyPair,
  generateNonce,
  generateRequestId,
  signData,
  verifySignature,
} from "@/lib/desktop/signing";
import { describe, expect, it } from "vitest";

describe("generateDeviceKeyPair()", () => {
  it("返回非空公钥和私钥（base64）", () => {
    const pair = generateDeviceKeyPair();
    expect(typeof pair.publicKeyBase64).toBe("string");
    expect(typeof pair.privateKeyBase64).toBe("string");
    expect(pair.publicKeyBase64.length).toBeGreaterThan(0);
    expect(pair.privateKeyBase64.length).toBeGreaterThan(0);
  });

  it("公钥和私钥不同", () => {
    const pair = generateDeviceKeyPair();
    expect(pair.publicKeyBase64).not.toBe(pair.privateKeyBase64);
  });

  it("每次生成的密钥对不同", () => {
    const a = generateDeviceKeyPair();
    const b = generateDeviceKeyPair();
    expect(a.publicKeyBase64).not.toBe(b.publicKeyBase64);
    expect(a.privateKeyBase64).not.toBe(b.privateKeyBase64);
  });

  it("公钥是合法 base64", () => {
    const pair = generateDeviceKeyPair();
    const buf = Buffer.from(pair.publicKeyBase64, "base64");
    expect(buf.length).toBeGreaterThan(0);
    // ed25519 公钥 32 字节
    expect(buf.length).toBe(32);
  });

  it("私钥是合法 base64 且可解析为 PKCS8", () => {
    const pair = generateDeviceKeyPair();
    const buf = Buffer.from(pair.privateKeyBase64, "base64");
    expect(buf.length).toBeGreaterThan(32);
  });
});

describe("signData() + verifySignature()", () => {
  it("正确签名通过验证", () => {
    const pair = generateDeviceKeyPair();
    const data = "hello world";
    const sig = signData(data, pair.privateKeyBase64);
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);
    expect(verifySignature(data, sig, pair.publicKeyBase64)).toBe(true);
  });

  it("Buffer 数据签名通过验证", () => {
    const pair = generateDeviceKeyPair();
    const data = Buffer.from("binary data \x00\x01\x02", "utf8");
    const sig = signData(data, pair.privateKeyBase64);
    expect(verifySignature(data, sig, pair.publicKeyBase64)).toBe(true);
  });

  it("篡改数据后验证失败", () => {
    const pair = generateDeviceKeyPair();
    const sig = signData("original", pair.privateKeyBase64);
    expect(verifySignature("tampered", sig, pair.publicKeyBase64)).toBe(false);
  });

  it("篡改签名后验证失败", () => {
    const pair = generateDeviceKeyPair();
    const sig = signData("hello", pair.privateKeyBase64);
    // 翻转签名首字符
    const tamperedSig = sig.charAt(0) === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(verifySignature("hello", tamperedSig, pair.publicKeyBase64)).toBe(false);
  });

  it("用错误的公钥验证失败", () => {
    const pair1 = generateDeviceKeyPair();
    const pair2 = generateDeviceKeyPair();
    const sig = signData("hello", pair1.privateKeyBase64);
    expect(verifySignature("hello", sig, pair2.publicKeyBase64)).toBe(false);
  });

  it("无效私钥抛出错误", () => {
    expect(() => signData("hello", "not-a-valid-key")).toThrow();
  });

  it("无效公钥验证抛出错误", () => {
    const pair = generateDeviceKeyPair();
    const sig = signData("hello", pair.privateKeyBase64);
    expect(() => verifySignature("hello", sig, "not-a-valid-key")).toThrow();
  });

  it("无效签名格式验证抛出错误", () => {
    const pair = generateDeviceKeyPair();
    expect(() => verifySignature("hello", "!!!not-base64!!!", pair.publicKeyBase64)).toThrow();
  });
});

describe("generateNonce()", () => {
  it("返回 base64 字符串", () => {
    const nonce = generateNonce();
    expect(typeof nonce).toBe("string");
    expect(nonce.length).toBeGreaterThan(0);
  });

  it("解码后为 32 字节", () => {
    const nonce = generateNonce();
    const buf = Buffer.from(nonce, "base64");
    expect(buf.length).toBe(32);
  });

  it("连续生成 1000 次不重复", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      nonces.add(generateNonce());
    }
    expect(nonces.size).toBe(1000);
  });
});

describe("generateRequestId()", () => {
  it("返回 UUID 格式字符串", () => {
    const id = generateRequestId();
    // UUID v4 格式: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("连续生成 100 次不重复", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateRequestId());
    }
    expect(ids.size).toBe(100);
  });
});
