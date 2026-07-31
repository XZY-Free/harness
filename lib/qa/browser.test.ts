import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.6 Stage A：Playwright 浏览器生命周期单测。
 * 用 mock Playwright（vi.mock("playwright")）注入假 chromium，**不真实 launch 浏览器**。
 * P1-4：测 CountingSemaphore 并发控制（经 openQaPage acquire/release）。
 */

const launch = vi.fn();
const close = vi.fn();
const newContext = vi.fn();

vi.mock("playwright", () => ({
  chromium: { launch },
}));

import {
  __resetQaBrowserForTest,
  isBrowserAvailable,
  openQaPage,
  viewportOf,
} from "@/lib/qa/browser";

const origMaxConc = process.env.QA_MAX_BROWSER_CONCURRENCY;

function makePage(
  overrides: Partial<{
    goto: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    goto: overrides.goto ?? vi.fn().mockResolvedValue(undefined),
    screenshot: overrides.screenshot ?? vi.fn().mockResolvedValue(Buffer.from("png")),
    evaluate: overrides.evaluate ?? vi.fn().mockResolvedValue(null),
    close: overrides.close ?? vi.fn().mockResolvedValue(undefined),
    on: overrides.on ?? vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetQaBrowserForTest();
  launch.mockReset();
  close.mockReset();
  newContext.mockReset();
  newContext.mockResolvedValue({ newPage: async () => makePage(), close: async () => {} });
  launch.mockResolvedValue({ close, newContext });
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.QA_MAX_BROWSER_CONCURRENCY;
});

afterEach(() => {
  __resetQaBrowserForTest();
  if (origMaxConc !== undefined) process.env.QA_MAX_BROWSER_CONCURRENCY = origMaxConc;
  else {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.QA_MAX_BROWSER_CONCURRENCY;
  }
});

describe("viewportOf", () => {
  it("构造默认高度 720 的 viewport", () => {
    expect(viewportOf(375)).toEqual({ width: 375, height: 720 });
  });
  it("自定义高度", () => {
    expect(viewportOf(1280, 800)).toEqual({ width: 1280, height: 800 });
  });
});

describe("isBrowserAvailable", () => {
  it("launch 成功 → true（单例缓存，不重复 launch）", async () => {
    await expect(isBrowserAvailable()).resolves.toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    await expect(isBrowserAvailable()).resolves.toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("launch 抛错 → false（不缓存失败，下次重试）", async () => {
    launch.mockRejectedValueOnce(new Error("Executable doesn't exist"));
    await expect(isBrowserAvailable()).resolves.toBe(false);
    // 失败不缓存：再次查询会重试 launch
    await expect(isBrowserAvailable()).resolves.toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
  });
});

describe("openQaPage", () => {
  it("建 context(viewport) + page，挂载钩子并返回句柄", async () => {
    const onConsole = vi.fn();
    const page = makePage();
    newContext.mockResolvedValueOnce({
      newPage: async () => page,
      close: async () => {},
    });
    const qaPage = await openQaPage(viewportOf(375), { onConsole });
    expect(newContext).toHaveBeenCalledWith({ viewport: { width: 375, height: 720 } });
    expect(qaPage.viewport).toEqual({ width: 375, height: 720 });

    await qaPage.goto("http://x/");
    expect(page.goto).toHaveBeenCalled();

    const buf = await qaPage.screenshotFullPage();
    expect(page.screenshot).toHaveBeenCalledWith({ fullPage: true, type: "png" });
    expect(Buffer.isBuffer(buf)).toBe(true);

    await qaPage.evaluate("document.title");
    expect(page.evaluate).toHaveBeenCalledWith("document.title");

    expect(page.on).toHaveBeenCalled();
    await qaPage.close();
    expect(page.close).toHaveBeenCalled();
  });

  it("浏览器不可用 → 抛 'Playwright 浏览器不可用'", async () => {
    launch.mockRejectedValueOnce(new Error("no browser"));
    await expect(openQaPage(viewportOf(375))).rejects.toThrow("Playwright 浏览器不可用");
  });

  // V9 阶段 9：storageState 传入 browser.newContext
  it("storageState 传入 → newContext 收到 storageState 参数", async () => {
    const page = makePage();
    newContext.mockResolvedValueOnce({
      newPage: async () => page,
      close: async () => {},
    });
    const sampleState = {
      cookies: [{ name: "session", value: "abc", domain: "localhost", path: "/" }],
      origins: [{ origin: "http://localhost", localStorage: [] }],
    };
    await openQaPage(viewportOf(1280), { storageState: sampleState });
    expect(newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: sampleState }));
  });

  it("无 storageState → newContext 不含 storageState 字段", async () => {
    newContext.mockResolvedValueOnce({
      newPage: async () => makePage(),
      close: async () => {},
    });
    await openQaPage(viewportOf(375));
    expect(newContext).toHaveBeenCalledWith({ viewport: { width: 375, height: 720 } });
  });
});

