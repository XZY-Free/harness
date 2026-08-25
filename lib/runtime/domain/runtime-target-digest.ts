/**
 * Runtime Target Digest — Conformance 被测对象的统一绑定（docs/V12/01/agent补充/03 §6）。
 *
 * Conformance 需要统一绑定"被测对象"，但不能强迫都是 Artifact：
 * - hosted_artifact：canonical(runtimeArtifactDigest, runtimeConfigDigest, protocolContractRevision)；
 * - external_endpoint：canonical(endpointRef 稳定非 Secret identity, runtimeConfigDigest,
 *   protocolType, protocolContractRevision, identityMode, networkZone)。
 *
 * Conformance 报告绑定 runtimeTargetDigest，而不是无条件绑定 runtimeArtifactDigest。
 */
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";

/** hosted_artifact 证据事实（全部必填，缺失 fail-closed）。 */
export interface HostedRuntimeTargetFacts {
  runtimeEvidenceKind: "hosted_artifact";
  runtimeArtifactDigest: string;
  runtimeConfigDigest: string;
  protocolContractRevision: string;
}

/** external_endpoint 证据事实（全部必填，缺失 fail-closed）。 */
export interface ExternalRuntimeTargetFacts {
  runtimeEvidenceKind: "external_endpoint";
  endpointRef: string;
  runtimeConfigDigest: string;
  protocolType: string;
  protocolContractRevision: string;
  identityMode: string;
  networkZone: string;
}

export type RuntimeTargetFacts = HostedRuntimeTargetFacts | ExternalRuntimeTargetFacts;

/**
 * 从 RuntimeRevision 行事实构造 target facts。
 *
 * hosted_artifact 缺 artifact digest、external_endpoint 缺 endpoint 等半完整证据返回 null
 * （fail-closed，禁止猜测）。
 */
export function runtimeTargetFactsFromRevision(revision: {
  runtimeEvidenceKind: string;
  artifactDigest: string | null;
  configHash: string;
  protocolContractRevision: string;
  endpointRef: string;
  protocolType: string;
  identityMode: string;
  networkZone: string;
}): RuntimeTargetFacts | null {
  if (revision.runtimeEvidenceKind === "hosted_artifact") {
    if (!revision.artifactDigest) return null;
    return {
      runtimeEvidenceKind: "hosted_artifact",
      runtimeArtifactDigest: revision.artifactDigest,
      runtimeConfigDigest: revision.configHash,
      protocolContractRevision: revision.protocolContractRevision,
    };
  }
  if (revision.runtimeEvidenceKind === "external_endpoint") {
    if (!revision.endpointRef) return null;
    return {
      runtimeEvidenceKind: "external_endpoint",
      endpointRef: revision.endpointRef,
      runtimeConfigDigest: revision.configHash,
      protocolType: revision.protocolType,
      protocolContractRevision: revision.protocolContractRevision,
      identityMode: revision.identityMode,
      networkZone: revision.networkZone,
    };
  }
  return null;
}

/** 计算 runtimeTargetDigest（RFC8785 canonical）。 */
export function computeRuntimeTargetDigest(facts: RuntimeTargetFacts): string {
  if (facts.runtimeEvidenceKind === "hosted_artifact") {
    return computeCanonicalDigest({
      runtime_evidence_kind: "hosted_artifact",
      runtime_artifact_digest: facts.runtimeArtifactDigest,
      runtime_config_digest: facts.runtimeConfigDigest,
      protocol_contract_revision: facts.protocolContractRevision,
    });
  }
  return computeCanonicalDigest({
    runtime_evidence_kind: "external_endpoint",
    endpoint_ref: facts.endpointRef,
    runtime_config_digest: facts.runtimeConfigDigest,
    protocol_type: facts.protocolType,
    protocol_contract_revision: facts.protocolContractRevision,
    identity_mode: facts.identityMode,
    network_zone: facts.networkZone,
  });
}

/** 从 Revision 行事实计算 runtimeTargetDigest；证据半完整返回 null。 */
export function computeRuntimeTargetDigestFromRevision(
  revision: Parameters<typeof runtimeTargetFactsFromRevision>[0],
): string | null {
  const facts = runtimeTargetFactsFromRevision(revision);
  return facts ? computeRuntimeTargetDigest(facts) : null;
}
