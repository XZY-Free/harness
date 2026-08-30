/**
 * RouteActivationPanel 测试夹具 — 边界服务器数据。
 *
 * 场景：agent-1「HR 智能体」published arev-1（仅冻结合同，不承载端点权威）；
 * 另有 draft Revision（arev-draft）不可选。
 * CredentialRef 摘要只含 provider/fingerprint/lifecycle_state/expires_at 等
 * 非机密字段，绝不含 vaultRef/secret 值。
 */
import type {
  AgentDTO,
  AgentRevisionSummaryDTO,
  CredentialRefSummaryDTO,
} from "@/lib/control-plane-client";

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

export function agentRevisionFixture(
  overrides?: Partial<AgentRevisionSummaryDTO>,
): AgentRevisionSummaryDTO {
  return {
    id: "arev-1",
    agent_id: "agent-1",
    revision_no: 3,
    revision_state: "published",
    agent_contract_snapshot_id: "snap-0001",
    etag: "agent-revision-1",
    ...overrides,
  };
}

export function credentialFixture(
  overrides?: Partial<CredentialRefSummaryDTO>,
): CredentialRefSummaryDTO {
  return {
    id: "cred-1",
    provider: "a2a-bearer",
    fingerprint: "sha256:abcd1234",
    lifecycle_state: "active",
    expires_at: "2027-08-30T00:00:00.000Z",
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
