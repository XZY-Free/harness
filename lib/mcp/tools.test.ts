import { computeArgFingerprint } from "@/lib/permission/approval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.4 Stage C：MCP 工具经 executeToolRun + mcpEvaluate（默认 ask）测试。
 *
 * 验收（命门）：
 * - callMcpTool 默认 ask → awaitingApproval + permissionKey=mcp.<server>.<tool> 派生
 * - callMcpTool 既定批准 → 升级 allow → 调用成功 + mcp.called 事件
 * - listMcpTools 列工具 + 工具名归一 mcp.<server>.<tool>
 * - disabled server 不暴露
 */

const TID = "test-mcp-tools";

const queryMocks = vi.hoisted(() => ({
  createToolRun: vi.fn(),
  appendThreadEvent: vi.fn(),
  finishToolRunSuccess: vi.fn(),
  finishToolRunFailure: vi.fn(),
  listPermissionRules: vi.fn(),
  findMatchingApprovals: vi.fn(),
  consumeOnceApproval: vi.fn(),
  requestApprovalAtomic: vi.fn(),
  updateThreadStatus: vi.fn(),
  listEnabledMcpServerConfigs: vi.fn(),
  getMcpServerConfigByName: vi.fn(),
  getThreadById: vi.fn(),
}));
vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: vi.fn() }));
vi.mock("@/lib/db/queries", () => ({
  updateThreadStatus: queryMocks.updateThreadStatus,
  createToolRun: queryMocks.createToolRun,
  appendThreadEvent: queryMocks.appendThreadEvent,
  finishToolRunSuccess: queryMocks.finishToolRunSuccess,
  finishToolRunFailure: queryMocks.finishToolRunFailure,
  listPermissionRules: queryMocks.listPermissionRules,
  findMatchingApprovals: queryMocks.findMatchingApprovals,
  consumeOnceApproval: queryMocks.consumeOnceApproval,
  requestApprovalAtomic: queryMocks.requestApprovalAtomic,
  listEnabledMcpServerConfigs: queryMocks.listEnabledMcpServerConfigs,
  getMcpServerConfigByName: queryMocks.getMcpServerConfigByName,
  getThreadById: queryMocks.getThreadById,
}));

const registryMocks = vi.hoisted(() => ({
  getOrConnect: vi.fn(),
  listEnabledServers: vi.fn(),
  closeClient: vi.fn().mockResolvedValue(undefined),
  rateLimitCheck: vi.fn(), // S1（10-P2-4）
  getServer: vi.fn(),
}));
vi.mock("./registry", () => ({
  getOrConnect: registryMocks.getOrConnect,
  listEnabledServers: registryMocks.listEnabledServers,
  closeClient: registryMocks.closeClient,
  rateLimitCheck: registryMocks.rateLimitCheck,
  getServer: registryMocks.getServer,
}));

const clientMocks = vi.hoisted(() => ({
  callToolWithTimeout: vi.fn(),
}));
vi.mock("./client", () => ({
  callToolWithTimeout: clientMocks.callToolWithTimeout,
}));

