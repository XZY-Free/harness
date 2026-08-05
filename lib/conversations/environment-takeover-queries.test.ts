import { describe, expect, it } from "vitest";
/**
 * S10-W07：isDeviceHeartbeatStale 纯函数 + 错误类单元测试。
 *
 * 覆盖：
 * - isDeviceHeartbeatStale：device null / lastActiveAt null / 未超时 / 超时。
 * - TakeoverConditionsNotMetError：构造 + conditions 字段保留。
 * - NoActiveOwnershipError：构造 + threadId 字段保留。
 * - EMPTY_CONDITIONS：字段值。
 *
 * 不覆盖 getTakeoverConditions / performTakeover（需要真实 MySQL，
 * 由 lib/conversations db 集成测试覆盖底层 queries）。
 */
import {
  DEVICE_HEARTBEAT_TIMEOUT_MS,
  EMPTY_CONDITIONS,
  NoActiveOwnershipError,
  TakeoverConditionsNotMetError,
  isDeviceHeartbeatStale,
} from "./environment-takeover-queries";

const NOW = new Date("2026-07-21T12:00:00Z");
const STALE_TIME = new Date(NOW.getTime() - DEVICE_HEARTBEAT_TIMEOUT_MS - 1000);
const FRESH_TIME = new Date(NOW.getTime() - DEVICE_HEARTBEAT_TIMEOUT_MS + 1000);

describe("DEVICE_HEARTBEAT_TIMEOUT_MS", () => {
  it("为 90000 毫秒（与 V10 bridge 对齐）", () => {
    expect(DEVICE_HEARTBEAT_TIMEOUT_MS).toBe(90_000);
  });
});

describe("isDeviceHeartbeatStale", () => {
  it("device 为 null → true", () => {
    expect(isDeviceHeartbeatStale(null, NOW)).toBe(true);
  });

  it("device.lastActiveAt 为 null → true", () => {
    expect(isDeviceHeartbeatStale({ lastActiveAt: null }, NOW)).toBe(true);
  });

  it("lastActiveAt 超过阈值 → true（陈旧）", () => {
    expect(isDeviceHeartbeatStale({ lastActiveAt: STALE_TIME }, NOW)).toBe(true);
  });

  it("lastActiveAt 未超过阈值 → false（在线）", () => {
    expect(isDeviceHeartbeatStale({ lastActiveAt: FRESH_TIME }, NOW)).toBe(false);
  });

  it("lastActiveAt 恰好等于阈值 → false（边界，> 才算陈旧）", () => {
    const boundary = new Date(NOW.getTime() - DEVICE_HEARTBEAT_TIMEOUT_MS);
    expect(isDeviceHeartbeatStale({ lastActiveAt: boundary }, NOW)).toBe(false);
  });

  it("未传 now 参数时使用 new Date()", () => {
    // 验证默认参数不抛错（实际时间判断结果取决于执行时刻）
    const result = isDeviceHeartbeatStale({ lastActiveAt: new Date() });
    expect(typeof result).toBe("boolean");
    // 刚刚 lastActiveAt，应该不陈旧
    expect(result).toBe(false);
  });
});

describe("EMPTY_CONDITIONS", () => {
  it("所有字段为空值 / false / 0", () => {
    expect(EMPTY_CONDITIONS).toEqual({
      can_takeover: false,
      blocking_reasons: [],
      pending_tool_calls: 0,
      unknown_effects: 0,
      active_write_locks: 0,
      owner_heartbeat_stale: false,
      owner_device_id: null,
      ownership_id: null,
    });
  });

  it("blocking_reasons 为空数组", () => {
    expect(Array.isArray(EMPTY_CONDITIONS.blocking_reasons)).toBe(true);
    expect(EMPTY_CONDITIONS.blocking_reasons.length).toBe(0);
  });
});

describe("TakeoverConditionsNotMetError", () => {
  it("构造时保留 conditions + message 包含阻塞原因", () => {
    const conditions = {
      can_takeover: false,
      blocking_reasons: ["有 2 个未完成 ToolCall", "有 1 个 unknown_effect 待核对"],
      pending_tool_calls: 2,
      unknown_effects: 1,
      active_write_locks: 0,
      owner_heartbeat_stale: true,
      owner_device_id: "dev-1",
      ownership_id: "own-1",
    };
    const err = new TakeoverConditionsNotMetError(conditions);
    expect(err.name).toBe("TakeoverConditionsNotMetError");
    expect(err.conditions).toBe(conditions);
    expect(err.message).toContain("有 2 个未完成 ToolCall");
    expect(err.message).toContain("有 1 个 unknown_effect 待核对");
  });

  it("空 blocking_reasons 时 message 包含「未知原因」", () => {
    const conditions = {
      can_takeover: false,
      blocking_reasons: [],
      pending_tool_calls: 0,
      unknown_effects: 0,
      active_write_locks: 0,
      owner_heartbeat_stale: true,
      owner_device_id: null,
      ownership_id: null,
    };
    const err = new TakeoverConditionsNotMetError(conditions);
    expect(err.message).toContain("未知原因");
  });

  it("是 Error 实例", () => {
    const err = new TakeoverConditionsNotMetError({
      can_takeover: false,
      blocking_reasons: [],
      pending_tool_calls: 0,
      unknown_effects: 0,
      active_write_locks: 0,
      owner_heartbeat_stale: false,
      owner_device_id: null,
      ownership_id: null,
    });
    expect(err).toBeInstanceOf(Error);
  });
});

describe("NoActiveOwnershipError", () => {
  it("构造时保留 threadId + message 包含 threadId", () => {
    const err = new NoActiveOwnershipError("thread-abc");
    expect(err.name).toBe("NoActiveOwnershipError");
    expect(err.threadId).toBe("thread-abc");
    expect(err.message).toContain("thread-abc");
    expect(err.message).toContain("无活跃 ExecutionOwnership");
  });

  it("是 Error 实例", () => {
    const err = new NoActiveOwnershipError("t1");
    expect(err).toBeInstanceOf(Error);
  });
});
