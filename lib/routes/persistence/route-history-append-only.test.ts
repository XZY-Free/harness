import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-13T00:00:00.000Z");

beforeEach(async () => {
  await resetDatabase(db);
});

async function seedRouteHistory() {
  const tenantId = randomUUID();
  const routeId = randomUUID();
  const routeSetId = randomUUID();
  const routeRevisionId = randomUUID();
  const routeActivationId = randomUUID();

  await db.insert(routeRevision).values({
    id: routeRevisionId,
    tenantId,
    routeId,
    routeSetId,
    routeKey: "append-only-route",
    revisionNo: 1,
    agentRevisionId: randomUUID(),
    runtimeRevisionId: randomUUID(),
    trafficAllocationJson: { percentage: 100 },
    routeGroupId: "primary",
    selectorDigest: `sha256:${"a".repeat(64)}`,
    trafficWeight: 100,
    priorityNo: 1,
    eligibilityConditionsJson: {},
    contentDigest: `sha256:${"b".repeat(64)}`,
    createdByType: "system",
    createdBy: "append-only-test",
    validatedAt: NOW,
    createdAt: NOW,
  });
  await db.insert(routeActivation).values({
    id: routeActivationId,
    tenantId,
    routeId,
    routeRevisionId,
    routeSetId,
    activationSequence: 1,
    activationState: "active",
    routeSetVersionNo: 1,
    activatedByType: "system",
    activatedBy: "append-only-test",
    reason: "initial activation",
    requestId: randomUUID(),
    idempotencyKey: "append-only-test:1",
    activatedAt: NOW,
  });

  return { routeRevisionId, routeActivationId };
}

describe("Route 历史表 append-only 数据库约束", () => {
  it("数据库拒绝 UPDATE RouteRevision 历史", async () => {
    const fixture = await seedRouteHistory();

    await expect(
      db
        .update(routeRevision)
        .set({ trafficWeight: 99 })
        .where(eq(routeRevision.id, fixture.routeRevisionId)),
    ).rejects.toThrow(/RouteRevision is append-only/);
  });

  it("数据库拒绝 UPDATE RouteActivation 历史", async () => {
    const fixture = await seedRouteHistory();

    await expect(
      db
        .update(routeActivation)
        .set({ reason: "mutated" })
        .where(eq(routeActivation.id, fixture.routeActivationId)),
    ).rejects.toThrow(/RouteActivation is append-only/);
  });
});
