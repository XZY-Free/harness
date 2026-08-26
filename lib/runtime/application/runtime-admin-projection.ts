import { listAttestationsByRevision } from "@/lib/artifacts/persistence/artifact-attestation-reader";
import type {
  RuntimeConformanceRunDTO,
  RuntimeDTO,
  RuntimeRevisionDTO,
} from "@/lib/control-plane-client/contracts/runtime";
import type { RuntimeRow } from "@/lib/persistence/schema/runtimes";
import {
  getPublicationRecordBySubject,
  getWithdrawalRecordBySubject,
} from "@/lib/publications/persistence/publication-record-queries";
import { validateCompletePublicationConformanceResult } from "@/lib/runtime/domain/runtime-conformance-contract";
import type {
  RuntimeConformanceCaseResultRecord,
  RuntimeConformanceRunRecord,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import { getRuntimeById } from "@/lib/runtime/persistence/runtime-queries";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  getRuntimeConformanceRunById,
  listRuntimeConformanceCaseResults,
} from "@/lib/runtime/provisioning/runtime-conformance-runs";

export function projectRuntime(runtime: RuntimeRow): RuntimeDTO {
  return {
    id: runtime.id,
    tenant_id: runtime.tenantId,
    runtime_key: runtime.runtimeKey,
    display_name: runtime.displayName,
    kind: runtime.runtimeKind,
    lifecycle_state: runtime.lifecycleState,
    owner_user_id: runtime.ownerUserId,
    current_revision_id: runtime.currentRevisionId,
    version_no: runtime.versionNo,
    created_at: runtime.createdAt.toISOString(),
    updated_at: runtime.updatedAt.toISOString(),
  };
}

export interface RuntimeRevisionEligibilityInput {
  runtimeLifecycleState: string;
  revisionState: string;
  /** hosted_artifact 才要求 Artifact 证据；external_endpoint 不得伪造（03 §3/§4）。 */
  runtimeEvidenceKind: "hosted_artifact" | "external_endpoint";
  artifactId: string | null;
  artifactDigest: string | null;
  publicationAttestationIds: string[];
  verifiedActiveAttestationIds: string[];
  publicationConformanceRunId: string | null;
  validConformanceRunId: string | null;
  hasPublication: boolean;
  hasWithdrawal: boolean;
}

function isValidIdSet(ids: string[]): boolean {
  return (
    ids.length > 0 && ids.every((id) => id.trim().length > 0) && new Set(ids).size === ids.length
  );
}

export function computeRuntimeRevisionEligibility(input: RuntimeRevisionEligibilityInput): {
  executionEligible: boolean;
  ineligibilityReasons: string[];
} {
  const reasons: string[] = [];
  const hosted = input.runtimeEvidenceKind === "hosted_artifact";
  if (input.runtimeLifecycleState !== "enabled") reasons.push("runtime_not_enabled");
  if (input.revisionState !== "published") reasons.push("revision_not_published");
  if (hosted && (!input.artifactId || !input.artifactDigest)) {
    reasons.push("artifact_binding_missing");
  }
  if (!input.hasPublication) reasons.push("publication_missing");
  if (input.hasWithdrawal) reasons.push("publication_withdrawn");
  const active = new Set(input.verifiedActiveAttestationIds);
  if (
    hosted &&
    (!isValidIdSet(input.publicationAttestationIds) ||
      !input.publicationAttestationIds.every((id) => active.has(id)))
  ) {
    reasons.push("publication_attestation_evidence_mismatch");
  }
  if (
    !input.publicationConformanceRunId ||
    input.publicationConformanceRunId !== input.validConformanceRunId
  ) {
    reasons.push("publication_conformance_evidence_mismatch");
  }
  return { executionEligible: reasons.length === 0, ineligibilityReasons: reasons };
}

