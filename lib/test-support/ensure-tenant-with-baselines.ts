/**
 * 可复用的"租户前置条件"装配。
 *
 * 生产不变量（tenant-bootstrap §5.4）：不允许出现"有 Tenant 但无 Governance / 无 Policy"。
 * Job admission 的 `resolveBindingGovernance` 会真实读取 GovernanceConfigSet 与
 * PolicySet，因此任何走到绑定解析的测试夹具，都必须先把租户补齐到该不变量成立。
 *
 * 本模块只做幂等的真实写入（Tenant 行 + `bootstrapTenantBaselines`），不伪造
 * Revision、不放宽生产校验。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { bootstrapTenantBaselines } from "@/lib/identity/tenant-bootstrap";
import { governanceConfigSetTable } from "@/lib/persistence/schema/governance-config";
import { tenant } from "@/lib/persistence/schema/identity";
import { eq } from "drizzle-orm";

/**
 * 幂等确保给定租户存在且已建立 Governance + Policy 双 baseline。
 *
 * - 租户行不存在 → 以 `status=active` 建出。
 * - baseline 缺失 → 调用 `bootstrapTenantBaselines` 真实建立（已在则不重复，避免
 *   UNIQUE(tenantId, configSetKey) 冲突）。
 */
export async function ensureTenantWithBaselines(
  tenantId: string,
  actorId = "test-support",
): Promise<void> {
  const [existingTenant] = await db
    .select({ id: tenant.id })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .limit(1);
  if (!existingTenant) {
    await db.insert(tenant).values({
      id: tenantId,
      key: `tenant-${randomUUID()}`,
      name: "Test Tenant",
      status: "active",
    });
  }

  const [existingSet] = await db
    .select({ id: governanceConfigSetTable.id })
    .from(governanceConfigSetTable)
    .where(eq(governanceConfigSetTable.tenantId, tenantId))
    .limit(1);
  if (existingSet) {
    return;
  }
  await bootstrapTenantBaselines(db, tenantId, actorId);
}
