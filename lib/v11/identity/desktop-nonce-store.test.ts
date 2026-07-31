import {
  DesktopNonceError,
  assertNonceNotReplayed,
  clearDesktopNonceStore,
  gc,
  isNonceUsed,
} from "@/lib/v11/identity/desktop-nonce-store";
/**
 * S12-W05：V11 Desktop 签名 Nonce 重放保护单元测试。
 *
 * 覆盖：
 * - assertNonceNotReplayed：首次写入 / 重复抛 nonce_replayed / 空 nonce / 过短 nonce。
 * - isNonceUsed：查询逻辑。
 * - gc：清理过期 nonce。
 * - clearDesktopNonceStore：清空。
 */
import { DESKTOP_SIGNATURE_WINDOW_MS } from "@/lib/v11/identity/device-signature";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  clearDesktopNonceStore();
});

// ─── assertNonceNotReplayed ─────────────────────────────────

describe("V11 assertNonceNotReplayed", () => {
  it("首次 nonce 不抛错并写入存储", () => {
    const now = Date.now();
    expect(() => assertNonceNotReplayed("dev-1", "abcdefgh1234", now)).not.toThrow();
    expect(isNonceUsed("dev-1", "abcdefgh1234")).toBe(true);
  });

  it("同一 (deviceKey, nonce) 重复使用 → nonce_replayed", () => {
    const now = Date.now();
    assertNonceNotReplayed("dev-1", "nonce-unique-1", now);
    expect(() => assertNonceNotReplayed("dev-1", "nonce-unique-1", now)).toThrow(DesktopNonceError);
    try {
      assertNonceNotReplayed("dev-1", "nonce-unique-1", now);
    } catch (e) {
      expect((e as DesktopNonceError).code).toBe("nonce_replayed");
    }
  });

  it("不同 deviceKey 同一 nonce 不冲突", () => {
    const now = Date.now();
    assertNonceNotReplayed("dev-1", "shared-nonce-1234", now);
    expect(() => assertNonceNotReplayed("dev-2", "shared-nonce-1234", now)).not.toThrow();
  });

  it("空 nonce → missing_nonce", () => {
    expect(() => assertNonceNotReplayed("dev-1", "", Date.now())).toThrow(DesktopNonceError);
    try {
      assertNonceNotReplayed("dev-1", "", Date.now());
    } catch (e) {
      expect((e as DesktopNonceError).code).toBe("missing_nonce");
    }
  });

  it("过短 nonce（< 8 字符）→ nonce_too_short", () => {
    expect(() => assertNonceNotReplayed("dev-1", "short", Date.now())).toThrow(DesktopNonceError);
    try {
      assertNonceNotReplayed("dev-1", "short", Date.now());
    } catch (e) {
      expect((e as DesktopNonceError).code).toBe("nonce_too_short");
    }
  });

  it("8 字符 nonce 是边界（通过）", () => {
    expect(() => assertNonceNotReplayed("dev-1", "12345678", Date.now())).not.toThrow();
  });

  it("DesktopNonceError 携带 name 字段", () => {
    try {
      assertNonceNotReplayed("dev-1", "", Date.now());
      throw new Error("应抛错");
    } catch (e) {
      expect((e as DesktopNonceError).name).toBe("DesktopNonceError");
    }
  });
});

// ─── isNonceUsed ────────────────────────────────────────────

describe("V11 isNonceUsed", () => {
  it("未写入的 nonce → false", () => {
    expect(isNonceUsed("dev-1", "never-used-nonce")).toBe(false);
  });

  it("已写入的 nonce → true", () => {
    const now = Date.now();
    assertNonceNotReplayed("dev-1", "used-nonce-1234", now);
    expect(isNonceUsed("dev-1", "used-nonce-1234")).toBe(true);
  });

  it("不同 deviceKey 的 nonce → false", () => {
    const now = Date.now();
    assertNonceNotReplayed("dev-1", "dev1-nonce-1234", now);
    expect(isNonceUsed("dev-2", "dev1-nonce-1234")).toBe(false);
  });
});

// ─── gc ─────────────────────────────────────────────────────

describe("V11 gc", () => {
  it("清理过期 nonce（按设备桶）", () => {
    const now = Date.now();
    // TTL = timestamp + DESKTOP_SIGNATURE_WINDOW_MS * 2
    const oldTimestamp = now - DESKTOP_SIGNATURE_WINDOW_MS * 3;
    assertNonceNotReplayed("dev-1", "old-nonce-12345", oldTimestamp);
    // 已过期的 nonce：isNonceUsed 返回 false（expiresAt 已过），但记录仍在 store 中等待 GC

    // 手动触发 GC（传入 now）→ 清理过期记录
    const removed = gc(now);
    expect(removed).toBeGreaterThan(0);
    expect(isNonceUsed("dev-1", "old-nonce-12345")).toBe(false);
  });

  it("未过期的 nonce 不被清理", () => {
    const now = Date.now();
    const freshTimestamp = now;
    assertNonceNotReplayed("dev-1", "fresh-nonce-12", freshTimestamp);
    gc(now);
    expect(isNonceUsed("dev-1", "fresh-nonce-12")).toBe(true);
  });

  it("空 bucket 在 GC 后被删除", () => {
    const now = Date.now();
    const oldTimestamp = now - DESKTOP_SIGNATURE_WINDOW_MS * 3;
    assertNonceNotReplayed("dev-1", "old-nonce-12345", oldTimestamp);
    gc(now);
    // dev-1 bucket 应被删除（无剩余 nonce）
    // 验证方式：再次写入同 deviceKey 不应报重放
    expect(() => assertNonceNotReplayed("dev-1", "new-nonce-1234", now)).not.toThrow();
  });
});

// ─── clearDesktopNonceStore ─────────────────────────────────

describe("V11 clearDesktopNonceStore", () => {
  it("清空后所有 nonce 均可用", () => {
    const now = Date.now();
    assertNonceNotReplayed("dev-1", "clearable-nonce", now);
    expect(isNonceUsed("dev-1", "clearable-nonce")).toBe(true);

    clearDesktopNonceStore();

    expect(isNonceUsed("dev-1", "clearable-nonce")).toBe(false);
    expect(() => assertNonceNotReplayed("dev-1", "clearable-nonce", now)).not.toThrow();
  });
});
