import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { staticPreviewRuntime } from "@/lib/runtime/preview-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = resolve(".test-workspaces-preview-gate");
const TID = "test-preview-gate";
const orig = process.env.SNOW_WORKSPACES_DIR;
const queryMocks = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  updateThreadPreviewUrl: vi.fn(),
  updateThreadStatus: vi.fn(),
  createToolRun: vi.fn(),
  appendThreadEvent: vi.fn(),
  finishToolRunSuccess: vi.fn(),
  finishToolRunFailure: vi.fn(),
  listPermissionRules: vi.fn(),
  findMatchingApprovals: vi.fn(),
  consumeOnceApproval: vi.fn(),
  createApprovalRequest: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  getThreadById: queryMocks.getThreadById,
  updateThreadPreviewUrl: queryMocks.updateThreadPreviewUrl,
  updateThreadStatus: queryMocks.updateThreadStatus,
  createToolRun: queryMocks.createToolRun,
  appendThreadEvent: queryMocks.appendThreadEvent,
  finishToolRunSuccess: queryMocks.finishToolRunSuccess,
  finishToolRunFailure: queryMocks.finishToolRunFailure,
  // V3.1：executeToolRun 权限引擎依赖（默认无 DB 规则、无既有批准）
  listPermissionRules: queryMocks.listPermissionRules,
  findMatchingApprovals: queryMocks.findMatchingApprovals,
  consumeOnceApproval: queryMocks.consumeOnceApproval,
  createApprovalRequest: queryMocks.createApprovalRequest,
}));

// Phase 4-1：policy hook 执行 seam mock——避免单测真起 shell 跑 prettier/npm test。
const execMocks = vi.hoisted(() => ({ runWorkspaceCommand: vi.fn() }));
vi.mock("@/lib/policy/exec", () => ({
  runWorkspaceCommand: execMocks.runWorkspaceCommand,
}));

// V3.2：finalizeThreadRun 调 stopAllByThread 回收后台任务——mock 为 spy 避免触 DB。
// closeAllBackgroundTasks/sweepIdleBackgroundTasks 供 manager.ts 全局退出 hook（teardown 触发）。
const bgMocks = vi.hoisted(() => ({
  stopAllByThread: vi.fn().mockResolvedValue(undefined),
  closeAllBackgroundTasks: vi.fn().mockResolvedValue(undefined),
  sweepIdleBackgroundTasks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/runtime/background-task-registry", () => ({
  stopAllByThread: bgMocks.stopAllByThread,
  closeAllBackgroundTasks: bgMocks.closeAllBackgroundTasks,
  sweepIdleBackgroundTasks: bgMocks.sweepIdleBackgroundTasks,
}));

// V3.6 Stage D：QA gate mock——默认 skipped=true（零回归），gate 集成测试覆盖时 override。
const gateMocks = vi.hoisted(() => ({
  runQaGate: vi.fn().mockResolvedValue({ ok: true, skipped: true, durationMs: 0 }),
}));
vi.mock("@/lib/qa/gate", () => ({
  runQaGate: gateMocks.runQaGate,
}));

import { finalizeThreadRun, probePreviewUrl } from "@/lib/ai/preview-gate";
import { buildTools } from "@/lib/ai/tools";

type ToolLike = { execute?: (...args: never[]) => unknown };

function callExecute(tool: ToolLike, input: unknown): Promise<unknown> {
  if (!tool.execute) {
    throw new Error("tool.execute missing");
  }
  return Promise.resolve(tool.execute(input as never, { toolCallId: "t", messages: [] } as never));
}

beforeEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = TEST_ROOT;
  await rm(join(TEST_ROOT, TID), { recursive: true, force: true });
  queryMocks.getThreadById.mockReset();
  queryMocks.updateThreadPreviewUrl.mockReset();
  queryMocks.updateThreadStatus.mockReset();
  queryMocks.createToolRun.mockReset();
  queryMocks.appendThreadEvent.mockReset();
  queryMocks.finishToolRunSuccess.mockReset();
  queryMocks.finishToolRunFailure.mockReset();
  queryMocks.listPermissionRules.mockReset();
  queryMocks.findMatchingApprovals.mockReset();
  queryMocks.createApprovalRequest.mockReset();
  execMocks.runWorkspaceCommand.mockReset();
  bgMocks.stopAllByThread.mockReset().mockResolvedValue(undefined);
  // V3.6：gate 默认 skipped=true（零回归），gate 集成测试时 override
  gateMocks.runQaGate.mockReset().mockResolvedValue({ ok: true, skipped: true, durationMs: 0 });
  // reportReady 经 executeToolRun 调用，需返回带 id 的 run
  queryMocks.createToolRun.mockResolvedValue({ id: "run-1", threadId: TID, status: "running" });
  // V3.1：默认无 DB 权限规则覆盖、无既有批准 → 引擎走默认规则
  queryMocks.listPermissionRules.mockResolvedValue([]);
  queryMocks.findMatchingApprovals.mockResolvedValue([]);
  // policy hook 执行层默认成功（格式化 / 验证 best-effort）
  execMocks.runWorkspaceCommand.mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
});

afterEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = orig;
  await staticPreviewRuntime.stop(TID);
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("preview gate", () => {
  it("probePreviewUrl 对空白页返回失败", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, { path: "index.html", content: "   " });
    const report = (await callExecute(tools.reportReady, { summary: "blank" })) as {
      ok: boolean;
      error?: string;
      url?: string;
    };

    expect(report.ok).toBe(false);
    if (report.ok) {
      throw new Error("expected failure");
    }
    expect(report.error).toBe("探活失败：响应体为空");
  });

  it("probePreviewUrl 对非 HTML 文本返回失败", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, { path: "index.html", content: "plain text only" });
    const report = (await callExecute(tools.reportReady, { summary: "plain" })) as {
      ok: boolean;
      error?: string;
      url?: string;
    };

    expect(report.ok).toBe(false);
    if (report.ok) {
      throw new Error("expected failure");
    }
    expect(report.error).toBe("探活失败：响应不是有效 HTML 文档");
  });

  it("probePreviewUrl 对正常 HTML 返回成功", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>ok</body></html>",
    });

    const report = (await callExecute(tools.reportReady, { summary: "ok" })) as {
      ok: boolean;
      url?: string;
    };

    expect(report.ok).toBe(true);
    if (!report.ok || !report.url) {
      throw new Error("expected success");
    }
    // 静态页面显式指向 index.html，避免 Next 去尾斜杠后破坏相对资源路径。
    expect(report.url).toBe(`/preview/${TID}/index.html`);
    const { url: localUrl } = await staticPreviewRuntime.start(TID);
    const st = staticPreviewRuntime.status(TID);
    // S1（05-P2-8）：静态 server 要求 token，探活带 token
    await expect(probePreviewUrl(localUrl, { token: st?.token })).resolves.toEqual({ ok: true });
  });

  it("finalizeThreadRun 在已有 ready_for_review + previewUrl 时直接复用", async () => {
    queryMocks.getThreadById.mockResolvedValue({
      status: "ready_for_review",
      previewUrl: "/preview/prev-ready/",
    });

    await expect(finalizeThreadRun(TID)).resolves.toEqual({
      previewUrl: "/preview/prev-ready/",
      status: "ready_for_review",
    });
    expect(queryMocks.updateThreadPreviewUrl).not.toHaveBeenCalled();
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalled();
  });

  it("V3.7：finalizeThreadRun 在 completed 时保留终态，不切 idle/failed", async () => {
    queryMocks.getThreadById.mockResolvedValue({
      status: "completed",
      previewUrl: "/preview/prev/",
    });
    await expect(finalizeThreadRun(TID)).resolves.toEqual({
      previewUrl: "/preview/prev/",
      status: "completed",
    });
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalled();
    expect(queryMocks.appendThreadEvent).not.toHaveBeenCalledWith(
      TID,
      "agent.status_changed",
      expect.objectContaining({ to: "idle" }),
    );
  });

  it("V3.7：finalizeThreadRun 在 delivering 时保留（transient 不被收尾覆盖）", async () => {
    queryMocks.getThreadById.mockResolvedValue({
      status: "delivering",
      previewUrl: null,
    });
    await expect(finalizeThreadRun(TID)).resolves.toEqual({
      previewUrl: "",
      status: "delivering",
    });
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalled();
  });

  it("finalizeThreadRun 对有 index 但未通过闸门的线程落 failed", async () => {
    queryMocks.getThreadById.mockResolvedValue({
      status: "executing",
      previewUrl: null,
    });
    await callExecute(buildTools(TID).writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>draft</body></html>",
    });

    await expect(finalizeThreadRun(TID)).resolves.toEqual({
      previewUrl: "",
      status: "failed",
    });
    expect(queryMocks.updateThreadPreviewUrl).toHaveBeenCalledWith(TID, null);
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "failed", "executing");
  });

  it("finalizeThreadRun 对无产出的线程落 idle", async () => {
    queryMocks.getThreadById.mockResolvedValue({
      status: "executing",
      previewUrl: null,
    });

    await expect(finalizeThreadRun(TID)).resolves.toEqual({
      previewUrl: "",
      status: "idle",
    });
    expect(queryMocks.updateThreadPreviewUrl).toHaveBeenCalledWith(TID, null);
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "idle", "executing");
  });
});

