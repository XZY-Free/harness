import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import { listAttestationsByRevision } from "@/lib/artifacts/persistence/artifact-attestation-reader";
import type {
  AgentDTO,
  AgentRevisionDTO,
  AgentRevisionSourceType,
} from "@/lib/control-plane-client/contracts/agent";
import type { AgentRow } from "@/lib/persistence/schema/agents";
import {
  getPublicationRecordBySubject,
  getWithdrawalRecordBySubject,
} from "@/lib/publications/persistence/publication-record-queries";

const SOURCE_TYPES = new Set<AgentRevisionSourceType>(["code", "agent_yaml", "veadk"]);

export function projectAgentAdmin(agent: AgentRow): AgentDTO {
  return {
    id: agent.id,
    agent_key: agent.agentKey,
    display_name: agent.displayName,
    description: agent.description,
    lifecycle_state: agent.lifecycleState,
    current_revision_id: agent.currentRevisionId,
    owner_user_id: agent.ownerUserId,
    visibility_policy_id: agent.visibilityPolicyId,
    version_no: agent.versionNo,
    updated_at: agent.updatedAt.toISOString(),
  };
}

export interface AgentRevisionEligibilityInput {
  agentLifecycleState: string;
  revisionState: string;
  artifactId: string | null;
  artifactDigest: string | null;
  publicationAttestationIds: string[];
  verifiedActiveAttestationIds: string[];
  hasPublication: boolean;
  hasWithdrawal: boolean;
}

function isValidIdSet(ids: string[]): boolean {
  return (
    ids.length > 0 && ids.every((id) => id.trim().length > 0) && new Set(ids).size === ids.length
  );
}

function publicationEvidenceIsActive(publicationIds: string[], activeIds: string[]): boolean {
  if (!isValidIdSet(publicationIds)) return false;
  const active = new Set(activeIds.filter((id) => id.trim().length > 0));
  return publicationIds.every((id) => active.has(id));
}

export function computeAgentRevisionEligibility(input: AgentRevisionEligibilityInput): {
  executionEligible: boolean;
  ineligibilityReasons: string[];
} {
  const reasons: string[] = [];
  if (input.agentLifecycleState !== "enabled") reasons.push("agent_not_enabled");
  if (input.revisionState !== "published") reasons.push("revision_not_published");
  if (!input.artifactId || !input.artifactDigest) reasons.push("artifact_binding_missing");
  if (!input.hasPublication) reasons.push("publication_missing");
  if (input.hasWithdrawal) reasons.push("publication_withdrawn");
  if (
    !publicationEvidenceIsActive(
      input.publicationAttestationIds,
      input.verifiedActiveAttestationIds,
    )
  ) {
    reasons.push("publication_attestation_evidence_mismatch");
  }
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

  const [publication, withdrawal, attestations] = await Promise.all([
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
    listAttestationsByRevision(tenantId, "agent_revision", revision.id),
  ]);
  const verifiedActiveAttestationIds = attestations
    .filter(
      ({ attestation, revocation }) =>
        attestation.verificationState === "verified" && revocation === null,
    )
    .map(({ attestation }) => attestation.id)
    .sort();
  const publicationAttestationIds = [...(publication?.attestationIds ?? [])].sort();
  const eligibility = computeAgentRevisionEligibility({
    agentLifecycleState: agent.lifecycleState,
    revisionState: revision.revisionState,
    artifactId: revision.artifactId,
    artifactDigest: revision.artifactDigest,
    publicationAttestationIds,
    verifiedActiveAttestationIds,
    hasPublication: publication !== null,
    hasWithdrawal: withdrawal !== null,
  });
  if (!SOURCE_TYPES.has(revision.sourceType as AgentRevisionSourceType)) {
    throw new Error(`AgentRevision ${revision.id} sourceType 非法: ${revision.sourceType}`);
  }

  return {
    id: revision.id,
    agent_id: revision.agentId,
    revision_no: revision.revisionNo,
    revision_state: revision.revisionState,
    source_type: revision.sourceType as AgentRevisionSourceType,
    source_revision: revision.sourceRevision,
    artifact_id: revision.artifactId,
    artifact_digest: revision.artifactDigest,
    artifact_ref: revision.agentArtifactRef,
    agent_contract_snapshot_id: revision.agentContractSnapshotId ?? null,
    attestation_ids: verifiedActiveAttestationIds,
    publication_record_id: publication?.id ?? null,
    withdrawal_record_id: withdrawal?.id ?? null,
    execution_eligible: eligibility.executionEligible,
    ineligibility_reasons: eligibility.ineligibilityReasons,
    created_at: revision.createdAt.toISOString(),
    published_at: revision.publishedAt?.toISOString() ?? null,
  };
}
