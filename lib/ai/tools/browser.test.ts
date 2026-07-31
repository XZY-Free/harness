import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V10 Phase 2：AI 浏览器工具测试。
 *
 * V9 的 browserGateway / page-insights / browser-queries / workspace / browser-policy
 * mock 全部移除（对应模块已删除或不再被 browser.ts 引用）。
 *
 * 验证：
 * - 每个工具调用返回 { ok: false, error: "desktop_unavailable" }
 * - 工具 schema（description / inputSchema / execute）仍然存在
 * - executeToolRun 审计包装仍工作（tool.called + tool.failed 事件）
 *
 * 仅 mock executeToolRun 依赖的 DB 函数（@/lib/db/queries）与 admin-audit，
 * 不再 mock 任何 V9 浏览器链路模块。
 */

// ─── mock 声明（vi.hoisted 保证在 vi.mock 工厂中可用） ─────────

const queryMocks = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  createToolRun: vi.fn(),
  appendThreadEvent: vi.fn(),
  finishToolRunSuccess: vi.fn(),
  finishToolRunFailure: vi.fn(),
  listPermissionRules: vi.fn(),
  findMatchingApprovals: vi.fn(),
  consumeOnceApproval: vi.fn(),
  requestApprovalAtomic: vi.fn(),
  updateThreadStatus: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  getThreadById: queryMocks.getThreadById,
  createToolRun: queryMocks.createToolRun,
  appendThreadEvent: queryMocks.appendThreadEvent,
  finishToolRunSuccess: queryMocks.finishToolRunSuccess,
  finishToolRunFailure: queryMocks.finishToolRunFailure,
  listPermissionRules: queryMocks.listPermissionRules,
  findMatchingApprovals: queryMocks.findMatchingApprovals,
  consumeOnceApproval: queryMocks.consumeOnceApproval,
  requestApprovalAtomic: queryMocks.requestApprovalAtomic,
  updateThreadStatus: queryMocks.updateThreadStatus,
}));

vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: vi.fn() }));

import { clearThreadRunScope, setThreadRunScope } from "@/lib/ai/tool-runtime";
import { buildBrowserTools } from "@/lib/ai/tools/browser";

// ─── 辅助 ──────────────────────────────────────────────────────

type ToolLike = {
  description?: unknown;
  inputSchema?: unknown;
  execute?: (...args: never[]) => unknown;
};

function callExecute(t: ToolLike, input: unknown): Promise<unknown> {
  if (!t.execute) throw new Error("no execute");
  return Promise.resolve(t.execute(input as never, { toolCallId: "t", messages: [] } as never));
}

const TID = "browser-tools-thread";
const RUN_ID = "run-1";

/** 全部 14 个工具名（与 buildBrowserTools 返回的 key 一一对应）。 */
const ALL_TOOL_NAMES = [
  "browserGetTabs",
  "browserSnapshot",
  "browserGetConsole",
  "browserGetNetwork",
  "browserScreenshot",
  "browserGetPageText",
  "browserNavigate",
  "browserClick",
  "browserType",
  "browserScroll",
  "browserPressKey",
  "browserSelectOption",
  "browserListDownloads",
  "browserUploadFile",
] as const;

/** 每个工具的合法入参（供批量调用用）。 */
const TOOL_INPUTS: Record<string, unknown> = {
  browserGetTabs: {},
  browserSnapshot: {},
  browserGetConsole: {},
  browserGetNetwork: {},
  browserScreenshot: {},
  browserGetPageText: {},
  browserNavigate: { url: "https://example.com/" },
  browserClick: { x: 0, y: 0 },
  browserType: { text: "hi" },
  browserScroll: { deltaX: 0, deltaY: 0 },
  browserPressKey: { key: "Enter" },
  browserSelectOption: { selector: "#s" },
  browserListDownloads: {},
  browserUploadFile: { selector: "input[type='file']", workspacePath: "downloads/x.pdf" },
};

beforeEach(() => {
  vi.clearAllMocks();
  // executeToolRun 依赖的 DB mock
  queryMocks.getThreadById.mockResolvedValue({ id: TID, userId: "user-1" });
  queryMocks.createToolRun.mockResolvedValue({ id: RUN_ID, threadId: TID, status: "running" });
  queryMocks.appendThreadEvent.mockResolvedValue(undefined);
  queryMocks.finishToolRunSuccess.mockResolvedValue(undefined);
  queryMocks.finishToolRunFailure.mockResolvedValue(undefined);
  queryMocks.listPermissionRules.mockResolvedValue([]);
  queryMocks.findMatchingApprovals.mockResolvedValue([]);
  queryMocks.requestApprovalAtomic.mockResolvedValue({
    run: { id: "run-ask", threadId: TID, status: "running" },
    approval: { id: "approval-1", threadId: TID, status: "pending" },
  });
  queryMocks.updateThreadStatus.mockResolvedValue(undefined);
  // 注入 ThreadRun scope（executeToolRun 读取 runId 归属事件）
  setThreadRunScope(TID, RUN_ID);
});

afterEach(() => {
  clearThreadRunScope(TID);
});

// ─── desktop_unavailable 返回（5 个代表性工具） ────────────────