// ─── P1-4：浏览器并发控制信号量 ──────────────────────────────
// 经 openQaPage 验证 CountingSemaphore:超 maxBrowserConcurrency 后续 acquire 等待,
// release 后等待的 acquire 放行。信号量是私有类,通过 openQaPage 行为观察。

describe("openQaPage 并发信号量", () => {
  it("P1-4 并发 acquire 超 maxBrowserConcurrency → 后续 acquire 等待,release 后放行", async () => {
    // 限流为 1:同一时刻只允许 1 个 page 占用槽位
    process.env.QA_MAX_BROWSER_CONCURRENCY = "1";
    // 用受控的 newPage:记录创建顺序,方便断言
    const createdPages: ReturnType<typeof makePage>[] = [];
    newContext.mockResolvedValue({
      newPage: async () => {
        const p = makePage();
        createdPages.push(p);
        return p;
      },
      close: async () => {},
    });

    // 第 1 个 acquire 立即成功（active 0 < max 1）
    const p1Promise = openQaPage(viewportOf(375));
    const p1 = await p1Promise;
    expect(createdPages).toHaveLength(1);

    // 第 2 个 acquire 会卡在信号量等待（active 1 = max 1,waiter 排队）
    let p2Resolved = false;
    const p2Promise = openQaPage(viewportOf(768)).then((p) => {
      p2Resolved = true;
      return p;
    });
    // 让微任务跑一轮,确认 p2 仍在等待
    await Promise.resolve();
    await Promise.resolve();
    expect(p2Resolved).toBe(false);
    expect(createdPages).toHaveLength(1); // 第 2 个 page 尚未创建

    // release 第 1 个 → 信号量放行第 2 个 acquire
    await p1.close();
    const p2 = await p2Promise;
    expect(p2Resolved).toBe(true);
    expect(createdPages).toHaveLength(2);

    await p2.close();
  });

  it("P1-4 maxBrowserConcurrency=2 → 两个并发 acquire 同时成功,第三个等待", async () => {
    process.env.QA_MAX_BROWSER_CONCURRENCY = "2";
    const createdPages: ReturnType<typeof makePage>[] = [];
    newContext.mockResolvedValue({
      newPage: async () => {
        const p = makePage();
        createdPages.push(p);
        return p;
      },
      close: async () => {},
    });

    // 前 2 个 acquire 同时成功（active 0→1→2,均 < max 2 边界）
    const [p1, p2] = await Promise.all([openQaPage(viewportOf(375)), openQaPage(viewportOf(768))]);
    expect(createdPages).toHaveLength(2);

    // 第 3 个 acquire 等待（active 2 = max 2）
    let p3Resolved = false;
    const p3Promise = openQaPage(viewportOf(1280)).then((p) => {
      p3Resolved = true;
      return p;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(p3Resolved).toBe(false);
    expect(createdPages).toHaveLength(2);

    // release 一个 → 第 3 个放行
    await p1.close();
    const p3 = await p3Promise;
    expect(p3Resolved).toBe(true);
    expect(createdPages).toHaveLength(3);

    await p2.close();
    await p3.close();
  });
});
