import { mcpConfig } from "@/lib/config";
import { recordMcpServerHandshake } from "@/lib/db/queries";
import type { McpServerConfig } from "@/lib/db/schema";
import { assertSafeExternalUrlResolved } from "@/lib/external/url-safety";
import { logger } from "@/lib/logger";

/**
 * V3.4 MCP client（蓝图 §5.4）。
 *
 * 基于官方 `@modelcontextprotocol/sdk`（不自滚 JSON-RPC）。支持 stdio / http / sse 传输；
 * stdio 在 host 侧 spawn（command/args/env）。SDK 经 lazy import 仅在 MCP 启用时加载，
 * 避免主 bundle 膨胀（§12 风险）。
 *
 * 连接池：per-server-name 复用 client，超时回收 + close。env 含 secret——调用时注入真实 env，
 * 不写日志/事件（§12）。
 *
 * 测试用 deps 注入（fake Client + fake Transport），不连真实 server（命门）。
 */

/** MCP 工具信息（listTools 返回的单条）。 */
export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/** MCP 工具调用结果（callTool 返回）。 */
export type McpCallResult = {
  content: unknown;
  isError?: boolean;
};

/** 最小 Client 契约（与 SDK Client 结构对齐，但解耦运行时依赖，便于 mock）。 */
export type McpClientLike = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: McpToolInfo[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<McpCallResult>;
  close(): Promise<void>;
};

/** Client 构造器契约。 */
export type McpClientCtor = new (
  info: { name: string; version: string },
  opts: { capabilities: Record<string, unknown> },
) => McpClientLike;

/** Transport 契约（SDK Transport 的最小子集）。 */
export type McpTransport = {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
};

/** 连接依赖（默认由 SDK lazy 构造；测试注入 fake）。 */
export type McpClientDeps = {
  Client: McpClientCtor;
  transport: McpTransport;
};

/** stdio command 白名单:仅允许已知 MCP server 包启动器,防 admin 配置任意命令在 host spawn。
 *  P2-7:移除 docker——docker 可经 -v/--mount 挂载宿主文件系统逃逸,env 隔离对其无效。需容器化 MCP server 时由运维在容器内直接跑 npx/uvx。
 *  审计修复:移除 node/python/python3——通用解释器可经 args(-e/-c)执行任意内联代码,
 *  而 config.args 未校验直接传入 spawn,等价任意宿主代码执行。仅保留包启动器(npx/pnpx/uvx),
 *  它们加载已发布包,不能直接执行内联代码。需自定义 MCP server 时发布为包再用启动器加载。 */
const MCP_COMMAND_ALLOWLIST = new Set(["npx", "pnpx", "uvx"]);

export function assertMcpCommand(command: string): void {
  // 取首个 token(命令本身),拒含路径分隔符(防 ./evil / /bin/sh)
  const base = command.trim().split(/\s+/)[0] ?? "";
  const last = base.split("/").pop() ?? base;
  if (!MCP_COMMAND_ALLOWLIST.has(last)) {
    throw new Error(
      `MCP stdio command 不在白名单: ${command}(仅允许 ${[...MCP_COMMAND_ALLOWLIST].join("/")})`,
    );
  }
}

/** 按 config 与传输类型构造 transport（lazy import SDK）。 */
async function buildTransport(config: McpServerConfig): Promise<McpTransport> {
  if (config.transport === "stdio") {
    if (!config.command) throw new Error("stdio server 缺少 command");
    // P1-16: command 白名单,防 host 侧 spawn 任意命令(curl /bin/sh 等)
    assertMcpCommand(config.command);
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    // S1（10-P1-3）：env 隔离——仅传最小系统 env(PATH/HOME) + server 配置 env，不继承全量 process.env
    // （原 undefined 继承全部 process.env，含 DATABASE_URL/LLM_API_KEY 等平台 secret）
    const minimalEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    };
    const serverEnv = (config.env as Record<string, string> | null) ?? {};
    return new StdioClientTransport({
      command: config.command,
      args: (config.args as string[] | null) ?? undefined,
      env: { ...minimalEnv, ...serverEnv },
      stderr: "pipe",
    }) as unknown as McpTransport;
  }
  if (config.transport === "sse") {
    if (!config.url) throw new Error("sse server 缺少 url");
    // P1-16: SSRF 守卫——拒内网/元数据/非 http(s) URL + DNS rebinding 校验
    await assertSafeExternalUrlResolved(config.url, "mcp sse url");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    return new SSEClientTransport(new URL(config.url)) as unknown as McpTransport;
  }
  if (config.transport === "http") {
    if (!config.url) throw new Error("http server 缺少 url");
    // P1-16: SSRF 守卫
    await assertSafeExternalUrlResolved(config.url, "mcp http url");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    return new StreamableHTTPClientTransport(new URL(config.url)) as unknown as McpTransport;
  }
  throw new Error(`不支持的 MCP transport: ${config.transport}`);
}

