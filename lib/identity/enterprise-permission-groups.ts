import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { permissionGroup, permissionGroupMember } from "@/lib/persistence/schema/authorization";
import { principalBinding, userIdentity } from "@/lib/persistence/schema/identity";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { DbTransaction } from "./enterprise-user-profile-queries";
import {
  attributesFromRows,
  getEnterpriseUserProfileFactsInTransaction,
} from "./enterprise-user-profile-queries";

export interface EnterprisePermissionGroup {
  kind: "department" | "group" | "factory" | "organization";
  externalId: string;
  displayName: string;
}
export function parseEnterprisePermissionGroups(value: unknown): EnterprisePermissionGroup[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new Error("企业授权主体列表无效");
  const keys = new Set<string>();
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      !["department", "group", "factory", "organization"].includes(item.kind) ||
      typeof item.externalId !== "string" ||
      !item.externalId.trim() ||
      item.externalId.length > 256 ||
      typeof item.displayName !== "string" ||
      !item.displayName.trim() ||
      item.displayName.length > 256
    )
      throw new Error("企业授权主体无效");
    const key = `${item.kind}:${item.externalId}`;
    if (keys.has(key)) throw new Error("企业授权主体重复");
    keys.add(key);
    return { kind: item.kind, externalId: item.externalId, displayName: item.displayName };
  });
}
/** 可信资料是唯一输入；过期或字段移除时撤掉旧关系，不保留 stale 授权。 */
export async function synchronizeEnterprisePermissionGroups(
  tenantId: string,
  userId: string,
  client?: DbTransaction,
  now = new Date(),
) {
  const synchronize = async (tx: DbTransaction) => {
    const [identity] = await tx
      .select()
      .from(userIdentity)
      .where(and(eq(userIdentity.tenantId, tenantId), eq(userIdentity.id, userId)))
      .for("update");
    if (!identity) return;
    // 与资料写入使用同一身份锁和当前读，不能拿事务外的旧资料覆盖新组织关系。
    const facts = await getEnterpriseUserProfileFactsInTransaction(tx, tenantId, userId);
    const syncState = facts?.syncState;
    const source = syncState ? `enterprise:${syncState.sourceSystem}` : "";
    let groups: EnterprisePermissionGroup[] = [];
    if (facts && syncState && identity.status === "active" && syncState.freshUntil > now) {
      try {
        groups = parseEnterprisePermissionGroups(
          attributesFromRows(facts.attributes).authorizationGroups,
        );
      } catch {
        groups = [];
      }
    }
    const existingGroups = await tx
      .select()
      .from(permissionGroup)
      .where(and(eq(permissionGroup.tenantId, tenantId), ne(permissionGroup.source, "local")));
    const desired: string[] = [];
    for (const group of groups) {
      if (!syncState) break;
      const externalId = `enterprise:${createHash("sha256")
        .update(JSON.stringify([source, group.kind, group.externalId]))
        .digest("hex")}`;
      await tx
        .insert(principalBinding)
        .ignore()
        .values({
          id: randomUUID(),
          tenantId,
          subjectType: group.kind === "department" ? "department" : "group",
          externalId,
          displayName: group.displayName,
        });
      const [principal] = await tx
        .select()
        .from(principalBinding)
        .where(
          and(eq(principalBinding.tenantId, tenantId), eq(principalBinding.externalId, externalId)),
        );
      if (!principal) throw new Error("企业授权主体未建立");
      if (principal.displayName !== group.displayName)
        await tx
          .update(principalBinding)
          .set({ displayName: group.displayName })
          .where(eq(principalBinding.id, principal.id));
      await tx
        .insert(permissionGroup)
        .ignore()
        .values({ principalId: principal.id, tenantId, source });
      desired.push(principal.id);
      await tx
        .insert(permissionGroupMember)
        .values({
          tenantId,
          groupId: principal.id,
          userId,
          validUntil: syncState.freshUntil,
        })
        .onDuplicateKeyUpdate({ set: { validUntil: syncState.freshUntil } });
    }
    const removed = existingGroups
      .filter((g) => !desired.includes(g.principalId))
      .map((g) => g.principalId);
    if (removed.length)
      await tx
        .delete(permissionGroupMember)
        .where(
          and(
            eq(permissionGroupMember.tenantId, tenantId),
            eq(permissionGroupMember.userId, userId),
            inArray(permissionGroupMember.groupId, removed),
          ),
        );
  };
  return client ? synchronize(client) : db.transaction(synchronize);
}
