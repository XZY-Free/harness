import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_SESSION_PARTITION,
  BROWSER_PARTITION_PREFIX,
  INCOGNITO_PARTITION_PREFIX,
  type SessionManager,
  SessionManager as SessionManagerClass,
  getBrowserPartition,
  getIncognitoPartition,
  isAppSession,
  isBrowserProfile,
  isIncognito,
  isPersistentPartition,
  sanitizeUserId,
} from "./session-manager";

/**
 * V10 Phase 4：Session partition 管理器单元测试。
 *
 * 验证 partition 名称生成与映射：
 * - 常量：APP_SESSION_PARTITION / BROWSER_PARTITION_PREFIX / INCOGNITO_PARTITION_PREFIX
 * - sanitizeUserId：合法字符保留、特殊字符替换、空字符串、中文
 * - getBrowserPartition：格式、幂等、sanitize 应用
 * - getIncognitoPartition：格式、nonce、自动生成、唯一性
 * - isPersistentPartition / isAppSession / isBrowserProfile / isIncognito 判断
 * - SessionManager 类：getOrCreate/create/destroy/count/remove/userIds
 *
 * 不依赖 electron，纯逻辑验证。
 */

describe("session-manager 常量 (V10 Phase 4)", () => {
  it("APP_SESSION_PARTITION 等于 persist:snowharness-app", () => {
    expect(APP_SESSION_PARTITION).toBe("persist:snowharness-app");
  });

  it("BROWSER_PARTITION_PREFIX 等于 persist:snowharness-browser-", () => {
    expect(BROWSER_PARTITION_PREFIX).toBe("persist:snowharness-browser-");
  });

  it("INCOGNITO_PARTITION_PREFIX 等于 snowharness-incognito-（不加 persist:）", () => {
    expect(INCOGNITO_PARTITION_PREFIX).toBe("snowharness-incognito-");
  });
});

describe("sanitizeUserId (V10 Phase 4)", () => {
  it("合法字符（字母数字下划线连字符）全部保留", () => {
    expect(sanitizeUserId("user_123-ABC")).toBe("user_123-ABC");
  });

  it("特殊字符替换为下划线", () => {
    expect(sanitizeUserId("user@domain.com")).toBe("user_domain_com");
  });

  it("空字符串返回空字符串", () => {
    expect(sanitizeUserId("")).toBe("");
  });

  it("中文字符替换为下划线", () => {
    expect(sanitizeUserId("用户123")).toBe("__123");
  });

  it("多个连续特殊字符每个替换为下划线（不折叠）", () => {
    expect(sanitizeUserId("a/b.c:d")).toBe("a_b_c_d");
  });

  it("纯特殊字符全替换为下划线", () => {
    expect(sanitizeUserId("@#$%")).toBe("____");
  });
});

describe("getBrowserPartition (V10 Phase 4)", () => {
  it("格式正确：persist:snowharness-browser-{userId}", () => {
    expect(getBrowserPartition("alice")).toBe("persist:snowharness-browser-alice");
  });

  it("同一 userId 多次调用结果一致（共享登录态）", () => {
    const a = getBrowserPartition("bob");
    const b = getBrowserPartition("bob");
    expect(a).toBe(b);
  });

  it("userId 含特殊字符被 sanitize 后拼接", () => {
    expect(getBrowserPartition("user@domain")).toBe("persist:snowharness-browser-user_domain");
  });

  it("不同 userId 生成不同 partition", () => {
    expect(getBrowserPartition("alice")).not.toBe(getBrowserPartition("bob"));
  });
});

describe("getIncognitoPartition (V10 Phase 4)", () => {
  it("格式正确：snowharness-incognito-{threadId}-{nonce}（无 persist:）", () => {
    const partition = getIncognitoPartition("thread-1", "abc123");
    expect(partition).toBe("snowharness-incognito-thread-1-abc123");
    // 不以 persist: 开头
    expect(partition.startsWith("persist:")).toBe(false);
  });

  it("带 nonce 时拼接到末尾", () => {
    const partition = getIncognitoPartition("thread-2", "nonce-xyz");
    expect(partition).toBe("snowharness-incognito-thread-2-nonce-xyz");
  });

  it("不带 nonce 时自动生成（基于 Date.now 36 进制）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0, 0));
    const ts = Date.now().toString(36);
    const partition = getIncognitoPartition("thread-3");
    expect(partition).toBe(`snowharness-incognito-thread-3-${ts}`);
    vi.useRealTimers();
  });

  it("同一 threadId 不同 nonce 生成不同 partition", () => {
    const a = getIncognitoPartition("thread-1", "n1");
    const b = getIncognitoPartition("thread-1", "n2");
    expect(a).not.toBe(b);
  });

  it("threadId 含特殊字符被 sanitize", () => {
    const partition = getIncognitoPartition("thread/1", "nonce");
    expect(partition).toBe("snowharness-incognito-thread_1-nonce");
  });
});

