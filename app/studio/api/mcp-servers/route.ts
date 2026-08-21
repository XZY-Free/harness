import { createMcpServerConfig, listMcpServerConfigs } from "@/lib/db/queries";
import { assertSafeExternalUrl } from "@/lib/external/url-safety";
import { jsonError, jsonOk } from "@/lib/http";
import { requireStudioAction } from "@/lib/identity/studio-access";
import { assertMcpCommand } from "@/lib/mcp/client";
import { redactEnv } from "@/lib/mcp/registry";
import type { NextRequest } from "next/server";

/**
 * V3.4 Stage E：MCP server 管理 API。
 *
 * 权限（§E 决策）：GET 任何 studio 用户可见（studio.access）；POST 仅 admin（policy.write，
 * 平台级配置——不扩 rbac 权限枚举，复用现有 admin-only 写权限）。未登录 401；无权限 403。
 *
 * env 含 secret：GET 返回脱敏（redactEnv），POST/PUT 接收真实 env 入库；不写日志/事件。
 */

function redact(row: Awaited<ReturnType<typeof listMcpServerConfigs>>[number]) {
  return { ...row, env: redactEnv(row.env as Record<string, string> | null) };
}

/** GET /studio/api/mcp-servers → 列全部 MCP server 配置（env 脱敏）。 */
export async function GET(req: NextRequest) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const rows = await listMcpServerConfigs();
  return jsonOk({ rows: rows.map(redact) });
}

/** POST /studio/api/mcp-servers → 新建 MCP server 配置（admin-only）。 */
export async function POST(req: NextRequest) {
  const r = await requireStudioAction(req, "policy.write");
  if (!r.ok) return r.response;
  let body: {
    name?: unknown;
    transport?: unknown;
    command?: unknown;
    args?: unknown;
    url?: unknown;
    env?: unknown;
    allowedTools?: unknown;
    enabled?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_body", "请求体不是合法 JSON");
  }
  if (typeof body.name !== "string" || body.name.length === 0) {
    return jsonError(400, "invalid_name", "name 不能为空");
  }
  if (body.transport !== "stdio" && body.transport !== "http" && body.transport !== "sse") {
    return jsonError(400, "invalid_transport", "transport 须为 stdio/http/sse");
  }
  const transport = body.transport as "stdio" | "http" | "sse";
  if (transport === "stdio" && typeof body.command !== "string") {
    return jsonError(400, "invalid_command", "stdio transport 须提供 command");
  }
  if ((transport === "http" || transport === "sse") && typeof body.url !== "string") {
    return jsonError(400, "invalid_url", `${transport} transport 须提供 url`);
  }
  // P1-16: SSRF + command 白名单在配置入口校验(防 admin 误配内网 URL / 任意命令)
  if (transport === "http" || transport === "sse") {
    try {
      assertSafeExternalUrl(body.url as string, "mcp url");
    } catch (e) {
      return jsonError(400, "unsafe_url", e instanceof Error ? e.message : String(e));
    }
  }
  if (transport === "stdio") {
    try {
      assertMcpCommand(body.command as string);
    } catch (e) {
      return jsonError(400, "unsafe_command", e instanceof Error ? e.message : String(e));
    }
  }
  try {
    const created = await createMcpServerConfig({
      name: body.name,
      transport,
      command: typeof body.command === "string" ? body.command : null,
      args: Array.isArray(body.args) ? (body.args as string[]) : null,
      url: typeof body.url === "string" ? body.url : null,
      env: body.env && typeof body.env === "object" ? (body.env as Record<string, string>) : null,
      allowedTools: Array.isArray(body.allowedTools) ? (body.allowedTools as string[]) : null,
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
    });
    return jsonOk({ row: redact(created) });
  } catch (e) {
    return jsonError(409, "create_failed", e instanceof Error ? e.message : String(e));
  }
}
