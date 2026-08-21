import { jsonOk } from "@/lib/http";
import { requireStudioAction } from "@/lib/identity/studio-access";
import { listSettingsUserRolesView } from "@/lib/identity/settings-queries";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/settings/users → 用户+角色模板列表（受 user.manage 守卫）。
 *
 * 关口02 02-2c：数据源从 legacy role/rolePermission/userRole 迁到正式身份模型
 * （userIdentity / principalBinding / roleActionBinding）。
 * 返回全部用户（含由 grant 推导的角色模板 templateKeys）与全部角色模板
 * （含只读 action 列表）。前端据此渲染用户列表 + 角色模板 checkbox。
 */
export async function GET(req: NextRequest) {
  const r = await requireStudioAction(req, "user.manage");
  if (!r.ok) return r.response;

  const view = await listSettingsUserRolesView(r.principal.tenantId);
  return jsonOk({ users: view.users, roles: view.roles });
}
