/**
 * 基础 Harness Route 稳定身份幂等性 — 真实 MySQL 测试。
 *
 * 目标不变量：同一 RouteSet、同一 RuntimeRevision、agentRevisionId=null、无显式 routeId
 * 的相同 Route 内容，连续两次 resolveRouteIdentity 必须返回相同 Route id，数据库只能有
 * 一条对应 DeploymentRoute。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { tenant } from "@/lib/persistence/schema/identity";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/routes";
import type { RouteRevisionContent } from "@/lib/routes/domain/route-revision";
import { mysqlRouteControlStore } from "@/lib/routes/persistence/mysql-route-control-store";
import { and, count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-24T00:00:00.000Z");
const RUNTIME_REVISION_ID = "runtime-rev-harness-0001";

beforeEach(async () => {
  await resetDatabase(db);
});

/** 插入真实 Tenant 与基础 Harness RouteSet（agentId=null）满足 FK。 */
async function seedBaseHarnessRouteSet() {
  const tenantId = randomUUID();
  await db.insert(tenant).values({
    id: tenantId,
    key: `tenant-${randomUUID()}`,
    name: "Harness Tenant",
    status: "active",
  });
  const routeSetId = randomUUID();
  await db.insert(deploymentRouteSetTable).values({
    id: routeSetId,
    tenantId,
    agentId: null,
    routeScopeKey: `base-harness-${randomUUID()}`,
    routeScopeJson: { networkZone: "internal" },
    versionNo: 1,
  });
  return { tenantId, routeSetId };
}

/** 合法基础 Harness RouteRevisionContent：agentRevisionId=null、固定 runtimeRevisionId。 */
function baseHarnessContent(): RouteRevisionContent {
  return {
    agentRevisionId: null,
    runtimeRevisionId: RUNTIME_REVISION_ID,
    policyRevisionId: null,
    modelPolicyRevisionId: null,
    toolsetRevisionId: null,
    trafficWeight: 100,
    priorityNo: 0,
    effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
    effectiveUntil: new Date("2026-12-31T00:00:00.000Z"),
    eligibilityConditions: {},
    routeGroupId: "primary",
  };
}

describe("基础 Harness Route 稳定身份幂等性", () => {
  it("同一 RouteSet + null agentRevisionId + 同一 runtimeRevisionId 两次 resolve 必须返回同一 Route id 且库中只有一行", async () => {
    const { routeSetId } = await seedBaseHarnessRouteSet();
    const content = baseHarnessContent();

    const first = await mysqlRouteControlStore.transaction((session) =>
      session.resolveRouteIdentity({
        routeSetId,
        content,
        now: NOW,
      }),
    );
    const second = await mysqlRouteControlStore.transaction((session) =>
      session.resolveRouteIdentity({
        routeSetId,
        content,
        now: NOW,
      }),
    );

    // 稳定身份：两次解析必须命中同一条 DeploymentRoute。
    expect(second.id, "连续两次 resolveRouteIdentity 必须返回相同 Route id").toBe(first.id);

    // 库中只能有一条对应 DeploymentRoute，且 agentRevisionId 为 null。
    const [countRow] = await db
      .select({ value: count() })
      .from(deploymentRouteTable)
      .where(
        and(
          eq(deploymentRouteTable.routeSetId, routeSetId),
          eq(deploymentRouteTable.runtimeRevisionId, RUNTIME_REVISION_ID),
        ),
      );
    expect(countRow?.value, "同组合 DeploymentRoute 必须唯一").toBe(1);

    const [onlyRow] = await db
      .select()
      .from(deploymentRouteTable)
      .where(eq(deploymentRouteTable.id, first.id))
      .limit(1);
    expect(onlyRow?.id).toBe(first.id);
    expect(
      onlyRow?.agentRevisionId,
      "基础 Harness Route 的 agentRevisionId 必须为 null",
    ).toBeNull();
  });
});
