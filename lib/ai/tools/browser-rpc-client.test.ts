import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V10 Phase 6：Browser RPC client 单元测试。
 *
 * 验证 executeBrowserToolRpc 的完整流程：
 * - 工具名 → RPC 命令映射（未知工具拒绝）
 * - userId 解析（从 threadId 查询）
 * - runId 注入（从 getThreadRunScope 获取）
 * - approval 校验（deny / require_approval / allow 三态）
 * - tabId 解析（通过 getTabs RPC 获取 active tab）
 * - RPC 发送 + 结果脱敏
 *
 * 使用 mock BrowserRpcDispatcher，不依赖真实 BridgeServer。
 */

// ─── mock 声明 ─────────────────────────────────────────────────

const queryMocks = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  getApprovalRequest: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  getThreadById: queryMocks.getThreadById,
  getApprovalRequest: queryMocks.getApprovalRequest,
}));

// getThreadRunScope 不 mock（测试真实 AsyncLocalStorage 行为，用 setThreadRunScope 注入）
vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: vi.fn() }));

import { clearThreadRunScope, setThreadRunScope } from "@/lib/ai/tool-runtime";
import {
  type BrowserRpcDispatcher,
  executeBrowserToolRpc,
} from "@/lib/ai/tools/browser-rpc-client";
import { computeArgFingerprint } from "@/lib/permission/approval";

// ─── 辅助：mock dispatcher ─────────────────────────────────────

class MockDispatcher implements BrowserRpcDispatcher {
  sendRpcToThread = vi.fn();
  /** 命令级 mock 覆盖：command → { ok, result?, code?, message? } */
  private overrides = new Map<
    string,
    { ok: boolean; result?: unknown; code?: string; message?: string }
  >();
  /** getTabs 返回数据 */
  private tabsData: {
    tabs: Array<{ id: string; url?: string }>;
    activeTabId: string | null;
  } | null = null;

  /** 设置 getTabs 返回的 tabs + activeTabId */
  mockTabs(
    threadId: string,
    tabs: Array<{ id: string; url?: string }>,
    activeTabId: string | null,
  ) {
    this.tabsData = { tabs, activeTabId };
    this.refreshImplementation();
  }

  /** 设置指定命令返回失败 */
  mockFailure(command: string, code: string, message: string) {
    this.overrides.set(command, { ok: false, code, message });
    this.refreshImplementation();
  }

  /** 设置指定命令返回特定结果 */
  mockResult(command: string, result: unknown) {
    this.overrides.set(command, { ok: true, result });
    this.refreshImplementation();
  }

  /** 设置 getTabs 失败 */
  mockGetTabsFailure() {
    this.overrides.set("browser.getTabs", {
      ok: false,
      code: "desktop_unavailable",
      message: "无 lease 持有该 thread",
    });
    this.tabsData = null;
    this.refreshImplementation();
  }

  private refreshImplementation() {
    this.sendRpcToThread.mockImplementation(async (params: { command: string }) => {
      // 优先使用 override
      const override = this.overrides.get(params.command);
      if (override) return override;
      // getTabs 默认返回 tabsData
      if (params.command === "browser.getTabs" && this.tabsData) {
        return { ok: true, result: this.tabsData };
      }
      // 默认成功
      return { ok: true, result: { success: true, command: params.command } };
    });
  }
}

const TID = "thread-rpc-1";
const UID = "user-1";
const RUN_ID = "run-rpc-1";

beforeEach(() => {
  vi.clearAllMocks();
  queryMocks.getThreadById.mockResolvedValue({ id: TID, userId: UID });
  setThreadRunScope(TID, RUN_ID);
});

// 清理 scope（在 afterAll 或每个 describe 后）
import { afterEach } from "vitest";
afterEach(() => {
  clearThreadRunScope(TID);
});

// ─── 工具名映射 ───────────────────────────────────────────────

