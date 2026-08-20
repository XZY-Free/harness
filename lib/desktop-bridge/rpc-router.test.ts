/**
 * rpc-router 测试。
 */
import { DeviceRegistry } from "@/lib/desktop-bridge/device-registry";
import { LeaseService } from "@/lib/desktop-bridge/lease-service";
import { routeRpc } from "@/lib/desktop-bridge/rpc-router";
import { describe, expect, it } from "vitest";

const NOW = 1700000000000;
const TENANT = "tenant-001";

function setup(): { registry: DeviceRegistry; lease: LeaseService; ws: object } {
  const registry = new DeviceRegistry();
  const lease = new LeaseService(registry);
  const ws = {};
  registry.register(ws, TENANT, "dev-001", "rec-001", "user-001", "server-pk");
  registry.markAuthenticated(ws);
  return { registry, lease, ws };
}

describe("routeRpc()", () => {
  it("无 lease 时返回 desktop_unavailable", () => {
    const { registry, lease } = setup();
    const result = routeRpc({
      registry,
      leaseService: lease,
      userId: "user-001",
      threadId: "thread-001",
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("desktop_unavailable");
    }
  });

  it("lease 过期时返回 desktop_unavailable", () => {
    const { registry, lease } = setup();
    lease.acquireLease({
      threadId: "thread-001",
      userId: "user-001",
      deviceRecordId: "rec-001",
      now: NOW,
      ttlMs: 1000,
    });
    // NOW + 2000 时 lease 已过期
    const result = routeRpc({
      registry,
      leaseService: lease,
      userId: "user-001",
      threadId: "thread-001",
      now: NOW + 2000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("desktop_unavailable");
    }
  });

  it("userId 不匹配时返回 desktop_unauthorized", () => {
    const { registry, lease } = setup();
    lease.acquireLease({
      threadId: "thread-001",
      userId: "user-001",
      deviceRecordId: "rec-001",
      now: NOW,
    });
    const result = routeRpc({
      registry,
      leaseService: lease,
      userId: "user-002",
      threadId: "thread-001",
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("desktop_unauthorized");
    }
  });

  it("设备离线时返回 desktop_disconnected", () => {
    const { registry, lease, ws } = setup();
    lease.acquireLease({
      threadId: "thread-001",
      userId: "user-001",
      deviceRecordId: "rec-001",
      now: NOW,
    });
    // 移除设备模拟离线
    registry.remove(ws);
    const result = routeRpc({
      registry,
      leaseService: lease,
      userId: "user-001",
      threadId: "thread-001",
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("desktop_disconnected");
    }
  });

  it("设备未认证时返回 desktop_unauthorized", () => {
    // 构造场景：lease 持有设备，但 registry 中设备 authenticated=false。
    // 由于 LeaseService.acquireLease 拒绝未认证设备，需要绕过：
    // 先认证 → 获取 lease → 重新注册同一 ws 使 authenticated=false（覆盖旧设备）。
    const registry = new DeviceRegistry();
    const lease = new LeaseService(registry);
    const ws = {};
    registry.register(ws, TENANT, "dev-001", "rec-001", "user-001", "pk");
    registry.markAuthenticated(ws);
    lease.acquireLease({
      threadId: "thread-001",
      userId: "user-001",
      deviceRecordId: "rec-001",
      now: NOW,
    });
    // 重新注册使 authenticated=false
    registry.register(ws, TENANT, "dev-001", "rec-001", "user-001", "pk");
    const result = routeRpc({
      registry,
      leaseService: lease,
      userId: "user-001",
      threadId: "thread-001",
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("desktop_unauthorized");
    }
  });

  it("一切正常时返回内部 deviceRecordId / 外部 deviceKey / ws", () => {
    const { registry, lease, ws } = setup();
    lease.acquireLease({
      threadId: "thread-001",
      userId: "user-001",
      deviceRecordId: "rec-001",
      now: NOW,
    });
    const result = routeRpc({
      registry,
      leaseService: lease,
      userId: "user-001",
      threadId: "thread-001",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deviceRecordId).toBe("rec-001");
      expect(result.deviceKey).toBe("dev-001");
      expect(result.ws).toBe(ws);
    }
  });

  it("lease 持有设备 userId 与请求 userId 不匹配返回 desktop_unauthorized", () => {
    // acquireLease 会校验设备 userId，正常情况下 lease.userId 与请求 userId 一致；
    // 这里直接以 user-002 请求 user-001 持有的 lease，router 必须拒绝。
    const { registry, lease } = setup();
    lease.acquireLease({
      threadId: "thread-001",
      userId: "user-001",
      deviceRecordId: "rec-001",
      now: NOW,
    });
    const result = routeRpc({
      registry,
      leaseService: lease,
      userId: "user-002",
      threadId: "thread-001",
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("desktop_unauthorized");
    }
  });

  it("跨租户相同 deviceKey 同时在线并分别持有不同 thread lease，各自路由互不串扰", () => {
    const registry = new DeviceRegistry();
    const lease = new LeaseService(registry);
    const wsA = {};
    const wsB = {};
    // 租户 A 与租户 B 使用相同的 deviceKey "shared-dev"，各自在线（内部 deviceRecordId 不同）
    registry.register(wsA, "tenant-A", "shared-dev", "rec-A", "user-A", "pk");
    registry.markAuthenticated(wsA);
    registry.register(wsB, "tenant-B", "shared-dev", "rec-B", "user-B", "pk");
    registry.markAuthenticated(wsB);
    // 各自持有不同 thread 的 lease
    lease.acquireLease({
      threadId: "thread-A",
      userId: "user-A",
      deviceRecordId: "rec-A",
      now: NOW,
    });
    lease.acquireLease({
      threadId: "thread-B",
      userId: "user-B",
      deviceRecordId: "rec-B",
      now: NOW,
    });
    // A 的路由命中 rec-A（内部 Device.id），外部 deviceKey 仍是 "shared-dev"
    const resultA = routeRpc({
      registry,
      leaseService: lease,
      userId: "user-A",
      threadId: "thread-A",
      now: NOW,
    });
    expect(resultA.ok).toBe(true);
    if (resultA.ok) {
      expect(resultA.deviceRecordId).toBe("rec-A");
      expect(resultA.deviceKey).toBe("shared-dev");
      expect(resultA.ws).toBe(wsA);
    }
    // B 的路由命中 rec-B
    const resultB = routeRpc({
      registry,
      leaseService: lease,
      userId: "user-B",
      threadId: "thread-B",
      now: NOW,
    });
    expect(resultB.ok).toBe(true);
    if (resultB.ok) {
      expect(resultB.deviceRecordId).toBe("rec-B");
      expect(resultB.deviceKey).toBe("shared-dev");
      expect(resultB.ws).toBe(wsB);
    }
    // 反查验证：同一复合键在两个租户各自在线，size=2
    expect(registry.size()).toBe(2);
  });
});
