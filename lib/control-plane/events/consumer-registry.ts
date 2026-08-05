/**
 * §3.3: 控制面事件消费者注册表。
 *
 * 所有 Outbox 消费者必须在此注册。
 * 新事件写入时，为每个已注册消费者创建 Delivery 行。
 */

/** 已注册消费者定义。 */
export interface RegisteredConsumer {
  /** 消费者名称（唯一标识）。 */
  name: string;
  /** 该消费者订阅的事件类型（空数组 = 订阅所有事件）。 */
  subscribedEventTypes: string[];
  /** 最大重试次数。 */
  maxAttempts: number;
}

/**
 * §3.3: 已注册的控制面事件消费者。
 *
 * 新增消费者必须在此注册，否则不会收到事件。
 */
export const CONTROL_PLANE_CONSUMERS: RegisteredConsumer[] = [
  {
    name: "route_projection",
    subscribedEventTypes: [
      "route.activated",
      "route.disabled",
      "route.revision.validated",
      "route_set.activated",
      "agent.revision.published",
      "agent.revision.withdrawn",
      "runtime.revision.published",
      "runtime.revision.withdrawn",
      "artifact.attestation.revoked",
      "runtime.conformance.recorded",
      "agent.lifecycle.changed",
      "runtime.lifecycle.changed",
      "policy.revision.published",
      "policy.revision.withdrawn",
    ],
    maxAttempts: 10,
  },
  // 后续消费者按需注册：
  // { name: "cache_invalidation", subscribedEventTypes: [], maxAttempts: 5 },
  // { name: "observability", subscribedEventTypes: [], maxAttempts: 3 },
  // { name: "notifications", subscribedEventTypes: [], maxAttempts: 5 },
];

/** 查找消费者是否订阅了某事件类型。 */
export function isEventSubscribed(consumer: RegisteredConsumer, eventType: string): boolean {
  if (consumer.subscribedEventTypes.length === 0) return true; // 订阅所有
  return consumer.subscribedEventTypes.includes(eventType);
}

/** 获取订阅了某事件类型的消费者列表。 */
export function getSubscribedConsumers(eventType: string): RegisteredConsumer[] {
  return CONTROL_PLANE_CONSUMERS.filter((c) => isEventSubscribed(c, eventType));
}
