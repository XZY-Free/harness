/**
 * DeviceRegistry 测试。
 */
import { type ConnectedDevice, DeviceRegistry } from "@/lib/desktop-bridge/device-registry";
import { describe, expect, it } from "vitest";

const NOW = 1700000000000;
const TENANT = "tenant-001";

// WebSocket 实例用简单对象模拟（registry 不依赖 ws 类型，按引用标识）
function makeWs(tag = "ws"): object {
  return { tag };
}

describe("DeviceRegistry", () => {
  describe("register() + getByWs()", () => {
    it("注册后可按 ws 查到", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      const dev = r.register(ws, TENANT, "dev-001", "rec-001", "user-001", "server-pk");
      expect(dev.deviceKey).toBe("dev-001");
      expect(dev.deviceRecordId).toBe("rec-001");
      expect(dev.userId).toBe("user-001");
      expect(dev.authenticated).toBe(false);
      expect(dev.connectedAt).toBeGreaterThan(0);
      expect(dev.lastHeartbeat).toBe(dev.connectedAt);
      expect(dev.serverPublicKeyBase64).toBe("server-pk");
      expect(r.getByWs(ws)).toBe(dev);
    });

    it("未注册的 ws 返回 null", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      expect(r.getByWs(ws)).toBeNull();
    });
  });

  describe("getByDeviceRecordId()（Device.id 内部定位）", () => {
    it("注册后可按 deviceRecordId 查到", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      r.register(ws, TENANT, "dev-001", "rec-001", "user-001", "server-pk");
      const dev = r.getByDeviceRecordId("rec-001");
      expect(dev).not.toBeNull();
      expect(dev?.deviceRecordId).toBe("rec-001");
    });

    it("未注册的 deviceRecordId 返回 null", () => {
      const r = new DeviceRegistry();
      expect(r.getByDeviceRecordId("rec-001")).toBeNull();
    });
  });

  describe("getByUserId()", () => {
    it("返回用户的所有在线设备", () => {
      const r = new DeviceRegistry();
      r.register(makeWs("a"), TENANT, "dev-001", "rec-001", "user-001", "pk");
      r.register(makeWs("b"), TENANT, "dev-002", "rec-002", "user-001", "pk");
      r.register(makeWs("c"), TENANT, "dev-003", "rec-003", "user-002", "pk");
      const list = r.getByUserId("user-001");
      expect(list.length).toBe(2);
      expect(list.map((d) => d.deviceKey).sort()).toEqual(["dev-001", "dev-002"]);
    });

    it("无在线设备返回空数组", () => {
      const r = new DeviceRegistry();
      expect(r.getByUserId("user-001")).toEqual([]);
    });
  });

  describe("markAuthenticated()", () => {
    it("注册后 authenticated=false，标记后变 true", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      r.register(ws, TENANT, "dev-001", "rec-001", "user-001", "pk");
      expect(r.getByWs(ws)?.authenticated).toBe(false);
      expect(r.markAuthenticated(ws)).toBe(true);
      expect(r.getByWs(ws)?.authenticated).toBe(true);
    });

    it("未注册的 ws 标记失败返回 false", () => {
      const r = new DeviceRegistry();
      expect(r.markAuthenticated(makeWs())).toBe(false);
    });
  });

  describe("updateHeartbeat()", () => {
    it("更新心跳时间", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      r.register(ws, TENANT, "dev-001", "rec-001", "user-001", "pk");
      const result = r.updateHeartbeat(ws, NOW + 5000);
      expect(result).toBe(true);
      expect(r.getByWs(ws)?.lastHeartbeat).toBe(NOW + 5000);
    });

    it("未注册的 ws 更新失败返回 false", () => {
      const r = new DeviceRegistry();
      expect(r.updateHeartbeat(makeWs(), NOW)).toBe(false);
    });
  });

  describe("remove()", () => {
    it("移除后从所有索引消失", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      const dev = r.register(ws, TENANT, "dev-001", "rec-001", "user-001", "pk");
      const removed = r.remove(ws);
      expect(removed).toBe(dev);
      expect(r.getByWs(ws)).toBeNull();
      expect(r.getByDeviceRecordId("rec-001")).toBeNull();
      expect(r.getByKey(TENANT, "dev-001")).toBeNull();
    });

    it("移除未注册的 ws 返回 null", () => {
      const r = new DeviceRegistry();
      expect(r.remove(makeWs())).toBeNull();
    });
  });

  describe("getAuthenticatedDevices()", () => {
    it("只返回已认证的设备", () => {
      const r = new DeviceRegistry();
      const ws1 = makeWs("a");
      const ws2 = makeWs("b");
      const ws3 = makeWs("c");
      r.register(ws1, TENANT, "dev-001", "rec-001", "user-001", "pk");
      r.register(ws2, TENANT, "dev-002", "rec-002", "user-001", "pk");
      r.register(ws3, TENANT, "dev-003", "rec-003", "user-002", "pk");
      r.markAuthenticated(ws1);
      r.markAuthenticated(ws3);
      const authed = r.getAuthenticatedDevices();
      expect(authed.length).toBe(2);
      expect(authed.map((d) => d.deviceKey).sort()).toEqual(["dev-001", "dev-003"]);
    });

    it("无认证设备返回空数组", () => {
      const r = new DeviceRegistry();
      r.register(makeWs(), TENANT, "dev-001", "rec-001", "user-001", "pk");
      expect(r.getAuthenticatedDevices()).toEqual([]);
    });
  });

  describe("size()", () => {
    it("注册后计数正确", () => {
      const r = new DeviceRegistry();
      expect(r.size()).toBe(0);
      r.register(makeWs("a"), TENANT, "dev-001", "rec-001", "user-001", "pk");
      expect(r.size()).toBe(1);
      r.register(makeWs("b"), TENANT, "dev-002", "rec-002", "user-001", "pk");
      expect(r.size()).toBe(2);
    });

    it("移除后计数减少", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      r.register(ws, TENANT, "dev-001", "rec-001", "user-001", "pk");
      expect(r.size()).toBe(1);
      r.remove(ws);
      expect(r.size()).toBe(0);
    });
  });

  describe("cleanupStale()", () => {
    it("心跳超时的设备被清理", () => {
      const r = new DeviceRegistry();
      const ws1 = makeWs("a");
      const ws2 = makeWs("b");
      r.register(ws1, TENANT, "dev-001", "rec-001", "user-001", "pk");
      r.register(ws2, TENANT, "dev-002", "rec-002", "user-002", "pk");
      // 设置 ws1 心跳为 NOW，ws2 心跳为 NOW + 5000
      r.updateHeartbeat(ws1, NOW);
      r.updateHeartbeat(ws2, NOW + 5000);
      // 超时 3000ms：NOW + 4000 时 ws1 心跳超时
      const stale = r.cleanupStale(NOW + 4000, 3000);
      expect(stale.length).toBe(1);
      expect(stale[0]?.deviceKey).toBe("dev-001");
      expect(r.getByDeviceRecordId("rec-001")).toBeNull();
      expect(r.getByDeviceRecordId("rec-002")).not.toBeNull();
      expect(r.size()).toBe(1);
    });

    it("无超时设备返回空数组", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      r.register(ws, TENANT, "dev-001", "rec-001", "user-001", "pk");
      r.updateHeartbeat(ws, NOW);
      const stale = r.cleanupStale(NOW + 1000, 3000);
      expect(stale).toEqual([]);
      expect(r.size()).toBe(1);
    });

    it("空注册表返回空数组", () => {
      const r = new DeviceRegistry();
      expect(r.cleanupStale(NOW, 3000)).toEqual([]);
    });
  });

  describe("重新注册同一 ws", () => {
    it("重新注册会覆盖原设备信息", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      const dev1 = r.register(ws, TENANT, "dev-001", "rec-001", "user-001", "pk");
      const dev2 = r.register(ws, TENANT, "dev-002", "rec-002", "user-002", "pk");
      // 新覆盖旧
      expect(r.getByWs(ws)).toBe(dev2);
      expect(r.getByDeviceRecordId("rec-001")).toBeNull();
      expect(r.getByDeviceRecordId("rec-002")).toBe(dev2);
      // size 不应增加
      expect(r.size()).toBe(1);
      // 旧引用保留旧数据
      expect(dev1.deviceKey).toBe("dev-001");
    });
  });

  describe("复合键 (tenantId, deviceKey) 跨租户隔离", () => {
    it("同 deviceKey 不同租户可同时在线（互不驱逐）", () => {
      const r = new DeviceRegistry();
      const wsA = makeWs("a");
      const wsB = makeWs("b");
      const devA = r.register(wsA, "tenant-A", "dev-001", "rec-A", "user-A", "pk");
      const devB = r.register(wsB, "tenant-B", "dev-001", "rec-B", "user-B", "pk");
      // 两个租户的相同 deviceKey 同时在线，size=2，各自索引互不干扰
      expect(r.size()).toBe(2);
      expect(r.getByKey("tenant-A", "dev-001")).toBe(devA);
      expect(r.getByKey("tenant-B", "dev-001")).toBe(devB);
      expect(r.getByDeviceRecordId("rec-A")).toBe(devA);
      expect(r.getByDeviceRecordId("rec-B")).toBe(devB);
    });

    it("同复合键重连只替换自身，不驱逐其他租户", () => {
      const r = new DeviceRegistry();
      const wsA = makeWs("a");
      const wsA2 = makeWs("a2");
      const wsB = makeWs("b");
      r.register(wsA, "tenant-A", "dev-001", "rec-A", "user-A", "pk");
      r.register(wsB, "tenant-B", "dev-001", "rec-B", "user-B", "pk");
      // tenant-A 用新 ws 重连（同复合键）→ 只替换 A 自身
      const devA2 = r.register(wsA2, "tenant-A", "dev-001", "rec-A", "user-A", "pk");
      expect(r.size()).toBe(2);
      expect(r.getByWs(wsA)).toBeNull();
      expect(r.getByWs(wsA2)).toBe(devA2);
      expect(r.getByDeviceRecordId("rec-A")).toBe(devA2);
      // B 不受影响
      expect(r.getByKey("tenant-B", "dev-001")?.ws).toBe(wsB);
      expect(r.getByKey("tenant-B", "dev-001")?.deviceRecordId).toBe("rec-B");
    });

    it("同复合键重连覆盖旧 deviceRecordId 索引", () => {
      const r = new DeviceRegistry();
      const wsA = makeWs("a");
      const wsA2 = makeWs("a2");
      r.register(wsA, "tenant-A", "dev-001", "rec-A1", "user-A", "pk");
      // 同复合键重连，deviceRecordId 更新（DB 记录 id 变化时）
      const devA2 = r.register(wsA2, "tenant-A", "dev-001", "rec-A2", "user-A", "pk");
      expect(r.getByDeviceRecordId("rec-A1")).toBeNull();
      expect(r.getByDeviceRecordId("rec-A2")).toBe(devA2);
      expect(r.size()).toBe(1);
    });
  });

  describe("getByKey(tenantId, deviceKey)", () => {
    it("按 (tenantId, deviceKey) 复合键查找命中", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      r.register(ws, "tenant-A", "dev-001", "rec-001", "user-001", "pk");
      const dev = r.getByKey("tenant-A", "dev-001");
      expect(dev).not.toBeNull();
      expect(dev?.deviceKey).toBe("dev-001");
    });

    it("同 deviceKey 不同租户查不到（跨租户隔离）", () => {
      const r = new DeviceRegistry();
      r.register(makeWs(), "tenant-A", "dev-001", "rec-001", "user-001", "pk");
      // 同 deviceKey 但在另一个租户 → 返回 null，避免跨租户误踢/误路由
      expect(r.getByKey("tenant-B", "dev-001")).toBeNull();
    });
  });
});
