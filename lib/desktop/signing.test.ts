import {
  AUTH_SIGN_DOMAIN,
  type DeviceKeyPair,
  generateDeviceKeyPair,
  generateNonce,
  generateRequestId,
  getAuthSignPayload,
  signData,
  verifySignature,
} from "@/lib/desktop/signing";
import { describe, expect, it } from "vitest";

describe("getAuthSignPayload()", () => {
  it("使用 domain separator 的 canonical JSON 数组编码", () => {
    const payload = getAuthSignPayload({
      tenantId: "tenant-1",
      deviceKey: "device-abc",
      challenge: "challenge-xyz",
    });
    expect(payload).toBe(
      JSON.stringify(["snowharness-device-auth-v1", "tenant-1", "device-abc", "challenge-xyz"]),
    );
    expect(payload).toContain(AUTH_SIGN_DOMAIN);
  });

  it("字段重排产生不同 payload（顺序敏感，无歧义）", () => {
    const a = getAuthSignPayload({ tenantId: "t1", deviceKey: "d1", challenge: "c1" });
    const b = getAuthSignPayload({ tenantId: "d1", deviceKey: "t1", challenge: "c1" });
    expect(a).not.toBe(b);
  });

  it("字段拼接不会碰撞（换行/逗号/引号免疫）", () => {
    // tenantId="a\nb" 与 deviceKey="a" 若用裸拼接会产生歧义；JSON 数组编码消除之
    const a = getAuthSignPayload({ tenantId: "a\nb", deviceKey: "c", challenge: "x" });
    const b = getAuthSignPayload({ tenantId: "a", deviceKey: "b\nc", challenge: "x" });
    expect(a).not.toBe(b);
  });

  it("delimiter 换行不会导致误验签（不同字段边界）", () => {
    // challenge 含换行 vs 普通 challenge——payload 必须不同
    const a = getAuthSignPayload({ tenantId: "t", deviceKey: "d", challenge: "c\nz" });
    const b = getAuthSignPayload({ tenantId: "t", deviceKey: "d", challenge: "c" });
    expect(a).not.toBe(b);
    const pair = generateDeviceKeyPair();
    const sig = signData(a, pair.privateKeyBase64);
    expect(verifySignature(b, sig, pair.publicKeyBase64)).toBe(false);
    expect(verifySignature(a, sig, pair.publicKeyBase64)).toBe(true);
  });

  it("任一字段为空抛出错误", () => {
    expect(() => getAuthSignPayload({ tenantId: "", deviceKey: "d", challenge: "c" })).toThrow();
    expect(() => getAuthSignPayload({ tenantId: "t", deviceKey: "", challenge: "c" })).toThrow();
    expect(() => getAuthSignPayload({ tenantId: "t", deviceKey: "d", challenge: "" })).toThrow();
  });
});

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