describe("thread 生命周期事件 (Stage C)", () => {
  it("reportReady 成功 → artifact.created(preview) + status_changed→ready_for_review", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>ok</body></html>",
    });
    await callExecute(tools.reportReady, { summary: "ok" });

    const calls = queryMocks.appendThreadEvent.mock.calls;
    const artCall = calls.find((c) => c[1] === "artifact.created");
    expect(artCall?.[2]).toMatchObject({
      type: "preview",
      status: "ready_for_review",
      previewUrl: expect.any(String),
    });
    const readyCall = calls.find(
      (c) => c[1] === "agent.status_changed" && (c[2] as { to?: string }).to === "ready_for_review",
    );
    expect(readyCall?.[2]).toMatchObject({ from: "executing", to: "ready_for_review" });
  });

  it("finalizeThreadRun 对有 index 未通过 → status_changed→failed", async () => {
    queryMocks.getThreadById.mockResolvedValue({ status: "executing", previewUrl: null });
    await callExecute(buildTools(TID).writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>d</body></html>",
    });
    await finalizeThreadRun(TID);

    const failedCall = queryMocks.appendThreadEvent.mock.calls.find(
      (c) => c[1] === "agent.status_changed" && (c[2] as { to?: string }).to === "failed",
    );
    expect(failedCall?.[2]).toMatchObject({
      from: "executing",
      to: "failed",
      reason: "run_failed",
    });
  });

  it("finalizeThreadRun 对无产出 → status_changed→idle", async () => {
    queryMocks.getThreadById.mockResolvedValue({ status: "executing", previewUrl: null });
    await finalizeThreadRun(TID);

    const idleCall = queryMocks.appendThreadEvent.mock.calls.find(
      (c) => c[1] === "agent.status_changed" && (c[2] as { to?: string }).to === "idle",
    );
    expect(idleCall?.[2]).toMatchObject({
      from: "executing",
      to: "idle",
      reason: "run_idle",
    });
  });

  it("finalizeThreadRun 已 ready_for_review → 不再追加 status_changed", async () => {
    queryMocks.getThreadById.mockResolvedValue({
      status: "ready_for_review",
      previewUrl: "/preview/prev-ready/",
    });
    await finalizeThreadRun(TID);

    const statusCalls = queryMocks.appendThreadEvent.mock.calls.filter(
      (c) => c[1] === "agent.status_changed",
    );
    expect(statusCalls).toHaveLength(0);
  });

  // V3.2 Stage E：finalizeThreadRun 切终态前调 stopAllByThread 回收后台任务
  it("finalizeThreadRun 调 stopAllByThread(threadId, thread_end) 回收后台任务", async () => {
    queryMocks.getThreadById.mockResolvedValue({ status: "executing", previewUrl: null });
    await finalizeThreadRun(TID);
    expect(bgMocks.stopAllByThread).toHaveBeenCalledWith(TID, "thread_end");
  });

  it("finalizeThreadRun 已 ready_for_review 也调 stopAllByThread", async () => {
    queryMocks.getThreadById.mockResolvedValue({
      status: "ready_for_review",
      previewUrl: "/preview/prev/",
    });
    await finalizeThreadRun(TID);
    expect(bgMocks.stopAllByThread).toHaveBeenCalledWith(TID, "thread_end");
  });
});