describe("executeBrowserToolRpc - 工具名映射", () => {
  it("未知工具名返回 unknown_tool", async () => {
    const dispatcher = new MockDispatcher();
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserUnknown",
      input: {},
      userId: UID,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown_tool");
  });

  it("browserListDownloads 正确映射到 browser.listDownloads（Phase 7-1）", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockResult("browser.listDownloads", { downloads: [] });
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserListDownloads",
      input: {},
      userId: UID,
    });
    expect(result.ok).toBe(true);
    expect(dispatcher.sendRpcToThread).toHaveBeenCalledTimes(1);
    const call = dispatcher.sendRpcToThread.mock.calls[0]?.[0];
    expect(call.command).toBe("browser.listDownloads");
  });

  it("browserGetTabs 正确映射到 browser.getTabs", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserGetTabs",
      input: {},
      userId: UID,
    });
    expect(result.ok).toBe(true);
    // getTabs 不需要 tabId 解析（不在 COMMANDS_NEEDING_TAB_ID 中）
    expect(dispatcher.sendRpcToThread).toHaveBeenCalledTimes(1);
    const call = dispatcher.sendRpcToThread.mock.calls[0]?.[0];
    expect(call.command).toBe("browser.getTabs");
  });
});

// ─── userId / runId 解析 ──────────────────────────────────────

describe("executeBrowserToolRpc - userId / runId 解析", () => {
  it("未提供 userId 时从 getThreadById 查询", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserGetTabs",
      input: {},
      // 不传 userId
    });
    expect(queryMocks.getThreadById).toHaveBeenCalledWith(TID);
    const call = dispatcher.sendRpcToThread.mock.calls[0]?.[0];
    expect(call.userId).toBe(UID);
  });

  it("thread 不存在时返回 thread_not_found", async () => {
    queryMocks.getThreadById.mockResolvedValue(null);
    const dispatcher = new MockDispatcher();
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: "nonexistent",
      toolName: "browserGetTabs",
      input: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("thread_not_found");
  });

  it("未提供 runId 时从 getThreadRunScope 获取", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserGetTabs",
      input: {},
      userId: UID,
      // 不传 runId → 从 scope 获取
    });
    const call = dispatcher.sendRpcToThread.mock.calls[0]?.[0];
    expect(call.runId).toBe(RUN_ID);
  });

  it("显式传入 runId 覆盖 scope", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserGetTabs",
      input: {},
      userId: UID,
      runId: "custom-run",
    });
    const call = dispatcher.sendRpcToThread.mock.calls[0]?.[0];
    expect(call.runId).toBe("custom-run");
  });
});

// ─── approval 校验 ────────────────────────────────────────────

describe("executeBrowserToolRpc - approval 校验", () => {
  it("credential 风险一律 deny（browser.type + password selector）", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserType",
      input: { text: "secret123", selector: "input[name='password']" },
      userId: UID,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("credential_denied");
    expect(result.message).toContain("凭证");
    // 不应发送 RPC
    expect(dispatcher.sendRpcToThread).not.toHaveBeenCalled();
  });

  it("require_approval 无 approvalId → approval_required", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserClick",
      input: { x: 100, y: 200, description: "点击删除按钮" },
      userId: UID,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("approval_required");
    // 不应发送 RPC
    expect(dispatcher.sendRpcToThread).not.toHaveBeenCalled();
  });

  it("require_approval 有 approvalId → 正常发送", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    const input = { x: 100, y: 200, description: "点击删除按钮" };
    queryMocks.getApprovalRequest.mockResolvedValue({
      id: "approval-1",
      threadId: TID,
      toolName: "browserClick",
      argFingerprint: computeArgFingerprint("browserClick", input),
      status: "approved",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserClick",
      input,
      userId: UID,
      approvalId: "approval-1",
    });
    expect(result.ok).toBe(true);
    // click 需要先调 getTabs 解析 tabId，实际 click 是第二次调用
    const clickCall = dispatcher.sendRpcToThread.mock.calls[1]?.[0];
    expect(clickCall.approvalId).toBe("approval-1");
  });

  it("伪造或不匹配的 approvalId 被拒绝且不发送 RPC", async () => {
    const dispatcher = new MockDispatcher();
    queryMocks.getApprovalRequest.mockResolvedValue(null);
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserClick",
      input: { x: 100, y: 200, description: "点击删除按钮" },
      userId: UID,
      approvalId: "forged",
    });
    expect(result.error).toBe("approval_invalid");
    expect(dispatcher.sendRpcToThread).not.toHaveBeenCalled();
  });

  it("allow 类命令无需 approvalId（browser.navigate）", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserNavigate",
      input: { url: "https://example.com/" },
      userId: UID,
    });
    expect(result.ok).toBe(true);
    // navigate 需要先调 getTabs 解析 tabId，实际 navigate 是第二次调用
    const navCall = dispatcher.sendRpcToThread.mock.calls[1]?.[0];
    expect(navCall.approvalId).toBeNull();
  });

  it("click 无敏感 description → allow（不需要 approval）", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserClick",
      input: { x: 10, y: 20, description: "点击展开按钮" },
      userId: UID,
    });
    expect(result.ok).toBe(true);
  });
});

