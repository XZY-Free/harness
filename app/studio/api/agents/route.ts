import { listAgents } from "@/lib/db/queries";
import { jsonOk } from "@/lib/http";
import { requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/agents → 列全部 agent 档案（受 agent.read 守卫）。
 *
 * 切片 B1：纯只读档案，不接 runtime。列表查询无 owner 范围（档案是全局只读）。
 */
export async function GET(req: NextRequest) {
  const r = await requirePermission(req, "agent.read");
  if (!r.ok) return r.response;
  return jsonOk({ rows: await listAgents() });
}
