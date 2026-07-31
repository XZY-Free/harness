import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.6 Stage B：QA 工具经 executeToolRun 收口 + 证据/事件测试。
 * mock @/lib/qa/capture、@/lib/qa/browser-check 与 @/lib/db/queries（executeToolRun 依赖）。
 * 不真实 launch 浏览器、不触 DB。
 */

const capture = vi.hoisted(() => ({ capturePreviewUrl: vi.fn() }));
const browserCheck = vi.hoisted(() => ({ runBrowserCheckUrl: vi.fn() }));
const responsive = vi.hoisted(() => ({ runResponsiveCheckUrl: vi.fn() }));
const a11y = vi.hoisted(() => ({ runAccessibilitySmokeUrl: vi.fn() }));
const verdict = vi.hoisted(() => ({ visualVerdict: vi.fn() }));
const queries = vi.hoisted(() => ({
  createToolRun: vi.fn(),
  appendThreadEvent: vi.fn(),
  finishToolRunSuccess: vi.fn(),
  finishToolRunFailure: vi.fn(),
  listPermissionRules: vi.fn(),
  findMatchingApprovals: vi.fn(),
  consumeOnceApproval: vi.fn(),
  createApprovalRequest: vi.fn(),
  updateThreadStatus: vi.fn(),
  getThreadById: vi.fn(),
}));
const qaBrowser = vi.hoisted(() => ({
  openQaPage: vi.fn(),
  viewportOf: vi.fn(),
  isBrowserAvailable: vi.fn(),
}));

vi.mock("@/lib/qa/capture", () => ({ capturePreviewUrl: capture.capturePreviewUrl }));
vi.mock("@/lib/qa/browser-check", () => ({ runBrowserCheckUrl: browserCheck.runBrowserCheckUrl }));
vi.mock("@/lib/qa/responsive", () => ({ runResponsiveCheckUrl: responsive.runResponsiveCheckUrl }));
vi.mock("@/lib/qa/a11y", () => ({ runAccessibilitySmokeUrl: a11y.runAccessibilitySmokeUrl }));
vi.mock("@/lib/qa/visual-verdict", () => ({ visualVerdict: verdict.visualVerdict }));
vi.mock("@/lib/qa/browser", () => ({
  openQaPage: qaBrowser.openQaPage,
  viewportOf: qaBrowser.viewportOf,
  isBrowserAvailable: qaBrowser.isBrowserAvailable,
}));
vi.mock("@/lib/db/queries", () => ({
  createToolRun: queries.createToolRun,
  appendThreadEvent: queries.appendThreadEvent,
  finishToolRunSuccess: queries.finishToolRunSuccess,
  finishToolRunFailure: queries.finishToolRunFailure,
  listPermissionRules: queries.listPermissionRules,
  findMatchingApprovals: queries.findMatchingApprovals,
  consumeOnceApproval: queries.consumeOnceApproval,
  createApprovalRequest: queries.createApprovalRequest,
  updateThreadStatus: queries.updateThreadStatus,
  getThreadById: queries.getThreadById,
}));

import { buildQaTools } from "@/lib/ai/tools/qa";
import type { RuntimeHandle } from "@/lib/runtime/types";

type ToolLike = { execute?: (...args: never[]) => unknown };

function callExecute(t: ToolLike, input: unknown): Promise<unknown> {
  if (!t.execute) throw new Error("no execute");
  return Promise.resolve(t.execute(input as never, { toolCallId: "t", messages: [] } as never));
}

const TID = "qa-tools-thread";
const fakeRuntime = {
  preview: {
    start: vi.fn().mockResolvedValue({
      url: "http://localhost:9999/",
      port: 9999,
      kind: "static",
      token: "preview-token",
    }),
  },
} as unknown as RuntimeHandle;

beforeEach(() => {
  vi.clearAllMocks();
  queries.createToolRun.mockResolvedValue({ id: "run-1", threadId: TID, status: "running" });
  queries.listPermissionRules.mockResolvedValue([]);
  queries.findMatchingApprovals.mockResolvedValue([]);
  queries.appendThreadEvent.mockResolvedValue(undefined);
  queries.finishToolRunSuccess.mockResolvedValue(undefined);
  queries.getThreadById.mockResolvedValue({ id: TID, userId: "user-qa" });
});