describe("beforeDelivery 交付前验证 (Phase 4-1 Stage D)", () => {
  it("有测试文件且验证未过 → ok:false、不开预览、status 维持 executing", async () => {
    // 验证命令返回非零 → fail-closed 拦截交付（格式化 best-effort 一同拿到非零，fail-open 不影响）
    execMocks.runWorkspaceCommand.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: " AssertionError: expected 2 to be 3",
      timedOut: false,
    });
    const tools = buildTools(TID);
    // 写一个测试文件 → detect 命中「有可验证项」
    await callExecute(tools.writeFile, {
      path: "app.test.js",
      content: "test('failing', () => { expect(2).toBe(3); });",
    });

    const r = (await callExecute(tools.reportReady, { summary: "done" })) as {
      ok: boolean;
      error?: string;
      summary: string;
    };

    expect(r.ok).toBe(false);
    expect(r.error).toContain("交付前验证未过");
    // 未落 ready_for_review，回灌 executing
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalledWith(TID, "ready_for_review");
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "executing");
    expect(queryMocks.updateThreadPreviewUrl).toHaveBeenCalledWith(TID, null);
  });

  it("有测试文件且验证通过 → 照常开预览、落 ready_for_review", async () => {
    execMocks.runWorkspaceCommand.mockResolvedValue({
      exitCode: 0,
      stdout: "passing",
      stderr: "",
      timedOut: false,
    });
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, { path: "app.test.js", content: "test('ok', ()=>{});" });
    await callExecute(tools.writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>ok</body></html>",
    });

    const r = (await callExecute(tools.reportReady, { summary: "done" })) as {
      ok: boolean;
      url?: string;
    };
    expect(r.ok).toBe(true);
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "ready_for_review");
  });

  it("无测试的静态站点 → 验证跳过、探活通过照常开预览（不回归）", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>ok</body></html>",
    });

    const r = (await callExecute(tools.reportReady, { summary: "static" })) as {
      ok: boolean;
      url?: string;
    };
    expect(r.ok).toBe(true);
    expect(r.url).toBe(`/preview/${TID}/index.html`);
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "ready_for_review");
    // 验证命令未跑（仅格式化 best-effort 可能跑过 prettier，不该跑 npm test）
    const commands = execMocks.runWorkspaceCommand.mock.calls.map((c) => c[1]);
    expect(commands.every((cmd) => !cmd.includes("npm test"))).toBe(true);
  });

  it("验证执行异常 → fail-closed 拦截交付", async () => {
    execMocks.runWorkspaceCommand.mockRejectedValue(new Error("verify engine boom"));
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, { path: "app.test.js", content: "test('x',()=>{});" });
    await callExecute(tools.writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>ok</body></html>",
    });

    const r = (await callExecute(tools.reportReady, { summary: "done" })) as {
      ok: boolean;
      error?: string;
      url?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("交付前验证未过");
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "executing");
  });
});

// ─── V3.6 Stage D：QA gate 集成 reportThreadReady ──────────────

describe("QA gate 集成 reportThreadReady (Stage D)", () => {
  it("gate 禁用 → 零回归（skipped=true，行为与今天逐字一致）", async () => {
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>ok</body></html>",
    });
    const r = (await callExecute(tools.reportReady, { summary: "ok" })) as {
      ok: boolean;
      url?: string;
    };
    expect(r.ok).toBe(true);
    expect(r.url).toBe(`/preview/${TID}/index.html`);
    expect(gateMocks.runQaGate).toHaveBeenCalledTimes(1);
    expect(gateMocks.runQaGate).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: TID,
        previewUrl: expect.stringMatching(/^http:\/\/localhost:\d+\/$/),
        previewToken: expect.any(String),
      }),
    );
    // gate 禁用 → 不阻断，照常 ready_for_review
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "ready_for_review");
  });

  it("gate 启用 + 通过 → ready_for_review", async () => {
    gateMocks.runQaGate.mockResolvedValue({
      ok: true,
      skipped: false,
      durationMs: 500,
      evidencePath: `${TID}/qa/gate-abc.json`,
    });
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>ok</body></html>",
    });
    const r = (await callExecute(tools.reportReady, { summary: "ok" })) as {
      ok: boolean;
      url?: string;
    };
    expect(r.ok).toBe(true);
    expect(r.url).toBe(`/preview/${TID}/index.html`);
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "ready_for_review");
  });

  it("gate 启用 + 白屏/console error/404 → 硬阻断 ready_for_review, status=executing", async () => {
    gateMocks.runQaGate.mockResolvedValue({
      ok: false,
      skipped: false,
      error: "QA gate 未过：blank@375, console_error@1280",
      failures: [
        { type: "blank", viewport: 375, detail: "页面主体为空" },
        { type: "console_error", viewport: 1280, detail: "boom" },
      ],
      durationMs: 300,
    });
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>ok</body></html>",
    });
    const r = (await callExecute(tools.reportReady, { summary: "ok" })) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("QA gate 未过");
    // 阻断 → previewUrl=null、status=executing（与 verify/probe 失败同语义）
    expect(queryMocks.updateThreadPreviewUrl).toHaveBeenCalledWith(TID, null);
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "executing");
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalledWith(TID, "ready_for_review");
  });

  it("gate 启用 + 浏览器缺失 → fail-closed 阻断（不静默跳过）", async () => {
    gateMocks.runQaGate.mockResolvedValue({
      ok: false,
      skipped: false,
      error: "QA gate 启用但 Playwright 浏览器不可用（fail-closed）",
      durationMs: 0,
    });
    const tools = buildTools(TID);
    await callExecute(tools.writeFile, {
      path: "index.html",
      content: "<!doctype html><html><body>ok</body></html>",
    });
    const r = (await callExecute(tools.reportReady, { summary: "ok" })) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("fail-closed");
    expect(queryMocks.updateThreadPreviewUrl).toHaveBeenCalledWith(TID, null);
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith(TID, "executing");
  });
});
