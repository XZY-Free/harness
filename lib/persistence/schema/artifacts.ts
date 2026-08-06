/**
 * 稳定 Artifacts Schema — 正式控制面职责命名。
 *
 * Artifact 和 Attestation 表定义已在 lib/artifacts/persistence/ 中稳定建立。
 * 此文件提供统一 re-export 入口。
 */

export {
 artifact,
 artifactAttestation,
 attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";

export type {
 Artifact,
 NewArtifact,
 ArtifactAttestation,
 NewArtifactAttestation,
 AttestationRevocationRecord,
 NewAttestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
