/**
 * 用户身份仓储。
 *
 * 按 (tenantId, externalSubject) 稳定映射内部 userIdentity id。
 * email/displayName 允许漂移更新（不再是身份主键）。
 * MySQL 无 INSERT ... RETURNING：IGNORE + 回查，并发下也只建一行。
 */
import { db } from "@/lib/db/client";
import { userIdentity } from "@/lib/v11/schema/identity";
import type { UserIdentity } from "@/lib/v11/schema/identity";
import { and, eq } from "drizzle-orm";

/** 按 (tenantId, externalSubject) upsert 用户身份。 */
export async function upsertUserIdentity(params: {
  tenantId: string;
  externalSubject: string;
  email: string;
  displayName: string | null;
}): Promise<UserIdentity> {
  const { tenantId, externalSubject: subject, email, displayName } = params;

  const [existing] = await db
    .select()
    .from(userIdentity)
    .where(and(eq(userIdentity.tenantId, tenantId), eq(userIdentity.externalSubject, subject)))
    .limit(1);

  if (existing) {
    // email / displayName 漂移才轻量 update，避免无谓写入。
    if (existing.email !== email || existing.displayName !== displayName) {
      await db
        .update(userIdentity)
        .set({ email, displayName })
        .where(eq(userIdentity.id, existing.id));
      return { ...existing, email, displayName };
    }
    return existing;
  }

  // INSERT IGNORE + 回查（并发竞态下也只建一行）。
  await db.insert(userIdentity).ignore().values({
    tenantId,
    externalSubject: subject,
    email,
    displayName,
    status: "active",
  });

  const [created] = await db
    .select()
    .from(userIdentity)
    .where(and(eq(userIdentity.tenantId, tenantId), eq(userIdentity.externalSubject, subject)))
    .limit(1);

  if (!created) {
    throw new Error("无法创建或读取用户身份");
  }
  return created;
}

/** 按 id 查找用户身份。 */
export async function getUserIdentityById(id: string): Promise<UserIdentity | null> {
  const [row] = await db.select().from(userIdentity).where(eq(userIdentity.id, id)).limit(1);
  return row ?? null;
}

/** 按 (tenantId, externalSubject) 查找用户身份。 */
export async function getUserIdentityBySubject(
  tenantId: string,
  externalSubject: string,
): Promise<UserIdentity | null> {
  const [row] = await db
    .select()
    .from(userIdentity)
    .where(
      and(eq(userIdentity.tenantId, tenantId), eq(userIdentity.externalSubject, externalSubject)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 校验 userIdentityId 属于指定 tenant。
 * 跨租户访问返回 null（调用方应返回 404 隐藏存在性）。
 */
export async function getUserIdentityForTenant(
  userIdentityId: string,
  tenantId: string,
): Promise<UserIdentity | null> {
  const [row] = await db
    .select()
    .from(userIdentity)
    .where(and(eq(userIdentity.id, userIdentityId), eq(userIdentity.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}
