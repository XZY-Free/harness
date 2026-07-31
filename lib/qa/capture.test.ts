import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.6 Stage B：capturePreview 单测。mock @/lib/qa/browser 的 openQaPage 与
 * @/lib/qa/artifact 的 saveScreenshot，不真实 launch 浏览器。
 */

const browser = vi.hoisted(() => ({
  openQaPage: vi.fn(),
  viewportOf: vi.fn((w: number, h = 720) => ({ width: w, height: h })),
}));
const artifact = vi.hoisted(() => ({ saveScreenshot: vi.fn() }));

vi.mock("@/lib/qa/browser", () => ({
  openQaPage: browser.openQaPage,
  viewportOf: browser.viewportOf,
}));
vi.mock("@/lib/qa/artifact", () => ({ saveScreenshot: artifact.saveScreenshot }));

import { capturePreviewUrl } from "@/lib/qa/capture";

function makePage(
  overrides: Partial<{
    goto: ReturnType<typeof vi.fn>;
    screenshotFullPage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    goto: overrides.goto ?? vi.fn().mockResolvedValue(undefined),
    screenshotFullPage:
      overrides.screenshotFullPage ?? vi.fn().mockResolvedValue(Buffer.from("png")),
    close: overrides.close ?? vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.QA_VIEWPORTS = "375,768,1280";
  artifact.saveScreenshot.mockResolvedValue("t/qa/cap.png");
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.QA_VIEWPORTS;
});

describe("capturePreviewUrl", () => {
  it("默认 desktop viewport（QA_VIEWPORTS 末档 1280）截图落盘", async () => {
    const page = makePage();
    browser.openQaPage.mockResolvedValue(page);
    const r = await capturePreviewUrl({
      url: "http://localhost:1234/",
      threadId: "t1",
      checkId: "cap1",
    });
    expect(r.ok).toBe(true);
    expect(r.viewport).toBe(1280);
    expect(page.goto).toHaveBeenCalledWith("http://localhost:1234/", expect.any(Number));
    expect(page.screenshotFullPage).toHaveBeenCalled();
    expect(artifact.saveScreenshot).toHaveBeenCalledWith("t1", "cap1", expect.any(Buffer), 1280);
    expect(r.screenshotPath).toBe("t/qa/cap.png");
    expect(page.close).toHaveBeenCalled();
  });

  it("指定 viewport=375 生效", async () => {
    const page = makePage();
    browser.openQaPage.mockResolvedValue(page);
    const r = await capturePreviewUrl({
      url: "http://x/",
      threadId: "t1",
      checkId: "cap2",
      viewport: 375,
    });
    expect(r.viewport).toBe(375);
    expect(browser.viewportOf).toHaveBeenCalledWith(375);
  });

  it("导航失败 → ok:false + error，仍关闭 page", async () => {
    const page = makePage({ goto: vi.fn().mockRejectedValue(new Error("net::ERR_REFUSED")) });
    browser.openQaPage.mockResolvedValue(page);
    const r = await capturePreviewUrl({
      url: "http://x/",
      threadId: "t1",
      checkId: "cap3",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("net::ERR_REFUSED");
    expect(page.close).toHaveBeenCalled();
  });

  it("openQaPage 抛错（浏览器不可用）→ ok:false + error", async () => {
    browser.openQaPage.mockRejectedValue(new Error("Playwright 浏览器不可用"));
    const r = await capturePreviewUrl({
      url: "http://x/",
      threadId: "t1",
      checkId: "cap4",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Playwright 浏览器不可用");
  });
});
