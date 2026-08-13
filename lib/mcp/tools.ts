import { executeToolRun } from "@/lib/ai/tool-runtime";
import { appendThreadEvent } from "@/lib/db/queries";
import type { ToolApprovalRequest } from "@/lib/db/schema";
import type { PermissionRule, PermissionVerdict } from "@/lib/permission/engine";
import { evaluatePermission, isReDoSRisky } from "@/lib/permission/engine";
import { tool } from "ai";
import { z } from "zod";
import { type McpClientDeps, callToolWithTimeout } from "./client";
import {
  closeClient,
  getOrConnect,
  getServer,
  listEnabledServers,
  rateLimitCheck,
} from "./registry";

// MCP callTool 结果结构校验 schema。
// content 必须是数组，每项是 { type: "text"|"image"|"resource", ...对应字段 } 之一。
// 不合规 → fail-closed 抛错（不静默兜底成空 content）。
const McpContentItemSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal("resource"), resource: z.unknown() }),
  z
    .object({
      type: z.string(),
    })
    .passthrough(), // 向前兼容：未知 type 保留原始数据（不丢信息），但 type 必须存在
]);

const McpCallResultSchema = z.object({
  content: z.array(McpContentItemSchema),
  isError: z.boolean().optional(),
});

// listTools TTL 缓存（60s），避免每次 listMcpTools 都 JSON-RPC 往返
const listToolsCache = new Map<string, { tools: unknown[]; expiry: number }>();
const LIST_TOOLS_TTL_MS = 60_000;

/**
 * MCP 工具：listMcpTools / callMcpTool（蓝图 ）。
 *
 * 工具名归一 `mcp.<server>.<tool>` 作为 permissionKey（依赖 多前缀修复）。
 * - listMcpTools：列指定/全部启用 server 的工具；写 mcp.listed 事件。
 * - callMcpTool：调 client.callTool；permissionKey = mcp.<server>.<tool>（动态派生）；
 * 默认 ask（外部不可信，mcpEvaluate）；写 mcp.called 事件。
 *
 * 本阶段只暴露 callMcpTool 通用入口 + listMcpTools（§决策：不逐 MCP 工具注入 buildTools，
 * 避免动态工具集膨胀，留后续）。
 */

/**
 * callMcpTool 的 `evaluate` 覆盖：默认 ask（外部不可信）。
 *
 * 合并 DB 规则 + 一条 `mcp.*` → ask 默认规则（priority 0），交 evaluatePermission 仲裁；
 * DB 规则（如 allow/deny）可覆盖默认 ask。ask 时既定批准升级为 allow。
 *
 * allowedTools 参数级约束——若 server 配置的 allowedTools 含本工具的
 * 显式 allow 条目（支持 "toolName" 纯白名单或 "toolName:{argMatcher}" 参数约束），
 * 注入 allow 规则（priority 高于默认 ask），argMatcher 命中即放行。
 */
export function mcpEvaluate(args: {
  input: Record<string, unknown>;
  threadId: string;
  projectId?: string | null;
  permissionKey: string;
  dbRules: PermissionRule[];
  existingApprovals: ToolApprovalRequest[];
  /** server 的 allowedTools 配置（解析后注入 allow 规则）。 */
  allowedTools?: string[] | null;
}): PermissionVerdict {
  const defaultAskRule: PermissionRule = {
    id: "default:mcp:ask",
    scope: "global",
    scopeRef: null,
    toolPattern: "mcp.*",
    argMatcher: null,
    decision: "ask",
    reason: "MCP 工具默认需审批（外部不可信）",
    priority: 0,
  };
  // 从 allowedTools 派生 allow 规则（参数级约束）
  // MCP 工具参数在 input.args 内，权限引擎的 argMatcher（pathRegex/commandRegex）匹配
  // input.path/input.command。这里在 mcpEvaluate 层先用 allowedTools 的 argMatcher 对
  // args 内字段做匹配，命中才注入 allow（argMatcher=null，避免 engine 重复匹配 args 外的 input）。
  const allowRules = deriveAllowRules(args.permissionKey, args.allowedTools, args.input);
  return evaluatePermission({
    toolName: "callMcpTool",
    permissionKey: args.permissionKey,
    input: args.input,
    threadId: args.threadId,
    projectId: args.projectId ?? null,
    dbRules: [...args.dbRules, ...allowRules, defaultAskRule],
    existingApprovals: args.existingApprovals,
  });
}

