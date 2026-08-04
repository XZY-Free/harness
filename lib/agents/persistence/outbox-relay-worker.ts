/**
 * Outbox Relay Worker — 异步领取和投递控制面事件。
 *
 * 领取语义：FOR UPDATE SKIP LOCKED + 租约 + 指数退避。
 * 成功投递后标记 publishedAt。
 * 可重试错误：退避后重试。
 * 永久错误或达到 maxAttempts：进入死信。
 */

import { db } from "@/lib/db/client";
import { controlPlaneOutboxEvent } from "@/lib/agents/persistence/control-plane-outbox";
import {
  computeOutboxBackoff,
  classifyOutboxError,
} from "@/lib/agents/persistence/outbox-relay";
import type { OutboxEventHandler } from "@/lib/routes/projection/projection-event-handlers";
import { logger } from "@/lib/logger";
import { and, eq, isNull, lte, sql } from "drizzle-orm";

/** Worker 配置。 */
export interface OutboxRelayWorkerConfig {
  workerId: string;
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
}

const DEFAULT_CONFIG: OutboxRelayWorkerConfig = {
  workerId: `outbox-relay-${process.pid}`,
  batchSize: 10,
  leaseMs: 120_000,
  pollIntervalMs: 2_000,
  maxAttempts: 10,
  baseBackoffMs: 5_000,
  maxBackoffMs: 300_000,
};

/**
 * 创建 Outbox Relay Worker。
 */
export function createOutboxRelayWorker(
  handler: OutboxEventHandler,
  configOverrides?: Partial<OutboxRelayWorkerConfig>,
) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  let running = false;

  return {
    async start() {
      running = true;
      logger.info("[outbox-relay-worker] 启动", {
        workerId: config.workerId,
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
    const events = await claimEvents(now);
    if (events.length === 0) return 0;

    for (const event of events) {
      try {
        await handler(event);
        // 成功投递
        await db
          .update(controlPlaneOutboxEvent)
          .set({
            publishedAt: new Date(),
            lockedBy: null,
            lockExpiresAt: null,
            lastErrorCode: null,
            lastErrorSummary: null,
          })
          .where(eq(controlPlaneOutboxEvent.id, event.id));

        logger.info("[outbox-relay-worker] 事件投递成功", {
          eventId: event.id,
          eventType: event.eventType,
        });
      } catch (error) {
        const classification = classifyOutboxError(error);
        const message = classification.summary;

        if (classification.category === "permanent" || event.attemptCount >= config.maxAttempts) {
          // 永久失败或达到最大次数 → 死信
          await db
            .update(controlPlaneOutboxEvent)
            .set({
              deadLetteredAt: new Date(),
              lockedBy: null,
              lockExpiresAt: null,
              lastErrorCode: classification.code,
              lastErrorSummary: message,
            })
            .where(eq(controlPlaneOutboxEvent.id, event.id));

          logger.warn("[outbox-relay-worker] 事件进入死信", {
            eventId: event.id,
            eventType: event.eventType,
            lastErrorCode: classification.code,
          });
        } else {
          // 可重试 → 退避
          const nextAttempt = computeOutboxBackoff(
            event.attemptCount,
            config.baseBackoffMs,
            config.maxBackoffMs,
          );
          await db
            .update(controlPlaneOutboxEvent)
            .set({
              nextAttemptAt: nextAttempt,
              lockedBy: null,
              lockExpiresAt: null,
              lastErrorCode: classification.code,
              lastErrorSummary: message,
            })
            .where(eq(controlPlaneOutboxEvent.id, event.id));
        }
      }
    }

    return events.length;
  }

  /** FOR UPDATE SKIP LOCKED 领取。 */
  async function claimEvents(now: Date) {
    const lockExpiresAt = new Date(now.getTime() + config.leaseMs);

    // 使用参数化 SQL 实现 SKIP LOCKED 领取
    const claimSql = sql`
      UPDATE ControlPlaneOutboxEvent
      SET lockedBy = ${config.workerId},
          lockExpiresAt = ${lockExpiresAt},
          lastAttemptAt = ${now},
          attemptCount = attemptCount + 1
      WHERE id IN (
        SELECT id FROM ControlPlaneOutboxEvent
        WHERE publishedAt IS NULL
          AND deadLetteredAt IS NULL
          AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${now})
          AND (lockExpiresAt IS NULL OR lockExpiresAt <= ${now})
        ORDER BY occurredAt ASC, id ASC
        LIMIT ${config.batchSize}
        FOR UPDATE SKIP LOCKED
      )
    `;

    await db.execute(claimSql);

    // 读取已领取的事件
    const events = await db
      .select()
      .from(controlPlaneOutboxEvent)
      .where(
        and(
          eq(controlPlaneOutboxEvent.lockedBy, config.workerId),
          isNull(controlPlaneOutboxEvent.publishedAt),
        ),
      );

    return events;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
