import type { McpServerConfig } from "@/lib/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.4 Stage C：MCP client 测试（mock transport + fake Client，不连真实 server）。
 *
 * 用 deps 注入 fake Client + fake Transport，验证 connect/listTools/callTool/close
 * 与超时治理。不触真实 SDK runtime / 网络。
 */

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logger: loggerMock }));

// S1（10-P2-5）：mock recordMcpServerHandshake,断言协商结果落 DB(不只日志)
const handshakeMock = vi.hoisted(() => ({
  recordMcpServerHandshake: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/db/queries", () => ({
  recordMcpServerHandshake: handshakeMock.recordMcpServerHandshake,
}));

function fakeConfig(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "m1",
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "server-github"],
    url: null,
    env: { GITHUB_TOKEN: "secret" },
    allowedTools: null,
    enabled: true,
    lastServerVersion: null,
    lastCapabilities: null,
    lastConnectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function fakeClientDeps(
  over: {
    listTools?: unknown;
    callTool?: unknown;
    serverVersion?: { name?: string; version?: string };
    capabilities?: Record<string, unknown>;
  } = {},
) {
  const calls: string[] = [];
  const client = {
    connect: vi.fn(async () => {
      calls.push("connect");
    }),
    listTools: vi.fn(async () => ({
      tools: over.listTools ?? [
        { name: "create_issue", description: "create an issue", inputSchema: { type: "object" } },
        { name: "list_issues", description: "list issues" },
      ],
    })),
    callTool: vi.fn(
      async (params: { name: string; arguments?: Record<string, unknown> }) =>
        over.callTool ?? {
          content: [{ type: "text", text: `called ${params.name}` }],
          isError: false,
        },
    ),
    close: vi.fn(async () => {
      calls.push("close");
    }),
  };
  // S1（10-P2-5）：可选注入 getServerVersion / getServerCapabilities
  if (over.serverVersion !== undefined) {
    (client as unknown as { getServerVersion: () => Promise<unknown> }).getServerVersion = vi.fn(
      async () => over.serverVersion,
    );
  }
  if (over.capabilities !== undefined) {
    (client as unknown as { getServerCapabilities: () => Promise<unknown> }).getServerCapabilities =
      vi.fn(async () => over.capabilities);
  }
  const transport = {
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { Client: vi.fn(() => client) as unknown as never, transport, client, calls };
}

describe("assertMcpCommand (stdio 白名单)", () => {
  it("包启动器 npx/pnpx/uvx 放行", async () => {
    const { assertMcpCommand } = await import("./client");
    expect(() => assertMcpCommand("npx")).not.toThrow();
    expect(() => assertMcpCommand("pnpx")).not.toThrow();
    expect(() => assertMcpCommand("uvx")).not.toThrow();
  });

  it("通用解释器 node/python/python3 被拒（防 args 内联代码绕过）", async () => {
    const { assertMcpCommand } = await import("./client");
    // 配 command="node" + args=["-e","<代码>"] 即可在宿主执行任意代码,故解释器一律拒。
    expect(() => assertMcpCommand("node")).toThrow();
    expect(() => assertMcpCommand("python")).toThrow();
    expect(() => assertMcpCommand("python3")).toThrow();
  });

  it("含路径分隔符的命令被拒（防 ./evil / /bin/sh）", async () => {
    const { assertMcpCommand } = await import("./client");
    expect(() => assertMcpCommand("/bin/sh")).toThrow();
    expect(() => assertMcpCommand("./evil")).toThrow();
    expect(() => assertMcpCommand("node/something")).toThrow();
  });

  it("其他任意命令被拒", async () => {
    const { assertMcpCommand } = await import("./client");
    expect(() => assertMcpCommand("curl")).toThrow();
    expect(() => assertMcpCommand("bash")).toThrow();
  });
});

describe("connectServer + listTools + callTool (mock deps)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loggerMock.info).mockClear?.();
  });

  it("connect → listTools 返回归一工具信息", async () => {
    const { connectServer } = await import("./client");
    const deps = fakeClientDeps();
    const c = await connectServer(fakeConfig(), deps as never);
    const tools = await c.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe("create_issue");
    expect(deps.client.connect).toHaveBeenCalledWith(deps.transport);
  });

  it("callTool 透传 name + arguments", async () => {
    const { connectServer } = await import("./client");
    const deps = fakeClientDeps();
    const c = await connectServer(fakeConfig(), deps as never);
    const r = await c.callTool("create_issue", { title: "t" });
    expect(deps.client.callTool).toHaveBeenCalledWith(
      {
        name: "create_issue",
        arguments: { title: "t" },
      },
      undefined,
      undefined,
    );
    expect(r.isError).toBe(false);
  });

  it("close 调用 client.close", async () => {
    const { connectServer } = await import("./client");
    const deps = fakeClientDeps();
    const c = await connectServer(fakeConfig(), deps as never);
    await c.close();
    expect(deps.client.close).toHaveBeenCalled();
  });

  it("stdio 无 command → 抛错（buildTransport 校验，不走 deps）", async () => {
    const { connectServer } = await import("./client");
    await expect(connectServer(fakeConfig({ command: null }))).rejects.toThrow(
      "stdio server 缺少 command",
    );
  });
});