/** lazy import SDK Client 构造器。 */
async function loadClientCtor(): Promise<McpClientCtor> {
  const mod = await import("@modelcontextprotocol/sdk/client/index.js");
  return mod.Client as unknown as McpClientCtor;
}

/** 已连接 client 句柄。 */
export type McpClient = {
  listTools(): Promise<McpToolInfo[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<McpCallResult>;
  close(): Promise<void>;
  /**
   * 审计修复：onclose setter 透传到 SDK Client（registry 设置时通过此 setter
   * 让 SDK 内部 transport close 事件触发 registry 的清理回调）。
   */
  set onclose(fn: (() => void) | undefined);
};

/**
 * 连接一个 MCP server，返回 client 句柄。
 *
 * @param config server 配置（来自 DB）
 * @param deps 可选依赖（测试注入 fake Client + transport）；默认 lazy 构造 SDK 依赖
 */
export async function connectServer(
  config: McpServerConfig,
  deps?: McpClientDeps,
): Promise<McpClient> {
  const ClientCtor = deps?.Client ?? (await loadClientCtor());
  const transport = deps?.transport ?? (await buildTransport(config));
  const client = new ClientCtor({ name: "snow-harness", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  // S1（10-P2-5）：记录 server 版本 + 能力协商到 DB（原仅落日志,日志轮转丢失不可追溯）。
  // best-effort:任一步失败仅记日志不阻断连接。
  let serverVersion: string | null = null;
  let capabilities: Record<string, unknown> | null = null;
  try {
    const serverInfo = (
      client as unknown as {
        getServerVersion?: () => Promise<{ name?: string; version?: string }>;
      }
    ).getServerVersion?.();
    if (serverInfo) {
      const info = await serverInfo;
      serverVersion = info.version ?? null;
      logger.info("[mcp] server connected", {
        name: config.name,
        serverName: info.name,
        serverVersion: info.version,
      });
    }
  } catch {
    // getServerVersion 不可用 — 忽略
  }
  try {
    const caps = (
      client as unknown as {
        getServerCapabilities?: () => Promise<Record<string, unknown>>;
      }
    ).getServerCapabilities?.();
    if (caps) {
      capabilities = await caps;
      logger.info("[mcp] server capabilities", {
        name: config.name,
        capabilities,
      });
    }
  } catch {
    // getServerCapabilities 不可用 — 忽略
  }
  // 落 DB 供审计兼容性（best-effort,失败不阻断）
  if (serverVersion !== null || capabilities !== null) {
    try {
      await recordMcpServerHandshake(config.name, { serverVersion, capabilities });
    } catch (err) {
      logger.warn("[mcp] server 协商记录落 DB 失败(不阻断连接)", {
        name: config.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    listTools: () => client.listTools().then((r) => r.tools),
    callTool: (name, args, options) =>
      client.callTool({ name, arguments: args }, undefined, options),
    close: () => client.close(),
    // 审计修复：onclose setter 透传到 SDK Client（原 wrapper 对象上设 onclose
    // 不会被 SDK Client 感知，导致 registry 的连接池清理机制失效）。
    set onclose(fn: (() => void) | undefined) {
      const sdkClient = client as unknown as { onclose?: () => void };
      sdkClient.onclose = fn;
    },
  };
}

/**
 * 带超时的 callTool 包装。超时（MCP_CALL_TIMEOUT_MS）→ 抛错。
 * 结果走 V3.3a oversized 摘要（由 executeToolRun / package-builder 自动处理）。
 *
 * P2 修复(10 MCP P2-3): 超时后调 client.close() 回收连接。
 * 超时后 client 状态可能不一致(pending 请求),复用可能异常。
 * 原 finally 只 clearTimeout,不 close,下次复用可能出错。
 * 现超时路径调 close 让 registry 下次 getOrConnect 重建连接。
 */
export async function callToolWithTimeout(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number = mcpConfig.callTimeoutMs,
): Promise<McpCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      // 审计修复：把 signal 传给 SDK callTool，让超时真正中止服务端执行。
      // 原实现只传 name+args → AbortController 仅触发客户端 Promise.race reject，
      // 服务端工具调用继续运行浪费资源。SDK RequestOptions.signal 支持中止。
      client.callTool(name, args, { signal: controller.signal }),
      new Promise<McpCallResult>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error(`MCP callTool 超时（${timeoutMs}ms）`)),
        );
      }),
    ]);
  } catch (error) {
    // 超时/任何错误 → close client,状态不可信,强制下次重建
    await client.close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
