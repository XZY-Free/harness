import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.6 Stage D：QA gate 单测。mock @/lib/qa/browser 的 isBrowserAvailable、
 * @/lib/qa/browser-check 的 runBrowserCheckUrl、正式链唯一事件写入口
 * @/lib/conversations/thread-queries 的 writeThreadEvents。
 * 不真实 launch 浏览器、不触 DB。qaConfig 经 env var 切换。
 *
 * 02-3：runQaGate 不再写 legacy threadEvent，也不做旧 Thread 状态升级
 * （needs_human_review / agent.status_changed 已移除，正式 Thread 无此状态机）。
 */

const browser = vi.hoisted(() => ({
  isBrowserAvailable: vi.fn(),
}));
const browserCheck = vi.hoisted(() => ({
  runBrowserCheckUrl: vi.fn(),
}));
const responsive = vi.hoisted(() => ({
  runResponsiveCheckUrl: vi.fn(),
}));
const a11y = vi.hoisted(() => ({
  runAccessibilitySmokeUrl: vi.fn(),
}));
const threadQueries = vi.hoisted(() => ({
  writeThreadEvents: vi.fn(),
}));

vi.mock("@/lib/qa/browser", () => ({
  isBrowserAvailable: browser.isBrowserAvailable,
}));
vi.mock("@/lib/qa/browser-check", () => ({
  runBrowserCheckUrl: browserCheck.runBrowserCheckUrl,
}));
vi.mock("@/lib/qa/responsive", () => ({
  runResponsiveCheckUrl: responsive.runResponsiveCheckUrl,
}));
vi.mock("@/lib/qa/a11y", () => ({
  runAccessibilitySmokeUrl: a11y.runAccessibilitySmokeUrl,
}));
vi.mock("@/lib/conversations/thread-queries", () => ({
  writeThreadEvents: threadQueries.writeThreadEvents,
}));

import { runQaGate } from "@/lib/qa/gate";

const origEnabled = process.env.QA_GATE_ENABLED;
const origRequired = process.env.QA_BROWSER_REQUIRED;
const origRules = process.env.QA_GATE_RULES;

const TENANT = "acme";
const THREAD = "t1";

/** 从 writeThreadEvents mock 调用中找出指定 eventType 的输入。 */
function findEvent(eventType: string) {
  return threadQueries.writeThreadEvents.mock.calls.find((c) => c[2]?.[0]?.eventType === eventType);
}

beforeEach(() => {
  browser.isBrowserAvailable.mockReset();
  browserCheck.runBrowserCheckUrl.mockReset();
  responsive.runResponsiveCheckUrl.mockReset();
  a11y.runAccessibilitySmokeUrl.mockReset();
  threadQueries.writeThreadEvents.mockReset().mockResolvedValue([]);
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.QA_GATE_ENABLED;
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.QA_BROWSER_REQUIRED;
  // biome-ignore lint/performance/noDelete: gateRules 默认空,用例按需设
  delete process.env.QA_GATE_RULES;
});

afterEach(() => {
  if (origEnabled !== undefined) process.env.QA_GATE_ENABLED = origEnabled;
  else {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.QA_GATE_ENABLED;
  }
  if (origRequired !== undefined) process.env.QA_BROWSER_REQUIRED = origRequired;
  else {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.QA_BROWSER_REQUIRED;
  }
  if (origRules !== undefined) process.env.QA_GATE_RULES = origRules;
  else {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.QA_GATE_RULES;
  }
});

