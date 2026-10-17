import { listStudioTools } from "@/lib/capability/tool-studio-queries";
import { apiSuccess, getRequestId } from "@/lib/http";
import { requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/tools → 列出 Studio 可见 Tool（含 mcp 同步来源）。
 * 受 tool.read 守卫；返回含同步态的列表。
 */
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  const r = await requireStudioAction(req, "tool.read");
  if (!r.ok) return r.response;
  const tools = await listStudioTools(r.principal.tenantId);
  return apiSuccess(tools, { headers: { "x-request-id": requestId } });
}
