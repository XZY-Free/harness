/**
 * RouteActivationPanel 测试夹具 — 边界服务器数据。
 *
 * 场景 A（精确匹配）：agent-1「HR 智能体」published arev-1 绑定 snap-1；
 * rt-1「HR 真实 Runtime」published rtrv-1 绑定 snap-1（唯一匹配）；
 * rt-2「HR 相似 Runtime」published rtrv-2 绑定 snap-other（名称相似但 snapshot 不匹配）；
 * 另有 draft Revision（arev-draft / rtrv-draft）不可选。
 */
import type {
  AgentDTO,
  AgentRevisionSummaryDTO,
  RuntimeDTO,
  RuntimeRevisionDTO,
} from "@/lib/control-plane-client";

export const SNAP_MATCHING = "snap-0001";
export const SNAP_MISMATCHED = "snap-9999";

export function agentFixture(overrides?: Partial<AgentDTO>): AgentDTO {
  return {
    id: "agent-1",
    agent_key: "hr-agent",
    display_name: "HR 智能体",
    description: null,
    lifecycle_state: "enabled",
    current_revision_id: "arev-1",
    owner_user_id: "user-1",
    visibility_policy_id: null,
    version_no: 1,
    updated_at: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

export function runtimeFixture(overrides?: Partial<RuntimeDTO>): RuntimeDTO {
  return {
    id: "rt-1",
    tenant_id: "tenant-1",
    runtime_key: "hr-runtime",
    display_name: "HR 真实 Runtime",
    kind: "external",
    lifecycle_state: "enabled",
    owner_user_id: "user-1",
    current_revision_id: "rtrv-1",
    version_no: 1,
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

export function agentRevisionFixture(
  overrides?: Partial<AgentRevisionSummaryDTO>,
): AgentRevisionSummaryDTO {
  return {
    id: "arev-1",
    agent_id: "agent-1",
    revision_no: 3,
    revision_state: "published",
    agent_contract_snapshot_id: SNAP_MATCHING,
    etag: "agent-revision-1",
    ...overrides,
  };
}

export function runtimeRevisionFixture(
  overrides?: Partial<RuntimeRevisionDTO>,
): RuntimeRevisionDTO {
  return {
    id: "rtrv-1",
    runtime_id: "rt-1",
    revision_no: 2,
    revision_state: "published",
    protocol_type: "a2a",
    protocol_contract_revision: "a2a@1",
    runtime_evidence_kind: "external_endpoint",
    runtime_target_digest: `sha256:${"d".repeat(64)}`,
    endpoint_ref: "https://runtime.example.com",
    artifact_id: null,
    artifact_digest: null,
    artifact_ref: null,
    config_hash: `sha256:${"f".repeat(64)}`,
    runtime_capabilities: {},
    agent_contract_snapshot_id: SNAP_MATCHING,
    identity_mode: "bearer",
    credential_ref_id: null,
    network_zone: "public",
    attestation_ids: [],
    publication_record_id: "pub-1",
    withdrawal_record_id: null,
    conformance_run_id: "run-1",
    conformance_overall_result: "passed",
    execution_eligible: true,
    ineligibility_reasons: [],
    created_at: "2026-08-25T00:00:00.000Z",
    published_at: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

export function errorEnvelopeResponse(code: string, message: string, status = 400): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        request_id: "req-test",
        retryable: false,
      },
    },
    { status },
  );
}
