import type {
  PublicationRecordDTO,
  WithdrawalRecordDTO,
} from "@/lib/control-plane-client/contracts/publication";
import type {
  PublicationRecord,
  WithdrawalRecord,
} from "@/lib/publications/persistence/publication-record";

export function projectPublicationRecord(record: PublicationRecord): PublicationRecordDTO {
  return {
    id: record.id,
    tenant_id: record.tenantId,
    subject_type: record.subjectType,
    subject_revision_id: record.subjectRevisionId,
    publication_sequence: record.publicationSequence,
    evidence_set_digest: record.evidenceSetDigest,
    attestation_ids: [...record.attestationIds],
    conformance_run_id: record.conformanceRunId,
    approvals: [...record.approvals],
    actor_type: record.publishedByType,
    actor_id: record.publishedBy,
    published_at: record.publishedAt.toISOString(),
  };
}

export function projectWithdrawalRecord(record: WithdrawalRecord): WithdrawalRecordDTO {
  return {
    id: record.id,
    tenant_id: record.tenantId,
    subject_type: record.subjectType,
    subject_revision_id: record.subjectRevisionId,
    publication_record_id: record.publicationRecordId,
    actor_type: record.withdrawnByType,
    actor_id: record.withdrawnBy,
    reason_code: record.reasonCode,
    reason: record.reason,
    withdrawn_at: record.withdrawnAt.toISOString(),
  };
}
