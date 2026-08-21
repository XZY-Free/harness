import type { ActionCode } from "@/lib/identity/action-codes";
import { AuthenticationError, type Principal } from "@/lib/identity/resolver";
import { hasStudioAction, resolveStudioPrincipal } from "@/lib/identity/studio-access";
import { headers } from "next/headers";

export type StudioPagePermissionResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; message: string };

export async function requireStudioPagePermission(
  perm: ActionCode,
): Promise<StudioPagePermissionResult> {
  let principal: Principal;
  try {
    principal = await resolveStudioPrincipal(await headers());
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return { ok: false, status: 401, message: "未认证：缺少 SSO 身份" };
    }
    throw error;
  }

  const allowed = await hasStudioAction(principal, perm);
  if (!allowed) {
    return { ok: false, status: 403, message: `无 ${perm} 权限` };
  }
  return { ok: true, principal };
}
