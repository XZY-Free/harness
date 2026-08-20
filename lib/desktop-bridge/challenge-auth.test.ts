/**
 * challenge-auth 测试。
 */
import {
  generateChallenge,
  generateServerKeyPair,
  verifyAuthResponse,
} from "@/lib/desktop-bridge/challenge-auth";
import { generateDeviceKeyPair, getAuthSignPayload, signData } from "@/lib/desktop/signing";
import { describe, expect, it } from "vitest";

/** 构造一次合法认证响应（签名绑定 tenantId + deviceKey + challenge）。 */
function signAuth(params: {
  tenantId: string;
  deviceId: string;
  challenge: string;
  privateKeyBase64: string;
}): string {
  return signData(
    getAuthSignPayload({
      tenantId: params.tenantId,
      deviceKey: params.deviceId,
      challenge: params.challenge,
    }),
    params.privateKeyBase64,
  );
}

describe("generateChallenge()", () => {
  it("返回非空 base64 字符串", () => {
    const challenge = generateChallenge();
    expect(typeof challenge).toBe("string");
    expect(challenge.length).toBeGreaterThan(0);
  });

  it("解码后为 32 字节", () => {
    const challenge = generateChallenge();
    const buf = Buffer.from(challenge, "base64");
    expect(buf.length).toBe(32);
  });

  it("连续调用 1000 次不重复", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      set.add(generateChallenge());
    }
    expect(set.size).toBe(1000);
  });
});

describe("generateServerKeyPair()", () => {
  it("返回非空公钥和私钥（base64）", () => {
    const pair = generateServerKeyPair();
    expect(typeof pair.publicKeyBase64).toBe("string");
    expect(typeof pair.privateKeyBase64).toBe("string");
    expect(pair.publicKeyBase64.length).toBeGreaterThan(0);
    expect(pair.privateKeyBase64.length).toBeGreaterThan(0);
  });

  it("公钥解码后为 32 字节（ed25519 raw）", () => {
    const pair = generateServerKeyPair();
    const buf = Buffer.from(pair.publicKeyBase64, "base64");
    expect(buf.length).toBe(32);
  });

  it("公钥与私钥不同", () => {
    const pair = generateServerKeyPair();
    expect(pair.publicKeyBase64).not.toBe(pair.privateKeyBase64);
  });

  it("每次生成的密钥对不同", () => {
    const a = generateServerKeyPair();
    const b = generateServerKeyPair();
    expect(a.publicKeyBase64).not.toBe(b.publicKeyBase64);
    expect(a.privateKeyBase64).not.toBe(b.privateKeyBase64);
  });
});

