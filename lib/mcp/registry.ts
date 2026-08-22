import {
  deleteMcpServerConfig,
  getMcpServerConfigByName,
  listEnabledMcpServerConfigs,
  listMcpServerConfigs,
} from "@/lib/db/queries";
import type { McpServerConfig } from "@/lib/db/schema";
import { type McpClient, type McpClientDeps, connectServer } from "./client";

/**
 * MCP server registry（蓝图 ）。
 *
 * DB（McpServerConfig）是配置真实来源；本模块提供列表/启停/CRUD 委托 + client 连接池
 * （per-server-name 复用，避免每次调用重新 spawn/connect）。权限走正式 Policy Revision
 * （mcp.<name>.<tool>，决策 allow/pause/block，在 lib/mcp/tools.ts 的 mcpEvaluate 表达）。
 *
 * env 含 secret：调用时注入真实 env（client.ts），本模块不日志化 env。
 */

/** Studio/API 返回时对 env 做脱敏（secret 值替换为 ***），不落明文。扩展关键词。 */
export function redactEnv(env: Record<string, string> | null): Record<string, string> | null {
  if (!env) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const lk = k.toLowerCase();
    out[k] =
      lk.includes("token") ||
      lk.includes("secret") ||
      lk.includes("key") ||
      lk.includes("password") ||
      lk.includes("pat") ||
      lk.includes("cred") ||
      lk.includes("api") ||
      lk.includes("auth")
        ? "***"
        : v;
  }
  return out;
}

/** 列全部 MCP server 配置（含禁用）。 */
export async function listServers(): Promise<McpServerConfig[]> {
  return listMcpServerConfigs();
}

/** 列启用的 MCP server 配置。 */
export async function listEnabledServers(): Promise<McpServerConfig[]> {
  return listEnabledMcpServerConfigs();
}

/** 按 name 取 server 配置。 */
export async function getServer(name: string): Promise<McpServerConfig | null> {
  return getMcpServerConfigByName(name);
}

/** 删除 server 配置（同时关闭其连接池 client）。 */
export async function removeServer(id: string, name?: string): Promise<void> {
  if (name) await closeClient(name);
  await deleteMcpServerConfig(id);
}

// ─── 连接池 ────────────────────────────────────────────────
//
// per-server-name 复用 McpClient。disabled/删除的 server 调 closeClient 回收。
// 单租户信任环境，无 tenant 维度（与 deliverToGit 一致）。

const pool = new Map<string, { client: McpClient; deps?: McpClientDeps }>();

// ping TTL 缓存——60s 内不重复 ping，减少 listTools 开销
const pingTimestamps = new Map<string, number>();
const PING_TTL_MS = 60_000;

// per-server 调用计数 + 限流（默认 10 req/min）
const callCounts = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_PER_MIN = Number.parseInt(process.env.SNOW_MCP_RATE_LIMIT ?? "10", 10);
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(serverName: string): void {
  const now = Date.now();
  const entry = callCounts.get(serverName);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    callCounts.set(serverName, { count: 1, windowStart: now });
    return;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_PER_MIN) {
    throw new Error(`MCP server ${serverName} 调用限流（${RATE_LIMIT_PER_MIN}/min）`);
  }
}

/** 取或创建某 server 的 client（复用）。TTL 心跳 + onclose 主动清理。 */
export async function getOrConnect(name: string, deps?: McpClientDeps): Promise<McpClient> {
  const existing = pool.get(name);
  if (existing) {
    // TTL 心跳——60s 内跳过重复 ping
    const lastPing = pingTimestamps.get(name) ?? 0;
    if (Date.now() - lastPing >= PING_TTL_MS) {
      try {
        await existing.client.listTools();
        pingTimestamps.set(name, Date.now());
      } catch {
        pool.delete(name);
        pingTimestamps.delete(name);
        await existing.client.close().catch(() => {});
        // fallthrough to reconnect
      }
    }
    if (pool.has(name)) return existing.client;
  }
  const config = await getServer(name);
  if (!config) throw new Error(`MCP server 不存在: ${name}`);
  if (!config.enabled) throw new Error(`MCP server 已禁用: ${name}`);
  const client = await connectServer(config, deps);
  pool.set(name, { client, deps });
  pingTimestamps.set(name, Date.now()); // 刚连接视为已 ping

  // onclose 回调——server 进程退出时主动清理池条目
  // 审计修复：原条件 `"onclose" in sdkClient || typeof sdkClient.onclose === "undefined"`
  // 逻辑上永真，且 wrapper 对象上的 onclose setter 未被 SDK Client 感知。
  // 现 connectServer 返回的 McpClient 增加 onclose setter（转发到 SDK Client），
  // 直接设置，依赖 wrapper 的 setter 透传。
  try {
    const handle = client as unknown as { onclose?: () => void };
    handle.onclose = () => {
      pool.delete(name);
      pingTimestamps.delete(name);
      callCounts.delete(name); // 审计修复：同步清理 callCounts 防止内存泄漏
    };
  } catch {
    // onclose 不可用（旧版 SDK）—— 忽略，依赖下次 ping 检测
  }

  return client;
}

/** 调用前检查限流。供 callMcpTool 使用。 */
export function rateLimitCheck(serverName: string): void {
  checkRateLimit(serverName);
}

/** 关闭并移除某 server 的 client（禁用/删除/出错时回收）。 */
export async function closeClient(name: string): Promise<void> {
  const entry = pool.get(name);
  if (!entry) return;
  pool.delete(name);
  pingTimestamps.delete(name);
  try {
    await entry.client.close();
  } catch {
    // 关闭失败忽略（已回收池条目）
  }
}

/** 关闭全部 client（进程退出清理）。 */
export async function closeAllClients(): Promise<void> {
  const names = [...pool.keys()];
  await Promise.all(names.map((n) => closeClient(n)));
}

/** 测试用：清空连接池（不 close）。 */
export function _clearPoolForTest(): void {
  pool.clear();
  pingTimestamps.clear();
}