type ToolLike = { execute?: (...args: never[]) => unknown };
async function callExecute(tool: ToolLike, input: unknown): Promise<Record<string, unknown>> {
  if (!tool.execute) throw new Error("tool.execute missing");
  return (await tool.execute(
    input as never,
    {
      toolCallId: "t",
      messages: [],
    } as never,
  )) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMocks.listPermissionRules.mockResolvedValue([]);
  queryMocks.findMatchingApprovals.mockResolvedValue([]);
  queryMocks.createToolRun.mockResolvedValue({ id: "tr-1" });
  queryMocks.requestApprovalAtomic.mockResolvedValue({
    run: { id: "run-ask", status: "awaiting_approval" },
    approval: { id: "apr-1" },
  });
  queryMocks.finishToolRunSuccess.mockResolvedValue(undefined);
  queryMocks.finishToolRunFailure.mockResolvedValue(undefined);
  queryMocks.appendThreadEvent.mockResolvedValue(undefined);
  queryMocks.updateThreadStatus.mockResolvedValue(undefined);
  queryMocks.getThreadById.mockResolvedValue({ id: TID, userId: "u1" });
  registryMocks.getServer.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("callMcpTool 默认 ask + permissionKey 派生", () => {
  it("无批准 → ask → awaitingApproval，permissionKey=mcp.github.create_issue", async () => {
    const { buildMcpTools } = await import("./tools");
    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.callMcpTool, {
      server: "github",
      tool: "create_issue",
      args: { title: "t" },
    });
    expect(out.ok).toBe(false);
    expect(out.awaitingApproval).toBe(true);
    expect(queryMocks.requestApprovalAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "callMcpTool",
        permissionKey: "mcp.github.create_issue",
      }),
    );
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalledWith(TID, "awaiting_approval");
    // ask 不调 client
    expect(registryMocks.getOrConnect).not.toHaveBeenCalled();
  });

  it("既定批准 → 升级 allow → 调用成功 + mcp.called 事件", async () => {
    const { buildMcpTools } = await import("./tools");
    const fp = computeArgFingerprint("mcp.github.create_issue", {
      server: "github",
      tool: "create_issue",
      args: { title: "t" },
    });
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-old",
        threadId: TID,
        permissionKey: "mcp.github.create_issue",
        argFingerprint: fp,
        status: "approved",
        approvedScope: "thread",
        expiresAt: null,
      },
    ]);
    registryMocks.getOrConnect.mockResolvedValue({
      listTools: vi.fn(),
      callTool: vi.fn(),
      close: vi.fn(),
    });
    clientMocks.callToolWithTimeout.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.callMcpTool, {
      server: "github",
      tool: "create_issue",
      args: { title: "t" },
    });
    expect(out.ok).toBe(true);
    expect(clientMocks.callToolWithTimeout).toHaveBeenCalled();
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain("mcp.called");
    const calledPayload = queryMocks.appendThreadEvent.mock.calls.find(
      (c) => c[1] === "mcp.called",
    )?.[2];
    expect(calledPayload).toMatchObject({
      server: "github",
      tool: "create_issue",
      permissionKey: "mcp.github.create_issue",
      ok: true,
    });
  });

  it("调用抛错 → ok:false + mcp.called(ok:false) + 回收 client", async () => {
    const { buildMcpTools } = await import("./tools");
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-old",
        threadId: TID,
        permissionKey: "mcp.github.create_issue",
        argFingerprint: computeArgFingerprint("mcp.github.create_issue", {
          server: "github",
          tool: "create_issue",
          args: {},
        }),
        status: "approved",
        approvedScope: "always",
        expiresAt: null,
      },
    ]);
    registryMocks.getOrConnect.mockRejectedValue(new Error("连接失败"));
    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.callMcpTool, {
      server: "github",
      tool: "create_issue",
      args: {},
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("连接失败");
    expect(registryMocks.closeClient).toHaveBeenCalledWith("github");
  });
});

describe("listMcpTools 列工具 + 归一", () => {
  it("列启用 server 工具，工具名归一 mcp.<server>.<tool> + mcp.listed 事件", async () => {
    const { buildMcpTools } = await import("./tools");
    registryMocks.listEnabledServers.mockResolvedValue([
      {
        id: "m1",
        name: "github",
        enabled: true,
        transport: "stdio",
        command: "x",
        allowedTools: null,
      },
    ]);
    registryMocks.getOrConnect.mockResolvedValue({
      listTools: async () => [{ name: "create_issue", description: "create" }],
      callTool: vi.fn(),
      close: vi.fn(),
    });
    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.listMcpTools, {});
    expect(out.ok).toBe(true);
    const listed = out.tools as Array<{ permissionKey: string }>;
    expect(listed[0]?.permissionKey).toBe("mcp.github.create_issue");
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain("mcp.listed");
  });

  it("allowedTools 白名单过滤（非白名单工具不暴露）", async () => {
    const { buildMcpTools } = await import("./tools");
    registryMocks.listEnabledServers.mockResolvedValue([
      {
        id: "m1",
        name: "github",
        enabled: true,
        transport: "stdio",
        command: "x",
        allowedTools: ["create_issue"],
      },
    ]);
    registryMocks.getOrConnect.mockResolvedValue({
      listTools: async () => [{ name: "create_issue" }, { name: "delete_repo" }],
      callTool: vi.fn(),
      close: vi.fn(),
    });
    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.listMcpTools, {});
    expect(out.ok).toBe(true);
    const names = (out.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(["create_issue"]);
  });

  it("无启用 server → ok:false", async () => {
    const { buildMcpTools } = await import("./tools");
    registryMocks.listEnabledServers.mockResolvedValue([]);
    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.listMcpTools, {});
    expect(out.ok).toBe(false);
  });
});

