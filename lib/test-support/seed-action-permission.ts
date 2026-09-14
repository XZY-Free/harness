/** 测试通过正式角色表建立精确授权，不保留旧动作表作为运行时事实源。 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import type { ActionCode } from "@/lib/identity/action-codes";
import { parsePermissionGrants } from "@/lib/identity/permission-directory";
import type { ResourceScope } from "@/lib/identity/resource-scope";
import { permissionRole, permissionRoleAssignment } from "@/lib/persistence/schema/authorization";
import { and, eq } from "drizzle-orm";
export async function seedActionPermission(params: {
  tenantId: string;
  principalBindingId: string;
  actionCode: ActionCode;
  resourceScope: ResourceScope;
  validFrom?: Date;
  validUntil?: Date | null;
}) {
  const id = randomUUID();
  const permissions = parsePermissionGrants([
    {
      actionCode: params.actionCode,
      resourceScope: params.resourceScope,
      ...(params.validFrom ? { validFrom: params.validFrom.toISOString() } : {}),
      ...(params.validUntil ? { validUntil: params.validUntil.toISOString() } : {}),
    },
  ]);
  await db.transaction(async (tx) => {
    await tx
      .insert(permissionRole)
      .values({ id, tenantId: params.tenantId, name: `测试授权 ${id}`, permissions });
    await tx.insert(permissionRoleAssignment).values({
      tenantId: params.tenantId,
      principalId: params.principalBindingId,
      roleKey: id,
      source: "local",
    });
  });
  return { id };
}
export async function revokeSeededActionPermission(tenantId: string, id: string) {
  const result = await db
    .delete(permissionRoleAssignment)
    .where(
      and(
        eq(permissionRoleAssignment.tenantId, tenantId),
        eq(permissionRoleAssignment.roleKey, id),
      ),
    );
  return result[0].affectedRows > 0;
}
