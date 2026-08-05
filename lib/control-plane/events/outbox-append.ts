/**
 * §3.2: 统一 Outbox 写入辅助。
 *
 * 所有 appendOutbox 调用必须通过此模块校验事件类型和 Payload，
 * 并从合同推导 aggregateType — Producer 禁止手写 aggregateType 字符串。
 */

import type { ControlPlaneEventType } from "./control-plane-event";
import { EVENT_AGGREGATE_TYPES, EVENT_PAYLOAD_SCHEMAS } from "./event-contracts";

/** 统一 Outbox 写入参数（所有 Store appendOutbox 必须接受此格式）。 */
export interface ControlPlaneOutboxAppendParams {
  id: string;
  tenantId: string;
  eventKey: string;
  /** 事件类型 — 必须是 ControlPlaneEventType 合同已知类型。 */
  eventType: ControlPlaneEventType;
  /** 聚合根 ID。 */
  aggregateId: string;
  /** 聚合版本号（乐观锁）。 */
  aggregateVersion: number;
  /** 事件载荷 — 必须符合 eventType 对应的 Payload Schema。 */
  payload: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * 校验并推导 Outbox 写入参数。
 *
 * 1. 校验 eventType 已知 → 推导 aggregateType
 * 2. 校验 payload 符合 Schema
 * 3. 返回可直接写入 ControlPlaneOutboxEvent 的值
 *
 * 如果校验失败，抛出 ControlPlaneEventContractError（Fail-closed）。
 */
export function resolveOutboxAppend(params: ControlPlaneOutboxAppendParams): {
  id: string;
  tenantId: string;
  eventKey: string;
  eventType: ControlPlaneEventType;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  payloadJson: Record<string, unknown>;
  occurredAt: Date;
} {
  // 1. 推导 aggregateType
  const aggregateType = EVENT_AGGREGATE_TYPES[params.eventType];
  if (!aggregateType) {
    throw new ControlPlaneEventContractError(
      `未知事件类型: ${params.eventType}，无法推导 aggregateType`,
    );
  }

  // 2. 校验 Payload
  const schema = EVENT_PAYLOAD_SCHEMAS[params.eventType];
  const parseResult = schema.safeParse(params.payload);
  if (!parseResult.success) {
    const errors = parseResult.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ControlPlaneEventContractError(
      `事件 ${params.eventType} Payload 校验失败: ${errors}`,
    );
  }

  return {
    id: params.id,
    tenantId: params.tenantId,
    eventKey: params.eventKey,
    eventType: params.eventType,
    aggregateType,
    aggregateId: params.aggregateId,
    aggregateVersion: params.aggregateVersion,
    payloadJson: parseResult.data as Record<string, unknown>,
    occurredAt: params.occurredAt,
  };
}

/**
 * §3.2: 控制面事件合同错误。
 *
 * 当 Producer 使用未知事件类型或非法 Payload 时抛出。
 * 这是 Fail-closed — 不允许写入不合规事件。
 */
export class ControlPlaneEventContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneEventContractError";
  }
}
