import { describe, expect, it } from "vitest";
import type { KeychainAdapter } from "../storage/keychain";
import {
  DEVICE_ID_KEY,
  clearDeviceIdentity,
  createDeviceIdentity,
  deserializeIdentity,
  loadDeviceIdentity,
  saveDeviceIdentity,
  serializeIdentity,
} from "./device-identity";

/**
 * 设备身份管理单元测试。
 *
 * 验证纯逻辑行为（使用真实 ed25519 密钥生成，禁止 mock crypto）：
 * - createDeviceIdentity 返回 UUID 格式 deviceId 和合法密钥对
 * - serializeIdentity/deserializeIdentity 往返一致
 * - loadDeviceIdentity 在 Keychain 无数据时返回 null
 * - saveDeviceIdentity + loadDeviceIdentity 往返一致
 * - 两次 createDeviceIdentity 生成的身份不同
 *
 * 测试使用内存实现的 KeychainAdapter，不 mock 加密本身。
 */

/** UUID v4 正则 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 内存 KeychainAdapter，用于测试 */
class MemoryKeychain implements KeychainAdapter {
  private store = new Map<string, string>();
  available = true;
  /** 故障注入：该 key 的下一次 set 调用在写入前抛错 */
  private failBeforeSetKey: string | null = null;

  /** 配置下一次对指定 key 的 set 在写入前失败（模拟持久化中途失败） */
  failBeforeSet(key: string): void {
    this.failBeforeSetKey = key;
  }