describe("isPersistentPartition (V10 Phase 4)", () => {
  it("persist: 前缀返回 true", () => {
    expect(isPersistentPartition("persist:snowharness-app")).toBe(true);
    expect(isPersistentPartition("persist:snowharness-browser-alice")).toBe(true);
  });

  it("非 persist: 前缀返回 false", () => {
    expect(isPersistentPartition("snowharness-incognito-thread-1-nonce")).toBe(false);
    expect(isPersistentPartition("memory")).toBe(false);
    expect(isPersistentPartition("")).toBe(false);
  });
});

describe("isAppSession (V10 Phase 4)", () => {
  it("精确匹配 APP_SESSION_PARTITION 返回 true", () => {
    expect(isAppSession("persist:snowharness-app")).toBe(true);
  });

  it("不匹配 browser profile partition 返回 false", () => {
    expect(isAppSession("persist:snowharness-browser-alice")).toBe(false);
  });

  it("不匹配 incognito partition 返回 false", () => {
    expect(isAppSession("snowharness-incognito-thread-1-nonce")).toBe(false);
  });

  it("前缀相似但不精确匹配返回 false", () => {
    expect(isAppSession("persist:snowharness-app-extra")).toBe(false);
    expect(isAppSession("persist:snowharness-app ")).toBe(false);
  });
});

describe("isBrowserProfile (V10 Phase 4)", () => {
  it("前缀匹配 persist:snowharness-browser- 返回 true", () => {
    expect(isBrowserProfile("persist:snowharness-browser-alice")).toBe(true);
    expect(isBrowserProfile("persist:snowharness-browser-user_domain")).toBe(true);
  });

  it("不匹配 app session partition 返回 false", () => {
    expect(isBrowserProfile("persist:snowharness-app")).toBe(false);
  });

  it("不匹配 incognito partition 返回 false", () => {
    expect(isBrowserProfile("snowharness-incognito-thread-1-nonce")).toBe(false);
  });

  it("仅前缀本身（无 userId）也匹配（容错）", () => {
    expect(isBrowserProfile("persist:snowharness-browser-")).toBe(true);
  });
});

describe("isIncognito (V10 Phase 4)", () => {
  it("前缀匹配 snowharness-incognito- 返回 true", () => {
    expect(isIncognito("snowharness-incognito-thread-1-nonce")).toBe(true);
  });

  it("不匹配 app session partition 返回 false", () => {
    expect(isIncognito("persist:snowharness-app")).toBe(false);
  });

  it("不匹配 browser profile partition 返回 false", () => {
    expect(isIncognito("persist:snowharness-browser-alice")).toBe(false);
  });

  it("仅前缀本身（无 threadId/nonce）也匹配（容错）", () => {
    expect(isIncognito("snowharness-incognito-")).toBe(true);
  });
});