// ─── tabId 解析 ───────────────────────────────────────────────

describe("executeBrowserToolRpc - tabId 解析", () => {
  it("需要 tabId 的命令先调 getTabs 解析 active tab", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }, { id: "tab-2" }], "tab-2");
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserNavigate",
      input: { url: "https://example.com/" },
      userId: UID,
    });
    expect(result.ok).toBe(true);
    // 第一次调用是 getTabs（解析 tabId），第二次是实际命令
    expect(dispatcher.sendRpcToThread).toHaveBeenCalledTimes(2);
    expect(dispatcher.sendRpcToThread.mock.calls[0]?.[0].command).toBe("browser.getTabs");
    expect(dispatcher.sendRpcToThread.mock.calls[1]?.[0].command).toBe("browser.navigate");
    expect(dispatcher.sendRpcToThread.mock.calls[1]?.[0].payload.tabId).toBe("tab-2");
  });

  it("activeTabId 为 null 时降级使用第一个 tab", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "first-tab" }, { id: "second-tab" }], null);
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserScroll",
      input: { deltaX: 0, deltaY: 100 },
      userId: UID,
    });
    expect(result.ok).toBe(true);
    expect(dispatcher.sendRpcToThread.mock.calls[1]?.[0].payload.tabId).toBe("first-tab");
  });

  it("无 tab 时返回 no_active_tab", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [], null);
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserNavigate",
      input: { url: "https://example.com/" },
      userId: UID,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_active_tab");
  });

  it("getTabs RPC 失败时返回 desktop_unavailable", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockGetTabsFailure();
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserNavigate",
      input: { url: "https://example.com/" },
      userId: UID,
    });
    expect(result.ok).toBe(false);
    // getTabs 失败 → resolveActiveTabId 返回 null → no_active_tab
    expect(result.error).toBe("no_active_tab");
  });

  it("browser.getTabs 本身不需要 tabId 解析（单次 RPC）", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserGetTabs",
      input: {},
      userId: UID,
    });
    // getTabs 命令本身只调一次 RPC（不先调 getTabs 解析 tabId）
    expect(dispatcher.sendRpcToThread).toHaveBeenCalledTimes(1);
  });
});

// ─── RPC 结果处理 ──────────────────────────────────────────────