/**
 * 从 allowedTools 配置派生 allow 规则。
 *
 * supported formats per entry:
 * - "toolName" → 纯工具名白名单，注入 allow（argMatcher=null，任意参数放行）
 * - "toolName:{json argMatcher}" → 工具名 + 参数约束（如 "read_file:{"pathRegex":"^src/.*"}"）
 *
 * 仅匹配当前 permissionKey 的条目生效。argMatcher 在本层对 input.args 内字段做匹配
 * （MCP 工具参数在 args 内，权限引擎的 matchArg 只看 input.path/input.command 顶层字段），
 * 命中才注入 allow（argMatcher=null，避免 engine 重复匹配）。返回规则 priority 高于默认 ask。
 */
function deriveAllowRules(
  permissionKey: string,
  allowedTools: string[] | null | undefined,
  input: Record<string, unknown>,
): PermissionRule[] {
  if (!allowedTools || allowedTools.length === 0) return [];
  // permissionKey = mcp.<server>.<tool>，取末段 toolName 做匹配
  const toolName = permissionKey.split(".").slice(2).join(".");
  if (!toolName) return [];
  // MCP 工具参数在 input.args 内，展开供 argMatcher 匹配
  const argsObj =
    input.args && typeof input.args === "object" ? (input.args as Record<string, unknown>) : {};
  const matchInput = { ...input, ...argsObj };
  const rules: PermissionRule[] = [];
  for (const entry of allowedTools) {
    const parsed = parseAllowedToolEntry(entry);
    if (!parsed || parsed.toolName !== toolName) continue;
    // 本层做 argMatcher 匹配（命中才注入 allow，argMatcher 置 null 避免 engine 重复匹配）
    if (!matchArgMatcher(parsed.argMatcher, matchInput)) continue;
    rules.push({
      id: `allowedTools:${permissionKey}:${entry}`,
      scope: "global",
      scopeRef: null,
      toolPattern: permissionKey,
      argMatcher: null,
      decision: "allow",
      reason: `allowedTools 显式放行：${entry}`,
      priority: 50, // 高于默认 ask(0)，低于 DB deny(100)
    });
  }
  return rules;
}

