import { AuthError, getCurrentUserFromRequest } from "@/lib/auth";
import type { User } from "@/lib/db/schema";
import { type Permission, hasPermission } from "@/lib/rbac";
import { headers } from "next/headers";

export type StudioPagePermissionResult =
 | { ok: true; user: User }
 | { ok: false; status: 401 | 403; message: string };

export async function requireStudioPagePermission(
 perm: Permission,
): Promise<StudioPagePermissionResult> {
 let user: User;
 try {
 user = await getCurrentUserFromRequest({ headers: await headers() });
 } catch (error) {
 if (error instanceof AuthError) {
 return { ok: false, status: 401, message: "未认证：缺少 SSO 身份" };
 }
 throw error;
 }

 const allowed = await hasPermission(user.id, perm);
 if (!allowed) {
 return { ok: false, status: 403, message: `无 ${perm} 权限` };
 }
 return { ok: true, user };
}
