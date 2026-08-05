/**
 * §3.3: Delivery 行创建辅助。
 *
 * 新 Outbox 事件写入时，在同一事务中为每个已注册消费者
 * 创建 ControlPlaneEventDelivery 行。
 */

import { controlPlaneEventDelivery } from "./control-plane-event-delivery";
import { getSubscribedConsumers } from "./consumer-registry";
import type { ControlPlaneEventType } from "./control-plane-event";
import type { MySql2Database } from "drizzle-orm/mysql2";

/**
 * 为新事件创建所有消费者的 Delivery 行。
 * 在 Outbox 事件插入的同一事务中调用。
 */
export async function seedEventDeliveries(
  tx: MySql2Database,
  eventId: string,
  eventType: ControlPlaneEventType | string,
  now: Date,
): Promise<void> {
  const consumers = getSubscribedConsumers(eventType);
  if (consumers.length === 0) return;

  const rows = consumers.map((consumer) => ({
    id: crypto.randomUUID(),
    eventId,
    consumerName: consumer.name,
    state: "pending" as const,
    attemptCount: 0,
    createdAt: now,
  }));

  // 批量插入
  for (const row of rows) {
    await tx.insert(controlPlaneEventDelivery).values(row);
  }
}
