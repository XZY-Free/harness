/**
 * RunnerSigningIdentityRegistry 单元测试。
 *
 * 覆盖：
 * - Key-Identity 绑定校验
 * - 租户范围校验
 * - 有效期校验
 * - 撤销状态校验
 * - Key 轮换支持
 * - getActivePublicKeys 过滤
 */
import { describe, expect, it } from "vitest";
import {
  type RunnerSigningIdentity,
  RunnerSigningIdentityRegistry,
} from "./runner-signing-identity";

const NOW = new Date("2026-08-01T00:00:00.000Z");

function makeEntry(overrides: Partial<RunnerSigningIdentity> = {}): RunnerSigningIdentity {
  return {
    keyId: "runner-key-1",
    publicKey: "base64key1",
    runnerIdentity: "ci/hosted-conformance",
    tenantScope: null,
    validFrom: "2020-01-01T00:00:00.000Z",
    validUntil: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("RunnerSigningIdentityRegistry", () => {
  describe("constructor", () => {
    it("同一 keyId 使用不同 publicKey 时拒绝构建注册表", () => {
      expect(
        () =>
          new RunnerSigningIdentityRegistry([
            makeEntry({ keyId: "key-a", publicKey: "pk-a", runnerIdentity: "runner-1" }),
            makeEntry({ keyId: "key-a", publicKey: "pk-b", runnerIdentity: "runner-2" }),
          ]),
      ).toThrow("runner_key_public_key_conflict:key-a");
    });

    it("同一 keyId 与 publicKey 可包含多条显式 Runner 和租户授权", () => {
      const registry = new RunnerSigningIdentityRegistry([
        makeEntry({
          keyId: "key-a",
          publicKey: "pk-a",
          runnerIdentity: "runner-1",
          tenantScope: "tenant-1",
        }),
        makeEntry({
          keyId: "key-a",
          publicKey: "pk-a",
          runnerIdentity: "runner-2",
          tenantScope: "tenant-2",
        }),
      ]);

      expect(
        registry.validate({
          keyId: "key-a",
          runnerIdentity: "runner-1",
          tenantId: "tenant-1",
          now: NOW,
        }).ok,
      ).toBe(true);
      expect(
        registry.validate({
          keyId: "key-a",
          runnerIdentity: "runner-2",
          tenantId: "tenant-2",
          now: NOW,
        }).ok,
      ).toBe(true);
    });
  });

  describe("validate", () => {
    it("Key-Identity 绑定匹配 → 校验通过", () => {
      const registry = new RunnerSigningIdentityRegistry([
        makeEntry({ keyId: "key-a", runnerIdentity: "runner-1" }),
      ]);
      const result = registry.validate({
        keyId: "key-a",
        runnerIdentity: "runner-1",
        tenantId: "t1",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.entry.keyId).toBe("key-a");
        expect(result.entry.runnerIdentity).toBe("runner-1");
      }
    });

    it("Key A 声明 Runner B → runner_key_identity_mismatch", () => {
      const registry = new RunnerSigningIdentityRegistry([
        makeEntry({ keyId: "key-a", runnerIdentity: "runner-1" }),
      ]);
      const result = registry.validate({
        keyId: "key-a",
        runnerIdentity: "runner-2", // 不同 identity
        tenantId: "t1",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failureReason).toBe("runner_key_identity_mismatch");
    });

    it("未注册的 Key → runner_key_not_registered", () => {
      const registry = new RunnerSigningIdentityRegistry([
        makeEntry({ keyId: "key-a", runnerIdentity: "runner-1" }),
      ]);
      const result = registry.validate({
        keyId: "key-unknown",
        runnerIdentity: "runner-1",
        tenantId: "t1",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failureReason).toBe("runner_key_not_registered");
    });

    it("跨租户 Key → runner_key_cross_tenant", () => {
      const registry = new RunnerSigningIdentityRegistry([
        makeEntry({ keyId: "key-a", runnerIdentity: "runner-1", tenantScope: "t1" }),
      ]);
      const result = registry.validate({
        keyId: "key-a",
        runnerIdentity: "runner-1",
        tenantId: "t2", // 不同租户
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failureReason).toBe("runner_key_cross_tenant");
    });

    it("全局授权（tenantScope=null）→ 任何租户通过", () => {
      const registry = new RunnerSigningIdentityRegistry([
        makeEntry({ keyId: "key-a", runnerIdentity: "runner-1", tenantScope: null }),
      ]);
      const result = registry.validate({
        keyId: "key-a",
        runnerIdentity: "runner-1",
        tenantId: "any-tenant",
        now: NOW,
      });
      expect(result.ok).toBe(true);
    });

    it("已撤销 Key → runner_key_revoked", () => {
      const registry = new RunnerSigningIdentityRegistry([
        makeEntry({
          keyId: "key-a",
          runnerIdentity: "runner-1",
          revokedAt: "2026-01-01T00:00:00.000Z",
        }),
      ]);
      const result = registry.validate({
        keyId: "key-a",
        runnerIdentity: "runner-1",
        tenantId: "t1",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failureReason).toBe("runner_key_revoked");
    });

    it("过期 Key → runner_key_expired", () => {
      const registry = new RunnerSigningIdentityRegistry([
        makeEntry({
          keyId: "key-a",
          runnerIdentity: "runner-1",
          validUntil: "2025-12-31T23:59:59.000Z",
        }),
      ]);
      const result = registry.validate({
        keyId: "key-a",
        runnerIdentity: "runner-1",
        tenantId: "t1",
        now: NOW, // 2026-08-01 > 2025-12-31
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failureReason).toBe("runner_key_expired");
    });

    it("尚未生效 Key → runner_key_expired", () => {
      const registry = new RunnerSigningIdentityRegistry([
        makeEntry({
          keyId: "key-a",
          runnerIdentity: "runner-1",
          validFrom: "2027-01-01T00:00:00.000Z",
        }),
      ]);
      const result = registry.validate({
        keyId: "key-a",
        runnerIdentity: "runner-1",
        tenantId: "t1",
        now: NOW, // 2026-08-01 < 2027-01-01
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failureReason).toBe("runner_key_expired");
    });

    it("同一 Runner 合法轮换 Key → 成功", () => {
      const registry = new RunnerSigningIdentityRegistry([
        makeEntry({
          keyId: "key-old",
          runnerIdentity: "runner-1",
          validUntil: "2026-06-30T23:59:59.000Z",
        }),
        makeEntry({
          keyId: "key-new",
          runnerIdentity: "runner-1",
          validFrom: "2026-07-01T00:00:00.000Z",
        }),
      ]);
      // 用新 Key 验证
      const result = registry.validate({
        keyId: "key-new",
        runnerIdentity: "runner-1",
        tenantId: "t1",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.entry.keyId).toBe("key-new");
    });

    it("同一 Key 不可跨 Runner（不同 identity 匹配失败）", () => {
      const registry = new RunnerSigningIdentityRegistry([
        makeEntry({ keyId: "key-a", runnerIdentity: "runner-1" }),
        // key-a 只绑定 runner-1，不绑定 runner-2
      ]);
      const result = registry.validate({
        keyId: "key-a",
        runnerIdentity: "runner-2",
        tenantId: "t1",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failureReason).toBe("runner_key_identity_mismatch");
    });
  });

  describe("getActivePublicKeys", () => {
    it("仅返回未撤销且在有效期内的公钥", () => {
      const registry = new RunnerSigningIdentityRegistry([
        makeEntry({ keyId: "key-active", publicKey: "pk-active" }),
        makeEntry({
          keyId: "key-revoked",
          publicKey: "pk-revoked",
          revokedAt: "2026-01-01T00:00:00.000Z",
        }),
        makeEntry({
          keyId: "key-expired",
          publicKey: "pk-expired",
          validUntil: "2025-12-31T23:59:59.000Z",
        }),
        makeEntry({
          keyId: "key-future",
          publicKey: "pk-future",
          validFrom: "2027-01-01T00:00:00.000Z",
        }),
      ]);
      const keys = registry.getActivePublicKeys(NOW);
      expect(keys).toEqual({ "key-active": "pk-active" });
    });

    it("空注册表返回空对象", () => {
      const registry = new RunnerSigningIdentityRegistry([]);
      expect(registry.getActivePublicKeys(NOW)).toEqual({});
    });
  });
});