describe("runQaGate", () => {
  it("显式禁用 → skipped=true, ok=true, 不查浏览器, 不写事件", async () => {
    process.env.QA_GATE_ENABLED = "false";
    const r = await runQaGate({ tenantId: TENANT, threadId: THREAD, previewUrl: "http://x/" });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(browser.isBrowserAvailable).not.toHaveBeenCalled();
    expect(threadQueries.writeThreadEvents).not.toHaveBeenCalled();
  });

  it("启用 + 浏览器不可用 + REQUIRED=true → fail-closed + qa.check_failed(kind=gate)", async () => {
    browser.isBrowserAvailable.mockResolvedValue(false);
    const r = await runQaGate({ tenantId: TENANT, threadId: THREAD, previewUrl: "http://x/" });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.error).toContain("fail-closed");
    expect(browserCheck.runBrowserCheckUrl).not.toHaveBeenCalled();
    const failed = findEvent("qa.check_failed");
    expect(failed).toBeTruthy();
    expect((failed?.[2]?.[0]?.payload as { kind: string }).kind).toBe("gate");
  });

  it("启用 + 浏览器不可用 + REQUIRED=false → skipped=true（不推荐但不阻断）", async () => {
    process.env.QA_GATE_ENABLED = "true";
    process.env.QA_BROWSER_REQUIRED = "false";
    browser.isBrowserAvailable.mockResolvedValue(false);
    const r = await runQaGate({ tenantId: TENANT, threadId: THREAD, previewUrl: "http://x/" });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(browserCheck.runBrowserCheckUrl).not.toHaveBeenCalled();
  });

  it("启用 + 可用 + browser check 通过 → ok=true + qa.check_passed(kind=gate)", async () => {
    process.env.QA_GATE_ENABLED = "true";
    browser.isBrowserAvailable.mockResolvedValue(true);
    browserCheck.runBrowserCheckUrl.mockResolvedValue({
      ok: true,
      failures: [],
      viewports: [375, 768, 1280],
      durationMs: 500,
      artifactPath: "t1/qa/gate-abc.json",
    });
    const r = await runQaGate({
      tenantId: TENANT,
      threadId: THREAD,
      previewUrl: "http://x/",
      previewToken: "tok",
    });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(false);
    expect(browserCheck.runBrowserCheckUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://x/", previewToken: "tok", threadId: THREAD }),
    );
    const passed = findEvent("qa.check_passed");
    expect(passed).toBeTruthy();
    expect((passed?.[2]?.[0]?.payload as { kind: string }).kind).toBe("gate");
    expect(threadQueries.writeThreadEvents).toHaveBeenCalledWith(TENANT, THREAD, expect.any(Array));
  });

  it("启用 + 可用 + console error → ok=false + qa.check_failed + error 含 console_error", async () => {
    process.env.QA_GATE_ENABLED = "true";
    browser.isBrowserAvailable.mockResolvedValue(true);
    browserCheck.runBrowserCheckUrl.mockResolvedValue({
      ok: false,
      failures: [{ type: "console_error", viewport: 1280, detail: "boom" }],
      viewports: [375, 768, 1280],
      durationMs: 300,
      artifactPath: "t1/qa/gate-def.json",
    });
    const r = await runQaGate({ tenantId: TENANT, threadId: THREAD, previewUrl: "http://x/" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("console_error");
    expect(r.failures).toHaveLength(1);
    const failed = findEvent("qa.check_failed");
    expect(failed).toBeTruthy();
  });

  it("启用 + 可用 + 白屏 → ok=false + error 含 blank", async () => {
    process.env.QA_GATE_ENABLED = "true";
    browser.isBrowserAvailable.mockResolvedValue(true);
    browserCheck.runBrowserCheckUrl.mockResolvedValue({
      ok: false,
      failures: [{ type: "blank", viewport: 375, detail: "页面主体为空" }],
      viewports: [375, 768, 1280],
      durationMs: 200,
      artifactPath: null,
    });
    const r = await runQaGate({ tenantId: TENANT, threadId: THREAD, previewUrl: "http://x/" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("blank");
  });

  it("启用 + 可用 + HTTP 失败 → ok=false + error 含 network_http_error", async () => {
    process.env.QA_GATE_ENABLED = "true";
    browser.isBrowserAvailable.mockResolvedValue(true);
    browserCheck.runBrowserCheckUrl.mockResolvedValue({
      ok: false,
      failures: [{ type: "network_http_error", viewport: 1280, detail: "GET /main.js → 404" }],
      viewports: [375, 768, 1280],
      durationMs: 250,
      artifactPath: null,
    });
    const r = await runQaGate({ tenantId: TENANT, threadId: THREAD, previewUrl: "http://x/" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("network_http_error");
  });

  it("gate 不调 LLM——仅调 isBrowserAvailable + runBrowserCheckUrl（确定性规则）", async () => {
    process.env.QA_GATE_ENABLED = "true";
    browser.isBrowserAvailable.mockResolvedValue(true);
    browserCheck.runBrowserCheckUrl.mockResolvedValue({
      ok: true,
      failures: [],
      viewports: [1280],
      durationMs: 100,
      artifactPath: null,
    });
    await runQaGate({ tenantId: TENANT, threadId: THREAD, previewUrl: "http://x/" });
    expect(browser.isBrowserAvailable).toHaveBeenCalledTimes(1);
    expect(browserCheck.runBrowserCheckUrl).toHaveBeenCalledTimes(1);
  });

  // ─── P1-3：gateRules 扩展（responsive / a11y 追加检查）─────────

  it("P1-3 gateRules 含 responsive → 调 runResponsiveCheckUrl 并合并 failures", async () => {
    process.env.QA_GATE_ENABLED = "true";
    process.env.QA_GATE_RULES = "responsive";
    browser.isBrowserAvailable.mockResolvedValue(true);
    browserCheck.runBrowserCheckUrl.mockResolvedValue({
      ok: true,
      failures: [],
      viewports: [1280],
      durationMs: 100,
      artifactPath: null,
    });
    responsive.runResponsiveCheckUrl.mockResolvedValue({
      ok: false,
      failures: [{ type: "horizontal_overflow", viewport: 375, detail: "mobile overflow" }],
      viewports: [375, 768, 1280],
      durationMs: 80,
      artifactPath: null,
    });
    const r = await runQaGate({
      tenantId: TENANT,
      threadId: THREAD,
      previewUrl: "http://x/",
      previewToken: "tok",
    });
    expect(responsive.runResponsiveCheckUrl).toHaveBeenCalledTimes(1);
    expect(responsive.runResponsiveCheckUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://x/", previewToken: "tok", threadId: THREAD }),
    );
    // browser-check 通过但 responsive 失败 → 整体失败
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.error).toContain("horizontal_overflow");
    expect(a11y.runAccessibilitySmokeUrl).not.toHaveBeenCalled();
  });

  it("P1-3 gateRules 含 a11y → 调 runAccessibilitySmokeUrl 并合并 failures", async () => {
    process.env.QA_GATE_ENABLED = "true";
    process.env.QA_GATE_RULES = "a11y";
    browser.isBrowserAvailable.mockResolvedValue(true);
    browserCheck.runBrowserCheckUrl.mockResolvedValue({
      ok: true,
      failures: [],
      viewports: [1280],
      durationMs: 100,
      artifactPath: null,
    });
    a11y.runAccessibilitySmokeUrl.mockResolvedValue({
      ok: false,
      failures: [{ type: "img_missing_alt", viewport: 1280, detail: "3 imgs without alt" }],
      viewports: [1280],
      durationMs: 60,
      artifactPath: null,
    });
    const r = await runQaGate({
      tenantId: TENANT,
      threadId: THREAD,
      previewUrl: "http://x/",
      previewToken: "tok",
    });
    expect(a11y.runAccessibilitySmokeUrl).toHaveBeenCalledTimes(1);
    expect(a11y.runAccessibilitySmokeUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://x/", previewToken: "tok", threadId: THREAD }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.error).toContain("img_missing_alt");
    expect(responsive.runResponsiveCheckUrl).not.toHaveBeenCalled();
  });

  it("P1-3 空 gateRules → 只跑默认 browser-check,不调 responsive/a11y", async () => {
    process.env.QA_GATE_ENABLED = "true";
    // V6-M3-7：默认改为 "responsive,a11y"，需显式设空串覆盖默认值
    process.env.QA_GATE_RULES = "";
    browser.isBrowserAvailable.mockResolvedValue(true);
    browserCheck.runBrowserCheckUrl.mockResolvedValue({
      ok: true,
      failures: [],
      viewports: [375, 768, 1280],
      durationMs: 100,
      artifactPath: null,
    });
    const r = await runQaGate({ tenantId: TENANT, threadId: THREAD, previewUrl: "http://x/" });
    expect(r.ok).toBe(true);
    expect(responsive.runResponsiveCheckUrl).not.toHaveBeenCalled();
    expect(a11y.runAccessibilitySmokeUrl).not.toHaveBeenCalled();
  });
});