describe("callToolWithTimeout 超时治理", () => {
  it("超时 → 抛超时错误 + close 被调用（S1 10-P2-3）", async () => {
    vi.useFakeTimers();
    try {
      const { callToolWithTimeout, connectServer } = await import("./client");
      const deps = fakeClientDeps();
      deps.client.callTool.mockImplementation(
        () => new Promise(() => {}) as never, // 永不 resolve
      );
      const c = await connectServer(fakeConfig(), deps as never);
      const p = callToolWithTimeout(c, "slow", {}, 100);
      vi.advanceTimersByTime(150);
      await expect(p).rejects.toThrow("MCP callTool 超时");
      // S1（10-P2-3）：超时后 client.close() 应被调用（回收连接）
      expect(deps.client.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("正常返回 → 不超时", async () => {
    const { callToolWithTimeout, connectServer } = await import("./client");
    const deps = fakeClientDeps();
    const c = await connectServer(fakeConfig(), deps as never);
    const r = await callToolWithTimeout(c, "fast", {}, 1000);
    expect(r.isError).toBe(false);
  });
});

// S1（10-P2-5）：MCP server 版本 + 能力协商记录
describe("connectServer 版本/能力协商记录", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("连接后记录 server version + capabilities 到 logger + DB", async () => {
    const { connectServer } = await import("./client");
    const deps = fakeClientDeps({
      serverVersion: { name: "github-mcp", version: "1.2.3" },
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
    });
    await connectServer(fakeConfig(), deps as never);

    // server version 记录
    expect(loggerMock.info).toHaveBeenCalledWith(
      "[mcp] server connected",
      expect.objectContaining({
        name: "github",
        serverName: "github-mcp",
        serverVersion: "1.2.3",
      }),
    );
    // capabilities 记录
    expect(loggerMock.info).toHaveBeenCalledWith(
      "[mcp] server capabilities",
      expect.objectContaining({
        name: "github",
        capabilities: expect.objectContaining({
          tools: {},
          resources: {},
          prompts: {},
          logging: {},
        }),
      }),
    );
    // S1（10-P2-5）：协商结果落 DB(不只日志)
    expect(handshakeMock.recordMcpServerHandshake).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({
        serverVersion: "1.2.3",
        capabilities: expect.objectContaining({ tools: {}, resources: {} }),
      }),
    );
  });

  it("server 不支持 getServerVersion/getServerCapabilities → 不抛错,不落 DB(best-effort)", async () => {
    const { connectServer } = await import("./client");
    // 不注入 serverVersion/capabilities → client 无这两个方法
    const deps = fakeClientDeps();
    await expect(connectServer(fakeConfig(), deps as never)).resolves.toBeDefined();
    // 不记录 version/capabilities（只有 connect 成功，无 server connected 日志）
    const calls = loggerMock.info.mock.calls ?? [];
    const versionCalls = calls.filter((c) => c[0] === "[mcp] server connected");
    const capsCalls = calls.filter((c) => c[0] === "[mcp] server capabilities");
    expect(versionCalls).toHaveLength(0);
    expect(capsCalls).toHaveLength(0);
    // 无协商信息 → 不落 DB
    expect(handshakeMock.recordMcpServerHandshake).not.toHaveBeenCalled();
  });
});
