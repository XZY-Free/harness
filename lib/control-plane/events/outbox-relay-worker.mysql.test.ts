import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { controlPlaneEventDelivery } from "./control-plane-event-delivery";
import { controlPlaneOutboxEvent } from "./control-plane-outbox";
import { mysqlOutboxRelayWorkerStore } from "./outbox-relay-worker";

beforeEach(async () => resetDatabase(db));

describe("Outbox Delivery MySQL lease authority", () => {
  it("B 接管过期租约后 A 无法 complete、retry、renew 或 dead-letter", async () => {
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    const now = new Date("2026-08-11T00:00:00.000Z");
    await db.insert(controlPlaneOutboxEvent).values({
      id: eventId,
      tenantId: randomUUID(),
      schemaVersion: "1.0",
      eventKey: `lease-test:${eventId}`,
      eventType: "route_set.activated",
      aggregateType: "route_set",
      aggregateId: randomUUID(),
      aggregateVersion: 1,
      payloadJson: { tenant_id: randomUUID(), route_set_id: randomUUID(), route_ids: [] },
      occurredAt: now,
    });
    await db.insert(controlPlaneEventDelivery).values({
      id: deliveryId,
      eventId,
      consumerName: "route_projection",
      state: "pending",
      attemptCount: 0,
      createdAt: now,
    });

    const [claimedByA] = await mysqlOutboxRelayWorkerStore.claimDeliveries({
      now,
      workerId: "worker-a",
      consumerName: "route_projection",
      batchSize: 1,
      leaseMs: 60_000,
    });
    expect(claimedByA?.id).toBe(deliveryId);

    const afterExpiry = new Date(now.getTime() + 61_000);
    await mysqlOutboxRelayWorkerStore.recoverExpired(afterExpiry);
    const [claimedByB] = await mysqlOutboxRelayWorkerStore.claimDeliveries({
      now: afterExpiry,
      workerId: "worker-b",
      consumerName: "route_projection",
      batchSize: 1,
      leaseMs: 60_000,
    });
    expect(claimedByB?.id).toBe(deliveryId);
    expect(claimedByB?.lockedBy).toBe("worker-b");

    expect(
      await mysqlOutboxRelayWorkerStore.complete({
        deliveryId,
        workerId: "worker-a",
        completedAt: afterExpiry,
      }),
    ).toBe(0);
    expect(
      await mysqlOutboxRelayWorkerStore.retry({
        deliveryId,
        workerId: "worker-a",
        nextAttemptAt: afterExpiry,
        errorCode: "STALE",
        errorSummary: "stale worker",
      }),
    ).toBe(0);
    expect(
      await mysqlOutboxRelayWorkerStore.renew({
        deliveryId,
        workerId: "worker-a",
        lockExpiresAt: new Date(afterExpiry.getTime() + 60_000),
      }),
    ).toBe(0);
    expect(
      await mysqlOutboxRelayWorkerStore.deadLetter({
        deliveryId,
        workerId: "worker-a",
        deadLetteredAt: afterExpiry,
        errorCode: "STALE",
        errorSummary: "stale worker",
      }),
    ).toBe(0);

    expect(
      await mysqlOutboxRelayWorkerStore.complete({
        deliveryId,
        workerId: "worker-b",
        completedAt: afterExpiry,
      }),
    ).toBe(1);
    const [completed] = await db
      .select()
      .from(controlPlaneEventDelivery)
      .where(eq(controlPlaneEventDelivery.id, deliveryId));
    expect(completed?.state).toBe("completed");
    expect(completed?.lockedBy).toBeNull();
  });
});