/** argMatcher 匹配（与 engine.matchArg 等价，但用于 mcpEvaluate 层）。 */
function matchArgMatcher(
  matcher: { pathRegex?: string; commandRegex?: string; risk?: string } | null,
  input: Record<string, unknown>,
): boolean {
  if (!matcher) return true; // 无约束 → 放行
  if (matcher.pathRegex !== undefined) {
    // 输入缺 path 字段或类型不匹配 → fail-closed（约束不满足，不放行）
    if (typeof input.path !== "string") return false;
    if (input.path.length > 10_000) return false;
    // ReDoS 防护（与 engine.matchArg 对齐）
    if (isReDoSRisky(matcher.pathRegex)) return false;
    const re = new RegExp(matcher.pathRegex);
    const normalized = input.path.replace(/^\.?\//, "");
    if (re.test(input.path) || re.test(normalized)) return true;
    return false;
  }
  if (matcher.commandRegex !== undefined) {
    // 输入缺 command 字段或类型不匹配 → fail-closed
    if (typeof input.command !== "string") return false;
    if (input.command.length > 10_000) return false;
    if (isReDoSRisky(matcher.commandRegex)) return false;
    const re = new RegExp(matcher.commandRegex);
    return re.test(input.command);
  }
  // 审计修复：若 argMatcher 仅含 risk 字段（无 pathRegex/commandRegex），
  // 原实现 fall-through 到 return true，导致 allow 规则无条件注入，绕过默认 ask。
  // risk 字段当前未实现评估逻辑，应 fail-closed（不放行）而非 fail-open。
  return false;
}

/** 解析 allowedTools 单条：返回 { toolName, argMatcher }，不合规返回 null。 */
function parseAllowedToolEntry(entry: string): {
  toolName: string;
  argMatcher: { pathRegex?: string; commandRegex?: string; risk?: string } | null;
} | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  // "toolName:{json}" 形态
  const m = /^([^{:\s]+):\s*(\{[\s\S]*\})\s*$/.exec(trimmed);
  if (m?.[1] && m[2]) {
    try {
      const obj = JSON.parse(m[2]) as {
        pathRegex?: string;
        commandRegex?: string;
        risk?: string;
      };
      return {
        toolName: m[1],
        argMatcher: {
          pathRegex: typeof obj.pathRegex === "string" ? obj.pathRegex : undefined,
          commandRegex: typeof obj.commandRegex === "string" ? obj.commandRegex : undefined,
          risk: typeof obj.risk === "string" ? obj.risk : undefined,
        },
      };
    } catch {
      return null; // JSON 解析失败，忽略该条（fail-closed：不注入 allow）
    }
  }
  // 纯工具名（不含 : 或 {）
  if (/^[^\s:{]+$/.test(trimmed)) {
    return { toolName: trimmed, argMatcher: null };
  }
  return null;
}

/** allowedTools 列表中是否有 entry 的 toolName 段匹配给定工具名。 */
function allowedToolNameMatches(allowedTools: string[], toolName: string): boolean {
  return allowedTools.some((entry) => parseAllowedToolEntry(entry)?.toolName === toolName);
}

/** 派生 permissionKey：mcp.<server>.<tool>。 */
export function mcpPermissionKey(server: string, tool: string): string {
  return `mcp.${server}.${tool}`;
}

/** 构造 MCP 工具集（仅需 threadId；测试可注入 clientDeps）。 */
export function buildMcpTools(threadId: string, deps?: { clientDeps?: McpClientDeps }) {
  return {
    listMcpTools: tool({
      description:
        "列出一个或全部已启用的 MCP server 提供的工具。工具名归一为 mcp.<server>.<tool>。",
      inputSchema: z.object({
        server: z.string().optional().describe("仅列出该 server 的工具；不传则列全部启用 server"),
      }),
      execute: async ({ server }) => {
        try {
          return await executeToolRun(threadId, "listMcpTools", { server }, async (signal) => {
            const servers = await listEnabledServers();
            const target = server ? servers.filter((s) => s.name === server) : servers;
            if (target.length === 0) {
              return {
                ok: false,
                error: server ? `MCP server 未启用或不存在: ${server}` : "无启用的 MCP server",
              };
            }
            const out: Array<{
              server: string;
              name: string;
              description?: string;
              permissionKey: string;
            }> = [];
            for (const s of target) {
              try {
                // TTL 缓存——60s 内复用 listTools 结果
                const cached = listToolsCache.get(s.name);
                let tools: Array<{ name: string; description?: string }>;
                if (cached && Date.now() < cached.expiry) {
                  tools = cached.tools as Array<{ name: string; description?: string }>;
                } else {
                  const client = await getOrConnect(s.name, deps?.clientDeps);
                  tools = await client.listTools();
                  listToolsCache.set(s.name, { tools, expiry: Date.now() + LIST_TOOLS_TTL_MS });
                }
                for (const t of tools) {
                  const allowed = s.allowedTools as string[] | null;
                  // allowedTools 参数级约束——工具名匹配（解析 entry 取 toolName 段）
                  // 才暴露；参数级约束在 callMcpTool 走 mcpEvaluate 时生效
                  if (allowed && !allowedToolNameMatches(allowed, t.name)) continue;
                  out.push({
                    server: s.name,
                    name: t.name,
                    description: t.description,
                    permissionKey: mcpPermissionKey(s.name, t.name),
                  });
                }
                await appendThreadEvent(threadId, "mcp.listed", {
                  server: s.name,
                  toolCount: tools.length,
                });
              } catch (e) {
                await appendThreadEvent(threadId, "mcp.listed", {
                  server: s.name,
                  toolCount: 0,
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }
            return { ok: true, tools: out };
          });
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    }),

    callMcpTool: tool({
      description:
        "调用一个 MCP server 的工具。permissionKey=mcp.<server>.<tool>，默认需审批（外部工具）。" +
        "审批后调用成功；结果过大由 a 自动摘要。",
      inputSchema: z.object({
        server: z.string().describe("MCP server 名"),
        tool: z.string().describe("工具名（不含 mcp.<server>. 前缀）"),
        args: z.record(z.string(), z.unknown()).optional().describe("工具参数"),
      }),
      execute: async ({ server, tool: toolName, args = {} }) => {
        const permissionKey = mcpPermissionKey(server, toolName);
        const startedAt = Date.now();
        // 预先查 server 配置拿 allowedTools，构造带参数级约束的 evaluate 闭包
        const serverConfig = await getServer(server).catch(() => null);
        const allowedTools = (serverConfig?.allowedTools as string[] | null) ?? null;
        try {
          return await executeToolRun(
            threadId,
            "callMcpTool",
            { server, tool: toolName, args },
            async (signal) => {
              // 兼容：runner 闭包内自处理连接/调用错误，转成 {ok:false} 返回，
              // 避免 executeToolRun 吞异常后外层 catch（含 closeClient 回收）不触发导致 client 泄漏。
              let client: Awaited<ReturnType<typeof getOrConnect>>;
              try {
                client = await getOrConnect(server, deps?.clientDeps);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                await appendThreadEvent(threadId, "mcp.called", {
                  server,
                  tool: toolName,
                  permissionKey,
                  ok: false,
                  durationMs: Date.now() - startedAt,
                  error: msg,
                }).catch(() => {});
                await closeClient(server).catch(() => {});
                return { ok: false, server, tool: toolName, error: msg };
              }
              // 调用前限流检查
              rateLimitCheck(server);
              const result = await callToolWithTimeout(client, toolName, args);
              // 结果结构校验——content 必须是数组，每项须含 type 字段。
              // fail-closed：不合规抛错（不静默兜底成空 content），由外层 catch 转 ok:false。
              const parsed = McpCallResultSchema.safeParse(result);
              if (!parsed.success) {
                throw new Error(
                  `MCP callTool 返回结果结构不合规：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
                );
              }
              // 超 256KB 截断（保留结构：逐项截断 text，超长整体降级为单条 text）
              let content: unknown = parsed.data.content;
              const str = JSON.stringify(content);
              if (str.length > 256 * 1024) {
                content = [
                  {
                    type: "text" as const,
                    text: `${str.slice(0, 256 * 1024)}[...MCP 结果截断（超 256KB）...]`,
                  },
                ];
              }
              await appendThreadEvent(threadId, "mcp.called", {
                server,
                tool: toolName,
                permissionKey,
                ok: !parsed.data.isError,
                durationMs: Date.now() - startedAt,
              });
              return {
                ok: !parsed.data.isError,
                server,
                tool: toolName,
                content,
                isError: parsed.data.isError ?? false,
              };
            },
            {
              permissionKey,
              evaluate: (ea) => mcpEvaluate({ ...ea, allowedTools }),
            },
          );
        } catch (error) {
          await appendThreadEvent(threadId, "mcp.called", {
            server,
            tool: toolName,
            permissionKey,
            ok: false,
            durationMs: Date.now() - startedAt,
            error: (error as Error).message,
          }).catch(() => {});
          await closeClient(server).catch(() => {});
          return { ok: false, server, tool: toolName, error: (error as Error).message };
        }
      },
    }),
  };
}
