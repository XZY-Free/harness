/**
 * 主体绑定仓储。
 *
 * 将外部主体（user/group/role/department）映射到内部 userIdentity。
 * subjectType=user 时 userIdentityId 指向 UserIdentity；其他类型为 null。
 * 不复制组织树——只保存稳定映射，授权层展开时再查。
 */
import { db } from "@/lib/db/client";
import { principalBinding } from "@/lib/persistence/schema/identity";
import type { PrincipalBinding, PrincipalSubjectType } from "@/lib/persistence/schema/identity";
import { and, eq } from "drizzle-orm";

/** 按 (tenantId, subjectType, externalId) upsert 主体绑定。 */
export async function upsertPrincipalBinding(params: {
  tenantId: string;
  subjectType: PrincipalSubjectType;
  externalId: string;
  displayName?: string | null;
  userIdentityId?: string | null;
}): Promise<PrincipalBinding> {
  const { tenantId, subjectType, externalId, displayName = null, userIdentityId = null } = params;

  const [existing] = await db
    .select()
    .from(principalBinding)
    .where(
      and(
        eq(principalBinding.tenantId, tenantId),
        eq(principalBinding.subjectType, subjectType),
        eq(principalBinding.externalId, externalId),
      ),
    )
    .limit(1);

  if (existing) {
    if (existing.displayName !== displayName || existing.userIdentityId !== userIdentityId) {
      await db
        .update(principalBinding)
        .set({ displayName, userIdentityId })
        .where(eq(principalBinding.id, existing.id));
      return { ...existing, displayName, userIdentityId };
    }
    return existing;
  }

  await db.insert(principalBinding).ignore().values({
    tenantId,
    subjectType,
    externalId,
    displayName,
    userIdentityId,
  });

  const [created] = await db
    .select()
    .from(principalBinding)
    .where(
      and(
        eq(principalBinding.tenantId, tenantId),
        eq(principalBinding.subjectType, subjectType),
        eq(principalBinding.externalId, externalId),
      ),
    )
    .limit(1);

  if (!created) {
    throw new Error("无法创建或读取主体绑定");
  }
  return created;
}

/** 列出某 userIdentity 关联的所有主体绑定（含 user/group/role/department）。 */
export async function listPrincipalBindingsByUser(
  tenantId: string,
  userIdentityId: string,
): Promise<PrincipalBinding[]> {
  return db
    .select()
    .from(principalBinding)
    .where(
      and(
        eq(principalBinding.tenantId, tenantId),
        eq(principalBinding.userIdentityId, userIdentityId),
      ),
    );
}

/** 按 (tenantId, subjectType, externalId) 查找主体绑定。 */
export async function getPrincipalBinding(
  tenantId: string,
  subjectType: PrincipalSubjectType,
  externalId: string,
): Promise<PrincipalBinding | null> {
  const [row] = await db
    .select()
    .from(principalBinding)
    .where(
      and(
        eq(principalBinding.tenantId, tenantId),
        eq(principalBinding.subjectType, subjectType),
        eq(principalBinding.externalId, externalId),
      ),
    )
    .limit(1);
  return row ?? null;
}
