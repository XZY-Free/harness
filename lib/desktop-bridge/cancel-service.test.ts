import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserLease } from "../desktop/lease";
import { CancelService } from "./cancel-service";

/**
 * V10 Phase 6-5：CancelService 单元测试。
 *
 * 验证"停止并接管"流程的 Server 端逻辑：
 * - requestCancel：Desktop 发起取消 → Server 释放 lease + 通知 Desktop
 * - serverCancel：Server 主动取消（超时/关停）→ 通知 Desktop + 拒绝 RPC
 * - 迟到 RPC 结果：cancel 后到达的 RPC 结果被丢弃
 * - runId 不匹配：cancel 只影响指定 runId
 *
 * 使用 mock LeaseServiceLike，不依赖真实 WebSocket。
 */

const TID = "thread-1";
const UID = "user-1";
const DID = "device-1";
const RUN1 = "run-1";
const RUN2 = "run-2";

function leaseFixture(overrides: Partial<BrowserLease> = {}): BrowserLease {
  return {
    threadId: TID,
    userId: UID,
    deviceId: DID,
    acquiredAt: 1000,
    expiresAt: 99999,
    ...overrides,
  };
}

class MockLeaseService {
  releaseLease = vi.fn().mockReturnValue(true);
  getLeaseHolder = vi.fn<(threadId: string) => BrowserLease | null>().mockReturnValue(null);
  revokeLease = vi.fn().mockReturnValue(true);
}

describe("CancelService", () => {
  let lease: MockLeaseService;
  let service: CancelService;

  beforeEach(() => {
    lease = new MockLeaseService();
    service = new CancelService(lease);
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── requestCancel（Desktop 触发） ─────────────────────────

  describe("requestCancel", () => {
    it("释放 Server lease + 通知 Desktop command_cancelled", async () => {
      lease.getLeaseHolder.mockReturnValue(leaseFixture());
      const result = await service.requestCancel({
        threadId: TID,
        runId: RUN1,
        reason: "user_takeover",
        deviceId: DID,
        now: 2000,
      });
      expect(result.cancelled).toBe(true);
      expect(result.runId).toBe(RUN1);
      // 释放 lease
      expect(lease.releaseLease).toHaveBeenCalledWith(TID, DID, 2000);
    });

    it("无 lease 时 cancel 返回 cancelled=false（命令可能已完成）", async () => {
      lease.getLeaseHolder.mockReturnValue(null);
      const result = await service.requestCancel({
        threadId: TID,
        runId: RUN1,
        reason: "user_takeover",
        deviceId: DID,
        now: 2000,
      });
      expect(result.cancelled).toBe(false);
      expect(result.runId).toBeNull();
    });

    it("lease 由其他设备持有时拒绝 cancel（不能跨设备取消）", async () => {
      lease.getLeaseHolder.mockReturnValue(leaseFixture({ deviceId: "device-other" }));
      const result = await service.requestCancel({
        threadId: TID,
        runId: RUN1,
        reason: "user_takeover",
        deviceId: DID,
        now: 2000,
      });
      expect(result.cancelled).toBe(false);
      expect(result.code).toBe("not_lease_holder");
    });

    it("已 cancel 的 runId 再次 cancel 返回 cancelled=false（幂等）", async () => {
      lease.getLeaseHolder.mockReturnValue(leaseFixture());
      await service.requestCancel({
        threadId: TID,
        runId: RUN1,
        reason: "user_takeover",
        deviceId: DID,
        now: 2000,
      });
      // 第二次 cancel（lease 已释放）
      lease.getLeaseHolder.mockReturnValue(null);
      const result = await service.requestCancel({
        threadId: TID,
        runId: RUN1,
        reason: "user_takeover",
        deviceId: DID,
        now: 3000,
      });
      expect(result.cancelled).toBe(false);
    });
  });

  // ─── serverCancel（Server 主动取消） ─────────────────────────

  describe("serverCancel", () => {
    it("Server 强制取消：撤销 lease + 标记 runId 为 cancelled", async () => {
      lease.getLeaseHolder.mockReturnValue(leaseFixture());
      const result = await service.serverCancel({
        threadId: TID,
        runId: RUN1,
        reason: "timeout",
        now: 2000,
      });
      expect(result.cancelled).toBe(true);
      expect(lease.revokeLease).toHaveBeenCalledWith(TID);
    });

    it("Server cancel 无 lease 时仍标记 runId 为 cancelled（防迟到 RPC）", async () => {
      lease.getLeaseHolder.mockReturnValue(null);
      const result = await service.serverCancel({
        threadId: TID,
        runId: RUN1,
        reason: "timeout",
        now: 2000,
      });
      expect(result.cancelled).toBe(true);
      // 已 cancelled 的 runId 仍在 cancelled 集合中
      expect(service.isCancelled(TID, RUN1)).toBe(true);
    });
  });

  // ─── isCancelled（防迟到 RPC） ─────────────────────────

  describe("isCancelled", () => {
    it("未 cancel 的 runId 返回 false", () => {
      expect(service.isCancelled(TID, RUN1)).toBe(false);
    });

    it("cancel 后 runId 标记为 cancelled", async () => {
      lease.getLeaseHolder.mockReturnValue(null);
      await service.serverCancel({
        threadId: TID,
        runId: RUN1,
        reason: "timeout",
        now: 2000,
      });
      expect(service.isCancelled(TID, RUN1)).toBe(true);
    });

    it("不同 runId 互不影响", async () => {
      lease.getLeaseHolder.mockReturnValue(null);
      await service.serverCancel({
        threadId: TID,
        runId: RUN1,
        reason: "timeout",
        now: 2000,
      });
      expect(service.isCancelled(TID, RUN2)).toBe(false);
    });

    it("过期 cancelled 记录自动清理（避免集合无限增长）", async () => {
      // 用较短 TTL 创建 service
      const shortTtlService = new CancelService(lease, 1000);
      lease.getLeaseHolder.mockReturnValue(null);
      await shortTtlService.serverCancel({
        threadId: TID,
        runId: RUN1,
        reason: "timeout",
        now: 1000,
      });
      expect(shortTtlService.isCancelled(TID, RUN1, 1500)).toBe(true);
      // TTL 过期后清理
      expect(shortTtlService.isCancelled(TID, RUN1, 3000)).toBe(false);
    });
  });

  // ─── dropCancelledRpcResult ─────────────────────────

  describe("dropCancelledRpcResult", () => {
    it("cancelled runId 的迟到 RPC 结果被丢弃", async () => {
      lease.getLeaseHolder.mockReturnValue(null);
      await service.serverCancel({
        threadId: TID,
        runId: RUN1,
        reason: "timeout",
        now: 2000,
      });
      expect(service.shouldDropRpcResult(TID, RUN1)).toBe(true);
    });

    it("未 cancel 的 runId RPC 结果正常处理", () => {
      expect(service.shouldDropRpcResult(TID, RUN1)).toBe(false);
    });
  });
});