// S1（10-P1-2）：callTool 结果结构校验——content 必须是数组，每项须含 type
describe("callMcpTool 结果结构校验", () => {
  function approvedFor(input: Record<string, unknown>) {
    return [
      {
        id: "apr-struct",
        threadId: TID,
        permissionKey: "mcp.github.create_issue",
        argFingerprint: computeArgFingerprint("mcp.github.create_issue", input),
        status: "approved",
        approvedScope: "always",
        expiresAt: null,
      },
    ];
  }

  beforeEach(() => {
    registryMocks.getOrConnect.mockResolvedValue({
      listTools: vi.fn(),
      callTool: vi.fn(),
      close: vi.fn(),
    });
  });

  it("合法 content（text 项）→ ok:true + 透传 content", async () => {
    const { buildMcpTools } = await import("./tools");
    const input = { server: "github", tool: "create_issue", args: { title: "t" } };
    queryMocks.findMatchingApprovals.mockResolvedValue(approvedFor(input));
    clientMocks.callToolWithTimeout.mockResolvedValue({
      content: [{ type: "text", text: "created #1" }],
      isError: false,
    });
    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.callMcpTool, input);
    expect(out.ok).toBe(true);
    expect(out.content).toEqual([{ type: "text", text: "created #1" }]);
  });

  it("content 非数组 → ok:false（fail-closed，不兜底）", async () => {
    const { buildMcpTools } = await import("./tools");
    const input = { server: "github", tool: "create_issue", args: {} };
    queryMocks.findMatchingApprovals.mockResolvedValue(approvedFor(input));
    clientMocks.callToolWithTimeout.mockResolvedValue({
      content: "just a string",
      isError: false,
    });
    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.callMcpTool, input);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("结构不合规");
  });

  it("content 项缺 type → ok:false（fail-closed）", async () => {
    const { buildMcpTools } = await import("./tools");
    const input = { server: "github", tool: "create_issue", args: {} };
    queryMocks.findMatchingApprovals.mockResolvedValue(approvedFor(input));
    clientMocks.callToolWithTimeout.mockResolvedValue({
      content: [{ text: "no type field" }],
      isError: false,
    });
    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.callMcpTool, input);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("结构不合规");
  });

  it("content 缺失（undefined）→ ok:false（fail-closed）", async () => {
    const { buildMcpTools } = await import("./tools");
    const input = { server: "github", tool: "create_issue", args: {} };
    queryMocks.findMatchingApprovals.mockResolvedValue(approvedFor(input));
    clientMocks.callToolWithTimeout.mockResolvedValue({ isError: false });
    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.callMcpTool, input);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("结构不合规");
  });

  it("超大 content（>256KB）→ 截断为单条 text，仍保留结构", async () => {
    const { buildMcpTools } = await import("./tools");
    const input = { server: "github", tool: "create_issue", args: {} };
    queryMocks.findMatchingApprovals.mockResolvedValue(approvedFor(input));
    const bigText = "x".repeat(300 * 1024);
    clientMocks.callToolWithTimeout.mockResolvedValue({
      content: [{ type: "text", text: bigText }],
      isError: false,
    });
    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.callMcpTool, input);
    expect(out.ok).toBe(true);
    const content = out.content as Array<{ type: string; text: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("MCP 结果截断");
    // 截断后不超 256KB + 标记长度
    expect(content[0]?.text.length).toBeLessThan(257 * 1024);
  });
});