describe("V10 浏览器工具 - desktop_unavailable（代表性工具）", () => {
  it("browserGetTabs → desktop_unavailable", async () => {
    const tools = buildBrowserTools(TID);
    const r = (await callExecute(tools.browserGetTabs, {})) as {
      ok: boolean;
      error: string;
      message: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("desktop_unavailable");
    expect(r.message).toContain("Desktop");
  });

  it("browserNavigate → desktop_unavailable", async () => {
    const tools = buildBrowserTools(TID);
    const r = (await callExecute(tools.browserNavigate, {
      url: "https://example.com/",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("desktop_unavailable");
  });

  it("browserClick → desktop_unavailable", async () => {
    const tools = buildBrowserTools(TID);
    const r = (await callExecute(tools.browserClick, { x: 100, y: 200 })) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("desktop_unavailable");
  });

  it("browserScreenshot → desktop_unavailable", async () => {
    const tools = buildBrowserTools(TID);
    const r = (await callExecute(tools.browserScreenshot, { fullPage: true })) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("desktop_unavailable");
  });

  it("browserUploadFile → desktop_unavailable", async () => {
    const tools = buildBrowserTools(TID);
    const r = (await callExecute(tools.browserUploadFile, {
      selector: "input[type='file']",
      workspacePath: "downloads/report.pdf",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("desktop_unavailable");
  });
});

// ─── 全部 14 个工具都返回 desktop_unavailable ──────────────────

describe("V10 浏览器工具 - 全部工具返回 desktop_unavailable", () => {
  for (const name of ALL_TOOL_NAMES) {
    it(`${name} → desktop_unavailable`, async () => {
      const tools = buildBrowserTools(TID);
      const t = (tools as Record<string, ToolLike>)[name] as ToolLike;
      const r = (await callExecute(t, TOOL_INPUTS[name])) as {
        ok: boolean;
        error: string;
      };
      expect(r.ok).toBe(false);
      expect(r.error).toBe("desktop_unavailable");
    });
  }

  it("工具总数为 14", () => {
    const tools = buildBrowserTools(TID);
    expect(ALL_TOOL_NAMES).toHaveLength(14);
    for (const name of ALL_TOOL_NAMES) {
      expect((tools as Record<string, ToolLike>)[name], `工具 ${name} 应存在`).toBeDefined();
    }
  });
});

// ─── schema 保留 ───────────────────────────────────────────────

describe("V10 浏览器工具 - schema 保留", () => {
  it("所有 14 个工具都有 description 和 inputSchema 和 execute", () => {
    const tools = buildBrowserTools(TID);
    for (const name of ALL_TOOL_NAMES) {
      const t = (tools as Record<string, ToolLike>)[name] as ToolLike;
      expect(t, `工具 ${name} 应存在`).toBeDefined();
      expect(typeof t.description, `工具 ${name} 应有 description`).toBe("string");
      expect((t.description as string).length, `工具 ${name} description 非空`).toBeGreaterThan(0);
      expect(t.inputSchema, `工具 ${name} 应有 inputSchema`).toBeDefined();
      expect(typeof t.execute, `工具 ${name} 应有 execute`).toBe("function");
    }
  });

  it("browserNavigate 的 inputSchema 包含 url 字段", () => {
    const tools = buildBrowserTools(TID);
    expect(tools.browserNavigate.inputSchema).toBeDefined();
  });

  it("browserClick 的 inputSchema 包含 x/y/button/description 字段", () => {
    const tools = buildBrowserTools(TID);
    expect(tools.browserClick.inputSchema).toBeDefined();
  });

  it("browserGetTabs 的 inputSchema 为空对象 schema", () => {
    const tools = buildBrowserTools(TID);
    expect(tools.browserGetTabs.inputSchema).toBeDefined();
  });
});

// ─── 审计包装 ──────────────────────────────────────────────────

describe("V10 浏览器工具 - 审计包装", () => {
  it("desktop_unavailable 仍经 executeToolRun 审计（tool.called + tool.failed）", async () => {
    const tools = buildBrowserTools(TID);
    await callExecute(tools.browserGetTabs, {});

    // createToolRun 被调用（tool_runs 落库）
    expect(queryMocks.createToolRun).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: TID, toolName: "browserGetTabs" }),
    );

    // tool.called 事件
    const called = queryMocks.appendThreadEvent.mock.calls.find((c) => c[1] === "tool.called");
    expect(called, "应有 tool.called 事件").toBeTruthy();
    expect(called?.[2]).toMatchObject({ toolName: "browserGetTabs" });

    // tool.failed 事件（business failure：desktop_unavailable）
    const failed = queryMocks.appendThreadEvent.mock.calls.find((c) => c[1] === "tool.failed");
    expect(failed, "应有 tool.failed 事件").toBeTruthy();
    expect(failed?.[2]).toMatchObject({ failureKind: "business" });

    // finishToolRunFailure 被调用（business failure 走 failure 路径）
    expect(queryMocks.finishToolRunFailure).toHaveBeenCalled();
    // finishToolRunSuccess 不应被调用（business failure 不走 success）
    expect(queryMocks.finishToolRunSuccess).not.toHaveBeenCalled();
  });

  it("不调用任何 V9 服务器浏览器链路", async () => {
    // V10：browser.ts 不再 import browserGateway / page-insights / browser-queries /
    // workspace / browser-policy。此处仅验证工具仍能正常返回 desktop_unavailable，
    // 且不依赖任何已删除的 Server 模块（若 import 已删除模块会直接报错）。
    const tools = buildBrowserTools(TID);
    const r = (await callExecute(tools.browserNavigate, { url: "https://example.com/" })) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("desktop_unavailable");
  });
});
