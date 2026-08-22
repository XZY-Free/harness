import { db } from "@/lib/db/client";
import { DEFAULT_TENANT_KEY, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
/**
 * 租户仓储。
 *
 * 提供 default tenant seed（单租户阶段）和按 key/id 查找。
 * 后续多租户阶段扩展 createTenant / suspendTenant 等。
 *
 * Tenant 创建（ensureDefaultTenant）同事务建立 Governance + Policy 双 baseline，
 * 实现位于 lib/identity/tenant-bootstrap.ts（02-6 冻结方案 §8）；本文件 re-export 保持
 * 既有导入面（ensureDefaultTenant / DEFAULT_TENANT_*）不变。
 */
import { tenant } from "@/lib/persistence/schema/identity";
import { and, eq } from "drizzle-orm";

export {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_KEY,
  DEFAULT_TENANT_NAME,
  ensureDefaultTenant,
} from "@/lib/identity/tenant-bootstrap";

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
