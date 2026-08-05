/**
 * 旧导入路径兼容层。正式 Artifact 与 ArtifactAttestation schema 位于 lib/artifacts。
 */
export {
  ARTIFACT_KINDS as ARTIFACT_TYPES,
  VERIFICATION_STATES,
} from "@/lib/artifacts/domain/artifact";
export type {
  ArtifactKind as ArtifactType,
  VerificationState,
} from "@/lib/artifacts/domain/artifact";
export {
  artifactAttestation as artifactAttestationTable,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
export type {
  ArtifactAttestation,
  NewArtifactAttestation,
} from "@/lib/artifacts/persistence/artifact-record";
export {
  ATTESTATION_FAILURE_CODES,
  type AttestationFailureCode,
} from "@/lib/artifacts/domain/artifact-attestation";
