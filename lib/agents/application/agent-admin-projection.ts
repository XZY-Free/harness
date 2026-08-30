import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import type { AgentDTO, AgentRevisionDTO } from "@/lib/control-plane-client/contracts/agent";
import type { AgentRow } from "@/lib/persistence/schema/agents";
import {
  getPublicationRecordBySubject,
  getWithdrawalRecordBySubject,
} from "@/lib/publications/persistence/publication-record-queries";

export function projectAgentAdmin(agent: AgentRow): AgentDTO {
  return {
    id: agent.id,
    agent_key: agent.agentKey,
    display_name: agent.displayName,
    description: agent.description,
    lifecycle_state: agent.lifecycleState,
    current_revision_id: agent.currentRevisionId,
    owner_user_id: agent.ownerUserId,
    version_no: agent.versionNo,
    updated_at: agent.updatedAt.toISOString(),
  };
}

export interface AgentRevisionEligibilityInput {
  agentLifecycleState: string;
  revisionState: string;
  /** 绑定的不可变 AgentContractSnapshot id（发布权威，Agent 是源码不可见黑盒）。 */
  agentContractSnapshotId: string;
  hasPublication: boolean;
  hasWithdrawal: boolean;
}

export function computeAgentRevisionEligibility(input: AgentRevisionEligibilityInput): {
  executionEligible: boolean;
  ineligibilityReasons: string[];
} {
  const reasons: string[] = [];
  if (input.agentLifecycleState !== "enabled") reasons.push("agent_not_enabled");
  if (input.revisionState !== "published") reasons.push("revision_not_published");
  if (!input.agentContractSnapshotId) reasons.push("agent_contract_snapshot_missing");
  if (!input.hasPublication) reasons.push("publication_missing");
  if (input.hasWithdrawal) reasons.push("publication_withdrawn");
  return { executionEligible: reasons.length === 0, ineligibilityReasons: reasons };
}

export async function loadAgentRevisionAdminProjection(
  tenantId: string,
  revisionId: string,
): Promise<AgentRevisionDTO | null> {
  const revision = await getRevisionById(revisionId);
  if (!revision) return null;
  const agent = await getAgentById(tenantId, revision.agentId);
  if (!agent) return null;

  const [publication, withdrawal] = await Promise.all([
    getPublicationRecordBySubject({
      tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: revision.id,
    }),
    getWithdrawalRecordBySubject({
      tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: revision.id,
    }),
  ]);
  const eligibility = computeAgentRevisionEligibility({
    agentLifecycleState: agent.lifecycleState,
    revisionState: revision.revisionState,
    agentContractSnapshotId: revision.agentContractSnapshotId,
    hasPublication: publication !== null,
    hasWithdrawal: withdrawal !== null,
  });

  return {
    id: revision.id,
    agent_id: revision.agentId,
    revision_no: revision.revisionNo,
    revision_state: revision.revisionState,
    agent_contract_snapshot_id: revision.agentContractSnapshotId,
    publication_record_id: publication?.id ?? null,
    withdrawal_record_id: withdrawal?.id ?? null,
    execution_eligible: eligibility.executionEligible,
    ineligibility_reasons: eligibility.ineligibilityReasons,
    created_at: revision.createdAt.toISOString(),
    published_at: revision.publishedAt?.toISOString() ?? null,
  };
}
