import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { agentTable } from "@/lib/persistence/schema/agents";
import {
  permissionRole,
  permissionRoleAssignment,
  resourceAccessPolicy,
  roleActionBinding,
} from "@/lib/persistence/schema/authorization";
import { principalBinding } from "@/lib/persistence/schema/identity";
import { eq, inArray } from "drizzle-orm";
import { type PermissionGrant, parsePermissionGrants } from "./permission-directory";
import { parseResourceScope } from "./resource-scope";

/** 启动迁移：原始范围和时间逐项保留，不猜测旧账号属于哪个内置角色。 */
export async function migrateLegacyPermissions(): Promise<{ converted: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(roleActionBinding).for("update");
    // 存量资产保持原有按角色授权语义，不能因本次默认策略变化自动对全员开放。
    const agents = await tx.select().from(agentTable);
    const policies = await tx.select().from(resourceAccessPolicy);
    for (const agent of agents)
      if (
        !policies.some(
          (p) =>
            p.tenantId === agent.tenantId &&
            p.resourceType === "agent" &&
            p.resourceId === agent.id,
        )
      ) {
        await tx.insert(resourceAccessPolicy).values({
          tenantId: agent.tenantId,
          resourceType: "agent",
          resourceId: agent.id,
          mode: "roles",
          principals: [],
          collaborators: [],
        });
      }
    if (!rows.length) return { converted: 0 };
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = JSON.stringify([row.tenantId, row.principalBindingId]);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    for (const bindings of grouped.values()) {
      const first = bindings[0];
      if (!first) continue;
      const [principal] = await tx
        .select()
        .from(principalBinding)
        .where(eq(principalBinding.id, first.principalBindingId));
      if (!principal || principal.tenantId !== first.tenantId)
        throw new Error("旧授权存在跨租户主体，迁移已回滚");
      const grants: PermissionGrant[] = parsePermissionGrants(
        bindings.map((binding) => ({
          actionCode: binding.actionCode,
          resourceScope: parseResourceScope(binding.resourceScopeJson),
          validFrom: binding.validFrom.toISOString(),
          ...(binding.validUntil ? { validUntil: binding.validUntil.toISOString() } : {}),
        })),
      );
      const id = randomUUID();
      await tx.insert(permissionRole).values({
        id,
        tenantId: first.tenantId,
        name: `原有权限 · ${(principal.displayName ?? "成员").slice(0, 48)} · ${id.slice(0, 8)}`,
        permissions: grants,
      });
      await tx.insert(permissionRoleAssignment).values({
        tenantId: first.tenantId,
        principalId: first.principalBindingId,
        roleKey: id,
        source: "local",
      });
    }
    await tx.delete(roleActionBinding).where(
      inArray(
        roleActionBinding.id,
        rows.map((row) => row.id),
      ),
    );
    return { converted: rows.length };
  });
}
