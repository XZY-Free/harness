import { sign as cryptoSign, generateKeyPairSync, randomBytes } from "node:crypto";
/**
 * S02-C02：V11 设备与 Workload 身份集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - device-queries：register/touch/revoke/list/getByKey/getForUser/isActive。
 * - workload-token：issue/decode/extractBearer/audienceMatch/invocationMatch/serviceActionAllowed。
 * - device-signature：ed25519 签名验证（真实密钥对）、时间窗口、状态校验、payload 构造。
 * - resolver（workload）：resolveV11WorkloadPrincipal runtime/gateway/service。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  getDeviceById,
  getDeviceByKey,
  getDeviceForUser,
  isDeviceActive,
  listActiveDevicesByUser,
  registerDevice,
  revokeDevice,
  touchDevice,
} from "@/lib/v11/identity/device-queries";
import {
  DESKTOP_DEVICE_KEY_HEADER,
  DESKTOP_SIGNATURE_HEADER,
  DESKTOP_SIGNATURE_WINDOW_MS,
  DESKTOP_TIMESTAMP_HEADER,
  DeviceSignatureError,
  assertDeviceValid,
  assertTimestampInWindow,
  buildSignaturePayload,
  computeBodyHash,
  extractDesktopSignature,
  parseDesktopSignatureHeaders,
  verifyDeviceSignature,
} from "@/lib/v11/identity/device-signature";
import { V11AuthError, resolveV11WorkloadPrincipal } from "@/lib/v11/identity/resolver";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import {
  CICD_SERVICE_ALLOWED_ACTIONS,
  WorkloadTokenError,
  assertAudienceMatch,
  assertInvocationMatch,
  decodeWorkloadToken,
  extractBearerToken,
  isServiceActionAllowed,
  issueWorkloadToken,
  workloadTokenErrorResponse,
} from "@/lib/v11/identity/workload-token";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

// ─── device-queries ──────────────────────────────────────────

describe("V11 device-queries", () => {
  async function seedDevice(
    overrides: Partial<{
      deviceKey: string;
      deviceName: string;
      appVersion: string;
    }> = {},
  ) {
    const tenant = await ensureDefaultTenant();
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice@example.com",
      displayName: "Alice",
    });
    const device = await registerDevice({
      tenantId: tenant.id,
      userId: identity.id,
      deviceKey: overrides.deviceKey ?? "macbook-pro-001",
      publicKey: "dGVzdC1wdWJsaWMta2V5", // base64("test-public-key")
      deviceName: overrides.deviceName ?? "MacBook Pro",
      appVersion: overrides.appVersion ?? "1.0.0",
    });
    return { tenant, identity, device };
  }

  it("registerDevice 首次创建新设备", async () => {
    const { tenant, identity, device } = await seedDevice();
    expect(device.id).toBeTruthy();
    expect(device.tenantId).toBe(tenant.id);
    expect(device.userId).toBe(identity.id);
    expect(device.deviceKey).toBe("macbook-pro-001");
    expect(device.deviceState).toBe("active");
    expect(device.revokedAt).toBeNull();
  });

  it("registerDevice 同 (tenantId, deviceKey) active 时幂等返回现有", async () => {
    const { device: first } = await seedDevice();
    const { device: second } = await seedDevice();
    expect(second.id).toBe(first.id);
  });

  it("getDeviceByKey 按 (tenantId, deviceKey) 查找", async () => {
    const { tenant, device } = await seedDevice();
    const found = await getDeviceByKey(tenant.id, device.deviceKey);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(device.id);
  });

  it("getDeviceByKey 未知返回 null", async () => {
    const tenant = await ensureDefaultTenant();
    const found = await getDeviceByKey(tenant.id, "nonexistent");
    expect(found).toBeNull();
  });

  it("getDeviceById 按 id 查找", async () => {
    const { device } = await seedDevice();
    const found = await getDeviceById(device.id);
    expect(found).not.toBeNull();
    expect(found?.deviceKey).toBe(device.deviceKey);
  });

  it("listActiveDevicesByUser 返回活跃设备按 lastActiveAt desc", async () => {
    const { tenant, identity } = await seedDevice({ deviceKey: "dev-1" });
    await seedDevice({ deviceKey: "dev-2" });
    // seedDevice 复用同一 identity（同 externalSubject）
    const list = await listActiveDevicesByUser(tenant.id, identity.id);
    expect(list.length).toBeGreaterThanOrEqual(1);
    for (const d of list) {
      expect(d.deviceState).toBe("active");
      expect(d.userId).toBe(identity.id);
    }
  });

  it("touchDevice 更新 lastActiveAt", async () => {
    const { tenant, device } = await seedDevice();
    const before = device.lastActiveAt.getTime();
    // 等待 50ms 确保 NOW(3) 比之前晚（避免 MySQL 毫秒精度抖动）
    await new Promise((r) => setTimeout(r, 50));
    await touchDevice(tenant.id, device.deviceKey);
    const after = await getDeviceByKey(tenant.id, device.deviceKey);
    expect(after).not.toBeNull();
    expect(after?.lastActiveAt.getTime()).toBeGreaterThan(before);
  });

  it("revokeDevice active → revoked + revokedAt 回填", async () => {
    const { tenant, device } = await seedDevice();
    const revoked = await revokeDevice(tenant.id, device.deviceKey);
    expect(revoked).not.toBeNull();
    expect(revoked?.deviceState).toBe("revoked");
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it("revokeDevice 重复撤销返回 null", async () => {
    const { tenant, device } = await seedDevice();
    await revokeDevice(tenant.id, device.deviceKey);
    const second = await revokeDevice(tenant.id, device.deviceKey);
    expect(second).toBeNull();
  });

  it("revokeDevice 不存在的设备返回 null", async () => {
    const tenant = await ensureDefaultTenant();
    const result = await revokeDevice(tenant.id, "nonexistent");
    expect(result).toBeNull();
  });

  it("revokeDevice 后设备不再 active", async () => {
    const { tenant, device } = await seedDevice();
    expect(await isDeviceActive(tenant.id, device.deviceKey)).toBe(true);
    await revokeDevice(tenant.id, device.deviceKey);
    expect(await isDeviceActive(tenant.id, device.deviceKey)).toBe(false);
  });

  it("isDeviceActive 不存在返回 false", async () => {
    const tenant = await ensureDefaultTenant();
    expect(await isDeviceActive(tenant.id, "nonexistent")).toBe(false);
  });

  it("getDeviceForUser owner guard：跨用户返回 null", async () => {
    const { tenant, identity, device } = await seedDevice();
    // 用错误的 userId 查找 → 返回 null
    const otherUserId = "11111111-1111-4111-8111-111111111111";
    const found = await getDeviceForUser(tenant.id, device.deviceKey, otherUserId);
    expect(found).toBeNull();
  });

  it("getDeviceForUser 同用户返回设备", async () => {
    const { tenant, identity, device } = await seedDevice();
    const found = await getDeviceForUser(tenant.id, device.deviceKey, identity.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(device.id);
  });

  it("撤销后设备仍可查但 deviceState=revoked", async () => {
    const { tenant, device } = await seedDevice();
    await revokeDevice(tenant.id, device.deviceKey);
    const found = await getDeviceByKey(tenant.id, device.deviceKey);
    expect(found).not.toBeNull();
    expect(found?.deviceState).toBe("revoked");
  });
});

// ─── workload-token ──────────────────────────────────────────

describe("V11 workload-token", () => {
  it("issueWorkloadToken + decodeWorkloadToken 往返一致", () => {
    const now = Date.now();
    const token = issueWorkloadToken({
      type: "runtime",
      tenantId: DEFAULT_TENANT_ID,
      invocationId: "inv-001",
      runtimeRevisionId: "rt-rev-001",
      audience: "runtime",
      expiresAt: now + 60000,
    });
    const claims = decodeWorkloadToken(token);
    expect(claims.type).toBe("runtime");
    expect(claims.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(claims.invocationId).toBe("inv-001");
    expect(claims.runtimeRevisionId).toBe("rt-rev-001");
    expect(claims.audience).toBe("runtime");
    expect(claims.issuedAt).toBeLessThanOrEqual(now + 1000);
  });

  it("decodeWorkloadToken 非 base64url 抛 malformed_token", () => {
    expect(() => decodeWorkloadToken("!!!not-base64!!!")).toThrow(WorkloadTokenError);
    try {
      decodeWorkloadToken("!!!not-base64!!!");
    } catch (e) {
      expect((e as WorkloadTokenError).code).toBe("malformed_token");
    }
  });

  it("decodeWorkloadToken 过期抛 expired_token", () => {
    const token = issueWorkloadToken({
      type: "gateway",
      tenantId: DEFAULT_TENANT_ID,
      invocationId: "inv-002",
      audience: "gateway",
      expiresAt: Date.now() - 1000, // 已过期
    });
    expect(() => decodeWorkloadToken(token)).toThrow(WorkloadTokenError);
    try {
      decodeWorkloadToken(token);
    } catch (e) {
      expect((e as WorkloadTokenError).code).toBe("expired_token");
    }
  });

  it("decodeWorkloadToken service 缺 serviceId 抛 malformed_token", () => {
    const now = Date.now();
    // 手动构造缺 serviceId 的 service token
    const claims = {
      type: "service",
      tenantId: DEFAULT_TENANT_ID,
      audience: "admin",
      issuedAt: now,
      expiresAt: now + 60000,
    };
    const token = Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url");
    expect(() => decodeWorkloadToken(token)).toThrow(WorkloadTokenError);
  });

  it("decodeWorkloadToken runtime 缺 invocationId 抛 malformed_token", () => {
    const now = Date.now();
    const claims = {
      type: "runtime",
      tenantId: DEFAULT_TENANT_ID,
      runtimeRevisionId: "rt-rev-001",
      audience: "runtime",
      issuedAt: now,
      expiresAt: now + 60000,
    };
    const token = Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url");
    expect(() => decodeWorkloadToken(token)).toThrow(WorkloadTokenError);
  });

  it("decodeWorkloadToken runtime 缺 runtimeRevisionId 抛 malformed_token", () => {
    const now = Date.now();
    const claims = {
      type: "runtime",
      tenantId: DEFAULT_TENANT_ID,
      invocationId: "inv-001",
      audience: "runtime",
      issuedAt: now,
      expiresAt: now + 60000,
    };
    const token = Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url");
    expect(() => decodeWorkloadToken(token)).toThrow(WorkloadTokenError);
  });

  it("extractBearerToken 提取 Bearer token", () => {
    const headers = new Headers();
    headers.set("authorization", "Bearer abc123");
    expect(extractBearerToken(headers)).toBe("abc123");
  });

  it("extractBearerToken 非 Bearer 返回 null", () => {
    const headers = new Headers();
    headers.set("authorization", "Basic abc123");
    expect(extractBearerToken(headers)).toBeNull();
  });

  it("extractBearerToken 缺失返回 null", () => {
    expect(extractBearerToken(new Headers())).toBeNull();
  });

  it("assertAudienceMatch 一致时不抛错", () => {
    const now = Date.now();
    const claims = {
      type: "runtime" as const,
      tenantId: DEFAULT_TENANT_ID,
      jti: "jti-device-aud-ok-001",
      invocationId: "inv-001",
      runtimeRevisionId: "rt-rev-001",
      audience: "runtime" as const,
      issuedAt: now,
      expiresAt: now + 60000,
    };
    expect(() => assertAudienceMatch(claims, "runtime")).not.toThrow();
  });

  it("assertAudienceMatch 不一致抛 audience_mismatch", () => {
    const now = Date.now();
    const claims = {
      type: "runtime" as const,
      tenantId: DEFAULT_TENANT_ID,
      jti: "jti-device-aud-mismatch-001",
      invocationId: "inv-001",
      runtimeRevisionId: "rt-rev-001",
      audience: "runtime" as const,
      issuedAt: now,
      expiresAt: now + 60000,
    };
    expect(() => assertAudienceMatch(claims, "gateway")).toThrow(WorkloadTokenError);
  });

  it("assertInvocationMatch 一致时不抛错", () => {
    const now = Date.now();
    const claims = {
      type: "runtime" as const,
      tenantId: DEFAULT_TENANT_ID,
      jti: "jti-device-inv-ok-001",
      invocationId: "inv-001",
      runtimeRevisionId: "rt-rev-001",
      audience: "runtime" as const,
      issuedAt: now,
      expiresAt: now + 60000,
    };
    expect(() => assertInvocationMatch(claims, "inv-001")).not.toThrow();
  });

  it("assertInvocationMatch 不一致抛 invocation_mismatch", () => {
    const now = Date.now();
    const claims = {
      type: "runtime" as const,
      tenantId: DEFAULT_TENANT_ID,
      jti: "jti-device-inv-mismatch-001",
      invocationId: "inv-001",
      runtimeRevisionId: "rt-rev-001",
      audience: "runtime" as const,
      issuedAt: now,
      expiresAt: now + 60000,
    };
    expect(() => assertInvocationMatch(claims, "inv-other")).toThrow(WorkloadTokenError);
  });

  it("isServiceActionAllowed cicd 允许的动作", () => {
    expect(isServiceActionAllowed("cicd", "artifact.attestation.verify")).toBe(true);
    expect(isServiceActionAllowed("cicd", "agent.revision.create")).toBe(true);
    expect(isServiceActionAllowed("cicd", "deletion.request")).toBe(true);
  });

  it("isServiceActionAllowed cicd 拒绝未授权动作", () => {
    expect(isServiceActionAllowed("cicd", "agent.publish")).toBe(false);
    expect(isServiceActionAllowed("cicd", "thread.create")).toBe(false);
  });

  it("isServiceActionAllowed 未知 service 拒绝", () => {
    expect(isServiceActionAllowed("unknown", "artifact.attestation.verify")).toBe(false);
  });

  it("CICD_SERVICE_ALLOWED_ACTIONS 不含 agent.publish（CI/CD 不能发布）", () => {
    expect(CICD_SERVICE_ALLOWED_ACTIONS).not.toContain("agent.publish");
  });

  it("workloadTokenErrorResponse 把 WorkloadTokenError 转 401", async () => {
    const error = new WorkloadTokenError("expired_token", "Token 已过期");
    const response = workloadTokenErrorResponse(error, "req_test_1");
    expect(response).not.toBeNull();
    expect(response?.status).toBe(401);
    const body = (await response?.json()) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(body.error.request_id).toBe("req_test_1");
  });

  it("workloadTokenErrorResponse 非 WorkloadTokenError 返回 null", () => {
    expect(workloadTokenErrorResponse(new Error("other"), "req_test_2")).toBeNull();
  });
});

// ─── device-signature ────────────────────────────────────────

describe("V11 device-signature", () => {
  /** 生成 ed25519 密钥对供测试用。 */
  function generateTestKeyPair() {
    return generateKeyPairSync("ed25519");
  }

  /** 提取公钥的原始 32 字节（base64）。 */
  function extractRawPublicKeyBase64(
    publicKey: ReturnType<typeof generateTestKeyPair>["publicKey"],
  ): string {
    const der = publicKey.export({ type: "spki", format: "der" });
    // SPKI for ed25519: 12 字节前缀 + 32 字节 raw key
    const raw = der.subarray(12);
    return Buffer.from(raw).toString("base64");
  }

  describe("extractDesktopSignature", () => {
    it("完整 header 提取成功", () => {
      const headers = new Headers();
      headers.set(DESKTOP_DEVICE_KEY_HEADER, "dev-key-1");
      headers.set(DESKTOP_SIGNATURE_HEADER, "sig-base64");
      headers.set(DESKTOP_TIMESTAMP_HEADER, String(Date.now()));
      const info = extractDesktopSignature(headers);
      expect(info.deviceKey).toBe("dev-key-1");
      expect(info.signature).toBe("sig-base64");
      expect(typeof info.timestamp).toBe("number");
    });

    it("缺 deviceKey 抛 missing_device_key", () => {
      const headers = new Headers();
      headers.set(DESKTOP_SIGNATURE_HEADER, "sig");
      headers.set(DESKTOP_TIMESTAMP_HEADER, String(Date.now()));
      expect(() => extractDesktopSignature(headers)).toThrow(DeviceSignatureError);
    });

    it("缺 signature 抛 missing_signature", () => {
      const headers = new Headers();
      headers.set(DESKTOP_DEVICE_KEY_HEADER, "dev-key-1");
      headers.set(DESKTOP_TIMESTAMP_HEADER, String(Date.now()));
      expect(() => extractDesktopSignature(headers)).toThrow(DeviceSignatureError);
    });

    it("缺 timestamp 抛 missing_timestamp", () => {
      const headers = new Headers();
      headers.set(DESKTOP_DEVICE_KEY_HEADER, "dev-key-1");
      headers.set(DESKTOP_SIGNATURE_HEADER, "sig");
      expect(() => extractDesktopSignature(headers)).toThrow(DeviceSignatureError);
    });

    it("timestamp 非数字抛 malformed_timestamp", () => {
      const headers = new Headers();
      headers.set(DESKTOP_DEVICE_KEY_HEADER, "dev-key-1");
      headers.set(DESKTOP_SIGNATURE_HEADER, "sig");
      headers.set(DESKTOP_TIMESTAMP_HEADER, "not-a-number");
      expect(() => extractDesktopSignature(headers)).toThrow(DeviceSignatureError);
    });
  });

  describe("assertTimestampInWindow", () => {
    it("当前时间戳通过", () => {
      expect(() => assertTimestampInWindow(Date.now())).not.toThrow();
    });

    it("超窗口时间戳抛 timestamp_expired", () => {
      const old = Date.now() - DESKTOP_SIGNATURE_WINDOW_MS - 1000;
      expect(() => assertTimestampInWindow(old)).toThrow(DeviceSignatureError);
    });

    it("未来超窗口时间戳抛 timestamp_expired", () => {
      const future = Date.now() + DESKTOP_SIGNATURE_WINDOW_MS + 1000;
      expect(() => assertTimestampInWindow(future)).toThrow(DeviceSignatureError);
    });
  });

  describe("buildSignaturePayload + computeBodyHash", () => {
    it("buildSignaturePayload 按规范顺序拼接", () => {
      const payload = buildSignaturePayload({
        method: "post",
        path: "/api/v1/threads/thr_1/turns",
        timestamp: 1234567890,
        bodyHash: "abc123",
      });
      expect(payload).toBe("POST\n/api/v1/threads/thr_1/turns\n1234567890\nabc123");
    });

    it("computeBodyHash 返回 SHA-256 hex", () => {
      const hash = computeBodyHash("test");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      // SHA-256("test") = 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
      expect(hash).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
    });

    it("computeBodyHash 空串返回空串的 SHA-256", () => {
      const hash = computeBodyHash("");
      // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
      expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });
  });

  describe("verifyDeviceSignature（真实 ed25519 密钥对）", () => {
    it("正确签名验签通过", () => {
      const { publicKey, privateKey } = generateTestKeyPair();
      const publicKeyBase64 = extractRawPublicKeyBase64(publicKey);
      const payload = buildSignaturePayload({
        method: "POST",
        path: "/api/v1/threads/thr_1/turns",
        timestamp: Date.now(),
        bodyHash: computeBodyHash('{"message":"hello"}'),
      });
      const signature = cryptoSign(null, Buffer.from(payload, "utf-8"), privateKey);
      const signatureBase64 = signature.toString("base64");

      expect(() =>
        verifyDeviceSignature({ publicKeyBase64, payload, signatureBase64 }),
      ).not.toThrow();
    });

    it("篡改 payload 后验签失败", () => {
      const { publicKey, privateKey } = generateTestKeyPair();
      const publicKeyBase64 = extractRawPublicKeyBase64(publicKey);
      const payload = buildSignaturePayload({
        method: "POST",
        path: "/api/v1/threads/thr_1/turns",
        timestamp: Date.now(),
        bodyHash: computeBodyHash('{"message":"hello"}'),
      });
      const signature = cryptoSign(null, Buffer.from(payload, "utf-8"), privateKey);
      const signatureBase64 = signature.toString("base64");

      // 篡改 payload：修改 path（确保实际改变 payload 内容）
      const tamperedPayload = payload.replace("thr_1", "thr_2");
      expect(tamperedPayload).not.toBe(payload); // 确认篡改生效
      expect(() =>
        verifyDeviceSignature({
          publicKeyBase64,
          payload: tamperedPayload,
          signatureBase64,
        }),
      ).toThrow(DeviceSignatureError);
    });

    it("错误公钥验签失败", () => {
      const { privateKey } = generateTestKeyPair();
      const { publicKey: otherPublicKey } = generateTestKeyPair();
      const wrongPublicKeyBase64 = extractRawPublicKeyBase64(otherPublicKey);

      const payload = "test-payload";
      const signature = cryptoSign(null, Buffer.from(payload, "utf-8"), privateKey);
      const signatureBase64 = signature.toString("base64");

      expect(() =>
        verifyDeviceSignature({
          publicKeyBase64: wrongPublicKeyBase64,
          payload,
          signatureBase64,
        }),
      ).toThrow(DeviceSignatureError);
    });

    it("空签名抛 malformed_signature", () => {
      const { publicKey } = generateTestKeyPair();
      const publicKeyBase64 = extractRawPublicKeyBase64(publicKey);
      expect(() =>
        verifyDeviceSignature({
          publicKeyBase64,
          payload: "test",
          signatureBase64: "",
        }),
      ).toThrow(DeviceSignatureError);
    });

    it("公钥长度非 32 字节抛 signature_invalid", () => {
      expect(() =>
        verifyDeviceSignature({
          publicKeyBase64: Buffer.from("short").toString("base64"),
          payload: "test",
          signatureBase64: Buffer.from("sig").toString("base64"),
        }),
      ).toThrow(DeviceSignatureError);
    });
  });

  describe("assertDeviceValid", () => {
    it("active 设备 + 正确 userId 通过", () => {
      const device = {
        id: "d1",
        tenantId: "t1",
        userId: "u1",
        deviceKey: "dk1",
        publicKey: "pk",
        deviceName: "Dev",
        appVersion: "1.0",
        deviceState: "active" as const,
        lastActiveAt: new Date(),
        revokedAt: null,
        createdAt: new Date(),
      };
      expect(() => assertDeviceValid(device, "u1")).not.toThrow();
    });

    it("revoked 设备抛 device_revoked", () => {
      const device = {
        id: "d1",
        tenantId: "t1",
        userId: "u1",
        deviceKey: "dk1",
        publicKey: "pk",
        deviceName: "Dev",
        appVersion: "1.0",
        deviceState: "revoked" as const,
        lastActiveAt: new Date(),
        revokedAt: new Date(),
        createdAt: new Date(),
      };
      expect(() => assertDeviceValid(device, "u1")).toThrow(DeviceSignatureError);
      try {
        assertDeviceValid(device, "u1");
      } catch (e) {
        expect((e as DeviceSignatureError).code).toBe("device_revoked");
      }
    });

    it("owner 不匹配抛 device_owner_mismatch", () => {
      const device = {
        id: "d1",
        tenantId: "t1",
        userId: "u1",
        deviceKey: "dk1",
        publicKey: "pk",
        deviceName: "Dev",
        appVersion: "1.0",
        deviceState: "active" as const,
        lastActiveAt: new Date(),
        revokedAt: null,
        createdAt: new Date(),
      };
      expect(() => assertDeviceValid(device, "u2")).toThrow(DeviceSignatureError);
      try {
        assertDeviceValid(device, "u2");
      } catch (e) {
        expect((e as DeviceSignatureError).code).toBe("device_owner_mismatch");
      }
    });
  });

  describe("parseDesktopSignatureHeaders", () => {
    it("完整 + 时间窗口内的 header 解析成功", () => {
      const headers = new Headers();
      headers.set(DESKTOP_DEVICE_KEY_HEADER, "dev-key-1");
      headers.set(DESKTOP_SIGNATURE_HEADER, "sig");
      headers.set(DESKTOP_TIMESTAMP_HEADER, String(Date.now()));
      const info = parseDesktopSignatureHeaders(headers);
      expect(info.deviceKey).toBe("dev-key-1");
    });

    it("超窗口时间戳抛 timestamp_expired", () => {
      const headers = new Headers();
      headers.set(DESKTOP_DEVICE_KEY_HEADER, "dev-key-1");
      headers.set(DESKTOP_SIGNATURE_HEADER, "sig");
      headers.set(
        DESKTOP_TIMESTAMP_HEADER,
        String(Date.now() - DESKTOP_SIGNATURE_WINDOW_MS - 1000),
      );
      expect(() => parseDesktopSignatureHeaders(headers)).toThrow(DeviceSignatureError);
    });
  });
});

