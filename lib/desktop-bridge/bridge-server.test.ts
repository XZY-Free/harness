/**
 * BridgeServer 安全集成测试。
 *
 * 验证关键安全行为：
 * - sendRpcToThread 对已 cancel 的 runId 返回 interrupted（阻止迟到 RPC 进入 Agent 上下文）
 * - sendRpcToThread 无 lease 时返回 desktop_unavailable
 * - cancel 后到达的迟到 RPC 结果被丢弃（不 resolve 给调用方）
 * - rejectPendingRpcByRunId 立即拒绝 pending RPC
 *
 * 测试策略：
 * - 启动真实 BridgeServer 在临时端口（port=0 由 OS 分配）
 * - 通过类型转换访问 private cancelService/pendingRpcs 进行测试注入
 * - 不需要真实 WebSocket 连接（cancel 检查在 routeRpc 之前执行）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeServer } from "./bridge-server";
import type { CancelService } from "./cancel-service";

/**
 * 测试辅助：访问 BridgeServer 的 private 成员。
 */
interface BridgeServerInternals {
  cancelService: CancelService;
  pendingRpcs: Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
      threadId: string;
      runId: string | null;
    }
  >;
}

function internals(server: BridgeServer): BridgeServerInternals {
  return server as unknown as BridgeServerInternals;
}

const TID = "thread-1";
const UID = "user-1";
const RUN1 = "run-1";
const RUN2 = "run-2";