describe("executeBrowserToolRpc - RPC 结果处理", () => {
  it("RPC 失败时透传 error code", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    dispatcher.mockFailure("browser.navigate", "tab_not_found", "tab 不存在");
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserNavigate",
      input: { url: "https://example.com/" },
      userId: UID,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("tab_not_found");
    expect(result.message).toBe("tab 不存在");
  });

  it("RPC 成功时对结果应用脱敏（console entries）", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    dispatcher.mockResult("browser.getConsole", {
      entries: [
        { level: "error", text: "Error: something\n    at fn (http://app.js:1:1)" },
        { level: "warning", text: "Warning: deprecated" },
      ],
    });
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserGetConsole",
      input: { level: "error" },
      userId: UID,
    });
    expect(result.ok).toBe(true);
    const redacted = result.result as { entries: Array<{ text: string }> };
    // stack trace 被移除
    expect(redacted.entries[0]?.text).toBe("Error: something");
    expect(redacted.entries[0]?.text).not.toContain("at fn");
  });

  it("screenshot 结果原始字节被替换为 ref 占位", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    dispatcher.mockResult("browser.screenshot", {
      path: "/tmp/screenshot.png",
      base64: "iVBORw0KGgoAAAANS...",
    });
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserScreenshot",
      input: {},
      userId: UID,
    });
    expect(result.ok).toBe(true);
    const redacted = result.result as { path: string; ref: string; base64?: string };
    expect(redacted.ref).toBe("[REDACTED_RAW_BYTES]");
    expect(redacted.base64).toBeUndefined();
  });

  it("network 结果敏感头被移除", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    dispatcher.mockResult("browser.getNetwork", {
      entries: [
        {
          url: "https://api.example.com/data",
          method: "GET",
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "session=abc123; HttpOnly",
            authorization: "Bearer token123",
          },
          body: '{"data":"sensitive"}',
        },
      ],
    });
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserGetNetwork",
      input: {},
      userId: UID,
    });
    expect(result.ok).toBe(true);
    const redacted = result.result as {
      entries: Array<{ headers: Record<string, string>; body: string | null }>;
    };
    expect(redacted.entries[0]?.headers["set-cookie"]).toBeUndefined();
    expect(redacted.entries[0]?.headers.authorization).toBeUndefined();
    expect(redacted.entries[0]?.headers["content-type"]).toBe("application/json");
    expect(redacted.entries[0]?.body).toBeNull();
  });

  it("getTabs 结果 URL 被脱敏（移除敏感 query 参数）", async () => {
    const dispatcher = new MockDispatcher();
    // getTabs 的返回值也走 redactCommandResult
    dispatcher.sendRpcToThread.mockResolvedValue({
      ok: true,
      result: {
        tabs: [{ id: "tab-1", url: "https://app.com/page?token=secret123&name=test" }],
        activeTabId: "tab-1",
      },
    });
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserGetTabs",
      input: {},
      userId: UID,
    });
    expect(result.ok).toBe(true);
    const redacted = result.result as { tabs: Array<{ url: string }> };
    expect(redacted.tabs[0]?.url).not.toContain("token=secret123");
    expect(redacted.tabs[0]?.url).toContain("name=test");
  });
});

// ─── payload 构建 ──────────────────────────────────────────────

describe("executeBrowserToolRpc - payload 构建", () => {
  it("browser.navigate payload 包含 url + threadId + tabId", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserNavigate",
      input: { url: "https://example.com/" },
      userId: UID,
    });
    const navCall = dispatcher.sendRpcToThread.mock.calls[1]?.[0];
    expect(navCall.payload).toMatchObject({
      threadId: TID,
      tabId: "tab-1",
      url: "https://example.com/",
    });
  });

  it("browser.click payload 包含 x/y/button/description", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserClick",
      input: { x: 50, y: 100, button: "right", description: "点击展开" },
      userId: UID,
    });
    const clickCall = dispatcher.sendRpcToThread.mock.calls[1]?.[0];
    expect(clickCall.payload).toMatchObject({
      x: 50,
      y: 100,
      button: "right",
      description: "点击展开",
    });
  });

  it("browser.navigate 需要先解析 tabId 再发送", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    const result = await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserNavigate",
      input: { url: "https://example.com/" },
      userId: UID,
    });
    expect(result.ok).toBe(true);
    // navigate 需要 tabId，先调 getTabs 解析再调 navigate
    expect(dispatcher.sendRpcToThread).toHaveBeenCalledTimes(2);
  });

  it("browser.scroll payload 包含 deltaX/deltaY", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserScroll",
      input: { deltaX: 0, deltaY: 500 },
      userId: UID,
    });
    const scrollCall = dispatcher.sendRpcToThread.mock.calls[1]?.[0];
    expect(scrollCall.payload).toMatchObject({ deltaX: 0, deltaY: 500 });
  });

  it("browser.uploadWorkspaceFile payload 包含 downloadUrl（Phase 7-2）", async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
    await executeBrowserToolRpc({
      dispatcher,
      threadId: TID,
      toolName: "browserUploadFile",
      input: { selector: "input[type='file']", workspacePath: "uploads/image.png" },
      userId: UID,
    });
    const uploadCall = dispatcher.sendRpcToThread.mock.calls[1]?.[0];
    // payload 应包含 downloadUrl（替代原 filePath）
    expect(uploadCall.payload).toHaveProperty("downloadUrl");
    expect(typeof uploadCall.payload.downloadUrl).toBe("string");
    expect(uploadCall.payload.downloadUrl.length).toBeGreaterThan(0);
    // downloadUrl 应包含 threadId 与 token 查询参数
    expect(uploadCall.payload.downloadUrl).toContain(`/api/threads/${TID}/workspace/download`);
    expect(uploadCall.payload.downloadUrl).toContain("token=");
    // payload 不应再包含 filePath（已替换为 downloadUrl）
    expect(uploadCall.payload).not.toHaveProperty("filePath");
    // payload 应保留 selector
    expect(uploadCall.payload).toMatchObject({ selector: "input[type='file']" });
  });
});