// S1（10-P2-2）：allowedTools 参数级约束——工具名白名单 + 参数匹配
describe("allowedTools 参数级约束", () => {
  function approvedFor(input: Record<string, unknown>) {
    return [
      {
        id: "apr-allow",
        threadId: TID,
        permissionKey: "mcp.fs.read_file",
        argFingerprint: computeArgFingerprint("mcp.fs.read_file", input),
        status: "approved",
        approvedScope: "always",
        expiresAt: null,
      },
    ];
  }

  beforeEach(() => {
    registryMocks.getOrConnect.mockResolvedValue({
      listTools: vi.fn(),
      callTool: vi.fn(),
      close: vi.fn(),
    });
    clientMocks.callToolWithTimeout.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
  });

  it("allowedTools 纯工具名白名单 → 注入 allow，直接放行（无需审批）", async () => {
    const { buildMcpTools } = await import("./tools");
    const input = { server: "fs", tool: "read_file", args: { path: "src/a.ts" } };
    queryMocks.findMatchingApprovals.mockResolvedValue([]); // 无既定批准
    registryMocks.getServer.mockResolvedValue({
      id: "m1",
      name: "fs",
      enabled: true,
      transport: "stdio",
      command: "x",
      allowedTools: ["read_file"],
    });

    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.callMcpTool, input);
    expect(out.ok).toBe(true);
    expect(out.awaitingApproval).toBeUndefined(); // 未走 ask
    expect(clientMocks.callToolWithTimeout).toHaveBeenCalled();
  });

  it("allowedTools 参数级约束（pathRegex 匹配）→ 参数命中放行", async () => {
    const { buildMcpTools } = await import("./tools");
    const input = { server: "fs", tool: "read_file", args: { path: "src/a.ts" } };
    queryMocks.findMatchingApprovals.mockResolvedValue([]);
    registryMocks.getServer.mockResolvedValue({
      id: "m1",
      name: "fs",
      enabled: true,
      transport: "stdio",
      command: "x",
      allowedTools: ['read_file:{"pathRegex":"^src/.*"}'],
    });

    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.callMcpTool, input);
    expect(out.ok).toBe(true);
    expect(clientMocks.callToolWithTimeout).toHaveBeenCalled();
  });

  it("allowedTools 参数级约束（pathRegex 不匹配）→ 走默认 ask → awaitingApproval", async () => {
    const { buildMcpTools } = await import("./tools");
    const input = { server: "fs", tool: "read_file", args: { path: "secret/key.pem" } };
    queryMocks.findMatchingApprovals.mockResolvedValue([]);
    registryMocks.getServer.mockResolvedValue({
      id: "m1",
      name: "fs",
      enabled: true,
      transport: "stdio",
      command: "x",
      allowedTools: ['read_file:{"pathRegex":"^src/.*"}'],
    });

    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.callMcpTool, input);
    expect(out.ok).toBe(false);
    expect(out.awaitingApproval).toBe(true);
    expect(clientMocks.callToolWithTimeout).not.toHaveBeenCalled();
  });

  it("allowedTools 无匹配工具名 → 走默认 ask → awaitingApproval", async () => {
    const { buildMcpTools } = await import("./tools");
    const input = { server: "fs", tool: "delete_file", args: {} };
    queryMocks.findMatchingApprovals.mockResolvedValue([]);
    registryMocks.getServer.mockResolvedValue({
      id: "m1",
      name: "fs",
      enabled: true,
      transport: "stdio",
      command: "x",
      allowedTools: ["read_file"],
    });

    const tools = buildMcpTools(TID);
    const out = await callExecute(tools.callMcpTool, input);
    expect(out.ok).toBe(false);
    expect(out.awaitingApproval).toBe(true);
  });
});
