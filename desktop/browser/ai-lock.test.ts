import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_LOCK_DEFAULT_TTL_MS,
  type AiLockEntry,
  AiLockManager,
  type LockAcquireResult,
  isLockValid,
  lockNeedsRenewal,
} from "./ai-lock";
import type { TabId, ThreadId } from "./tab-store";

/**
 * V10 Phase 6-5：Desktop AI 锁状态机单元测试。
 *
 * 验证 AiLockManager 的完整流程：
 * - acquire：AI 持锁时获取成功（同 runId 续期，不同 runId 在同 deviceId 下覆盖）
 * - release：只有持有锁的 runId/deviceId 能释放
 * - cancel：用户"停止并接管"取消当前 AI 命令并释放锁
 * - 过期：lease TTL 到期后自动失效
 * - 状态查询：isLocked / getLock / isInputBlocked
 *
 * 安全约束：
 * - 不同 deviceId 持有有效锁时返回 lock_held_by_other
 * - cancel 必须由用户主动触发，AI 无法自行 cancel 释放锁
 * - 网络断开时 lease 不立即释放，需等 TTL 自然过期
 * - isInputBlocked 反映"AI 持锁时用户输入被阻止"
 */
const TID: ThreadId = "thread-1";
const TID2: ThreadId = "thread-2";
const UID = "user-1";
const DID = "device-1";
const DID2 = "device-2";
const RUN1 = "run-1";
const RUN2 = "run-2";
const TAB1: TabId = "tab-1";