export function projectRuntimeConformanceRun(
  run: RuntimeConformanceRunRecord,
  caseResults: RuntimeConformanceCaseResultRecord[],
): RuntimeConformanceRunDTO {
  return {
    id: run.id,
    tenant_id: run.tenantId,
    runtime_revision_id: run.runtimeRevisionId,
    runtime_target_digest: run.runtimeTargetDigest,
    runtime_config_digest: run.runtimeConfigDigest,
    protocol_contract_revision: run.protocolContractRevision,
    overall_result: run.overallResult,
    runner_identity: run.runnerIdentity,
    suite_revision: run.suiteRevision,
    runner_artifact_digest: run.runnerArtifactDigest,
    test_environment_revision: run.testEnvironmentRevision,
    conformance_format: run.conformanceFormat,
    evidence_manifest_digest: run.evidenceManifestDigest,
    envelope_digest: run.envelopeDigest,
    payload_digest: run.payloadDigest,
    signing_key_id: run.signingKeyId,
    verification_engine: run.verificationEngine,
    verification_engine_version: run.verificationEngineVersion,
    predicate_type: run.predicateType,
    verified_at: run.verifiedAt.toISOString(),
    started_at: run.startedAt.toISOString(),
    completed_at: run.completedAt.toISOString(),
    recorded_at: run.recordedAt.toISOString(),
    case_results: caseResults.map((result) => ({
      case_id: result.caseId,
      passed: result.passed,
      reason: result.reason,
      evidence_digest: result.evidenceDigest,
    })),
  };
}

export async function loadRuntimeRevisionAdminProjection(
  tenantId: string,
  revisionId: string,
): Promise<RuntimeRevisionDTO | null> {
  const revision = await getRuntimeRevisionById(revisionId);
  if (!revision) return null;
  const runtime = await getRuntimeById(tenantId, revision.runtimeId);
  if (!runtime) return null;
  const [publication, withdrawal, attestations] = await Promise.all([
    getPublicationRecordBySubject({
      tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: revisionId,
    }),
    getWithdrawalRecordBySubject({
      tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: revisionId,
    }),
    listAttestationsByRevision(tenantId, "runtime_revision", revisionId),
  ]);
  const verifiedActiveAttestationIds = attestations
    .filter(
      ({ attestation, revocation }) =>
        attestation.verificationState === "verified" && revocation === null,
    )
    .map(({ attestation }) => attestation.id)
    .sort();
  const publicationAttestationIds = [...(publication?.attestationIds ?? [])].sort();
  const run = publication?.conformanceRunId
    ? await getRuntimeConformanceRunById(tenantId, publication.conformanceRunId)
    : null;
  const caseResults = run ? await listRuntimeConformanceCaseResults(run.id) : [];
  const conformanceValid = Boolean(
    run &&
      run.runtimeRevisionId === revision.id &&
      run.overallResult === "passed" &&
      run.runtimeTargetDigest === revision.runtimeTargetDigest &&
      run.runtimeConfigDigest === revision.configHash &&
      run.protocolContractRevision === revision.protocolContractRevision &&
      validateCompletePublicationConformanceResult(
        caseResults as Parameters<typeof validateCompletePublicationConformanceResult>[0],
      ).valid,
  );
  const eligibility = computeRuntimeRevisionEligibility({
    runtimeLifecycleState: runtime.lifecycleState,
    revisionState: revision.revisionState,
    runtimeEvidenceKind: revision.runtimeEvidenceKind,
    artifactId: revision.artifactId,
    artifactDigest: revision.artifactDigest,
    publicationAttestationIds,
    verifiedActiveAttestationIds,
    publicationConformanceRunId: publication?.conformanceRunId ?? null,
    validConformanceRunId: conformanceValid ? (run?.id ?? null) : null,
    hasPublication: publication !== null,
    hasWithdrawal: withdrawal !== null,
  });
  return {
    id: revision.id,
    runtime_id: revision.runtimeId,
    revision_no: revision.revisionNo,
    revision_state: revision.revisionState,
    protocol_type: revision.protocolType,
    protocol_contract_revision: revision.protocolContractRevision,
    runtime_evidence_kind: revision.runtimeEvidenceKind,
    runtime_target_digest: revision.runtimeTargetDigest,
    endpoint_ref: revision.endpointRef,
    artifact_id: revision.artifactId,
    artifact_digest: revision.artifactDigest,
    artifact_ref: revision.runtimeArtifactRef,
    config_hash: revision.configHash,
    runtime_capabilities: revision.runtimeCapabilitiesJson,
    agent_contract_snapshot_id: revision.agentContractSnapshotId,
    identity_mode: revision.identityMode,
    credential_ref_id: revision.credentialRefId,
    network_zone: revision.networkZone,
    attestation_ids: verifiedActiveAttestationIds,
    publication_record_id: publication?.id ?? null,
    withdrawal_record_id: withdrawal?.id ?? null,
    conformance_run_id: publication?.conformanceRunId ?? null,
    conformance_overall_result: run?.overallResult ?? null,
    execution_eligible: eligibility.executionEligible,
    ineligibility_reasons: eligibility.ineligibilityReasons,
    created_at: revision.createdAt.toISOString(),
    published_at: revision.publishedAt?.toISOString() ?? null,
  };
}