describe("QA 工具 buildQaTools (Stage B)", () => {
  it("capturePreview → 截图落盘 + qa.check_passed 事件", async () => {
    capture.capturePreviewUrl.mockResolvedValue({
      ok: true,
      viewport: 1280,
      durationMs: 100,
      screenshotPath: "t/qa/cap.png",
    });
    const tools = buildQaTools(TID, fakeRuntime, "host");
    const r = (await callExecute(tools.capturePreview, {})) as {
      ok: boolean;
      screenshotPath?: string;
    };
    expect(r.ok).toBe(true);
    expect(r.screenshotPath).toBe("t/qa/cap.png");
    expect(capture.capturePreviewUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:9999/",
        previewToken: "preview-token",
        threadId: TID,
      }),
    );
    // 追加 qa.check_passed 事件
    const passedCall = queries.appendThreadEvent.mock.calls.find((c) => c[1] === "qa.check_passed");
    expect(passedCall?.[2]).toMatchObject({ kind: "browser", viewports: [1280] });
  });

  it("capturePreview 截图失败 → qa.check_failed 事件", async () => {
    capture.capturePreviewUrl.mockResolvedValue({
      ok: false,
      viewport: 1280,
      durationMs: 50,
      error: "net::ERR_REFUSED",
    });
    const tools = buildQaTools(TID, fakeRuntime, "host");
    const r = (await callExecute(tools.capturePreview, {})) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    const failedCall = queries.appendThreadEvent.mock.calls.find((c) => c[1] === "qa.check_failed");
    expect(failedCall?.[2]).toMatchObject({ kind: "browser" });
  });

  it("runBrowserCheck → 检查通过 + qa.check_passed(kind=browser)", async () => {
    browserCheck.runBrowserCheckUrl.mockResolvedValue({
      ok: true,
      failures: [],
      viewports: [375, 768, 1280],
      durationMs: 200,
      artifactPath: "t/qa/bc.json",
    });
    const tools = buildQaTools(TID, fakeRuntime, "host");
    const r = (await callExecute(tools.runBrowserCheck, {})) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(browserCheck.runBrowserCheckUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:9999/",
        previewToken: "preview-token",
        threadId: TID,
      }),
    );
    const passedCall = queries.appendThreadEvent.mock.calls.find((c) => c[1] === "qa.check_passed");
    expect(passedCall?.[2]).toMatchObject({ kind: "browser", viewports: [375, 768, 1280] });
  });

  it("runBrowserCheck 检测到 console error → ok:false + qa.check_failed", async () => {
    browserCheck.runBrowserCheckUrl.mockResolvedValue({
      ok: false,
      failures: [{ type: "console_error", viewport: 1280, detail: "boom" }],
      viewports: [1280],
      durationMs: 100,
      artifactPath: "t/qa/bc.json",
    });
    const tools = buildQaTools(TID, fakeRuntime, "host");
    const r = (await callExecute(tools.runBrowserCheck, {})) as { ok: boolean };
    expect(r.ok).toBe(false);
    const failedCall = queries.appendThreadEvent.mock.calls.find((c) => c[1] === "qa.check_failed");
    expect(failedCall?.[2]).toMatchObject({
      kind: "browser",
      failures: [{ type: "console_error", viewport: 1280, detail: "boom" }],
    });
  });

  it("preview.start 被 QA 工具调用取 url（不依赖 reportReady）", async () => {
    capture.capturePreviewUrl.mockResolvedValue({ ok: true, viewport: 1280, durationMs: 1 });
    const tools = buildQaTools(TID, fakeRuntime, "host");
    await callExecute(tools.capturePreview, {});
    expect(
      (fakeRuntime.preview as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).toHaveBeenCalledWith(TID);
  });

  it("runResponsiveCheck → 通过 + qa.check_passed(kind=responsive)", async () => {
    responsive.runResponsiveCheckUrl.mockResolvedValue({
      ok: true,
      failures: [],
      viewports: [375, 768, 1280],
      durationMs: 200,
      artifactPath: "t/qa/r.json",
    });
    const tools = buildQaTools(TID, fakeRuntime, "host");
    const r = (await callExecute(tools.runResponsiveCheck, {})) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(responsive.runResponsiveCheckUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:9999/",
        previewToken: "preview-token",
        threadId: TID,
      }),
    );
    const passed = queries.appendThreadEvent.mock.calls.find((c) => c[1] === "qa.check_passed");
    expect(passed?.[2]).toMatchObject({ kind: "responsive", viewports: [375, 768, 1280] });
  });

  it("runResponsiveCheck 检测溢出 → qa.check_failed(kind=responsive)", async () => {
    responsive.runResponsiveCheckUrl.mockResolvedValue({
      ok: false,
      failures: [{ type: "horizontal_overflow", viewport: 375, detail: "溢出" }],
      viewports: [375, 1280],
      durationMs: 100,
      artifactPath: "t/qa/r.json",
    });
    const tools = buildQaTools(TID, fakeRuntime, "host");
    const r = (await callExecute(tools.runResponsiveCheck, {})) as { ok: boolean };
    expect(r.ok).toBe(false);
    const failed = queries.appendThreadEvent.mock.calls.find((c) => c[1] === "qa.check_failed");
    expect(failed?.[2]).toMatchObject({ kind: "responsive" });
  });

  it("runAccessibilitySmoke → 违规 + qa.check_failed(kind=a11y)", async () => {
    a11y.runAccessibilitySmokeUrl.mockResolvedValue({
      ok: false,
      failures: [{ type: "a11y_img_alt", viewport: 1280, detail: "2 个 img 缺 alt" }],
      viewports: [1280],
      durationMs: 80,
      artifactPath: "t/qa/a.json",
    });
    const tools = buildQaTools(TID, fakeRuntime, "host");
    const r = (await callExecute(tools.runAccessibilitySmoke, {})) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(a11y.runAccessibilitySmokeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:9999/",
        previewToken: "preview-token",
        threadId: TID,
      }),
    );
    const failed = queries.appendThreadEvent.mock.calls.find((c) => c[1] === "qa.check_failed");
    expect(failed?.[2]).toMatchObject({ kind: "a11y" });
  });

  it("visualVerdict → 走 LLM 评审 + qa 事件（gate 不依赖）", async () => {
    verdict.visualVerdict.mockResolvedValue({
      layout: "broken",
      blank: false,
      misalignment: "detected",
      summary: "侧栏错位",
      usedLlm: true,
      ok: true,
    });
    const tools = buildQaTools(TID, fakeRuntime, "host");
    const r = (await callExecute(tools.visualVerdict, {
      screenshotPath: "t/qa/cap.png",
    })) as { layout: string; usedLlm: boolean };
    expect(r.layout).toBe("broken");
    expect(r.usedLlm).toBe(true);
    // 布局破坏 → qa.check_failed(kind=verdict)
    const failed = queries.appendThreadEvent.mock.calls.find((c) => c[1] === "qa.check_failed");
    expect(failed?.[2]).toMatchObject({ kind: "verdict" });
  });

  it("visualVerdict 评审通过 → qa.check_passed(kind=verdict)", async () => {
    verdict.visualVerdict.mockResolvedValue({
      layout: "good",
      blank: false,
      misalignment: "none",
      summary: "ok",
      usedLlm: false,
      ok: true,
    });
    const tools = buildQaTools(TID, fakeRuntime, "host");
    await callExecute(tools.visualVerdict, { screenshotPath: "t/qa/cap.png" });
    const passed = queries.appendThreadEvent.mock.calls
      .filter((c) => c[1] === "qa.check_passed")
      .find((c) => (c[2] as { kind?: string }).kind === "verdict");
    expect(passed).toBeTruthy();
  });
});

// V10 Phase 2：QA useProfile 派生登录态测试已移除。
// 原 V9 从 UserBrowserProfile 解密 storageState 供 QA 隐藏 context 继承，
// V10 删除服务端用户浏览器链路后无数据来源。QA 现以未登录态运行；
// Phase 7 Desktop QA 隐藏 WebContents 再经 RPC 派生。
