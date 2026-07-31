/**
 * V10 Phase 5：DeviceRegistry 测试。
 */
import { type ConnectedDevice, DeviceRegistry } from "@/lib/desktop-bridge/device-registry";
import { describe, expect, it } from "vitest";

const NOW = 1700000000000;

// WebSocket 实例用简单对象模拟（registry 不依赖 ws 类型，按引用标识）
function makeWs(tag = "ws"): object {
  return { tag };
}

describe("DeviceRegistry", () => {
  describe("register() + getByWs()", () => {
    it("注册后可按 ws 查到", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      const dev = r.register(ws, "dev-001", "rec-001", "user-001", "server-pk");
      expect(dev.deviceId).toBe("dev-001");
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

  describe("getByDeviceId()", () => {
    it("注册后可按 deviceId 查到", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      r.register(ws, "dev-001", "rec-001", "user-001", "server-pk");
      const dev = r.getByDeviceId("dev-001");
      expect(dev).not.toBeNull();
      expect(dev?.deviceId).toBe("dev-001");
    });

    it("未注册的 deviceId 返回 null", () => {
      const r = new DeviceRegistry();
      expect(r.getByDeviceId("dev-001")).toBeNull();
    });
  });

  describe("getByUserId()", () => {
    it("返回用户的所有在线设备", () => {
      const r = new DeviceRegistry();
      r.register(makeWs("a"), "dev-001", "rec-001", "user-001", "pk");
      r.register(makeWs("b"), "dev-002", "rec-002", "user-001", "pk");
      r.register(makeWs("c"), "dev-003", "rec-003", "user-002", "pk");
      const list = r.getByUserId("user-001");
      expect(list.length).toBe(2);
      expect(list.map((d) => d.deviceId).sort()).toEqual(["dev-001", "dev-002"]);
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
      r.register(ws, "dev-001", "rec-001", "user-001", "pk");
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
      r.register(ws, "dev-001", "rec-001", "user-001", "pk");
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
    it("移除后查不到", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      const dev = r.register(ws, "dev-001", "rec-001", "user-001", "pk");
      const removed = r.remove(ws);
      expect(removed).toBe(dev);
      expect(r.getByWs(ws)).toBeNull();
      expect(r.getByDeviceId("dev-001")).toBeNull();
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
      r.register(ws1, "dev-001", "rec-001", "user-001", "pk");
      r.register(ws2, "dev-002", "rec-002", "user-001", "pk");
      r.register(ws3, "dev-003", "rec-003", "user-002", "pk");
      r.markAuthenticated(ws1);
      r.markAuthenticated(ws3);
      const authed = r.getAuthenticatedDevices();
      expect(authed.length).toBe(2);
      expect(authed.map((d) => d.deviceId).sort()).toEqual(["dev-001", "dev-003"]);
    });

    it("无认证设备返回空数组", () => {
      const r = new DeviceRegistry();
      r.register(makeWs(), "dev-001", "rec-001", "user-001", "pk");
      expect(r.getAuthenticatedDevices()).toEqual([]);
    });
  });

  describe("size()", () => {
    it("注册后计数正确", () => {
      const r = new DeviceRegistry();
      expect(r.size()).toBe(0);
      r.register(makeWs("a"), "dev-001", "rec-001", "user-001", "pk");
      expect(r.size()).toBe(1);
      r.register(makeWs("b"), "dev-002", "rec-002", "user-001", "pk");
      expect(r.size()).toBe(2);
    });

    it("移除后计数减少", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      r.register(ws, "dev-001", "rec-001", "user-001", "pk");
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
      r.register(ws1, "dev-001", "rec-001", "user-001", "pk");
      r.register(ws2, "dev-002", "rec-002", "user-002", "pk");
      // 设置 ws1 心跳为 NOW，ws2 心跳为 NOW + 5000
      r.updateHeartbeat(ws1, NOW);
      r.updateHeartbeat(ws2, NOW + 5000);
      // 超时 3000ms：NOW + 4000 时 ws1 心跳超时（NOW < NOW + 4000 - 3000 = NOW + 1000）
      const stale = r.cleanupStale(NOW + 4000, 3000);
      expect(stale.length).toBe(1);
      expect(stale[0]?.deviceId).toBe("dev-001");
      expect(r.getByDeviceId("dev-001")).toBeNull();
      expect(r.getByDeviceId("dev-002")).not.toBeNull();
      expect(r.size()).toBe(1);
    });

    it("无超时设备返回空数组", () => {
      const r = new DeviceRegistry();
      const ws = makeWs();
      r.register(ws, "dev-001", "rec-001", "user-001", "pk");
      r.updateHeartbeat(ws, NOW);
      // 当前 NOW + 1000，超时 3000：lastHeartbeat = NOW > NOW + 1000 - 3000 = NOW - 2000，未超时
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
      const dev1 = r.register(ws, "dev-001", "rec-001", "user-001", "pk");
      const dev2 = r.register(ws, "dev-002", "rec-002", "user-002", "pk");
      // 新覆盖旧
      expect(r.getByWs(ws)).toBe(dev2);
      expect(r.getByDeviceId("dev-001")).toBeNull();
      expect(r.getByDeviceId("dev-002")).toBe(dev2);
      // size 不应增加
      expect(r.size()).toBe(1);
      // 旧引用保留旧数据
      expect(dev1.deviceId).toBe("dev-001");
    });
  });
});