describe("SessionManager 类 (V10 Phase 4)", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManagerClass();
  });

  describe("getOrCreateBrowserPartition", () => {
    it("首次调用创建并返回 partition", () => {
      const partition = manager.getOrCreateBrowserPartition("alice");
      expect(partition).toBe("persist:snowharness-browser-alice");
      expect(manager.getUserIds()).toContain("alice");
    });

    it("再次获取相同 userId 返回相同 partition（共享登录态）", () => {
      const first = manager.getOrCreateBrowserPartition("bob");
      const second = manager.getOrCreateBrowserPartition("bob");
      expect(first).toBe(second);
      expect(manager.getUserIds().filter((id) => id === "bob")).toHaveLength(1);
    });

    it("不同 userId 生成不同 partition", () => {
      const a = manager.getOrCreateBrowserPartition("alice");
      const b = manager.getOrCreateBrowserPartition("bob");
      expect(a).not.toBe(b);
      expect(manager.getUserIds()).toContain("alice");
      expect(manager.getUserIds()).toContain("bob");
    });

    it("userId 含特殊字符被 sanitize 后保存", () => {
      const partition = manager.getOrCreateBrowserPartition("user@domain");
      expect(partition).toBe("persist:snowharness-browser-user_domain");
      // 内部 key 仍为原始 userId（removeBrowserProfile 应能匹配）
      expect(manager.removeBrowserProfile("user@domain")).toBe(true);
    });
  });

  describe("createIncognitoPartition", () => {
    it("创建并返回 incognito partition", () => {
      const partition = manager.createIncognitoPartition("thread-1", "nonce-1");
      expect(partition).toBe("snowharness-incognito-thread-1-nonce-1");
      expect(manager.getIncognitoCount("thread-1")).toBe(1);
    });

    it("同一线程创建多个 incognito partition 全部被追踪", () => {
      manager.createIncognitoPartition("thread-1", "n1");
      manager.createIncognitoPartition("thread-1", "n2");
      manager.createIncognitoPartition("thread-1", "n3");
      expect(manager.getIncognitoCount("thread-1")).toBe(3);
    });

    it("不同线程的 incognito 计数互相独立", () => {
      manager.createIncognitoPartition("thread-1", "n1");
      manager.createIncognitoPartition("thread-2", "n1");
      manager.createIncognitoPartition("thread-2", "n2");
      expect(manager.getIncognitoCount("thread-1")).toBe(1);
      expect(manager.getIncognitoCount("thread-2")).toBe(2);
    });

    it("不带 nonce 时基于时间戳生成唯一 partition", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0, 0));
      const a = manager.createIncognitoPartition("thread-1");
      // 推进时间，确保 Date.now() 返回不同值
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 1, 0));
      const b = manager.createIncognitoPartition("thread-1");
      expect(a).not.toBe(b);
      expect(manager.getIncognitoCount("thread-1")).toBe(2);
      vi.useRealTimers();
    });
  });

  describe("destroyIncognitoPartitions", () => {
    it("销毁线程所有 incognito 并返回被销毁的 partition 列表", () => {
      const p1 = manager.createIncognitoPartition("thread-1", "n1");
      const p2 = manager.createIncognitoPartition("thread-1", "n2");
      const destroyed = manager.destroyIncognitoPartitions("thread-1");
      expect(destroyed).toHaveLength(2);
      expect(destroyed).toContain(p1);
      expect(destroyed).toContain(p2);
      expect(manager.getIncognitoCount("thread-1")).toBe(0);
    });

    it("不存在的 thread 返回空数组", () => {
      expect(manager.destroyIncognitoPartitions("nonexistent")).toEqual([]);
    });

    it("销毁后可重新创建（无残留状态）", () => {
      manager.createIncognitoPartition("thread-1", "n1");
      manager.destroyIncognitoPartitions("thread-1");
      const partition = manager.createIncognitoPartition("thread-1", "n2");
      expect(partition).toBe("snowharness-incognito-thread-1-n2");
      expect(manager.getIncognitoCount("thread-1")).toBe(1);
    });

    it("销毁一个线程不影响其他线程的 incognito", () => {
      manager.createIncognitoPartition("thread-1", "n1");
      manager.createIncognitoPartition("thread-2", "n1");
      manager.destroyIncognitoPartitions("thread-1");
      expect(manager.getIncognitoCount("thread-1")).toBe(0);
      expect(manager.getIncognitoCount("thread-2")).toBe(1);
    });
  });

  describe("getIncognitoCount", () => {
    it("存在的线程返回正确数量", () => {
      manager.createIncognitoPartition("thread-1", "n1");
      manager.createIncognitoPartition("thread-1", "n2");
      expect(manager.getIncognitoCount("thread-1")).toBe(2);
    });

    it("不存在的线程返回 0", () => {
      expect(manager.getIncognitoCount("nonexistent")).toBe(0);
    });
  });

  describe("removeBrowserProfile", () => {
    it("存在的 userId 移除成功返回 true", () => {
      manager.getOrCreateBrowserPartition("alice");
      expect(manager.removeBrowserProfile("alice")).toBe(true);
      expect(manager.getUserIds()).not.toContain("alice");
    });

    it("不存在的 userId 移除返回 false", () => {
      expect(manager.removeBrowserProfile("nonexistent")).toBe(false);
    });

    it("移除后再次 getOrCreate 重新创建", () => {
      manager.getOrCreateBrowserPartition("alice");
      manager.removeBrowserProfile("alice");
      const partition = manager.getOrCreateBrowserPartition("alice");
      expect(partition).toBe("persist:snowharness-browser-alice");
      expect(manager.getUserIds()).toContain("alice");
    });
  });

  describe("getUserIds", () => {
    it("初始无用户返回空数组", () => {
      expect(manager.getUserIds()).toEqual([]);
    });

    it("返回所有已注册的 userId", () => {
      manager.getOrCreateBrowserPartition("alice");
      manager.getOrCreateBrowserPartition("bob");
      manager.getOrCreateBrowserPartition("carol");
      const ids = manager.getUserIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain("alice");
      expect(ids).toContain("bob");
      expect(ids).toContain("carol");
    });

    it("移除后 getUserIds 不再包含该 userId", () => {
      manager.getOrCreateBrowserPartition("alice");
      manager.getOrCreateBrowserPartition("bob");
      manager.removeBrowserProfile("alice");
      const ids = manager.getUserIds();
      expect(ids).toEqual(["bob"]);
    });
  });
});
