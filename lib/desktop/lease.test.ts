import {
  type BrowserLease,
  DEFAULT_LEASE_TTL_MS,
  LeaseManager,
  isLeaseForUser,
  isLeaseHeldBy,
  isLeaseValid,
  needsRenewal,
} from "@/lib/desktop/lease";
import { describe, expect, it } from "vitest";

const NOW = 1700000000000;
const TTL = DEFAULT_LEASE_TTL_MS;

function makeLease(overrides: Partial<BrowserLease> = {}): BrowserLease {
  return {
    threadId: "thread-001",
    userId: "user-001",
    deviceId: "dev-001",
    acquiredAt: NOW,
    expiresAt: NOW + TTL,
    ...overrides,
  };
}

describe("DEFAULT_LEASE_TTL_MS", () => {
  it("为 5 分钟（300000 毫秒）", () => {
    expect(DEFAULT_LEASE_TTL_MS).toBe(5 * 60 * 1000);
  });
});

describe("isLeaseValid()", () => {
  it("未过期返回 true", () => {
    const lease = makeLease({ expiresAt: NOW + 60000 });
    expect(isLeaseValid(lease, NOW)).toBe(true);
  });

  it("过期返回 false", () => {
    const lease = makeLease({ expiresAt: NOW - 1000 });
    expect(isLeaseValid(lease, NOW)).toBe(false);
  });

  it("刚好过期（now === expiresAt）返回 false", () => {
    const lease = makeLease({ expiresAt: NOW });
    expect(isLeaseValid(lease, NOW)).toBe(false);
  });

  it("now 在 expiresAt 之前 1ms 返回 true", () => {
    const lease = makeLease({ expiresAt: NOW + 1 });
    expect(isLeaseValid(lease, NOW)).toBe(true);
  });
});

describe("isLeaseHeldBy()", () => {
  it("匹配 deviceId 返回 true", () => {
    const lease = makeLease({ deviceId: "dev-001" });
    expect(isLeaseHeldBy(lease, "dev-001")).toBe(true);
  });

  it("不匹配 deviceId 返回 false", () => {
    const lease = makeLease({ deviceId: "dev-001" });
    expect(isLeaseHeldBy(lease, "dev-002")).toBe(false);
  });
});

describe("isLeaseForUser()", () => {
  it("匹配 userId + threadId 返回 true", () => {
    const lease = makeLease({ userId: "user-001", threadId: "thread-001" });
    expect(isLeaseForUser(lease, "user-001", "thread-001")).toBe(true);
  });

  it("userId 不匹配返回 false", () => {
    const lease = makeLease({ userId: "user-001", threadId: "thread-001" });
    expect(isLeaseForUser(lease, "user-002", "thread-001")).toBe(false);
  });

  it("threadId 不匹配返回 false", () => {
    const lease = makeLease({ userId: "user-001", threadId: "thread-001" });
    expect(isLeaseForUser(lease, "user-001", "thread-002")).toBe(false);
  });
});

describe("needsRenewal()", () => {
  it("剩余时间 > 1/3 TTL 返回 false", () => {
    // TTL = 300000，1/3 = 100000
    // 剩余 200000 > 100000
    const lease = makeLease({ acquiredAt: NOW, expiresAt: NOW + TTL });
    expect(needsRenewal(lease, NOW)).toBe(false);
  });

  it("剩余时间 = 1/3 TTL 返回 false（边界不续期）", () => {
    // 剩余刚好 1/3 TTL（100000）
    const lease = makeLease({ acquiredAt: NOW, expiresAt: NOW + TTL });
    // NOW + 200000 时剩余 100000
    expect(needsRenewal(lease, NOW + 200000)).toBe(false);
  });

  it("剩余时间 < 1/3 TTL 返回 true", () => {
    // 剩余 50000 < 100000
    const lease = makeLease({ acquiredAt: NOW, expiresAt: NOW + TTL });
    // NOW + 250000 时剩余 50000
    expect(needsRenewal(lease, NOW + 250000)).toBe(true);
  });

  it("已过期返回 true", () => {
    const lease = makeLease({ acquiredAt: NOW, expiresAt: NOW + 1000 });
    expect(needsRenewal(lease, NOW + 2000)).toBe(true);
  });
});

