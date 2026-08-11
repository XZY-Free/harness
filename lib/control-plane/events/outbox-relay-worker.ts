/**
 * Outbox Relay Worker — 基于 Delivery 模型的安全领取。
 *
 * complete、retry、renew、dead-letter 都必须仍持有 lockedBy；任何更新未精确影响
 * 一行都视为租约丢失，旧 Worker 不再写 Delivery 状态。
 */

import { db } from "@/lib/db/client";
import { logger } from "@/lib/logger";
import type { OutboxEventHandler } from "@/lib/routes/projection/projection-event-handlers";
import { and, eq, lte, sql } from "drizzle-orm";
import {
  type ControlPlaneEventDelivery,
  controlPlaneEventDelivery,
} from "./control-plane-event-delivery";
import { type ControlPlaneOutboxEvent, controlPlaneOutboxEvent } from "./control-plane-outbox";
import { classifyOutboxError, computeOutboxBackoff } from "./outbox-relay";

export interface OutboxRelayWorkerConfig {
  workerId: string;
  consumerName: string;
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  renewIntervalMs?: number;
}

const DEFAULT_CONFIG: OutboxRelayWorkerConfig = {
  workerId: `outbox-relay-${process.pid}`,
  consumerName: "route_projection",
  batchSize: 10,
  leaseMs: 120_000,
  pollIntervalMs: 2_000,
  maxAttempts: 10,
  baseBackoffMs: 5_000,
  maxBackoffMs: 300_000,
};

export type DeliveryLeaseMutationOperation = "complete" | "retry" | "renew" | "dead-letter";

export class DeliveryLeaseLostError extends Error {
  constructor(
    public readonly operation: DeliveryLeaseMutationOperation,
    public readonly deliveryId: string,
    public readonly workerId: string,
    public readonly affectedRows: number | undefined,
  ) {
    super(
      `delivery_lease_lost: ${operation} deliveryId=${deliveryId} workerId=${workerId} affectedRows=${String(affectedRows)}`,
    );
    this.name = "DeliveryLeaseLostError";
  }
}

export function assertDeliveryLeaseMutation(
  affectedRows: number | undefined,
  operation: DeliveryLeaseMutationOperation,
  deliveryId: string,
  workerId: string,
): void {
  if (affectedRows !== 1) {
    throw new DeliveryLeaseLostError(operation, deliveryId, workerId, affectedRows);
  }
}

export interface OutboxRelayWorkerStore {
  recoverExpired(now: Date): Promise<void>;
  claimDeliveries(params: {
    now: Date;
    workerId: string;
    consumerName: string;
    batchSize: number;
    leaseMs: number;
  }): Promise<ControlPlaneEventDelivery[]>;
  findEvent(eventId: string): Promise<ControlPlaneOutboxEvent | null>;
  complete(params: {
    deliveryId: string;
    workerId: string;
    completedAt: Date;
  }): Promise<number | undefined>;
  retry(params: {
    deliveryId: string;
    workerId: string;
    nextAttemptAt: Date;
    errorCode: string;
    errorSummary: string;
  }): Promise<number | undefined>;
  renew(params: {
    deliveryId: string;
    workerId: string;
    lockExpiresAt: Date;
  }): Promise<number | undefined>;
  deadLetter(params: {
    deliveryId: string;
    workerId: string;
    deadLetteredAt: Date;
    errorCode: string;
    errorSummary: string;
  }): Promise<number | undefined>;
}

export interface OutboxRelayWorkerDependencies {
  store?: OutboxRelayWorkerStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export function createOutboxRelayWorker(
  handler: OutboxEventHandler,
  configOverrides?: Partial<OutboxRelayWorkerConfig>,
  dependencies: OutboxRelayWorkerDependencies = {},
) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const renewIntervalMs = config.renewIntervalMs ?? Math.floor(config.leaseMs / 2);
  const store = dependencies.store ?? mysqlOutboxRelayWorkerStore;
  const now = dependencies.now ?? (() => new Date());
  const wait = dependencies.sleep ?? sleep;
  let running = false;

