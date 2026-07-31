import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.6 Stage C：runResponsiveCheckUrl 单测。mock openQaPage（evaluate 返回布局 probe）。
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

import { runResponsiveCheckUrl } from "@/lib/qa/responsive";

interface Probe {
  scrollWidth: number;
  clientWidth: number;
  nodeCount: number;
  textLength: number;
  hasMedia: boolean;
  overlapCount?: number;
  truncatedCount?: number;
}

function setup(probeByWidth: Record<number, Probe>) {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (script: string) => {
      // script 是布局探测 IIFE；按当前 viewport 返回预设 probe
      const vp = (browser.viewportOf as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as number;
      return {
        overlapCount: 0,
        truncatedCount: 0,
        ...(probeByWidth[vp] ?? {
          scrollWidth: 1280,
          clientWidth: 1280,
          nodeCount: 5,
          textLength: 10,
          hasMedia: false,
        }),
      };
    }),
    screenshotFullPage: vi.fn().mockResolvedValue(Buffer.from("png")),
    close: vi.fn().mockResolvedValue(undefined),
  };
  browser.openQaPage.mockResolvedValue(page);
  return page;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.QA_VIEWPORTS = "375,1280";
  artifact.saveScreenshot.mockResolvedValue("t/qa/x.png");
  artifact.saveQaReport.mockResolvedValue("t/qa/x.json");
});
afterEach(() => {
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.QA_VIEWPORTS;
});

describe("runResponsiveCheckUrl", () => {
  it("干净布局（无溢出、有内容）→ ok:true", async () => {
    setup({
      375: { scrollWidth: 375, clientWidth: 375, nodeCount: 8, textLength: 20, hasMedia: false },
      1280: { scrollWidth: 1280, clientWidth: 1280, nodeCount: 12, textLength: 30, hasMedia: true },
    });
    const r = await runResponsiveCheckUrl({ url: "http://x/", threadId: "t1", checkId: "r1" });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("水平溢出 → horizontal_overflow failure", async () => {
    setup({
      375: { scrollWidth: 800, clientWidth: 375, nodeCount: 5, textLength: 10, hasMedia: false },
      1280: { scrollWidth: 1280, clientWidth: 1280, nodeCount: 5, textLength: 10, hasMedia: false },
    });
    const r = await runResponsiveCheckUrl({ url: "http://x/", threadId: "t1", checkId: "r2" });
    expect(r.ok).toBe(false);
    expect(r.failures.find((f) => f.type === "horizontal_overflow")?.viewport).toBe(375);
    // 移动端溢出 + 桌面端不溢出 → layout_break
    expect(r.failures.find((f) => f.type === "layout_break")).toBeTruthy();
  });

  it("内容不可见（nodeCount=0）→ content_invisible failure", async () => {
    setup({
      375: { scrollWidth: 375, clientWidth: 375, nodeCount: 0, textLength: 0, hasMedia: false },
      1280: { scrollWidth: 1280, clientWidth: 1280, nodeCount: 5, textLength: 10, hasMedia: false },
    });
    const r = await runResponsiveCheckUrl({ url: "http://x/", threadId: "t1", checkId: "r3" });
    expect(r.failures.find((f) => f.type === "content_invisible")).toBeTruthy();
  });

  it("两端都溢出 → horizontal_overflow ×2，无 layout_break", async () => {
    setup({
      375: { scrollWidth: 900, clientWidth: 375, nodeCount: 5, textLength: 10, hasMedia: false },
      1280: { scrollWidth: 1500, clientWidth: 1280, nodeCount: 5, textLength: 10, hasMedia: false },
    });
    const r = await runResponsiveCheckUrl({ url: "http://x/", threadId: "t1", checkId: "r4" });
    expect(r.failures.filter((f) => f.type === "horizontal_overflow")).toHaveLength(2);
    expect(r.failures.find((f) => f.type === "layout_break")).toBeFalsy();
  });

  it("独立元素发生明显重叠 → element_overlap failure", async () => {
    setup({
      375: {
        scrollWidth: 375,
        clientWidth: 375,
        nodeCount: 8,
        textLength: 20,
        hasMedia: false,
        overlapCount: 1,
      },
      1280: {
        scrollWidth: 1280,
        clientWidth: 1280,
        nodeCount: 8,
        textLength: 20,
        hasMedia: false,
      },
    });
    const r = await runResponsiveCheckUrl({ url: "http://x/", threadId: "t1", checkId: "r5" });
    expect(r.failures.find((f) => f.type === "element_overlap")?.viewport).toBe(375);
  });
});
