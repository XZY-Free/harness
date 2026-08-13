import { type RequestLike, authErrorResponse, getCurrentUserFromRequest } from "@/lib/auth";
import { studioConfig } from "@/lib/config";
import { DEFAULT_USER_ID } from "@/lib/constants";
import { getPermissionsForUserRaw } from "@/lib/db/queries";
import type { User } from "@/lib/db/schema";
import { jsonError } from "@/lib/http";

/**
 * ：最小可用 RBAC（role → permission，user → role）。
 *
 * 权限是**固定常量集合**（PERMISSIONS），不建动态权限表——避免过早抽象（）。
 * 内置角色（seed）：admin（全部权限）/ member（受限）。规则：
 * - dev/test 且 studioConfig.devOpen 且 userId === DEFAULT_USER_ID → 注入全部权限（零回归）。
 * - production：用户角色由 UserRole 表决定；无角色 = 无 studio 权限 → /studio 403。
 * - 不做角色继承、不做资源级 ACL（thread 级仍用 P4-3 owner guard；thread.read.all 仅控「能否看别人的」）。
 *
 * 公司 SSO 协议未定，不做 SSO 角色映射——角色由应用内 UserRole 表维护。
 */

export const PERMISSIONS = [
  "studio.access",
  "skill.read",
  "skill.write",
  "skill.write.all",
  "skill.publish",
  "analytics.read.self",
  "analytics.read.global",
  "thread.read.all",
  "thread.write.self",
  "thread.write.all",
  "policy.read",
  "policy.write",
  "user.manage",
  "agent.read",
  "provider.read",
  "workspace.read",
  "workspace.write",
  "audit.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

/** member 角色权限集合（seed 用，见 lib/db/seed.ts）。 */
export const MEMBER_PERMISSIONS: Permission[] = [
  "studio.access",
  "skill.read",
  "analytics.read.self",
  "policy.read",
  "agent.read",
  "provider.read",
  "workspace.read",
  "thread.write.self",
];

/** admin 角色权限集合（seed 用）——全部权限。 */
export const ADMIN_PERMISSIONS: Permission[] = [...PERMISSIONS];

/**
 * 取用户权限集（策略层）。
 * - devOpen + 默认用户 → 全权限（不查 DB，本地 / 测试零回归）。
 * - 否则查 UserRole → RolePermission 并集；过滤掉不在固定集合内的脏数据。
 */
export async function getPermissionsForUser(userId: string): Promise<Set<Permission>> {
  if (studioConfig.devOpen && userId === DEFAULT_USER_ID) {
    return new Set(PERMISSIONS);
  }
  const raw = await getPermissionsForUserRaw(userId);
  const perms = new Set<Permission>();
  for (const p of raw) {
    if (PERMISSION_SET.has(p)) perms.add(p as Permission);
  }
  return perms;
}

export async function hasPermission(userId: string, perm: Permission): Promise<boolean> {
  const perms = await getPermissionsForUser(userId);
  return perms.has(perm);
}

export type RequirePermissionResult = { ok: true; user: User } | { ok: false; response: Response };

/**
 * route 入口守卫：解析当前用户 → 校验权限；不通过返回 403 Response。
 * 认证失败（AuthError）经 authErrorResponse 转 401（先于权限判断）。
 *
 * 用法：`const r = await requirePermission(req, "skill.read"); if (!r.ok) return r.response;`
 */
export async function requirePermission(
  request: RequestLike,
  perm: Permission,
): Promise<RequirePermissionResult> {
  let user: User;
  try {
    user = await getCurrentUserFromRequest(request);
  } catch (error) {
    const authResp = authErrorResponse(error);
    return { ok: false, response: authResp ?? jsonError(500, "auth_error", "认证异常") };
  }

  const allowed = await hasPermission(user.id, perm);
  if (!allowed) {
    return { ok: false, response: jsonError(403, "forbidden", "无权限") };
  }
  return { ok: true, user };
}