  async set(key: string, value: string): Promise<void> {
    if (this.failBeforeSetKey === key) {
      this.failBeforeSetKey = null;
      throw new Error(`injected keychain set failure for key: ${key}`);
    }
    this.store.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  isAvailable(): boolean {
    return this.available;
  }
}

describe("device-identity", () => {
  describe("createDeviceIdentity", () => {
    it("返回 UUID 格式的 deviceId", () => {
      const identity = createDeviceIdentity();
      expect(identity.deviceId).toMatch(UUID_V4_REGEX);
    });

    it("返回非空 ed25519 密钥对", () => {
      const identity = createDeviceIdentity();
      expect(typeof identity.keyPair.publicKeyBase64).toBe("string");
      expect(typeof identity.keyPair.privateKeyBase64).toBe("string");
      expect(identity.keyPair.publicKeyBase64.length).toBeGreaterThan(0);
      expect(identity.keyPair.privateKeyBase64.length).toBeGreaterThan(0);
    });

    it("公钥解码后为 32 字节（ed25519 raw）", () => {
      const identity = createDeviceIdentity();
      const raw = Buffer.from(identity.keyPair.publicKeyBase64, "base64");
      expect(raw.length).toBe(32);
    });

    it("公钥与私钥不同", () => {
      const identity = createDeviceIdentity();
      expect(identity.keyPair.publicKeyBase64).not.toBe(identity.keyPair.privateKeyBase64);
    });

    it("两次生成身份不同", () => {
      const a = createDeviceIdentity();
      const b = createDeviceIdentity();
      expect(a.deviceId).not.toBe(b.deviceId);
      expect(a.keyPair.publicKeyBase64).not.toBe(b.keyPair.publicKeyBase64);
      expect(a.keyPair.privateKeyBase64).not.toBe(b.keyPair.privateKeyBase64);
    });
  });

  describe("serializeIdentity / deserializeIdentity", () => {
    it("往返一致", () => {
      const identity = createDeviceIdentity();
      const json = serializeIdentity(identity);
      const restored = deserializeIdentity(json);
      expect(restored).not.toBeNull();
      expect(restored?.deviceId).toBe(identity.deviceId);
      expect(restored?.keyPair.publicKeyBase64).toBe(identity.keyPair.publicKeyBase64);
      expect(restored?.keyPair.privateKeyBase64).toBe(identity.keyPair.privateKeyBase64);
      expect(restored?.tenantId).toBe(identity.tenantId);
    });

    it("tenantId 序列化往返保留（注册后回填）", () => {
      const identity = createDeviceIdentity();
      identity.tenantId = "tenant-abc";
      const restored = deserializeIdentity(serializeIdentity(identity));
      expect(restored?.tenantId).toBe("tenant-abc");
    });

    it("缺 tenantId（undefined）拒绝加载，返回 null", () => {
      const identity = createDeviceIdentity();
      const obj = JSON.parse(serializeIdentity(identity));
      // 置为 undefined 模拟缺失 tenantId（JSON.stringify 会丢弃 undefined 键）
      obj.tenantId = undefined;
      const restored = deserializeIdentity(JSON.stringify(obj));
      // 身份没有显式 tenantId，不允许当作 null——调用方据此生成新身份重新注册
      expect(restored).toBeNull();
    });

    it("tenantId 为 null 时合法（未注册身份）", () => {
      const identity = createDeviceIdentity();
      const obj = JSON.parse(serializeIdentity(identity));
      obj.tenantId = null;
      const restored = deserializeIdentity(JSON.stringify(obj));
      expect(restored).not.toBeNull();
      expect(restored?.tenantId).toBeNull();
    });

    it("tenantId 空字符串返回 null（非空合法值）", () => {
      const identity = createDeviceIdentity();
      const obj = JSON.parse(serializeIdentity(identity));
      obj.tenantId = "";
      expect(deserializeIdentity(JSON.stringify(obj))).toBeNull();
    });

    it("tenantId 非字符串类型返回 null（严格校验）", () => {
      const identity = createDeviceIdentity();
      const obj = JSON.parse(serializeIdentity(identity));
      obj.tenantId = 12345;
      expect(deserializeIdentity(JSON.stringify(obj))).toBeNull();
    });

    it("serializeIdentity 返回合法 JSON 字符串", () => {
      const identity = createDeviceIdentity();
      const json = serializeIdentity(identity);
      expect(typeof json).toBe("string");
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it("deserializeIdentity 非法 JSON 返回 null", () => {
      expect(deserializeIdentity("not-json")).toBeNull();
    });

    it("deserializeIdentity 缺少 deviceId 返回 null", () => {
      const identity = createDeviceIdentity();
      const obj = JSON.parse(serializeIdentity(identity));
      obj.deviceId = undefined;
      expect(deserializeIdentity(JSON.stringify(obj))).toBeNull();
    });

    it("deserializeIdentity 缺少 keyPair 返回 null", () => {
      const identity = createDeviceIdentity();
      const obj = JSON.parse(serializeIdentity(identity));
      obj.keyPair = undefined;
      expect(deserializeIdentity(JSON.stringify(obj))).toBeNull();
    });

    it("deserializeIdentity keyPair 缺少 publicKeyBase64 返回 null", () => {
      const identity = createDeviceIdentity();
      const obj = JSON.parse(serializeIdentity(identity));
      obj.keyPair.publicKeyBase64 = undefined;
      expect(deserializeIdentity(JSON.stringify(obj))).toBeNull();
    });

    it("deserializeIdentity 字段类型错误返回 null", () => {
      expect(
        deserializeIdentity(
          JSON.stringify({
            deviceId: 123,
            keyPair: { publicKeyBase64: "x", privateKeyBase64: "y" },
          }),
        ),
      ).toBeNull();
    });
  });

  describe("loadDeviceIdentity", () => {
    it("Keychain 无数据返回 null", async () => {
      const kc = new MemoryKeychain();
      const identity = await loadDeviceIdentity(kc);
      expect(identity).toBeNull();
    });

    it("Keychain 有数据返回身份", async () => {
      const kc = new MemoryKeychain();
      const original = createDeviceIdentity();
      await saveDeviceIdentity(kc, original);

      const loaded = await loadDeviceIdentity(kc);
      expect(loaded).not.toBeNull();
      expect(loaded?.deviceId).toBe(original.deviceId);
      expect(loaded?.keyPair.publicKeyBase64).toBe(original.keyPair.publicKeyBase64);
    });
  });

  describe("saveDeviceIdentity + loadDeviceIdentity", () => {
    it("往返一致", async () => {
      const kc = new MemoryKeychain();
      const original = createDeviceIdentity();
      await saveDeviceIdentity(kc, original);

      const loaded = await loadDeviceIdentity(kc);
      expect(loaded).not.toBeNull();
      expect(loaded?.deviceId).toBe(original.deviceId);
      expect(loaded?.keyPair.publicKeyBase64).toBe(original.keyPair.publicKeyBase64);
      expect(loaded?.keyPair.privateKeyBase64).toBe(original.keyPair.privateKeyBase64);
    });

    it("保存后密钥仍可用于签名验证", async () => {
      const kc = new MemoryKeychain();
      const original = createDeviceIdentity();
      await saveDeviceIdentity(kc, original);

      const loaded = await loadDeviceIdentity(kc);
      expect(loaded).not.toBeNull();
      // 已断言非空，guard 用于 TypeScript 类型收窄（避免非空断言）
      if (loaded === null) return;

      // 使用 node:crypto 验证密钥对的可用性
      const { createPrivateKey, sign, verify } = await import("node:crypto");
      const der = Buffer.from(loaded.keyPair.privateKeyBase64, "base64");
      const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      const data = Buffer.from("challenge-value", "utf8");
      const signature = sign(null, data, privateKey);

      const rawPub = Buffer.from(loaded.keyPair.publicKeyBase64, "base64");
      const x = rawPub.toString("base64url");
      const publicKey = (await import("node:crypto")).createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x },
        format: "jwk",
      });
      expect(verify(null, data, publicKey, signature)).toBe(true);
    });

    it("覆盖保存后加载得到最新身份", async () => {
      const kc = new MemoryKeychain();
      const first = createDeviceIdentity();
      const second = createDeviceIdentity();
      await saveDeviceIdentity(kc, first);
      await saveDeviceIdentity(kc, second);

      const loaded = await loadDeviceIdentity(kc);
      expect(loaded?.deviceId).toBe(second.deviceId);
      expect(loaded?.deviceId).not.toBe(first.deviceId);
    });
  });

  describe("clearDeviceIdentity()", () => {
    it("清除后 loadDeviceIdentity 返回 null", async () => {
      const kc = new MemoryKeychain();
      const identity = createDeviceIdentity();
      await saveDeviceIdentity(kc, identity);
      expect(await loadDeviceIdentity(kc)).not.toBeNull();

      await clearDeviceIdentity(kc);

      expect(await loadDeviceIdentity(kc)).toBeNull();
    });

    it("未保存时调用不抛错（幂等）", async () => {
      const kc = new MemoryKeychain();
      await expect(clearDeviceIdentity(kc)).resolves.toBeUndefined();
    });

    it("清除后可重新保存新身份", async () => {
      const kc = new MemoryKeychain();
      const first = createDeviceIdentity();
      await saveDeviceIdentity(kc, first);
      await clearDeviceIdentity(kc);

      const second = createDeviceIdentity();
      await saveDeviceIdentity(kc, second);

      const loaded = await loadDeviceIdentity(kc);
      expect(loaded?.deviceId).toBe(second.deviceId);
      expect(loaded?.deviceId).not.toBe(first.deviceId);
    });

    it("第二次 set 失败后 loadDeviceIdentity 不应观察到新 tenantId", async () => {
      const kc = new MemoryKeychain();
      // 首次真实保存 tenantId=null 的初始身份
      const identity = createDeviceIdentity();
      expect(identity.tenantId).toBeNull();
      await saveDeviceIdentity(kc, identity);

      // 模拟注册：回填 tenantId
      identity.tenantId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

      // 故障注入：下一次 saveDeviceIdentity 的第二个 set（写入 device-id）在写入前失败
      kc.failBeforeSet(DEVICE_ID_KEY);

      // 保存必须抛错
      await expect(saveDeviceIdentity(kc, identity)).rejects.toThrow();

      // 真实 loadDeviceIdentity 必须仍是旧 tenantId=null，而非新租户
      const loaded = await loadDeviceIdentity(kc);
      expect(loaded?.deviceId).toBe(identity.deviceId);
      expect(loaded?.tenantId).toBeNull();
    });
  });
});