describe("AiLockManager", () => {
  let manager: AiLockManager;

  beforeEach(() => {
    manager = new AiLockManager();
    vi.useFakeTimers();
    // 初始时间 1000ms，与测试期望的 now=1000 一致
    vi.setSystemTime(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── 基础查询 ─────────────────────────────────────

  describe("基础查询", () => {
    it("初始状态无锁", () => {
      expect(manager.isLocked(TID)).toBe(false);
      expect(manager.getLock(TID)).toBeNull();
      expect(manager.isInputBlocked(TID, TAB1)).toBe(false);
    });

    it("未知 thread 查询返回 false/null", () => {
      expect(manager.isLocked("nonexistent")).toBe(false);
      expect(manager.getLock("nonexistent")).toBeNull();
      expect(manager.isInputBlocked("nonexistent", "no-tab")).toBe(false);
    });
  });

  // ─── acquire ─────────────────────────────────────

  describe("acquire", () => {
    it("首次获取 lease 成功", () => {
      const now = 1000;
      const result = manager.acquire({
        threadId: TID,
        userId: UID,
        deviceId: DID,
        runId: RUN1,
        now,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lock.deviceId).toBe(DID);
        expect(result.lock.runId).toBe(RUN1);
        expect(result.lock.threadId).toBe(TID);
        expect(result.lock.acquiredAt).toBe(now);
        expect(result.lock.expiresAt).toBe(now + AI_LOCK_DEFAULT_TTL_MS);
      }
    });

    it("同 deviceId + 同 runId 续期（更新 expiresAt）", () => {
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      const result = manager.acquire({
        threadId: TID,
        userId: UID,
        deviceId: DID,
        runId: RUN1,
        now: 2000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lock.acquiredAt).toBe(2000);
        expect(result.lock.expiresAt).toBe(2000 + AI_LOCK_DEFAULT_TTL_MS);
      }
    });

    it("同 deviceId + 不同 runId 替换锁（新 runId 接管）", () => {
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      const result = manager.acquire({
        threadId: TID,
        userId: UID,
        deviceId: DID,
        runId: RUN2,
        now: 2000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lock.runId).toBe(RUN2);
        expect(result.lock.acquiredAt).toBe(2000);
      }
    });

    it("不同 deviceId 持有有效锁 → lock_held_by_other", () => {
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      const result = manager.acquire({
        threadId: TID,
        userId: UID,
        deviceId: DID2,
        runId: RUN2,
        now: 2000,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("lock_held_by_other");
      }
      // 原锁仍然存在
      expect(manager.getLock(TID)?.deviceId).toBe(DID);
    });

    it("过期 lease 可被其他设备获取", () => {
      manager.acquire({
        threadId: TID,
        userId: UID,
        deviceId: DID,
        runId: RUN1,
        now: 1000,
        ttlMs: 5000,
      });
      // 过期后获取
      const result = manager.acquire({
        threadId: TID,
        userId: UID,
        deviceId: DID2,
        runId: RUN2,
        now: 7000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lock.deviceId).toBe(DID2);
      }
    });

    it("自定义 ttlMs 生效", () => {
      const result = manager.acquire({
        threadId: TID,
        userId: UID,
        deviceId: DID,
        runId: RUN1,
        now: 1000,
        ttlMs: 10000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lock.expiresAt).toBe(11000);
      }
    });

    it("不同 threadId 互不影响", () => {
      const r1 = manager.acquire({
        threadId: TID,
        userId: UID,
        deviceId: DID,
        runId: RUN1,
        now: 1000,
      });
      const r2 = manager.acquire({
        threadId: TID2,
        userId: UID,
        deviceId: DID,
        runId: RUN1,
        now: 1000,
      });
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(manager.isLocked(TID)).toBe(true);
      expect(manager.isLocked(TID2)).toBe(true);
    });
  });

  // ─── release / cancel ─────────────────────────────────────

  describe("release", () => {
    it("持有锁的 deviceId + runId 可释放", () => {
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      expect(manager.release(TID, DID, RUN1, 2000)).toBe(true);
      expect(manager.isLocked(TID)).toBe(false);
    });

    it("非持有 deviceId 不能释放", () => {
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      expect(manager.release(TID, DID2, RUN1, 2000)).toBe(false);
      expect(manager.isLocked(TID)).toBe(true);
    });

    it("不匹配 runId 不能释放", () => {
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      expect(manager.release(TID, DID, RUN2, 2000)).toBe(false);
      expect(manager.isLocked(TID)).toBe(true);
    });

    it("释放不存在的 thread 返回 false", () => {
      expect(manager.release("nonexistent", DID, RUN1, 2000)).toBe(false);
    });
  });

  describe("cancel", () => {
    it("用户取消释放锁并标记 interrupted", () => {
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      const result = manager.cancel(TID, 2000);
      expect(result.cancelled).toBe(true);
      expect(result.runId).toBe(RUN1);
      expect(manager.isLocked(TID)).toBe(false);
    });

    it("取消不存在的锁返回 cancelled=false", () => {
      const result = manager.cancel(TID, 2000);
      expect(result.cancelled).toBe(false);
      expect(result.runId).toBeNull();
    });

    it("取消过期锁不报错（视为已释放）", () => {
      manager.acquire({
        threadId: TID,
        userId: UID,
        deviceId: DID,
        runId: RUN1,
        now: 1000,
        ttlMs: 5000,
      });
      const result = manager.cancel(TID, 10000);
      expect(result.cancelled).toBe(true);
      expect(manager.isLocked(TID)).toBe(false);
    });
  });

  // ─── 输入阻止判定 ─────────────────────────────────────

  describe("isInputBlocked", () => {
    it("AI 持锁时输入被阻止", () => {
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      expect(manager.isInputBlocked(TID, TAB1)).toBe(true);
    });

    it("无锁时输入不阻止", () => {
      expect(manager.isInputBlocked(TID, TAB1)).toBe(false);
    });

    it("锁过期后输入不再阻止", () => {
      manager.acquire({
        threadId: TID,
        userId: UID,
        deviceId: DID,
        runId: RUN1,
        now: 1000,
        ttlMs: 5000,
      });
      expect(manager.isInputBlocked(TID, TAB1, 6000)).toBe(false);
    });

    it("释放后输入不再阻止", () => {
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      manager.release(TID, DID, RUN1, 2000);
      expect(manager.isInputBlocked(TID, TAB1)).toBe(false);
    });
  });

  // ─── 过期清理 ─────────────────────────────────────

  describe("cleanupExpired", () => {
    it("清理过期锁", () => {
      manager.acquire({
        threadId: TID,
        userId: UID,
        deviceId: DID,
        runId: RUN1,
        now: 1000,
        ttlMs: 5000,
      });
      manager.acquire({
        threadId: TID2,
        userId: UID,
        deviceId: DID,
        runId: RUN1,
        now: 1000,
        ttlMs: 10000,
      });
      const cleaned = manager.cleanupExpired(7000);
      expect(cleaned).toBe(1);
      expect(manager.isLocked(TID)).toBe(false);
      expect(manager.isLocked(TID2)).toBe(true);
    });

    it("无过期锁返回 0", () => {
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      expect(manager.cleanupExpired(2000)).toBe(0);
    });
  });

  // ─── 事件回调 ─────────────────────────────────────

  describe("事件回调", () => {
    it("acquire 触发 onLocked 回调", () => {
      const cb = vi.fn();
      manager.onLocked(cb);
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: TID, runId: RUN1, deviceId: DID }),
      );
    });

    it("release 触发 onReleased 回调（reason=manual）", () => {
      const cb = vi.fn();
      manager.onReleased(cb);
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      manager.release(TID, DID, RUN1, 2000);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: TID, runId: RUN1, reason: "manual" }),
      );
    });

    it("cancel 触发 onReleased 回调（reason=cancelled）", () => {
      const cb = vi.fn();
      manager.onReleased(cb);
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      manager.cancel(TID, 2000);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: TID, runId: RUN1, reason: "cancelled" }),
      );
    });

    it("过期 cleanupExpired 触发 onReleased 回调（reason=expired）", () => {
      const cb = vi.fn();
      manager.onReleased(cb);
      manager.acquire({
        threadId: TID,
        userId: UID,
        deviceId: DID,
        runId: RUN1,
        now: 1000,
        ttlMs: 5000,
      });
      manager.cleanupExpired(7000);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: TID, runId: RUN1, reason: "expired" }),
      );
    });

    it("onLocked/onReleased 返回取消订阅函数", () => {
      const cb = vi.fn();
      const unsub1 = manager.onLocked(cb);
      const unsub2 = manager.onReleased(cb);
      unsub1();
      unsub2();
      manager.acquire({ threadId: TID, userId: UID, deviceId: DID, runId: RUN1, now: 1000 });
      manager.release(TID, DID, RUN1, 2000);
      expect(cb).not.toHaveBeenCalled();
    });
  });
});

