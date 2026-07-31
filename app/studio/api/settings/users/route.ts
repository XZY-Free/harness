import { listRolesWithPermissions, listUsersWithRoles } from "@/lib/db/queries";
import { jsonOk } from "@/lib/http";
import { requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/settings/users → 用户+角色列表（受 user.manage 守卫）。
 *
 * Settings 仅管理已有用户的 role 绑定：返回全部用户及其角色，以及全部角色及其权限
 * （权限只读展示，不在此编辑）。前端据此渲染用户列表 + 角色 checkbox。
 */
export async function GET(req: NextRequest) {
  const r = await requirePermission(req, "user.manage");
  if (!r.ok) return r.response;

  const [users, roles] = await Promise.all([listUsersWithRoles(), listRolesWithPermissions()]);
  return jsonOk({ users, roles });
}
