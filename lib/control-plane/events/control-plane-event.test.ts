/**
 * §3.1: 冻结事件 Envelope + §3.2 事件合同 单元测试。
 */

import { describe, expect, it } from "vitest";
import {
  type ControlPlaneEvent,
  type ControlPlaneEventType,
  EVENT_SCHEMA_VERSION,
  deserializeEventEnvelope,
  serializeEventEnvelope,
} from "./control-plane-event";
import {
  EVENT_AGGREGATE_TYPES,
  EVENT_PAYLOAD_SCHEMAS,
  validateEventPayload,
} from "./event-contracts";

// ─── §3.1 Envelope ────────────────────────────────────────────

describe("ControlPlaneEvent Envelope", () => {
  it("Schema 版本为 1.0", () => {
    expect(EVENT_SCHEMA_VERSION).toBe("1.0");
  });

  it("serialize → deserialize 往返一致", () => {
    const event: ControlPlaneEvent = {
      eventId: "00000000-0000-0000-0000-000000000001",
      schemaVersion: "1.0",
      eventType: "agent.revision.published",
      tenantId: "00000000-0000-0000-0000-000000000099",
      aggregateType: "agent_revision",
      aggregateId: "00000000-0000-0000-0000-000000000002",
      aggregateVersion: 3,
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      payload: { agent_id: "a", revision_id: "r" },
    };
    const serialized = serializeEventEnvelope(event);
    expect(serialized.event_id).toBe(event.eventId);
    expect(serialized.schema_version).toBe("1.0");
    expect(serialized.event_type).toBe("agent.revision.published");
    expect(serialized.tenant_id).toBe(event.tenantId);
    expect(serialized.occurred_at).toBe("2026-01-01T00:00:00.000Z");

    const roundtrip = deserializeEventEnvelope(serialized);
    expect(roundtrip.eventId).toBe(event.eventId);
    expect(roundtrip.occurredAt.getTime()).toBe(event.occurredAt.getTime());
  });

  it("所有已知事件类型在 PAYLOAD_SCHEMAS 中注册", () => {
    const knownTypes: ControlPlaneEventType[] = [
      "agent.revision.published",
      "agent.revision.withdrawn",
      "agent.lifecycle.changed",
      "runtime.revision.published",
      "runtime.revision.withdrawn",
      "runtime.lifecycle.changed",
      "runtime.conformance.recorded",
      "artifact.attestation.recorded",
      "artifact.attestation.revoked",
      "route.activated",
      "route.disabled",
      "route.revision.validated",
      "route_set.activated",
      "policy.revision.published",
      "policy.revision.withdrawn",
    ];
    for (const t of knownTypes) {
      expect(EVENT_PAYLOAD_SCHEMAS[t]).toBeDefined();
    }
    expect(Object.keys(EVENT_PAYLOAD_SCHEMAS)).toHaveLength(knownTypes.length);
  });

  it("所有已知事件类型在 AGGREGATE_TYPES 中注册", () => {
    const knownTypes: ControlPlaneEventType[] = [
      "agent.revision.published",
      "agent.revision.withdrawn",
      "agent.lifecycle.changed",
      "runtime.revision.published",
      "runtime.revision.withdrawn",
      "runtime.lifecycle.changed",
      "runtime.conformance.recorded",
      "artifact.attestation.recorded",
      "artifact.attestation.revoked",
      "route.activated",
      "route.disabled",
      "route.revision.validated",
      "route_set.activated",
      "policy.revision.published",
      "policy.revision.withdrawn",
    ];
    for (const t of knownTypes) {
      expect(EVENT_AGGREGATE_TYPES[t]).toBeDefined();
    }
    expect(Object.keys(EVENT_AGGREGATE_TYPES)).toHaveLength(knownTypes.length);
  });
});

// ─── §3.2 Payload 验证 ────────────────────────────────────────

describe("validateEventPayload", () => {
  it("已知类型 + 合法 Payload → valid", () => {
    const result = validateEventPayload("runtime.conformance.recorded", {
      run_id: "00000000-0000-0000-0000-000000000001",
      runtime_revision_id: "00000000-0000-0000-0000-000000000002",
      overall_result: "passed",
    });
    expect(result.valid).toBe(true);
  });

  it("已知类型 + 非法 Payload → invalid", () => {
    const result = validateEventPayload("runtime.conformance.recorded", {
      run_id: "not-a-uuid",
      // 缺少 runtime_revision_id
      overall_result: "maybe",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("未知事件类型 → invalid", () => {
    const result = validateEventPayload("unknown.event.type", {});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain("未知事件类型");
    }
  });

  it("agent.revision.published 合法 Payload", () => {
    const result = validateEventPayload("agent.revision.published", {
      agent_id: "00000000-0000-0000-0000-000000000001",
      revision_id: "00000000-0000-0000-0000-000000000002",
      revision_no: 1,
      publication_record_id: "00000000-0000-0000-0000-000000000003",
      audit_event_id: "00000000-0000-0000-0000-000000000004",
    });
    expect(result.valid).toBe(true);
  });

  it("route_set.activated 合法 Payload", () => {
    const result = validateEventPayload("route_set.activated", {
      route_set_id: "00000000-0000-0000-0000-000000000001",
      route_set_version_no: 2,
      tenant_id: "00000000-0000-0000-0000-000000000008",
      route_ids: ["00000000-0000-0000-0000-000000000009"],
      activation_ids: ["00000000-0000-0000-0000-000000000010"],
    });
    expect(result).toEqual({
      valid: true,
      data: {
        route_set_id: "00000000-0000-0000-0000-000000000001",
        route_set_version_no: 2,
        tenant_id: "00000000-0000-0000-0000-000000000008",
        route_ids: ["00000000-0000-0000-0000-000000000009"],
        activation_ids: ["00000000-0000-0000-0000-000000000010"],
      },
    });
  });
});
