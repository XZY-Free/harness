import { listAdminAuditLogs } from "@/lib/db/queries";
import { ADMIN_AUDIT_ACTIONS, type AdminAuditAction } from "@/lib/db/schema";
import { jsonError, jsonOk } from "@/lib/http";
import { requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/audit → 审计日志列表（受 audit.read 守卫，切片 C）。
 *
 * 查询参数（均可选）：
 * - limit：默认 100，钳制到 [1, 200]；非数字回退默认。
 * - actorUserId / targetType / targetId：精确过滤。
 * - action：必须属于 ADMIN_AUDIT_ACTIONS，否则 400 invalid_action。
 *
 * 审计 append-only：本 API 只读，不提供 update/delete（约束 7）。
 */
const ACTION_SET: ReadonlySet<string> = new Set(ADMIN_AUDIT_ACTIONS);

export async function GET(req: NextRequest) {
  const r = await requireStudioAction(req, "audit.read");
  if (!r.ok) return r.response;

  const sp = req.nextUrl.searchParams;
  const rawLimit = sp.get("limit");
  const limit =
    rawLimit !== null && Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : undefined;
  const actorUserId = sp.get("actorUserId") ?? undefined;
  const targetType = sp.get("targetType") ?? undefined;
  const targetId = sp.get("targetId") ?? undefined;
  const action = sp.get("action") ?? undefined;

  if (action !== undefined && !ACTION_SET.has(action)) {
    return jsonError(400, "invalid_action", "未知审计动作");
  }

  const logs = await listAdminAuditLogs({
    limit,
    actorUserId,
    targetType,
    targetId,
    action: action as AdminAuditAction | undefined,
  });
  return jsonOk({ logs });
}
