import { listAdminAuditLogs } from "@/lib/db/queries";
import { jsonOk } from "@/lib/http";
import { requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * S1（07-P2-5）：permission rule 变更审计历史。
 *
 * 读 adminAuditLog 中 targetType=permission_rule 的记录(created/updated/deleted),
 * 含 actor/前后值 metadata,满足 audit P2-5"谁改/何时/改前值可追溯"。
 * 守卫 audit.read(admin 角色);limit 默认 100,上限 200。
 */
export async function GET(req: NextRequest) {
  const r = await requirePermission(req, "audit.read");
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  const targetId = url.searchParams.get("ruleId") ?? undefined;

  const logs = await listAdminAuditLogs({
    targetType: "permission_rule",
    limit: Number.isFinite(limit) ? limit : 100,
    targetId,
  });
  return jsonOk({ logs });
}
