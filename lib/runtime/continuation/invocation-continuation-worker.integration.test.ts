import type { ControlPlaneEventDelivery } from "@/lib/control-plane/events/control-plane-event-delivery";
import type { ControlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import type { OutboxRelayWorkerStore } from "@/lib/control-plane/events/outbox-relay-worker";
import { createOutboxRelayWorker } from "@/lib/control-plane/events/outbox-relay-worker";
import { describe, expect, it, vi } from "vitest";
import {
  INVOCATION_CONTINUATION_CONSUMER,
  INVOCATION_CONTINUATION_LEASE_MS,
  INVOCATION_CONTINUATION_MAX_ATTEMPTS,
  INVOCATION_CONTINUATION_RETRY_DELAYS_MS,
  InvocationContinuationPermanentError,
  classifyInvocationContinuationError,
} from "./invocation-continuation";

function delivery(attemptCount = 1): ControlPlaneEventDelivery {
  return {
    id: "delivery-1",
    eventId: "event-1",
    consumerName: INVOCATION_CONTINUATION_CONSUMER,
    state: "running",
    attemptCount,
    nextAttemptAt: null,
    lockedBy: "continuation-test",
    lockExpiresAt: new Date("2026-01-01T00:01:00Z"),
    lastErrorCode: null,
    lastErrorSummary: null,
    completedAt: null,
    deadLetteredAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

const event: ControlPlaneOutboxEvent = {
  id: "event-1",
  tenantId: "tenant-1",
  schemaVersion: "1.0",
  eventKey: "continuation-1",
  eventType: "agent_call.continuation.requested",
  aggregateType: "AgentCall",
  aggregateId: "call-1",
  aggregateVersion: 2,
  payloadJson: {},
  occurredAt: new Date("2026-01-01T00:00:00Z"),
  availableAt: new Date("2026-01-01T00:00:00Z"),
};

function storeFor(row: ControlPlaneEventDelivery) {
  const retry = vi.fn(async () => 1);
  const deadLetter = vi.fn(async () => 1);
  const complete = vi.fn(async () => 1);
  const store: OutboxRelayWorkerStore = {
    recoverExpired: vi.fn(async () => undefined),
    claimDeliveries: vi.fn(async () => [row]),
    findEvent: vi.fn(async () => event),
    complete,
    retry,
    renew: vi.fn(async () => 1),
    deadLetter,
  };
  return { store, retry, deadLetter, complete };
}

describe("Invocation continuation worker", () => {
  it("冻结为 8 次和 1s/5s/30s/2m/10m/30m/2h/6h", () => {
    expect(INVOCATION_CONTINUATION_MAX_ATTEMPTS).toBe(8);
    expect(INVOCATION_CONTINUATION_RETRY_DELAYS_MS).toEqual([
      1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000,
    ]);
  });

  it("使用 60 秒租约、8 次上限和冻结退避表", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const fixture = storeFor(delivery(1));
    const worker = createOutboxRelayWorker(
      async () => {
        throw new Error("temporary database failure");
      },
      {
        workerId: "continuation-test",
        consumerName: INVOCATION_CONTINUATION_CONSUMER,
        batchSize: 1,
        leaseMs: INVOCATION_CONTINUATION_LEASE_MS,
        pollIntervalMs: 1,
        maxAttempts: INVOCATION_CONTINUATION_MAX_ATTEMPTS,
        baseBackoffMs: 1,
        maxBackoffMs: INVOCATION_CONTINUATION_RETRY_DELAYS_MS.at(-1) ?? 1,
        retryScheduleMs: INVOCATION_CONTINUATION_RETRY_DELAYS_MS,
      },
      { store: fixture.store, now: () => now },
    );

    await worker.pollOnce();

    expect(fixture.store.claimDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({ leaseMs: 60_000, consumerName: "invocation_continuation" }),
    );
    expect(fixture.retry).toHaveBeenCalledWith(
      expect.objectContaining({ nextAttemptAt: new Date("2026-01-01T00:00:01Z") }),
    );
  });

  it("不可重试错误立即进入 dead-letter 并触发诊断回调", async () => {
    const fixture = storeFor(delivery(1));
    const onDeadLetter = vi.fn(async () => undefined);
    const worker = createOutboxRelayWorker(
      async () => {
        throw new InvocationContinuationPermanentError("BINDING_MISSING", "binding missing");
      },
      {
        workerId: "continuation-test",
        consumerName: INVOCATION_CONTINUATION_CONSUMER,
        batchSize: 1,
        leaseMs: 60_000,
        pollIntervalMs: 1,
        maxAttempts: 8,
        baseBackoffMs: 1,
        maxBackoffMs: 1,
      },
      {
        store: fixture.store,
        classifyError: classifyInvocationContinuationError,
        onDeadLetter,
      },
    );

    await worker.pollOnce();

    expect(fixture.retry).not.toHaveBeenCalled();
    expect(fixture.deadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "BINDING_MISSING" }),
    );
    expect(onDeadLetter).toHaveBeenCalledOnce();
  });

  it("第 8 次可重试失败进入 dead-letter，不再无限重试", async () => {
    const fixture = storeFor(delivery(8));
    const worker = createOutboxRelayWorker(
      async () => {
        throw new Error("temporary failure");
      },
      {
        workerId: "continuation-test",
        consumerName: INVOCATION_CONTINUATION_CONSUMER,
        batchSize: 1,
        leaseMs: 60_000,
        pollIntervalMs: 1,
        maxAttempts: 8,
        baseBackoffMs: 1_000,
        maxBackoffMs: 21_600_000,
        retryScheduleMs: INVOCATION_CONTINUATION_RETRY_DELAYS_MS,
      },
      { store: fixture.store },
    );

    await worker.pollOnce();

    expect(fixture.retry).not.toHaveBeenCalled();
    expect(fixture.deadLetter).toHaveBeenCalledOnce();
  });
});
