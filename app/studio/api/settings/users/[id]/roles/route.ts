import { db } from "@/lib/db/client";
import { jsonError, jsonOk } from "@/lib/http";
import {
  PermissionManagementError,
  changePermissionManagement,
} from "@/lib/identity/permission-management";
import { requireStudioAction } from "@/lib/identity/studio-access";
import { principalBinding } from "@/lib/persistence/schema/identity";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
/** 成员角色接口复用正式角色分配服务，不覆盖资源专项授权。 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireStudioAction(request, "user.manage");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const [principal] = await db
    .select()
    .from(principalBinding)
    .where(
      and(
        eq(principalBinding.tenantId, gate.principal.tenantId),
        eq(principalBinding.subjectType, "user"),
        eq(principalBinding.userIdentityId, id),
      ),
    );
  if (!principal) return jsonError(404, "user_not_found", "成员不存在");
  try {
    const result = await changePermissionManagement(
      gate.principal.tenantId,
      gate.principal.userIdentityId,
      {
        operation: "set_roles",
        principalId: principal.id,
        roleKeys: body?.roleIds,
        expectedRoleKeys: body?.expectedRoleIds,
      },
    );
    return jsonOk({ userId: id, roleIds: result.roleKeys });
  } catch (error) {
    if (error instanceof PermissionManagementError)
      return jsonError(error.status, error.code, error.message);
    return jsonError(500, "update_failed", "角色保存失败");
  }
}
