/**
 * 租户仓储。
 *
 * 提供 default tenant seed（单租户阶段）和按 key/id 查找。
 * 后续多租户阶段扩展 createTenant / suspendTenant 等。
 */
import { db } from "@/lib/db/client";
import { tenant } from "@/lib/v11/schema/identity";
import { and, eq } from "drizzle-orm";

/** 默认租户 key（单租户阶段固定）。 */
export const DEFAULT_TENANT_KEY = "default";
export const DEFAULT_TENANT_NAME = "Default Tenant";
/** 默认租户 id 固定，便于 dev 模式和测试复用。 */
export const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000000";

/**
 * 幂等确保默认租户存在。
 * - 已存在且 active：直接返回。
 * - 已存在但 suspended：返回（调用方决定是否拒绝）。
 * - 不存在：插入。
 */
export async function ensureDefaultTenant(): Promise<{
  id: string;
  key: string;
  name: string;
  status: string;
}> {
  const [existing] = await db
    .select({
      id: tenant.id,
      key: tenant.key,
      name: tenant.name,
      status: tenant.status,
    })
    .from(tenant)
    .where(eq(tenant.key, DEFAULT_TENANT_KEY))
    .limit(1);

  if (existing) {
    return existing;
  }

  await db.insert(tenant).values({
    id: DEFAULT_TENANT_ID,
    key: DEFAULT_TENANT_KEY,
    name: DEFAULT_TENANT_NAME,
    status: "active",
  });

  const [created] = await db
    .select({
      id: tenant.id,
      key: tenant.key,
      name: tenant.name,
      status: tenant.status,
    })
    .from(tenant)
    .where(eq(tenant.key, DEFAULT_TENANT_KEY))
    .limit(1);

  if (!created) {
    throw new Error("无法创建默认租户");
  }
  return created;
}

/** 按 key 查找租户（active 或任意状态）。 */
export async function getTenantByKey(key: string): Promise<{
  id: string;
  key: string;
  name: string;
  status: string;
} | null> {
  const [row] = await db
    .select({
      id: tenant.id,
      key: tenant.key,
      name: tenant.name,
      status: tenant.status,
    })
    .from(tenant)
    .where(and(eq(tenant.key, key), eq(tenant.status, "active")))
    .limit(1);
  return row ?? null;
}

/** 按 id 查找租户。 */
export async function getTenantById(id: string): Promise<{
  id: string;
  key: string;
  name: string;
  status: string;
} | null> {
  const [row] = await db
    .select({
      id: tenant.id,
      key: tenant.key,
      name: tenant.name,
      status: tenant.status,
    })
    .from(tenant)
    .where(eq(tenant.id, id))
    .limit(1);
  return row ?? null;
}
