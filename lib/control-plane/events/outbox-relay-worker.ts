/**
 * §3.5: Outbox Relay Worker — 基于 Delivery 模型的安全领取。
 *
 * 核心安全保证：
 * 1. 领取与租约更新在同一事务（FOR UPDATE SKIP LOCKED）
 * 2. 完成/失败时带 lockedBy=当前Worker 条件更新（租约丢失保护）
 * 3. 长任务续租机制
 * 4. 租约丢失后禁止旧 Worker 写成功状态
 */

import { db } from "@/lib/db/client";
import { logger } from "@/lib/logger";
import type { OutboxEventHandler } from "@/lib/routes/projection/projection-event-handlers";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { controlPlaneEventDelivery } from "./control-plane-event-delivery";
import { controlPlaneOutboxEvent } from "./control-plane-outbox";
import { classifyOutboxError, computeOutboxBackoff } from "./outbox-relay";

/** Worker 配置。 */
export interface OutboxRelayWorkerConfig {
  workerId: string;
  /** 消费者名称（对应 Delivery 表的 consumerName）。 */
  consumerName: string;
  /** 每轮领取的事件数量。 */
  batchSize: number;
  /** 租约时长（毫秒）。 */
  leaseMs: number;
  /** 轮询间隔（毫秒）。 */
  pollIntervalMs: number;
  /** 最大重试次数。 */
  maxAttempts: number;
  /** 退避基数（毫秒）。 */
  baseBackoffMs: number;
  /** 退避上限（毫秒）。 */
  maxBackoffMs: number;
  /** 续租间隔（毫秒），默认 leaseMs / 2。 */
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

/**
 * §3.5: 创建基于 Delivery 模型的 Outbox Relay Worker。
 *
 * 与旧 Worker 的区别：
 * - 领取 Delivery 行（而非 Outbox 事件行）
 * - 完成时带 lockedBy 条件更新 Delivery（租约丢失保护）
 * - 长任务续租
 */
export function createOutboxRelayWorker(
  handler: OutboxEventHandler,
  configOverrides?: Partial<OutboxRelayWorkerConfig>,
) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const renewIntervalMs = config.renewIntervalMs ?? Math.floor(config.leaseMs / 2);
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
          if (processed === 0) {
            await sleep(config.pollIntervalMs);
          }
        } catch (error) {
          logger.error("[outbox-relay-worker] 轮询错误", {
            error: String(error),
          });
          await sleep(config.pollIntervalMs);
        }
      }

      logger.info("[outbox-relay-worker] 停止");
    },

    stop() {
      running = false;
    },
  };

  /** 单轮轮询：领取 → 处理 → 标记。 */
  async function poll(): Promise<number> {
    const now = new Date();
    const deliveries = await claimDeliveries(now);
    if (deliveries.length === 0) return 0;

    for (const delivery of deliveries) {
      // 读取关联的 Outbox 事件
      const [event] = await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(eq(controlPlaneOutboxEvent.id, delivery.eventId))
        .limit(1);

      if (!event) {
        // 事件不存在 → 死信此 Delivery
        await markDeliveryDeadLettered(delivery.id, "EVENT_NOT_FOUND", "关联事件不存在");
        continue;
      }

      // 启动续租定时器
      const renewTimer = setInterval(() => renewLease(delivery.id), renewIntervalMs);

      try {
        await handler(event);

        // §3.5: 成功投递 — 带 lockedBy 条件更新（租约丢失保护）
        const updated = await db
          .update(controlPlaneEventDelivery)
          .set({
            state: "completed",
            completedAt: new Date(),
            lockedBy: null,
            lockExpiresAt: null,
            lastErrorCode: null,
            lastErrorSummary: null,
          })
          .where(
            and(
              eq(controlPlaneEventDelivery.id, delivery.id),
              eq(controlPlaneEventDelivery.lockedBy, config.workerId),
            ),
          );

        // 如果 affectedRows = 0，说明租约已丢失，不能标记成功
        // （其他 Worker 可能已经接管了此 Delivery）

        logger.info("[outbox-relay-worker] Delivery 投递成功", {
          deliveryId: delivery.id,
          eventId: event.id,
          eventType: event.eventType,
        });
      } catch (error) {
        const classification = classifyOutboxError(error);
        const message = classification.summary;

        if (
          classification.category === "permanent" ||
          delivery.attemptCount >= config.maxAttempts
        ) {
          // 永久失败或达到最大次数 → 死信
          await markDeliveryDeadLettered(delivery.id, classification.code, message);
        } else {
          // 可重试 → 退避 + 带 lockedBy 条件更新
          const nextAttempt = computeOutboxBackoff(
            delivery.attemptCount,
            config.baseBackoffMs,
            config.maxBackoffMs,
          );
          await db
            .update(controlPlaneEventDelivery)
            .set({
              state: "pending",
              nextAttemptAt: nextAttempt,
              lockedBy: null,
              lockExpiresAt: null,
              lastErrorCode: classification.code,
              lastErrorSummary: message,
            })
            .where(
              and(
                eq(controlPlaneEventDelivery.id, delivery.id),
                eq(controlPlaneEventDelivery.lockedBy, config.workerId),
              ),
            );
        }
      } finally {
        clearInterval(renewTimer);
      }
    }

    return deliveries.length;
  }

  /** §3.5: FOR UPDATE SKIP LOCKED 领取 Delivery 行。 */
  async function claimDeliveries(now: Date) {
    const lockExpiresAt = new Date(now.getTime() + config.leaseMs);

    // 领取 SQL：UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
    const claimSql = sql`
      UPDATE ControlPlaneEventDelivery
      SET lockedBy = ${config.workerId},
          lockExpiresAt = ${lockExpiresAt},
          state = 'running',
          attemptCount = attemptCount + 1
      WHERE id IN (
        SELECT id FROM ControlPlaneEventDelivery
        WHERE consumerName = ${config.consumerName}
          AND state = 'pending'
          AND deadLetteredAt IS NULL
          AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${now})
          AND (lockExpiresAt IS NULL OR lockExpiresAt <= ${now})
        ORDER BY createdAt ASC, id ASC
        LIMIT ${config.batchSize}
        FOR UPDATE SKIP LOCKED
      )
    `;

    await db.execute(claimSql);

    // 读取已领取的 Delivery 行
    const deliveries = await db
      .select()
      .from(controlPlaneEventDelivery)
      .where(
        and(
          eq(controlPlaneEventDelivery.lockedBy, config.workerId),
          eq(controlPlaneEventDelivery.state, "running"),
        ),
      );

    return deliveries;
  }

  /** §3.5: 续租 — 延长当前 Delivery 的租约（带 lockedBy 条件）。 */
  async function renewLease(deliveryId: string): Promise<void> {
    const newExpires = new Date(Date.now() + config.leaseMs);
    await db
      .update(controlPlaneEventDelivery)
      .set({ lockExpiresAt: newExpires })
      .where(
        and(
          eq(controlPlaneEventDelivery.id, deliveryId),
          eq(controlPlaneEventDelivery.lockedBy, config.workerId),
        ),
      );
  }

  /** §3.5: 标记 Delivery 为死信（带 lockedBy 条件）。 */
  async function markDeliveryDeadLettered(
    deliveryId: string,
    errorCode: string,
    errorSummary: string,
  ): Promise<void> {
    await db
      .update(controlPlaneEventDelivery)
      .set({
        state: "dead_lettered",
        deadLetteredAt: new Date(),
        lockedBy: null,
        lockExpiresAt: null,
        lastErrorCode: errorCode,
        lastErrorSummary: errorSummary,
      })
      .where(
        and(
          eq(controlPlaneEventDelivery.id, deliveryId),
          eq(controlPlaneEventDelivery.lockedBy, config.workerId),
        ),
      );

    logger.warn("[outbox-relay-worker] Delivery 进入死信", {
      deliveryId,
      lastErrorCode: errorCode,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