  return {
    async start() {
      running = true;
      logger.info("[outbox-relay-worker] 启动", {
        workerId: config.workerId,
        consumerName: config.consumerName,
        batchSize: config.batchSize,
        leaseMs: config.leaseMs,
      });

      while (running) {
        try {
          const processed = await poll();
          if (processed === 0) await wait(config.pollIntervalMs);
        } catch (error) {
          logger.error("[outbox-relay-worker] 轮询错误", { error: String(error) });
          await wait(config.pollIntervalMs);
        }
      }

      logger.info("[outbox-relay-worker] 停止");
    },

    stop() {
      running = false;
    },

    async pollOnce() {
      return poll();
    },
  };

  async function poll(): Promise<number> {
    const polledAt = now();
    await store.recoverExpired(polledAt);
    const deliveries = await store.claimDeliveries({
      now: polledAt,
      workerId: config.workerId,
      consumerName: config.consumerName,
      batchSize: config.batchSize,
      leaseMs: config.leaseMs,
    });

    for (const delivery of deliveries) {
      await deliverOne(delivery);
    }
    return deliveries.length;
  }

  async function deliverOne(delivery: ControlPlaneEventDelivery): Promise<void> {
    const event = await store.findEvent(delivery.eventId);
    if (!event) {
      await deadLetterOwned(delivery, "EVENT_NOT_FOUND", "关联事件不存在");
      return;
    }

    let leaseLost = false;
    let renewInFlight: Promise<void> | null = null;
    const renew = () => {
      if (leaseLost || renewInFlight) return;
      renewInFlight = renewOwned(delivery)
        .catch((error) => {
          leaseLost = true;
          logLeaseLost(delivery, error);
        })
        .finally(() => {
          renewInFlight = null;
        });
    };
    const renewTimer = setInterval(renew, renewIntervalMs);

    try {
      await handler(event);
      clearInterval(renewTimer);
      if (renewInFlight) await renewInFlight;
      if (leaseLost) return;

      const affectedRows = await store.complete({
        deliveryId: delivery.id,
        workerId: config.workerId,
        completedAt: now(),
      });
      assertDeliveryLeaseMutation(affectedRows, "complete", delivery.id, config.workerId);
      logger.info("[outbox-relay-worker] Delivery 投递成功", {
        deliveryId: delivery.id,
        eventId: event.id,
        eventType: event.eventType,
      });
    } catch (error) {
      clearInterval(renewTimer);
      if (renewInFlight) await renewInFlight;
      if (leaseLost || error instanceof DeliveryLeaseLostError) {
        logLeaseLost(delivery, error);
        return;
      }

      const classification = classifyOutboxError(error);
      if (classification.category === "permanent" || delivery.attemptCount >= config.maxAttempts) {
        await deadLetterOwned(delivery, classification.code, classification.summary);
        return;
      }

      try {
        const affectedRows = await store.retry({
          deliveryId: delivery.id,
          workerId: config.workerId,
          nextAttemptAt: computeOutboxBackoff(
            delivery.attemptCount,
            config.baseBackoffMs,
            config.maxBackoffMs,
          ),
          errorCode: classification.code,
          errorSummary: classification.summary,
        });
        assertDeliveryLeaseMutation(affectedRows, "retry", delivery.id, config.workerId);
      } catch (mutationError) {
        if (mutationError instanceof DeliveryLeaseLostError) {
          logLeaseLost(delivery, mutationError);
          return;
        }
        throw mutationError;
      }
    } finally {
      clearInterval(renewTimer);
    }
  }

  async function renewOwned(delivery: ControlPlaneEventDelivery): Promise<void> {
    const affectedRows = await store.renew({
      deliveryId: delivery.id,
      workerId: config.workerId,
      lockExpiresAt: new Date(now().getTime() + config.leaseMs),
    });
    assertDeliveryLeaseMutation(affectedRows, "renew", delivery.id, config.workerId);
  }

  async function deadLetterOwned(
    delivery: ControlPlaneEventDelivery,
    errorCode: string,
    errorSummary: string,
  ): Promise<void> {
    try {
      const affectedRows = await store.deadLetter({
        deliveryId: delivery.id,
        workerId: config.workerId,
        deadLetteredAt: now(),
        errorCode,
        errorSummary,
      });
      assertDeliveryLeaseMutation(affectedRows, "dead-letter", delivery.id, config.workerId);
      logger.warn("[outbox-relay-worker] Delivery 进入死信", {
        deliveryId: delivery.id,
        lastErrorCode: errorCode,
      });
    } catch (error) {
      if (error instanceof DeliveryLeaseLostError) {
        logLeaseLost(delivery, error);
        return;
      }
      throw error;
    }
  }