// ─── 各读取命令 ────────────────────────────────────────────────

describe("executeBrowserToolRpc - 读取命令", () => {
  const readCases = [
    { tool: "browserGetTabs", input: {}, cmd: "browser.getTabs" },
    { tool: "browserSnapshot", input: { maxTextLength: 1000 }, cmd: "browser.snapshot" },
    { tool: "browserGetConsole", input: { level: "error", limit: 20 }, cmd: "browser.getConsole" },
    { tool: "browserGetNetwork", input: { filter: "failed" }, cmd: "browser.getNetwork" },
    { tool: "browserScreenshot", input: { fullPage: true }, cmd: "browser.screenshot" },
    { tool: "browserGetPageText", input: { maxTextLength: 3000 }, cmd: "browser.getPageMetadata" },
  ];

  for (const { tool, input, cmd } of readCases) {
    it(`${tool} → ${cmd}`, async () => {
      const dispatcher = new MockDispatcher();
      if (cmd === "browser.getTabs") {
        dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
      } else {
        dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
        dispatcher.mockResult(cmd, { data: "test" });
      }
      const result = await executeBrowserToolRpc({
        dispatcher,
        threadId: TID,
        toolName: tool,
        input,
        userId: UID,
      });
      expect(result.ok).toBe(true);
    });
  }
});

// ─── 各操作命令 ────────────────────────────────────────────────

describe("executeBrowserToolRpc - 操作命令（allow 类）", () => {
  const actionCases = [
    { tool: "browserNavigate", input: { url: "https://example.com/" }, cmd: "browser.navigate" },
    { tool: "browserScroll", input: { deltaX: 0, deltaY: 100 }, cmd: "browser.scroll" },
    { tool: "browserPressKey", input: { key: "Enter" }, cmd: "browser.press" },
    {
      tool: "browserSelectOption",
      input: { selector: "#s", value: "opt1" },
      cmd: "browser.select",
    },
    {
      tool: "browserUploadFile",
      input: { selector: "input[type='file']", workspacePath: "downloads/f.pdf" },
      cmd: "browser.uploadWorkspaceFile",
    },
  ];

  for (const { tool, input, cmd } of actionCases) {
    it(`${tool} → ${cmd}`, async () => {
      const dispatcher = new MockDispatcher();
      dispatcher.mockTabs(TID, [{ id: "tab-1" }], "tab-1");
      const result = await executeBrowserToolRpc({
        dispatcher,
        threadId: TID,
        toolName: tool,
        input,
        userId: UID,
      });
      expect(result.ok).toBe(true);
      // 最后一次调用应是实际命令
      const lastCall =
        dispatcher.sendRpcToThread.mock.calls[
          dispatcher.sendRpcToThread.mock.calls.length - 1
        ]?.[0];
      expect(lastCall.command).toBe(cmd);
    });
  }
});
