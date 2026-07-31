import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.6 Stage B：runBrowserCheckUrl 单测。mock @/lib/qa/browser 的 openQaPage
 * （捕获 hooks 并在 goto 期间触发）+ @/lib/qa/artifact 落盘，不真实 launch 浏览器。
 * 覆盖 console error / pageerror / 404（含白名单）/ 白屏 / warning 不阻断。
 */

const browser = vi.hoisted(() => ({
  openQaPage: vi.fn(),
  viewportOf: vi.fn((w: number, h = 720) => ({ width: w, height: h })),
}));
const artifact = vi.hoisted(() => ({
  saveScreenshot: vi.fn(),
  saveQaReport: vi.fn(),
}));

vi.mock("@/lib/qa/browser", () => ({
  openQaPage: browser.openQaPage,
  viewportOf: browser.viewportOf,
}));
vi.mock("@/lib/qa/artifact", () => ({
  saveScreenshot: artifact.saveScreenshot,
  saveQaReport: artifact.saveQaReport,
}));

import { runBrowserCheckUrl } from "@/lib/qa/browser-check";

interface Scenario {
  consoleMsgs?: { level: string; text: string }[];
  pageErrors?: string[];
  responses?: { url: string; status: number; method?: string }[];
  probe?: { bodyHtml: string; nodeCount: number; textLength: number };
  gotoError?: Error;
}

function setup(scenario: Scenario) {
  let hooks: {
    onConsole?: (m: { level: string; text: string }) => void;
    onPageError?: (e: string) => void;
    onResponse?: (r: { url: string; status: number; method?: string }) => void;
  } = {};
  const page = {
    goto: vi.fn(async () => {
      for (const m of scenario.consoleMsgs ?? []) hooks.onConsole?.(m);
      for (const e of scenario.pageErrors ?? []) hooks.onPageError?.(e);
      for (const r of scenario.responses ?? []) hooks.onResponse?.(r);
      if (scenario.gotoError) throw scenario.gotoError;
    }),
    evaluate: vi
      .fn()
      .mockResolvedValue(
        scenario.probe ?? { bodyHtml: "<div>hello</div>", nodeCount: 3, textLength: 5 },
      ),
    screenshotFullPage: vi.fn().mockResolvedValue(Buffer.from("png")),
    close: vi.fn().mockResolvedValue(undefined),
  };
  browser.openQaPage.mockImplementation(async (_vp, h) => {
    hooks = h ?? {};
    return page;
  });
  return page;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.QA_VIEWPORTS = "1280";
  process.env.QA_404_WHITELIST = "";
  artifact.saveScreenshot.mockResolvedValue("t/qa/x.png");
  artifact.saveQaReport.mockResolvedValue("t/qa/x.json");
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.QA_VIEWPORTS;
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.QA_404_WHITELIST;
});

