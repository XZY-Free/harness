import { deleteCustomTool, getCustomTool, updateCustomTool } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

/**
 * V3.4 Stage E：单条自定义工具管理 API（admin-only）。
 * PUT → 更新（含启停）；DELETE → 删除。
 */
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
    "description",
    "inputSchema",
    "executorType",
    "executorConfig",
    "enabled",
  ]) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  const updated = await updateCustomTool(id, patch as Parameters<typeof updateCustomTool>[1]);
  if (!updated) return jsonError(404, "not_found", "自定义工具不存在");
  return jsonOk({ row: updated });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "policy.write");
  if (!r.ok) return r.response;
  const { id } = await ctx.params;
  const existing = await getCustomTool(id);
  if (!existing) return jsonError(404, "not_found", "自定义工具不存在");
  await deleteCustomTool(id);
  return jsonOk({ ok: true });
}
