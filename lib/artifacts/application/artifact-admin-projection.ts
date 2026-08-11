import { ARTIFACT_KINDS, type ArtifactKind } from "@/lib/artifacts/domain/artifact";
import type { ArtifactAttestation } from "@/lib/artifacts/persistence/artifact-record";
import type { ArtifactAttestationDTO } from "@/lib/control-plane-client/contracts/artifact";

function assertArtifactKind(value: string): ArtifactKind {
  if (!(ARTIFACT_KINDS as readonly string[]).includes(value)) {
    throw new Error(`ArtifactAttestation artifactType 非法: ${value}`);
  }
  return value as ArtifactKind;
}

export function projectArtifactAttestation(
  attestation: ArtifactAttestation,
): ArtifactAttestationDTO {
  return {
    id: attestation.id,
    tenant_id: attestation.tenantId,
    artifact_id: attestation.artifactId,
    artifact_type: assertArtifactKind(attestation.artifactType),
    artifact_revision_id: attestation.artifactRevisionId,
    artifact_digest: attestation.artifactDigest,
    dsse_envelope_ref: attestation.dsseEnvelopeRef,
    sbom_ref: attestation.sbomRef,
    provenance_ref: attestation.provenanceRef,
    builder_identity: attestation.builderIdentity,
    verification_state: attestation.verificationState,
    policy_revision_id: attestation.policyRevisionId,
    source_revision: attestation.sourceRevision,
    build_pipeline: attestation.buildPipeline,
    dependency_lock_file_hash: attestation.dependencyLockFileHash,
    build_time: attestation.buildTime?.toISOString() ?? null,
    scan_summary: attestation.scanSummaryJson,
    failure_code: attestation.failureCode,
    verified_at: attestation.verifiedAt?.toISOString() ?? null,
    attestation_format: attestation.attestationFormat,
    statement_type: attestation.statementType,
    predicate_type: attestation.predicateType,
    bundle_digest: attestation.bundleDigest,
    subject_name: attestation.subjectName,
    subject_digest: attestation.subjectDigest,
    verification_engine: attestation.verificationEngine,
    verification_engine_version: attestation.verificationEngineVersion,
    revoked_at: attestation.revokedAt?.toISOString() ?? null,
    revoked_by: attestation.revokedBy,
    revocation_reason: attestation.revocationReason,
    created_at: attestation.createdAt.toISOString(),
  };
}