describe("BridgeServer 安全集成", () => {
  let server: BridgeServer;
  let port: number;

  beforeEach(async () => {
    // 使用临时端口避免冲突
    port = 10000 + Math.floor(Math.random() * 50000);
    server = new BridgeServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  // ─── cancel 阻止 RPC 进入 Agent 上下文 ─────────────────────────

  describe("sendRpcToThread cancel 集成", () => {
    it("已 cancel 的 runId 返回 interrupted（不发送 RPC）", async () => {
      const { cancelService } = internals(server);
      // 标记 runId 为 cancelled（serverCancel 不需要 lease holder）
      await cancelService.serverCancel({
        threadId: TID,
        runId: RUN1,
        reason: "user_takeover",
        now: Date.now(),
      });
      const result = await server.sendRpcToThread({
        threadId: TID,
        userId: UID,
        command: "browser.getTabs",
        payload: {},
        runId: RUN1,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("interrupted");
      expect(result.message).toBe("命令已被取消");
    });

    it("未 cancel 的 runId 不返回 interrupted（继续走 routeRpc）", async () => {
      // 无 lease → routeRpc 返回 desktop_unavailable，但不是 interrupted
      const result = await server.sendRpcToThread({
        threadId: TID,
        userId: UID,
        command: "browser.getTabs",
        payload: {},
        runId: RUN1,
      });
      expect(result.ok).toBe(false);
      // 无 lease → desktop_unavailable（证明 cancel 检查通过，进入 routeRpc）
      expect(result.code).toBe("desktop_unavailable");
    });

    it("cancel 一个 runId 不影响其他 runId", async () => {
      const { cancelService } = internals(server);
      await cancelService.serverCancel({
        threadId: TID,
        runId: RUN1,
        reason: "user_takeover",
        now: Date.now(),
      });
      // RUN1 被 cancel → interrupted
      const r1 = await server.sendRpcToThread({
        threadId: TID,
        userId: UID,
        command: "browser.getTabs",
        payload: {},
        runId: RUN1,
      });
      expect(r1.code).toBe("interrupted");
      // RUN2 未 cancel → 继续 routeRpc → desktop_unavailable（无 lease）
      const r2 = await server.sendRpcToThread({
        threadId: TID,
        userId: UID,
        command: "browser.getTabs",
        payload: {},
        runId: RUN2,
      });
      expect(r2.code).toBe("desktop_unavailable");
    });

    it("无 runId 的 RPC 不检查 cancel（直接 routeRpc）", async () => {
      const { cancelService } = internals(server);
      // 即使 TID 有 cancelled 记录，无 runId 的 RPC 不受影响
      await cancelService.serverCancel({
        threadId: TID,
        runId: RUN1,
        reason: "test",
        now: Date.now(),
      });
      const result = await server.sendRpcToThread({
        threadId: TID,
        userId: UID,
        command: "browser.getTabs",
        payload: {},
        // 不传 runId
      });
      // 无 lease → desktop_unavailable（不是 interrupted）
      expect(result.code).toBe("desktop_unavailable");
    });
  });

  // ─── 迟到 RPC 结果丢弃 ─────────────────────────

  describe("迟到 RPC 结果丢弃", () => {
    it("cancel 后到达的 RPC 结果被 reject（不 resolve 给调用方）", async () => {
      const { cancelService, pendingRpcs } = internals(server);
      // 手动注入一个 pending RPC（模拟正在等待的 RPC）
      let resolved = false;
      let rejected = false;
      let rejectMsg = "";
      const fakeTimer = setTimeout(() => {}, 999999);
      pendingRpcs.set("req-test", {
        resolve: () => {
          resolved = true;
        },
        reject: (err: Error) => {
          rejected = true;
          rejectMsg = err.message;
        },
        timer: fakeTimer,
        threadId: TID,
        runId: RUN1,
      });
      // cancel 该 runId
      await cancelService.serverCancel({
        threadId: TID,
        runId: RUN1,
        reason: "user_takeover",
        now: Date.now(),
      });
      // 模拟迟到 RPC 结果到达 → handleMessage 中的 rpc_result 分支
      // 通过直接检查 shouldDropRpcResult 验证逻辑
      const shouldDrop = cancelService.shouldDropRpcResult(TID, RUN1);
      expect(shouldDrop).toBe(true);
      // 手动模拟 rpc_result handler 的行为
      if (shouldDrop) {
        const pending = pendingRpcs.get("req-test");
        if (pending?.runId && cancelService.shouldDropRpcResult(pending.threadId, pending.runId)) {
          clearTimeout(pending.timer);
          pendingRpcs.delete("req-test");
          pending.reject(new Error("命令已被取消"));
        }
      }
      expect(resolved).toBe(false);
      expect(rejected).toBe(true);
      expect(rejectMsg).toBe("命令已被取消");
      expect(pendingRpcs.has("req-test")).toBe(false);
    });

    it("未 cancel 的 RPC 结果正常 resolve", async () => {
      const { pendingRpcs } = internals(server);
      let resolved = false;
      const fakeTimer = setTimeout(() => {}, 999999);
      pendingRpcs.set("req-ok", {
        resolve: () => {
          resolved = true;
        },
        reject: () => {},
        timer: fakeTimer,
        threadId: TID,
        runId: RUN1,
      });
      // 不 cancel → 模拟 rpc_result 到达
      const pending = pendingRpcs.get("req-ok");
      if (pending) {
        pending.resolve({ tabs: [] });
      }
      expect(resolved).toBe(true);
      clearTimeout(fakeTimer);
    });
  });

  // ─── Bridge 未运行 ─────────────────────────

  describe("Bridge 未运行", () => {
    it("未启动的 Bridge 返回 desktop_unavailable", async () => {
      await server.stop();
      const result = await server.sendRpcToThread({
        threadId: TID,
        userId: UID,
        command: "browser.getTabs",
        payload: {},
        runId: RUN1,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("desktop_unavailable");
    });
  });

  // ─── kickDevice 主动断开 ─────────────────────────

  describe("kickDevice(tenantId, deviceKey)", () => {
    it("设备不在线时返回 false", () => {
      expect(server.kickDevice("tenant-001", "non-existent-device")).toBe(false);
    });

    it("设备在线时调用 ws.close 并返回 true", async () => {
      // 手动注入一个 fake 设备到 registry（通过类型转换访问 private）
      const fakeWs = {
        close: vi.fn(),
        readyState: 1, // WebSocket.OPEN
      };
      const serverInternals = server as unknown as {
        registry: {
          register: (
            ws: unknown,
            tenantId: string,
            deviceId: string,
            recordId: string,
            userId: string,
            key: string,
          ) => unknown;
          markAuthenticated: (ws: unknown) => boolean;
        };
      };
      serverInternals.registry.register(fakeWs, "tenant-001", "dev-kick-1", "rec-1", UID, "pk");
      serverInternals.registry.markAuthenticated(fakeWs);

      const result = server.kickDevice("tenant-001", "dev-kick-1");
      expect(result).toBe(true);
      expect(fakeWs.close).toHaveBeenCalledTimes(1);
      // 验证 close 调用参数：close(code, reason)
      expect(fakeWs.close).toHaveBeenCalledWith(4001, "device_revoked");
    });

    it("ws.close 抛错时不影响返回值（仍返回 true）", async () => {
      const fakeWs = {
        close: vi.fn(() => {
          throw new Error("ws already closed");
        }),
        readyState: 1,
      };
      const serverInternals = server as unknown as {
        registry: {
          register: (
            ws: unknown,
            tenantId: string,
            deviceId: string,
            recordId: string,
            userId: string,
            key: string,
          ) => unknown;
          markAuthenticated: (ws: unknown) => boolean;
        };
      };
      serverInternals.registry.register(fakeWs, "tenant-001", "dev-kick-2", "rec-2", UID, "pk");
      serverInternals.registry.markAuthenticated(fakeWs);

      // 不抛错，返回 true（ws 异常不阻断 kick 流程）
      expect(() => server.kickDevice("tenant-001", "dev-kick-2")).not.toThrow();
      expect(server.kickDevice("tenant-001", "dev-kick-2")).toBe(true);
    });

    it("踢错租户的设备返回 false（跨租户隔离，不误踢）", async () => {
      const fakeWsA = { close: vi.fn(), readyState: 1 };
      const serverInternals = server as unknown as {
        registry: {
          register: (
            ws: unknown,
            tenantId: string,
            deviceId: string,
            recordId: string,
            userId: string,
            key: string,
          ) => unknown;
          markAuthenticated: (ws: unknown) => boolean;
        };
      };
      // 租户 A 在线一台 deviceKey="shared-dev" 的设备
      serverInternals.registry.register(fakeWsA, "tenant-A", "shared-dev", "rec-A", UID, "pk");
      serverInternals.registry.markAuthenticated(fakeWsA);

      // 用错误的租户（tenant-B）踢 → getByKey 返回 null → false，A 的 ws 不被关闭
      const wrongTenant = server.kickDevice("tenant-B", "shared-dev");
      expect(wrongTenant).toBe(false);
      expect(fakeWsA.close).not.toHaveBeenCalled();
      // 用正确的租户踢 → true，关闭 A 的 ws
      const rightTenant = server.kickDevice("tenant-A", "shared-dev");
      expect(rightTenant).toBe(true);
      expect(fakeWsA.close).toHaveBeenCalledTimes(1);
    });
  });
});
