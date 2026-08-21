import { deleteMcpServerConfig, getMcpServerConfig, updateMcpServerConfig } from "@/lib/db/queries";
import { assertSafeExternalUrl } from "@/lib/external/url-safety";
import { jsonError, jsonOk } from "@/lib/http";
import { assertMcpCommand } from "@/lib/mcp/client";
import { requireStudioAction } from "@/lib/identity/studio-access";
import { redactEnv, removeServer } from "@/lib/mcp/registry";
import type { NextRequest } from "next/server";

/**
 * V3.4 Stage E：单条 MCP server 管理 API（admin-only）。
 *
 * PUT /studio/api/mcp-servers/[id] → 更新（含启停）；env 脱敏返回。
 * DELETE /studio/api/mcp-servers/[id] → 删除（同时回收连接池 client）。
 */

function redact(row: Awaited<ReturnType<typeof getMcpServerConfig>>) {
  if (!row) return row;
  return { ...row, env: redactEnv(row.env as Record<string, string> | null) };
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "policy.write");
  if (!r.ok) return r.response;
  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "invalid_body", "请求体不是合法 JSON");
  }
  const patch: Record<string, unknown> = {};
  for (const k of [
    "name",
    "transport",
    "command",
    "args",
    "url",
    "env",
    "allowedTools",
    "enabled",
  ]) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  // P1-16: PATCH 同样校验 SSRF + command 白名单
  if (typeof patch.url === "string") {
    try {
      assertSafeExternalUrl(patch.url, "mcp url");
    } catch (e) {
      return jsonError(400, "unsafe_url", e instanceof Error ? e.message : String(e));
    }
  }
  if (typeof patch.command === "string") {
    try {
      assertMcpCommand(patch.command);
    } catch (e) {
      return jsonError(400, "unsafe_command", e instanceof Error ? e.message : String(e));
    }
  }
  const updated = await updateMcpServerConfig(
    id,
    patch as Parameters<typeof updateMcpServerConfig>[1],
  );
  if (!updated) return jsonError(404, "not_found", "MCP server 不存在");
  return jsonOk({ row: redact(updated) });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "policy.write");
  if (!r.ok) return r.response;
  const { id } = await ctx.params;
  const existing = await getMcpServerConfig(id);
  if (!existing) return jsonError(404, "not_found", "MCP server 不存在");
  await removeServer(id, existing.name);
  return jsonOk({ ok: true });
}