describe("runBrowserCheckUrl", () => {
  it("干净页面 → ok:true，无 failures，证据落盘", async () => {
    setup({});
    const r = await runBrowserCheckUrl({ url: "http://x/", threadId: "t1", checkId: "b1" });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(artifact.saveScreenshot).toHaveBeenCalled();
    expect(artifact.saveQaReport).toHaveBeenCalledWith(
      "t1",
      "b1",
      expect.objectContaining({ checkId: "b1" }),
    );
  });

  it("console error → ok:false + console_error failure；warning 不阻断", async () => {
    setup({
      consoleMsgs: [
        { level: "warning", text: "deprecated" },
        { level: "error", text: "TypeError: x is undefined" },
      ],
    });
    const r = await runBrowserCheckUrl({ url: "http://x/", threadId: "t1", checkId: "b2" });
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]?.type).toBe("console_error");
    expect(r.failures[0]?.detail).toBe("TypeError: x is undefined");
  });

  it("pageerror（未捕获异常）→ failure", async () => {
    setup({ pageErrors: ["Uncaught ReferenceError: foo is not defined"] });
    const r = await runBrowserCheckUrl({ url: "http://x/", threadId: "t1", checkId: "b3" });
    expect(r.ok).toBe(false);
    expect(r.failures.find((f) => f.type === "pageerror")?.detail).toContain("ReferenceError");
  });

  it("HTTP 失败非白名单 → failure；白名单 favicon/fonts 不误杀", async () => {
    process.env.QA_404_WHITELIST = "favicon.ico,fonts";
    setup({
      responses: [
        { url: "http://x/favicon.ico", status: 403 },
        { url: "http://x/fonts/roboto.woff2", status: 404 },
        { url: "http://x/api/users", status: 403 },
      ],
    });
    const r = await runBrowserCheckUrl({ url: "http://x/", threadId: "t1", checkId: "b4" });
    expect(r.ok).toBe(false);
    const httpErrors = r.failures.filter((f) => f.type === "network_http_error");
    expect(httpErrors).toHaveLength(1);
    expect(httpErrors[0]?.detail).toContain("/api/users");
    expect(httpErrors[0]?.detail).toContain("403");
  });

  it("资源加载泛化 console error 由 response 处理，白名单资源不误杀", async () => {
    process.env.QA_404_WHITELIST = "favicon.ico";
    setup({
      consoleMsgs: [
        {
          level: "error",
          text: "Failed to load resource: the server responded with a status of 403 (Forbidden)",
        },
      ],
      responses: [{ url: "http://x/favicon.ico", status: 403 }],
    });
    const r = await runBrowserCheckUrl({ url: "http://x/", threadId: "t1", checkId: "b4b" });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("previewToken 通过 x-preview-token header 传给浏览器 context，不拼进报告 url", async () => {
    setup({});
    await runBrowserCheckUrl({
      url: "http://x/",
      previewToken: "tok-123",
      threadId: "t1",
      checkId: "b4c",
    });
    expect(browser.openQaPage).toHaveBeenCalledWith(
      { width: 1280, height: 720 },
      expect.objectContaining({ headers: { "x-preview-token": "tok-123" } }),
    );
    expect(artifact.saveQaReport).toHaveBeenCalledWith(
      "t1",
      "b4c",
      expect.objectContaining({ url: "http://x/" }),
    );
  });

  it("白屏（body innerHTML 空）→ blank failure", async () => {
    setup({ probe: { bodyHtml: "   ", nodeCount: 0, textLength: 0 } });
    const r = await runBrowserCheckUrl({ url: "http://x/", threadId: "t1", checkId: "b5" });
    expect(r.ok).toBe(false);
    expect(r.failures.find((f) => f.type === "blank")).toBeTruthy();
  });

  it("白屏（有 DOM 节点但 bodyHtml 空）→ blank failure", async () => {
    setup({ probe: { bodyHtml: "", nodeCount: 1, textLength: 0 } });
    const r = await runBrowserCheckUrl({ url: "http://x/", threadId: "t1", checkId: "b6" });
    expect(r.failures.find((f) => f.type === "blank")).toBeTruthy();
  });

  it("多 viewport 逐一检查，failure 带 viewport", async () => {
    process.env.QA_VIEWPORTS = "375,1280";
    setup({ consoleMsgs: [{ level: "error", text: "boom" }] });
    const r = await runBrowserCheckUrl({ url: "http://x/", threadId: "t1", checkId: "b7" });
    expect(r.viewports).toEqual([375, 1280]);
    expect(r.failures).toHaveLength(2);
    expect(
      r.failures.map((f) => f.viewport).sort((a?: number, b?: number) => (a ?? 0) - (b ?? 0)),
    ).toEqual([375, 1280]);
  });

  it("导航失败 → navigation_failed failure", async () => {
    setup({ gotoError: new Error("net::ERR_REFUSED") });
    const r = await runBrowserCheckUrl({ url: "http://x/", threadId: "t1", checkId: "b8" });
    expect(r.ok).toBe(false);
    expect(r.failures.find((f) => f.type === "navigation_failed")?.detail).toBe("net::ERR_REFUSED");
  });
});
