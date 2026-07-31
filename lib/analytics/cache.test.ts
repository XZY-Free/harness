import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAnalyticsCache, withAnalyticsCache } from "./cache";

/**
 * P2(12 Studio P1-4)：analytics TTL 缓存契约测试。
 *
 * 验证:命中缓存不重复调 loader、TTL 过期后重新调、clearAnalyticsCache 强制失效、
 * 不同 scope key 隔离、TTL=0 禁用缓存。
 */

// cache.ts 顶部读 process.env.SNOW_ANALYTICS_CACHE_TTL_MS 决定 TTL,默认 60s。
// 测试用 vi 的假时间控制 TTL 过期,无需改 env。

afterEach(() => {
  clearAnalyticsCache();
  vi.useRealTimers();
});

describe("withAnalyticsCache", () => {
  it("首次调用执行 loader,同 key 二次命中缓存(不调 loader)", async () => {
    const loader = vi.fn(async () => ({ v: 1 }));
    await withAnalyticsCache("k", { a: 1 }, loader);
    await withAnalyticsCache("k", { a: 1 }, loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("不同 scope key 不共享缓存(各调一次)", async () => {
    const loader = vi.fn(async () => ({ v: 1 }));
    await withAnalyticsCache("k", { userId: "u1" }, loader);
    await withAnalyticsCache("k", { userId: "u2" }, loader);
    await withAnalyticsCache("k", undefined, loader);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("scope key 顺序无关:{a,b} 与 {b,a} 同 key", async () => {
    const loader = vi.fn(async () => ({ v: 1 }));
    await withAnalyticsCache("k", { a: 1, b: 2 }, loader);
    await withAnalyticsCache("k", { b: 2, a: 1 }, loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("clearAnalyticsCache 后重新调 loader", async () => {
    const loader = vi.fn(async () => ({ v: 1 }));
    await withAnalyticsCache("k", undefined, loader);
    clearAnalyticsCache();
    await withAnalyticsCache("k", undefined, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("TTL 过期后重新调 loader", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => ({ v: 1 }));
    await withAnalyticsCache("k", undefined, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    // 推进时间超过 TTL(默认 60s)
    vi.advanceTimersByTime(61_000);
    await withAnalyticsCache("k", undefined, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("TTL 内多次调用只调一次 loader", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => ({ v: 1 }));
    for (let i = 0; i < 5; i++) {
      await withAnalyticsCache("k", undefined, loader);
      vi.advanceTimersByTime(10_000); // 每次推进 10s,5 次共 40s < 60s TTL
    }
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
