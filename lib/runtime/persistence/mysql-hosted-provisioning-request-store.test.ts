/**
 * mysqlHostedProvisioningRequestStore 冻结权威行为测试（真实 MySQL 8）。
 *
 * 专题01 冻结（runtime-only）：请求权威 = (tenantId, routeScopeKey)；insert 落库非空
 * requesterId；无 agentId/agentRevisionId/desiredRuntimeKey；唯一键拒绝同 (tenant, scope)
 * 重复。保留既有 lease/claim 原子性单元测试。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { tenant } from "@/lib/persistence/schema/identity";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HostedProvisioningLeaseLostError,
  assertAffectedRowsExactlyOne,
  assertClaimAffectedRows,
  extractClaimableRequestIds,
  mysqlHostedProvisioningRequestStore,
} from "./mysql-hosted-provisioning-request-store";

const NOW = new Date("2026-08-29T00:00:00.000Z");

/** 每个测试前清空所有业务表，杜绝 (tenantId, routeScopeKey) 行跨测试残留。 */
beforeEach(async () => {
  await resetDatabase(db);
});

describe("assertAffectedRowsExactlyOne", () => {
  it("accepts exactly one affected row", () => {
    expect(() =>
      assertAffectedRowsExactlyOne(1, {
        operation: "updateState",
        requestId: "request-1",
        workerId: "worker-1",
      }),
    ).not.toThrow();
  });

  it.each([0, undefined])("fails closed when affectedRows is %s", (affectedRows) => {
    expect(() =>
      assertAffectedRowsExactlyOne(affectedRows, {
        operation: "releaseLease",
        requestId: "request-1",
        workerId: "worker-1",
      }),
    ).toThrow(HostedProvisioningLeaseLostError);
  });
});

describe("claimRequests result authority", () => {
  it("extracts ids from the mysql2 [rows, fields] tuple", () => {
    const fields = [{ name: "id" }];

    expect(
      extractClaimableRequestIds([[{ id: "request-1" }, { id: "request-2" }], fields]),
    ).toEqual(["request-1", "request-2"]);
  });

  it.each([
    { rawResult: [] },
    { rawResult: [[{ missing: "request-1" }], []] },
    { rawResult: [[{ id: "" }], []] },
    { rawResult: [[{ id: "request-1" }, { id: "request-1" }], []] },
  ])("fails closed for malformed mysql2 rows: $rawResult", ({ rawResult }) => {
    expect(() => extractClaimableRequestIds(rawResult)).toThrow();
  });

  it("requires the claim update to affect every selected row", () => {
    expect(() => assertClaimAffectedRows(2, ["request-1", "request-2"])).not.toThrow();
    expect(() => assertClaimAffectedRows(1, ["request-1", "request-2"])).toThrow();
    expect(() => assertClaimAffectedRows(undefined, ["request-1"])).toThrow();
  });
});

describe("mysqlHostedProvisioningRequestStore 冻结权威", () => {
  it("insert 落库 requesterId，findActiveRequest 按 (tenantId, routeScopeKey) 幂等", async () => {
    const { id: tenantId } = await ensureDefaultTenant();
    await mysqlHostedProvisioningRequestStore.insert({
      id: randomUUID(),
      tenantId,
      requesterId: "requester-1",
      routeScopeKey: "prod",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const found = await mysqlHostedProvisioningRequestStore.findActiveRequest({
      tenantId,
      routeScopeKey: "prod",
    });
    expect(found).not.toBeNull();
    expect(found?.requesterId).toBe("requester-1");
  });

  it("同 (tenantId, routeScopeKey) 第二 insert 被唯一约束拒绝（不覆盖 first requester）", async () => {
    const { id: tenantId } = await ensureDefaultTenant();
    await mysqlHostedProvisioningRequestStore.insert({
      id: randomUUID(),
      tenantId,
      requesterId: "requester-first",
      routeScopeKey: "prod",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(
      mysqlHostedProvisioningRequestStore.insert({
        id: randomUUID(),
        tenantId,
        requesterId: "requester-second",
        routeScopeKey: "prod",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toThrow();

    const [rows] = await db.execute(
      sql`SELECT requesterId FROM \`HostedProvisioningRequest\` WHERE tenantId = ${tenantId}`,
    );
    const requesterIds = (rows as unknown as { requesterId: string }[]).map((r) => r.requesterId);
    expect(requesterIds).toEqual(["requester-first"]);
  });

  it("不同 tenant 相同 routeScopeKey 可共存（租户隔离）", async () => {
    const defaultTenant = await ensureDefaultTenant();
    const secondTenantId = randomUUID();
    await db.insert(tenant).values({
      id: secondTenantId,
      key: `tenant-${secondTenantId.slice(0, 8)}`,
      name: "Second Tenant",
      status: "active",
    });
    await mysqlHostedProvisioningRequestStore.insert({
      id: randomUUID(),
      tenantId: defaultTenant.id,
      requesterId: "requester-1",
      routeScopeKey: "prod",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await mysqlHostedProvisioningRequestStore.insert({
      id: randomUUID(),
      tenantId: secondTenantId,
      requesterId: "requester-2",
      routeScopeKey: "prod",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const [rows] = await db.execute(
      sql`SELECT tenantId, COUNT(*) AS n FROM \`HostedProvisioningRequest\`
          GROUP BY tenantId ORDER BY tenantId`,
    );
    const counts = (rows as unknown as { tenantId: string; n: number }[]).map((r) => Number(r.n));
    expect(counts).toEqual([1, 1]);
  });
});