// ─── resolver（workload）──────────────────────────────────────

describe("V11 resolver（workload）", () => {
  it("resolveV11WorkloadPrincipal runtime token 解析成功", () => {
    const now = Date.now();
    const token = issueWorkloadToken({
      type: "runtime",
      tenantId: DEFAULT_TENANT_ID,
      invocationId: "inv-001",
      runtimeRevisionId: "rt-rev-001",
      audience: "runtime",
      expiresAt: now + 60000,
    });
    const headers = new Headers();
    headers.set("authorization", `Bearer ${token}`);

    const principal = resolveV11WorkloadPrincipal(headers, "runtime");
    expect(principal.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(principal.audience).toBe("runtime");
    expect(principal.callerType).toBe("workload");
    expect(principal.invocationId).toBe("inv-001");
    expect(principal.runtimeRevisionId).toBe("rt-rev-001");
    expect(principal.serviceId).toBeNull();
  });

  it("resolveV11WorkloadPrincipal gateway token 解析成功", () => {
    const now = Date.now();
    const token = issueWorkloadToken({
      type: "gateway",
      tenantId: DEFAULT_TENANT_ID,
      invocationId: "inv-002",
      audience: "gateway",
      expiresAt: now + 60000,
    });
    const headers = new Headers();
    headers.set("authorization", `Bearer ${token}`);

    const principal = resolveV11WorkloadPrincipal(headers, "gateway");
    expect(principal.audience).toBe("gateway");
    expect(principal.invocationId).toBe("inv-002");
    expect(principal.runtimeRevisionId).toBeNull();
  });

  it("resolveV11WorkloadPrincipal service token 解析成功", () => {
    const now = Date.now();
    const token = issueWorkloadToken({
      type: "service",
      tenantId: DEFAULT_TENANT_ID,
      audience: "admin",
      serviceId: "cicd",
      expiresAt: now + 60000,
    });
    const headers = new Headers();
    headers.set("authorization", `Bearer ${token}`);

    const principal = resolveV11WorkloadPrincipal(headers, "admin");
    expect(principal.audience).toBe("admin");
    expect(principal.callerType).toBe("service");
    expect(principal.serviceId).toBe("cicd");
    expect(principal.invocationId).toBeNull();
  });

  it("resolveV11WorkloadPrincipal 缺 token 抛 V11AuthError", () => {
    expect(() => resolveV11WorkloadPrincipal(new Headers(), "runtime")).toThrow(V11AuthError);
  });

  it("resolveV11WorkloadPrincipal audience 不匹配抛 WorkloadTokenError", () => {
    const now = Date.now();
    const token = issueWorkloadToken({
      type: "runtime",
      tenantId: DEFAULT_TENANT_ID,
      invocationId: "inv-001",
      runtimeRevisionId: "rt-rev-001",
      audience: "runtime",
      expiresAt: now + 60000,
    });
    const headers = new Headers();
    headers.set("authorization", `Bearer ${token}`);
    expect(() => resolveV11WorkloadPrincipal(headers, "gateway")).toThrow(WorkloadTokenError);
  });

  it("resolveV11WorkloadPrincipal 过期 token 抛 WorkloadTokenError", () => {
    const token = issueWorkloadToken({
      type: "runtime",
      tenantId: DEFAULT_TENANT_ID,
      invocationId: "inv-001",
      runtimeRevisionId: "rt-rev-001",
      audience: "runtime",
      expiresAt: Date.now() - 1000,
    });
    const headers = new Headers();
    headers.set("authorization", `Bearer ${token}`);
    expect(() => resolveV11WorkloadPrincipal(headers, "runtime")).toThrow(WorkloadTokenError);
  });
});
