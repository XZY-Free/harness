/**
 * : 冻结事件 Envelope — 控制面事件统一类型。
 *
 * 所有控制面事件必须符合此 Envelope 结构。
 * 跨语言 Payload 使用 snake_case；内部解析后可转换为 camelCase。
 *
 * 合同文件：event-contracts.ts（Producer 和 Consumer 共用，禁止各自手写）。
 */

/** 事件 Envelope 序列化格式（snake_case，跨语言合同）。 */
export interface ControlPlaneEventEnvelope {
  /** 事件唯一 ID（UUID v4）。 */
  event_id: string;
  /** Schema 版本（固定 "1.0"）。 */
  schema_version: string;
  /** 事件类型（必须来自 EventContracts 的已知类型）。 */
  event_type: ControlPlaneEventType;
  /** 租户 ID。 */
  tenant_id: string;
  /** 聚合根类型（如 "agent_revision", "runtime_revision"）。 */
  aggregate_type: string;
  /** 聚合根 ID。 */
  aggregate_id: string;
  /** 聚合版本号（乐观锁，用于事件排序与去重）。 */
  aggregate_version: number;
  /** 事件发生时间（ISO 8601）。 */
  occurred_at: string;
  /** 事件载荷（snake_case，结构由各事件类型 Schema 定义）。 */
  payload: Record<string, unknown>;
}

/** 内部解析后的 camelCase Envelope（运行时使用）。 */
export interface ControlPlaneEvent {
  eventId: string;
  schemaVersion: string;
  eventType: ControlPlaneEventType;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

// ─── 事件类型枚举 ──────────────────────────────────────────────

/**
 * /3.2: 已知控制面事件类型。
 *
 * 新增事件类型必须在此注册，并在 event-contracts.ts 定义对应 Payload Schema。
 * 未知事件类型将在 Fail-loud 逻辑中被拒绝。
 */
export type ControlPlaneEventType =
  // Agent
  | "agent.revision.published"
  | "agent.revision.withdrawn"
  | "agent.lifecycle.changed"
  // Runtime
  | "runtime.revision.published"
  | "runtime.revision.withdrawn"
  | "runtime.lifecycle.changed"
  | "runtime.conformance.recorded"
  // Artifact
  | "artifact.attestation.recorded"
  | "artifact.attestation.revoked"
  // Route
  | "route.activated"
  | "route.disabled"
  | "route.revision.validated"
  | "route_set.activated"
  // Policy
  | "policy.revision.published"
  | "policy.revision.withdrawn"
  // AgentCall continuation
  | "agent_call.continuation.requested";

/** 聚合根类型。 */
export type AggregateType =
  | "agent_revision"
  | "agent"
  | "runtime_revision"
  | "runtime"
  | "runtime_conformance_run"
  | "artifact_attestation"
  | "deployment_route"
  | "route_set"
  | "policy_revision"
  | "agent_call";

/** 当前冻结的 Schema 版本。 */
export const EVENT_SCHEMA_VERSION = "1.0" as const;

// ─── Envelope 转换 ────────────────────────────────────────────

/** 将内部 camelCase ControlPlaneEvent 转为 snake_case 序列化 Envelope。 */
export function serializeEventEnvelope(event: ControlPlaneEvent): ControlPlaneEventEnvelope {
  return {
    event_id: event.eventId,
    schema_version: event.schemaVersion,
    event_type: event.eventType,
    tenant_id: event.tenantId,
    aggregate_type: event.aggregateType,
    aggregate_id: event.aggregateId,
    aggregate_version: event.aggregateVersion,
    occurred_at: event.occurredAt.toISOString(),
    payload: event.payload,
  };
}

/** 将 snake_case Envelope 解析为内部 camelCase ControlPlaneEvent。 */
export function deserializeEventEnvelope(envelope: ControlPlaneEventEnvelope): ControlPlaneEvent {
  return {
    eventId: envelope.event_id,
    schemaVersion: envelope.schema_version,
    eventType: envelope.event_type,
    tenantId: envelope.tenant_id,
    aggregateType: envelope.aggregate_type,
    aggregateId: envelope.aggregate_id,
    aggregateVersion: envelope.aggregate_version,
    occurredAt: new Date(envelope.occurred_at),
    payload: envelope.payload,
  };
}
