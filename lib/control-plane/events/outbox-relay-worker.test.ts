import { afterEach, describe, expect, it, vi } from "vitest";

import type { ControlPlaneEventDelivery } from "./control-plane-event-delivery";
import type { ControlPlaneOutboxEvent } from "./control-plane-outbox";
import {
  DeliveryLeaseLostError,
  type OutboxRelayWorkerStore,
  assertDeliveryLeaseMutation,
  createOutboxRelayWorker,
} from "./outbox-relay-worker";

const NOW = new Date("2026-08-11T00:00:00.000Z");

function delivery(): ControlPlaneEventDelivery {
  return {
    id: "delivery-1",
    eventId: "event-1",
    consumerName: "route_projection",
    state: "running",
    attemptCount: 1,
    nextAttemptAt: null,
    lockedBy: "worker-1",
    lockExpiresAt: new Date("2026-08-11T00:01:00.000Z"),
    lastErrorCode: null,
    lastErrorSummary: null,
    completedAt: null,
    deadLetteredAt: null,
    createdAt: NOW,
  };
}

function event(): ControlPlaneOutboxEvent {
  return {
    id: "event-1",
    tenantId: "tenant-1",
    schemaVersion: "1.0",
    eventKey: "event-key-1",
    eventType: "route_set.activated",
    aggregateType: "route_set",
    aggregateId: "route-set-1",
    aggregateVersion: 1,
    payloadJson: {},
    occurredAt: NOW,
    availableAt: null,
  };
}

function store(overrides: Partial<OutboxRelayWorkerStore> = {}): OutboxRelayWorkerStore {
  return {
    recoverExpired: vi.fn(async () => undefined),
    claimDeliveries: vi.fn(async () => [delivery()]),
    findEvent: vi.fn(async () => event()),
    complete: vi.fn(async () => 1),
    retry: vi.fn(async () => 1),
    renew: vi.fn(async () => 1),
    deadLetter: vi.fn(async () => 1),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Outbox Relay lease authority", () => {
  it.each(["complete", "retry", "renew", "dead-letter"] as const)(
    "requires %s to affect exactly one owned row",
    (operation) => {
      expect(() =>
        assertDeliveryLeaseMutation(1, operation, "delivery-1", "worker-1"),
      ).not.toThrow();
      expect(() => assertDeliveryLeaseMutation(0, operation, "delivery-1", "worker-1")).toThrow(
        DeliveryLeaseLostError,
      );
      expect(() =>
        assertDeliveryLeaseMutation(undefined, operation, "delivery-1", "worker-1"),
      ).toThrow(DeliveryLeaseLostError);
    },
  );

  it("renew 丢失租约后即使 handler 成功也不 complete", async () => {
    vi.useFakeTimers();
    const relayStore = store({ renew: vi.fn(async () => 0) });
    const handler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const worker = createOutboxRelayWorker(
      handler,
      { workerId: "worker-1", renewIntervalMs: 1 },
      { store: relayStore, now: () => NOW },
    );

    const polling = worker.pollOnce();
    await vi.advanceTimersByTimeAsync(10);
    await polling;

    expect(relayStore.renew).toHaveBeenCalled();
    expect(relayStore.complete).not.toHaveBeenCalled();
    expect(relayStore.retry).not.toHaveBeenCalled();
    expect(relayStore.deadLetter).not.toHaveBeenCalled();
  });

  it("complete 丢失租约后不转写 retry 或 dead-letter", async () => {
    const relayStore = store({ complete: vi.fn(async () => 0) });
    const worker = createOutboxRelayWorker(
      vi.fn(async () => undefined),
      { workerId: "worker-1", renewIntervalMs: 60_000 },
      { store: relayStore, now: () => NOW },
    );

    await worker.pollOnce();

    expect(relayStore.complete).toHaveBeenCalledOnce();
    expect(relayStore.retry).not.toHaveBeenCalled();
    expect(relayStore.deadLetter).not.toHaveBeenCalled();
  });

  it("retry 丢失租约后停止失败状态写入", async () => {
    const relayStore = store({ retry: vi.fn(async () => 0) });
    const worker = createOutboxRelayWorker(
      vi.fn(async () => {
        throw new Error("connection timeout");
      }),
      { workerId: "worker-1", renewIntervalMs: 60_000 },
      { store: relayStore, now: () => NOW },
    );

    await worker.pollOnce();

    expect(relayStore.retry).toHaveBeenCalledOnce();
    expect(relayStore.deadLetter).not.toHaveBeenCalled();
    expect(relayStore.complete).not.toHaveBeenCalled();
  });

  it("dead-letter 丢失租约后不记录死信成功", async () => {
    const relayStore = store({ deadLetter: vi.fn(async () => 0) });
    const worker = createOutboxRelayWorker(
      vi.fn(async () => {
        throw new Error("invalid format");
      }),
      { workerId: "worker-1", renewIntervalMs: 60_000 },
      { store: relayStore, now: () => NOW },
    );

    await worker.pollOnce();

    expect(relayStore.deadLetter).toHaveBeenCalledOnce();
    expect(relayStore.retry).not.toHaveBeenCalled();
    expect(relayStore.complete).not.toHaveBeenCalled();
  });
});
