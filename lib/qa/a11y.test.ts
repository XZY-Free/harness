import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.6 Stage C：runAccessibilitySmokeUrl 单测。mock openQaPage（evaluate 返回 a11y probe）。
 */

const browser = vi.hoisted(() => ({
  openQaPage: vi.fn(),
  viewportOf: vi.fn((w: number, h = 720) => ({ width: w, height: h })),
}));
const artifact = vi.hoisted(() => ({ saveScreenshot: vi.fn(), saveQaReport: vi.fn() }));

vi.mock("@/lib/qa/browser", () => ({
  openQaPage: browser.openQaPage,
  viewportOf: browser.viewportOf,
}));
vi.mock("@/lib/qa/artifact", () => ({
  saveScreenshot: artifact.saveScreenshot,
  saveQaReport: artifact.saveQaReport,
}));

import { runAccessibilitySmokeUrl } from "@/lib/qa/a11y";

interface Probe {
  imagesWithoutAlt: number;
  controlsWithoutLabel: string[];
  lowContrast: number;
  invisibleText: number;
  badTabindex: number;
  hasLandmark: boolean;
}

function setup(probe: Probe) {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(probe),
    screenshotFullPage: vi.fn().mockResolvedValue(Buffer.from("png")),
    close: vi.fn().mockResolvedValue(undefined),
  };
  browser.openQaPage.mockResolvedValue(page);
  return page;
}

const CLEAN: Probe = {
  imagesWithoutAlt: 0,
  controlsWithoutLabel: [],
  lowContrast: 0,
  invisibleText: 0,
  badTabindex: 0,
  hasLandmark: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.QA_VIEWPORTS = "1280";
  artifact.saveScreenshot.mockResolvedValue("t/qa/x.png");
  artifact.saveQaReport.mockResolvedValue("t/qa/x.json");
});
afterEach(() => {
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.QA_VIEWPORTS;
});

describe("runAccessibilitySmokeUrl", () => {
  it("无违规 → ok:true", async () => {
    setup(CLEAN);
    const r = await runAccessibilitySmokeUrl({ url: "http://x/", threadId: "t1", checkId: "a1" });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("img 缺 alt → a11y_img_alt", async () => {
    setup({ ...CLEAN, imagesWithoutAlt: 2 });
    const r = await runAccessibilitySmokeUrl({ url: "http://x/", threadId: "t1", checkId: "a2" });
    expect(r.ok).toBe(false);
    expect(r.failures.find((v) => v.type === "a11y_img_alt")?.detail).toContain("2");
  });

  it("表单控件缺 label → a11y_label", async () => {
    setup({ ...CLEAN, controlsWithoutLabel: ["input[name=email]"] });
    const r = await runAccessibilitySmokeUrl({ url: "http://x/", threadId: "t1", checkId: "a3" });
    expect(r.failures.find((v) => v.type === "a11y_label")?.detail).toContain("email");
  });

  it("color===background 不可见文本 → a11y_contrast", async () => {
    setup({ ...CLEAN, invisibleText: 3 });
    const r = await runAccessibilitySmokeUrl({ url: "http://x/", threadId: "t1", checkId: "a4" });
    expect(r.failures.find((v) => v.type === "a11y_contrast")).toBeTruthy();
  });

  it("文本对比度低于 WCAG 阈值 → a11y_contrast", async () => {
    setup({ ...CLEAN, lowContrast: 2 });
    const r = await runAccessibilitySmokeUrl({ url: "http://x/", threadId: "t1", checkId: "a5" });
    expect(r.failures.find((v) => v.type === "a11y_contrast")?.detail).toContain("2");
  });

  it("tabindex>0 → a11y_tabindex", async () => {
    setup({ ...CLEAN, badTabindex: 1 });
    const r = await runAccessibilitySmokeUrl({ url: "http://x/", threadId: "t1", checkId: "a6" });
    expect(r.failures.find((v) => v.type === "a11y_tabindex")).toBeTruthy();
  });

  it("无 landmark → a11y_landmark", async () => {
    setup({ ...CLEAN, hasLandmark: false });
    const r = await runAccessibilitySmokeUrl({ url: "http://x/", threadId: "t1", checkId: "a7" });
    expect(r.failures.find((v) => v.type === "a11y_landmark")).toBeTruthy();
  });
});
