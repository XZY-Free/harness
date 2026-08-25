/**
 * /3.2: 事件合同 — 所有控制面事件的 Payload Schema 定义。
 *
 * Producer 和 Consumer 必须使用此文件，禁止各自手写字符串和 Payload 字段。
 * 未知事件类型或 Payload 不合法 → Fail-loud。
 *
 * Payload 字段统一使用 snake_case（跨语言合同）。
 */

import { z } from "zod";
import type { ControlPlaneEventType } from "./control-plane-event";

/**
 * ID 字段 Schema：非空字符串（长度 1-128）。
 * 使用 z.string().min(1) 而非 z.string().uuid()，
 * 因为运行时 ID 可能包含非 UUID 格式（如复合 key、short ID）。
 * 合同重点校验字段存在性与类型，ID 格式由生产者保证。
 */
const id = z.string().min(1).max(128);

// ─── Agent 事件 Payload ──────────────────────────────────────

export const AgentRevisionPublishedPayload = z.object({
  agent_id: id,
  revision_id: id,
  revision_no: z.number().int().positive(),
  publication_record_id: id,
  audit_event_id: id,
});

export const AgentRevisionWithdrawnPayload = z.object({
  agent_id: id,
  revision_id: id,
  publication_record_id: id,
  withdrawal_record_id: id,
  current_revision_id: z.string().nullable(),
  audit_event_id: id,
});

export const AgentLifecycleChangedPayload = z.object({
  agent_id: id,
  previous_state: z.string(),
  new_state: z.string(),
});

// ─── Runtime 事件 Payload ────────────────────────────────────

export const RuntimeRevisionPublishedPayload = z.object({
  runtime_id: id,
  revision_id: id,
  revision_no: z.number().int().positive(),
  /** null = external_endpoint 发布（无 Runtime Artifact Attestation，03 §4）。 */
  attestation_id: id.nullable(),
  audit_event_id: id,
  publication_record_id: id,
  conformance_run_id: id,
});

export const RuntimeRevisionWithdrawnPayload = z.object({
  runtime_id: id,
  revision_id: id,
  publication_record_id: id,
  withdrawal_record_id: id,
  current_revision_id: z.string().nullable(),
  audit_event_id: id,
});

export const RuntimeLifecycleChangedPayload = z.object({
  runtime_id: id,
  previous_state: z.string(),
  new_state: z.string(),
});

export const RuntimeConformanceRecordedPayload = z.object({
  run_id: id,
  runtime_revision_id: id,
  overall_result: z.enum(["passed", "failed"]),
});

// ─── Artifact 事件 Payload ───────────────────────────────────

export const ArtifactAttestationRecordedPayload = z.object({
  attestation_id: id,
  artifact_id: id,
  verification_state: z.string(),
});

export const ArtifactAttestationRevokedPayload = z.object({
  attestation_id: id,
  artifact_id: id,
  revoked_at: z.string(), // ISO 8601
  reason: z.string(),
});

// ─── Route 事件 Payload ──────────────────────────────────────

export const RouteActivatedPayload = z.object({
  route_id: id,
  route_revision_id: id,
  tenant_id: id,
});

export const RouteDisabledPayload = z.object({
  route_id: id,
  route_revision_id: id,
  reason: z.string(),
});

export const RouteRevisionValidatedPayload = z.object({
  route_revision_id: id,
  revision_no: z.number().int().positive(),
  content_digest: z.string(),
});

export const RouteSetActivatedPayload = z.object({
  route_set_id: id,
  route_set_version_no: z.number().int().positive(),
  tenant_id: id,
  route_ids: z.array(id),
  activation_ids: z.array(id),
});

// ─── Policy 事件 Payload ─────────────────────────────────────

export const PolicyRevisionPublishedPayload = z.object({
  policy_revision_id: id,
  policy_id: id,
  revision_no: z.number().int().positive(),
});

export const PolicyRevisionWithdrawnPayload = z.object({
  policy_revision_id: id,
  policy_id: id,
  reason: z.string(),
});

// ─── 事件类型 → Payload Schema 映射 ─────────────────────────

/**
 * : 事件类型到 Payload Zod Schema 的映射表。
 *
 * 每个已知事件类型必须在此注册。未知事件类型查找结果为 undefined。
 * 用于 Fail-loud：未知/无效 → 不标记成功。
 */
export const EVENT_PAYLOAD_SCHEMAS: Record<ControlPlaneEventType, z.ZodType> = {
  "agent.revision.published": AgentRevisionPublishedPayload,
  "agent.revision.withdrawn": AgentRevisionWithdrawnPayload,
  "agent.lifecycle.changed": AgentLifecycleChangedPayload,
  "runtime.revision.published": RuntimeRevisionPublishedPayload,
  "runtime.revision.withdrawn": RuntimeRevisionWithdrawnPayload,
  "runtime.lifecycle.changed": RuntimeLifecycleChangedPayload,
  "runtime.conformance.recorded": RuntimeConformanceRecordedPayload,
  "artifact.attestation.recorded": ArtifactAttestationRecordedPayload,
  "artifact.attestation.revoked": ArtifactAttestationRevokedPayload,
  "route.activated": RouteActivatedPayload,
  "route.disabled": RouteDisabledPayload,
  "route.revision.validated": RouteRevisionValidatedPayload,
  "route_set.activated": RouteSetActivatedPayload,
  "policy.revision.published": PolicyRevisionPublishedPayload,
  "policy.revision.withdrawn": PolicyRevisionWithdrawnPayload,
};

// ─── 事件类型 → 聚合根类型 映射 ──────────────────────────────

/**
 * : 事件类型到聚合根类型的权威映射。
 * Producer 不得手写 aggregateType，必须通过此映射查找。
 */
export const EVENT_AGGREGATE_TYPES: Record<ControlPlaneEventType, string> = {
  "agent.revision.published": "agent_revision",
  "agent.revision.withdrawn": "agent_revision",
  "agent.lifecycle.changed": "agent",
  "runtime.revision.published": "runtime_revision",
  "runtime.revision.withdrawn": "runtime_revision",
  "runtime.lifecycle.changed": "runtime",
  "runtime.conformance.recorded": "runtime_conformance_run",
  "artifact.attestation.recorded": "artifact_attestation",
  "artifact.attestation.revoked": "artifact_attestation",
  "route.activated": "deployment_route",
  "route.disabled": "deployment_route",
  "route.revision.validated": "deployment_route",
  "route_set.activated": "route_set",
  "policy.revision.published": "policy_revision",
  "policy.revision.withdrawn": "policy_revision",
};

// ─── Payload 验证 ─────────────────────────────────────────────

/**
 * 验证事件 Payload 是否符合其事件类型的 Schema。
 * 返回 { valid: true } 或 { valid: false, errors }。
 */
export function validateEventPayload(
  eventType: string,
  payload: unknown,
): { valid: true; data: unknown } | { valid: false; errors: string[] } {
  const schema = EVENT_PAYLOAD_SCHEMAS[eventType as ControlPlaneEventType];
  if (!schema) {
    return { valid: false, errors: [`未知事件类型: ${eventType}`] };
  }
  const result = schema.safeParse(payload);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  return {
    valid: false,
    errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}
