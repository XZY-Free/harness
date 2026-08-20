/**
 * LeaseService 测试。
 */
import { DeviceRegistry } from "@/lib/desktop-bridge/device-registry";
import { type LeaseAcquireResult, LeaseService } from "@/lib/desktop-bridge/lease-service";
import { DEFAULT_LEASE_TTL_MS } from "@/lib/desktop/lease";
import { describe, expect, it } from "vitest";

const NOW = 1700000000000;
const TTL = DEFAULT_LEASE_TTL_MS;
const TENANT = "tenant-001";

function setup(): { registry: DeviceRegistry; lease: LeaseService; ws: object } {
  const registry = new DeviceRegistry();
  const lease = new LeaseService(registry);
  const ws = {};
  registry.register(ws, TENANT, "dev-001", "rec-001", "user-001", "server-pk");
  registry.markAuthenticated(ws);
  return { registry, lease, ws };
}

describe("LeaseService", () => {
  describe("acquireLease()", () => {
    it("设备在线且已认证时获取成功", () => {
      const { lease } = setup();
      const result = lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lease.threadId).toBe("thread-001");
        expect(result.lease.userId).toBe("user-001");
        expect(result.lease.deviceRecordId).toBe("rec-001");
        expect(result.lease.acquiredAt).toBe(NOW);
        expect(result.lease.expiresAt).toBe(NOW + TTL);
      }
    });

    it("设备离线时返回 desktop_unavailable", () => {
      const { registry, lease } = setup();
      // 用未注册的 deviceId
      const result = lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-002",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("desktop_unavailable");
      }
      // 注册表无变化
      expect(registry.size()).toBe(1);
    });

    it("设备未认证时返回 desktop_unauthorized", () => {
      const registry = new DeviceRegistry();
      const lease = new LeaseService(registry);
      const ws = {};
      registry.register(ws, TENANT, "dev-001", "rec-001", "user-001", "pk");
      // 不调用 markAuthenticated
      const result = lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("desktop_unauthorized");
      }
    });

    it("已有 lease 时其他设备获取返回 lease_held_by_other", () => {
      const { registry, lease } = setup();
      // 注册第二个设备
      const ws2 = {};
      registry.register(ws2, TENANT, "dev-002", "rec-002", "user-001", "pk");
      registry.markAuthenticated(ws2);
      // dev-001 先获取
      lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      // dev-002 尝试获取同一 thread
      const result = lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-002",
        now: NOW + 1000,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("lease_held_by_other");
      }
    });

    it("同一设备重新获取自己的 lease 成功（续期）", () => {
      const { lease } = setup();
      lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      const result = lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW + 1000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lease.acquiredAt).toBe(NOW + 1000);
      }
    });

    it("自定义 TTL 生效", () => {
      const { lease } = setup();
      const result = lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
        ttlMs: 10000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lease.expiresAt).toBe(NOW + 10000);
      }
    });

    it("userId 不匹配时返回 desktop_unauthorized", () => {
      const { lease } = setup();
      const result = lease.acquireLease({
        threadId: "thread-001",
        userId: "user-002",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("desktop_unauthorized");
      }
    });
  });

  describe("releaseLease()", () => {
    it("只有持有设备可以释放", () => {
      const { registry, lease } = setup();
      const ws2 = {};
      registry.register(ws2, TENANT, "dev-002", "rec-002", "user-001", "pk");
      registry.markAuthenticated(ws2);
      lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      // 非持有设备释放失败
      expect(lease.releaseLease("thread-001", "rec-002", NOW)).toBe(false);
      // 持有设备释放成功
      expect(lease.releaseLease("thread-001", "rec-001", NOW)).toBe(true);
      // lease 已释放
      expect(lease.getLeaseHolder("thread-001")).toBeNull();
    });

    it("不存在的 lease 释放返回 false", () => {
      const { lease } = setup();
      expect(lease.releaseLease("thread-001", "rec-001", NOW)).toBe(false);
    });
  });

  describe("holdsLease()", () => {
    it("持有设备返回 true", () => {
      const { lease } = setup();
      lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      expect(lease.holdsLease("thread-001", "rec-001", NOW)).toBe(true);
    });

    it("非持有设备返回 false", () => {
      const { lease } = setup();
      lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      expect(lease.holdsLease("thread-001", "rec-002", NOW)).toBe(false);
    });

    it("过期 lease 返回 false", () => {
      const { lease } = setup();
      lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
        ttlMs: 1000,
      });
      // NOW + 2000 时 lease 已过期
      expect(lease.holdsLease("thread-001", "rec-001", NOW + 2000)).toBe(false);
    });

    it("无 lease 返回 false", () => {
      const { lease } = setup();
      expect(lease.holdsLease("thread-001", "rec-001", NOW)).toBe(false);
    });
  });

  describe("getLeaseHolder()", () => {
    it("返回当前 lease 信息", () => {
      const { lease } = setup();
      lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      const holder = lease.getLeaseHolder("thread-001");
      expect(holder).not.toBeNull();
      expect(holder?.deviceRecordId).toBe("rec-001");
    });

    it("无 lease 返回 null", () => {
      const { lease } = setup();
      expect(lease.getLeaseHolder("thread-001")).toBeNull();
    });
  });

  describe("revokeLease()", () => {
    it("强制撤销成功", () => {
      const { lease } = setup();
      lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      expect(lease.revokeLease("thread-001")).toBe(true);
      expect(lease.getLeaseHolder("thread-001")).toBeNull();
    });

    it("撤销不存在的 lease 返回 false", () => {
      const { lease } = setup();
      expect(lease.revokeLease("thread-001")).toBe(false);
    });
  });

  describe("cleanupExpired()", () => {
    it("清理过期 lease", () => {
      const { lease } = setup();
      lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
        ttlMs: 1000,
      });
      lease.acquireLease({
        threadId: "thread-002",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
        ttlMs: 100000,
      });
      expect(lease.cleanupExpired(NOW + 2000)).toBe(1);
      expect(lease.getLeaseHolder("thread-001")).toBeNull();
      expect(lease.getLeaseHolder("thread-002")).not.toBeNull();
    });

    it("无过期返回 0", () => {
      const { lease } = setup();
      lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      expect(lease.cleanupExpired(NOW + 1000)).toBe(0);
    });
  });

  describe("LeaseAcquireResult 类型", () => {
    it("ok=true 时持有 lease 字段", () => {
      const { lease } = setup();
      const result: LeaseAcquireResult = lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lease).toBeDefined();
        // ok=true 分支不持有 code 字段（鉴别联合类型保证）
      }
    });

    it("ok=false 时持有 code 字段", () => {
      const { lease } = setup();
      const result: LeaseAcquireResult = lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-002",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBeDefined();
        // ok=false 分支不持有 lease 字段（鉴别联合类型保证）
      }
    });
  });

  describe("getActiveLeaseCount()", () => {
    it("无 lease 时返回 0", () => {
      const { lease } = setup();
      expect(lease.getActiveLeaseCount()).toBe(0);
    });

    it("获取 lease 后计数增加", () => {
      const { lease } = setup();
      lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      expect(lease.getActiveLeaseCount()).toBe(1);
      lease.acquireLease({
        threadId: "thread-002",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      expect(lease.getActiveLeaseCount()).toBe(2);
    });

    it("释放 lease 后计数减少", () => {
      const { lease } = setup();
      lease.acquireLease({
        threadId: "thread-001",
        userId: "user-001",
        deviceRecordId: "rec-001",
        now: NOW,
      });
      expect(lease.getActiveLeaseCount()).toBe(1);
      lease.releaseLease("thread-001", "rec-001", NOW);
      expect(lease.getActiveLeaseCount()).toBe(0);
    });
  });
});