describe("LeaseManager", () => {
  describe("getLease()", () => {
    it("不存在返回 null", () => {
      const lm = new LeaseManager();
      expect(lm.getLease("thread-001")).toBeNull();
    });

    it("获取已存在的 lease", () => {
      const lm = new LeaseManager();
      const result = lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(lm.getLease("thread-001")).toEqual(result.lease);
      }
    });
  });

  describe("acquireLease()", () => {
    it("无 lease 时获取成功", () => {
      const lm = new LeaseManager();
      const result = lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lease.threadId).toBe("thread-001");
        expect(result.lease.userId).toBe("user-001");
        expect(result.lease.deviceId).toBe("dev-001");
        expect(result.lease.acquiredAt).toBe(NOW);
        expect(result.lease.expiresAt).toBe(NOW + TTL);
      }
    });

    it("同一设备重新获取自己的 lease 成功", () => {
      const lm = new LeaseManager();
      lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      const result = lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW + 1000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lease.acquiredAt).toBe(NOW + 1000);
      }
    });

    it("已有有效 lease 时其他设备获取失败", () => {
      const lm = new LeaseManager();
      lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      const result = lm.acquireLease("thread-001", "user-002", "dev-002", TTL, NOW + 1000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("lease_held_by_other");
      }
    });

    it("过期 lease 自动清理后可获取", () => {
      const lm = new LeaseManager();
      lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      // lease 已过期
      const result = lm.acquireLease("thread-001", "user-002", "dev-002", TTL, NOW + TTL + 1000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lease.deviceId).toBe("dev-002");
      }
    });

    it("自定义 TTL 生效", () => {
      const lm = new LeaseManager();
      const customTtl = 10000;
      const result = lm.acquireLease("thread-001", "user-001", "dev-001", customTtl, NOW);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lease.expiresAt).toBe(NOW + customTtl);
      }
    });
  });

  describe("releaseLease()", () => {
    it("持有设备可以释放", () => {
      const lm = new LeaseManager();
      lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      expect(lm.releaseLease("thread-001", "dev-001", NOW)).toBe(true);
      expect(lm.getLease("thread-001")).toBeNull();
    });

    it("非持有设备释放失败", () => {
      const lm = new LeaseManager();
      lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      expect(lm.releaseLease("thread-001", "dev-002", NOW)).toBe(false);
      expect(lm.getLease("thread-001")).not.toBeNull();
    });

    it("释放不存在的 lease 返回 false", () => {
      const lm = new LeaseManager();
      expect(lm.releaseLease("thread-001", "dev-001", NOW)).toBe(false);
    });
  });

  describe("revokeLease()", () => {
    it("强制撤销成功", () => {
      const lm = new LeaseManager();
      lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      expect(lm.revokeLease("thread-001")).toBe(true);
      expect(lm.getLease("thread-001")).toBeNull();
    });

    it("撤销不存在的 lease 返回 false", () => {
      const lm = new LeaseManager();
      expect(lm.revokeLease("thread-001")).toBe(false);
    });

    it("撤销后其他设备可获取", () => {
      const lm = new LeaseManager();
      lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      lm.revokeLease("thread-001");
      const result = lm.acquireLease("thread-001", "user-002", "dev-002", TTL, NOW);
      expect(result.ok).toBe(true);
    });
  });

  describe("cleanupExpired()", () => {
    it("清理过期 lease", () => {
      const lm = new LeaseManager();
      // thread-001 使用短 TTL
      lm.acquireLease("thread-001", "user-001", "dev-001", 1000, NOW);
      // thread-002 使用默认 TTL
      lm.acquireLease("thread-002", "user-002", "dev-002", TTL, NOW);
      // NOW + 2000 时，thread-001 已过期，thread-002 未过期
      expect(lm.cleanupExpired(NOW + 2000)).toBe(1);
      expect(lm.getLease("thread-001")).toBeNull();
      expect(lm.getLease("thread-002")).not.toBeNull();
    });

    it("无过期时返回 0", () => {
      const lm = new LeaseManager();
      lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      expect(lm.cleanupExpired(NOW + 1000)).toBe(0);
    });

    it("清理所有过期 lease", () => {
      const lm = new LeaseManager();
      lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      lm.acquireLease("thread-002", "user-002", "dev-002", TTL, NOW);
      lm.acquireLease("thread-003", "user-003", "dev-003", TTL, NOW);
      expect(lm.cleanupExpired(NOW + TTL + 1000)).toBe(3);
    });
  });

  describe("getActiveLeases()", () => {
    it("返回所有未过期 lease", () => {
      const lm = new LeaseManager();
      lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      lm.acquireLease("thread-002", "user-002", "dev-002", TTL, NOW);
      const active = lm.getActiveLeases();
      expect(active.length).toBe(2);
    });

    it("不返回过期 lease", () => {
      const lm = new LeaseManager();
      lm.acquireLease("thread-001", "user-001", "dev-001", TTL, NOW);
      lm.acquireLease("thread-002", "user-002", "dev-002", TTL, NOW);
      // 一个过期
      lm.cleanupExpired(NOW + TTL + 1000);
      const active = lm.getActiveLeases();
      expect(active.length).toBe(0);
    });

    it("空时返回空数组", () => {
      const lm = new LeaseManager();
      expect(lm.getActiveLeases()).toEqual([]);
    });
  });
});
