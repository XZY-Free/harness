import { jsonError, jsonOk } from "@/lib/http";
import { isKnownActionCode } from "@/lib/identity/action-codes";
import { evaluatePermission, loadPermissionContext } from "@/lib/identity/permission-context";
import {
  PermissionManagementError,
  changePermissionManagement,
  listPermissionManagement,
} from "@/lib/identity/permission-management";
import { isKnownResourceScopeType } from "@/lib/identity/resource-scope";
import { requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const gate = await requireStudioAction(request, "user.manage");
  if (!gate.ok) return gate.response;
  return jsonOk(await listPermissionManagement(gate.principal.tenantId));
}
export async function POST(request: NextRequest) {
  const gate = await requireStudioAction(request, "user.manage");
  if (!gate.ok) return gate.response;
  const body = await request.json().catch(() => null);
  try {
    if (body?.operation === "explain") {
      if (
        !isKnownActionCode(body.actionCode) ||
        !isKnownResourceScopeType(body.resource?.type) ||
        typeof body.userId !== "string" ||
        (body.resource.id !== null && typeof body.resource.id !== "string")
      )
        return jsonError(400, "invalid_input", "权限查询参数无效");
      const context = await loadPermissionContext(gate.principal.tenantId, body.userId, undefined, [
        { actionCode: body.actionCode, resource: body.resource },
      ]);
      return jsonOk(
        evaluatePermission(context, { actionCode: body.actionCode, resource: body.resource }),
      );
    }
    return jsonOk(
      await changePermissionManagement(
        gate.principal.tenantId,
        gate.principal.userIdentityId,
        body,
      ),
    );
  } catch (error) {
    if (error instanceof PermissionManagementError)
      return jsonError(error.status, error.code, error.message);
    return jsonError(500, "permission_update_failed", "权限保存失败，请检查输入或刷新后重试");
  }
}