describe("verifyAuthResponse()", () => {
  const TENANT = "tenant-001";

  it("正确签名返回 true", () => {
    const deviceKey = generateDeviceKeyPair();
    const challenge = generateChallenge();
    const signature = signAuth({
      tenantId: TENANT,
      deviceId: "dev-001",
      challenge,
      privateKeyBase64: deviceKey.privateKeyBase64,
    });
    const result = verifyAuthResponse({
      challenge,
      signature,
      tenantId: TENANT,
      deviceId: "dev-001",
      devicePublicKeyBase64: deviceKey.publicKeyBase64,
    });
    expect(result).toBe(true);
  });

  it("篡改 challenge 返回 false", () => {
    const deviceKey = generateDeviceKeyPair();
    const challenge = generateChallenge();
    const signature = signAuth({
      tenantId: TENANT,
      deviceId: "dev-001",
      challenge,
      privateKeyBase64: deviceKey.privateKeyBase64,
    });
    const result = verifyAuthResponse({
      challenge: generateChallenge(),
      signature,
      tenantId: TENANT,
      deviceId: "dev-001",
      devicePublicKeyBase64: deviceKey.publicKeyBase64,
    });
    expect(result).toBe(false);
  });

  it("篡改签名返回 false", () => {
    const deviceKey = generateDeviceKeyPair();
    const challenge = generateChallenge();
    const signature = signAuth({
      tenantId: TENANT,
      deviceId: "dev-001",
      challenge,
      privateKeyBase64: deviceKey.privateKeyBase64,
    });
    const tamperedSig =
      signature.charAt(0) === "A" ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    const result = verifyAuthResponse({
      challenge,
      signature: tamperedSig,
      tenantId: TENANT,
      deviceId: "dev-001",
      devicePublicKeyBase64: deviceKey.publicKeyBase64,
    });
    expect(result).toBe(false);
  });

  it("错误公钥返回 false", () => {
    const deviceKey1 = generateDeviceKeyPair();
    const deviceKey2 = generateDeviceKeyPair();
    const challenge = generateChallenge();
    const signature = signAuth({
      tenantId: TENANT,
      deviceId: "dev-001",
      challenge,
      privateKeyBase64: deviceKey1.privateKeyBase64,
    });
    const result = verifyAuthResponse({
      challenge,
      signature,
      tenantId: TENANT,
      deviceId: "dev-001",
      devicePublicKeyBase64: deviceKey2.publicKeyBase64,
    });
    expect(result).toBe(false);
  });

  it("换租户验签返回 false（签名绑定 tenantId）", () => {
    const deviceKey = generateDeviceKeyPair();
    const challenge = generateChallenge();
    const signature = signAuth({
      tenantId: "tenant-A",
      deviceId: "dev-001",
      challenge,
      privateKeyBase64: deviceKey.privateKeyBase64,
    });
    // 同一设备、同一 challenge，但 tenantId 换成 tenant-B → 验签失败（防跨租户重放）
    const result = verifyAuthResponse({
      challenge,
      signature,
      tenantId: "tenant-B",
      deviceId: "dev-001",
      devicePublicKeyBase64: deviceKey.publicKeyBase64,
    });
    expect(result).toBe(false);
  });

  it("换 deviceId 验签返回 false（签名绑定 deviceKey）", () => {
    const deviceKey = generateDeviceKeyPair();
    const challenge = generateChallenge();
    const signature = signAuth({
      tenantId: TENANT,
      deviceId: "dev-001",
      challenge,
      privateKeyBase64: deviceKey.privateKeyBase64,
    });
    const result = verifyAuthResponse({
      challenge,
      signature,
      tenantId: TENANT,
      deviceId: "dev-999",
      devicePublicKeyBase64: deviceKey.publicKeyBase64,
    });
    expect(result).toBe(false);
  });

  it("空 challenge 返回 false", () => {
    const deviceKey = generateDeviceKeyPair();
    const challenge = generateChallenge();
    const signature = signAuth({
      tenantId: TENANT,
      deviceId: "dev-001",
      challenge,
      privateKeyBase64: deviceKey.privateKeyBase64,
    });
    const result = verifyAuthResponse({
      challenge: "",
      signature,
      tenantId: TENANT,
      deviceId: "dev-001",
      devicePublicKeyBase64: deviceKey.publicKeyBase64,
    });
    expect(result).toBe(false);
  });

  it("空 tenantId 返回 false", () => {
    const deviceKey = generateDeviceKeyPair();
    const challenge = generateChallenge();
    const signature = signAuth({
      tenantId: TENANT,
      deviceId: "dev-001",
      challenge,
      privateKeyBase64: deviceKey.privateKeyBase64,
    });
    const result = verifyAuthResponse({
      challenge,
      signature,
      tenantId: "",
      deviceId: "dev-001",
      devicePublicKeyBase64: deviceKey.publicKeyBase64,
    });
    expect(result).toBe(false);
  });

  it("空签名返回 false", () => {
    const deviceKey = generateDeviceKeyPair();
    const challenge = generateChallenge();
    const result = verifyAuthResponse({
      challenge,
      signature: "",
      tenantId: TENANT,
      deviceId: "dev-001",
      devicePublicKeyBase64: deviceKey.publicKeyBase64,
    });
    expect(result).toBe(false);
  });
});