// ─── 纯函数 ─────────────────────────────────────────

describe("ai-lock 纯函数", () => {
  const lock: AiLockEntry = {
    threadId: TID,
    userId: UID,
    deviceId: DID,
    runId: RUN1,
    acquiredAt: 1000,
    expiresAt: 6000,
  };

  describe("isLockValid", () => {
    it("未过期返回 true", () => {
      expect(isLockValid(lock, 5000)).toBe(true);
    });

    it("已过期返回 false", () => {
      expect(isLockValid(lock, 6000)).toBe(false);
      expect(isLockValid(lock, 7000)).toBe(false);
    });

    it("expiresAt === now 视为过期", () => {
      expect(isLockValid(lock, 6000)).toBe(false);
    });
  });

  describe("lockNeedsRenewal", () => {
    it("剩余时间 < 1/3 TTL 返回 true", () => {
      // TTL = 5000, 1/3 = 1666.67, 剩余 < 1666 时需续期
      // now=5000 → remaining=1000 < 1666 → true
      expect(lockNeedsRenewal(lock, 5000)).toBe(true);
    });

    it("剩余时间 >= 1/3 TTL 返回 false", () => {
      // now=3000 → remaining=3000 > 1666 → false
      expect(lockNeedsRenewal(lock, 3000)).toBe(false);
    });

    it("已过期返回 true", () => {
      expect(lockNeedsRenewal(lock, 7000)).toBe(true);
    });
  });
});