  function logLeaseLost(delivery: ControlPlaneEventDelivery, error: unknown): void {
    logger.warn("[outbox-relay-worker] delivery_lease_lost", {
      deliveryId: delivery.id,
      workerId: config.workerId,
      error: String(error),
    });
  }
}

export const mysqlOutboxRelayWorkerStore: OutboxRelayWorkerStore = {
  async recoverExpired(now) {
    await db
      .update(controlPlaneEventDelivery)
      .set({ state: "pending", lockedBy: null, lockExpiresAt: null })
      .where(
        and(
          eq(controlPlaneEventDelivery.state, "running"),
          lte(controlPlaneEventDelivery.lockExpiresAt, now),
        ),
      );
  },

  async claimDeliveries({ now, workerId, consumerName, batchSize, leaseMs }) {
    const lockExpiresAt = new Date(now.getTime() + leaseMs);
    await db.execute(sql`
      UPDATE ControlPlaneEventDelivery
      SET lockedBy = ${workerId},
          lockExpiresAt = ${lockExpiresAt},
          state = 'running',
          attemptCount = attemptCount + 1
      WHERE id IN (
        SELECT id FROM ControlPlaneEventDelivery
        WHERE consumerName = ${consumerName}
          AND state = 'pending'
          AND deadLetteredAt IS NULL
          AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${now})
          AND (lockExpiresAt IS NULL OR lockExpiresAt <= ${now})
        ORDER BY createdAt ASC, id ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
    `);
    return db
      .select()
      .from(controlPlaneEventDelivery)
      .where(
        and(
          eq(controlPlaneEventDelivery.lockedBy, workerId),
          eq(controlPlaneEventDelivery.state, "running"),
        ),
      );
  },

  async findEvent(eventId) {
    const [event] = await db
      .select()
      .from(controlPlaneOutboxEvent)
      .where(eq(controlPlaneOutboxEvent.id, eventId))
      .limit(1);
    return event ?? null;
  },

  async complete({ deliveryId, workerId, completedAt }) {
    const result = await db
      .update(controlPlaneEventDelivery)
      .set({
        state: "completed",
        completedAt,
        lockedBy: null,
        lockExpiresAt: null,
        lastErrorCode: null,
        lastErrorSummary: null,
      })
      .where(
        and(
          eq(controlPlaneEventDelivery.id, deliveryId),
          eq(controlPlaneEventDelivery.lockedBy, workerId),
        ),
      );
    return result[0]?.affectedRows;
  },

  async retry({ deliveryId, workerId, nextAttemptAt, errorCode, errorSummary }) {
    const result = await db
      .update(controlPlaneEventDelivery)
      .set({
        state: "pending",
        nextAttemptAt,
        lockedBy: null,
        lockExpiresAt: null,
        lastErrorCode: errorCode,
        lastErrorSummary: errorSummary,
      })
      .where(
        and(
          eq(controlPlaneEventDelivery.id, deliveryId),
          eq(controlPlaneEventDelivery.lockedBy, workerId),
        ),
      );
    return result[0]?.affectedRows;
  },

  async renew({ deliveryId, workerId, lockExpiresAt }) {
    const result = await db
      .update(controlPlaneEventDelivery)
      .set({ lockExpiresAt })
      .where(
        and(
          eq(controlPlaneEventDelivery.id, deliveryId),
          eq(controlPlaneEventDelivery.lockedBy, workerId),
        ),
      );
    return result[0]?.affectedRows;
  },

  async deadLetter({ deliveryId, workerId, deadLetteredAt, errorCode, errorSummary }) {
    const result = await db
      .update(controlPlaneEventDelivery)
      .set({
        state: "dead_lettered",
        deadLetteredAt,
        lockedBy: null,
        lockExpiresAt: null,
        lastErrorCode: errorCode,
        lastErrorSummary: errorSummary,
      })
      .where(
        and(
          eq(controlPlaneEventDelivery.id, deliveryId),
          eq(controlPlaneEventDelivery.lockedBy, workerId),
        ),
      );
    return result[0]?.affectedRows;
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
