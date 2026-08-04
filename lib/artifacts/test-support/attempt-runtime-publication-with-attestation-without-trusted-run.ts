import { randomUUID } from "node:crypto";
import { ArtifactNotVerifiedError } from "@/lib/artifacts/domain/artifact-attestation";
import { getAttestationById } from "@/lib/artifacts/persistence/artifact-attestation-queries";
import type { ArtifactAttestation } from "@/lib/artifacts/persistence/artifact-record";
import type { AuditActor } from "@/lib/identity/audit";
import type { RuntimeRevisionRow } from "@/lib/persistence/schema/control-plane";
import { publishRuntimeRevisionThroughControlPlane } from "@/lib/runtimes/application/publish-runtime-revision-service";
import type { ConformanceCaseResult } from "@/lib/runtimes/domain/runtime-conformance";
import { RuntimePublicationPrerequisiteError } from "@/lib/runtimes/domain/runtime-revision-publication-policy";

export interface PublishRuntimeRevisionWithAttestationResult {
  revision: RuntimeRevisionRow;
  attestation: ArtifactAttestation;
  auditEventId: string;
}

/** 测试有 Attestation 但缺少可信 Conformance Run 时的 fail-closed 行为。 */
export async function publishRuntimeRevisionWithAttestation(
  tenantId: string,
  revisionId: string,
  runtimeExpectedVersionNo: number,
  _conformanceResults: ConformanceCaseResult[],
  attestationId: string,
  actor: AuditActor,
  requestId?: string,
): Promise<PublishRuntimeRevisionWithAttestationResult> {
  try {
    const result = await publishRuntimeRevisionThroughControlPlane({
      tenantId,
      revisionId,
      runtimeExpectedVersionNo,
      attestationId,
      actor,
      requestId: requestId ?? `runtime-publish:${randomUUID()}`,
      idempotencyKey: `runtime-attested-publish:${revisionId}`,
    });
    const attestation = await getAttestationById(tenantId, attestationId);
    if (!attestation) throw new ArtifactNotVerifiedError(attestationId, "attestation 不存在");
    return {
      revision: result.revision as RuntimeRevisionRow,
      attestation,
      auditEventId: result.auditEventId,
    };
  } catch (error) {
    if (error instanceof RuntimePublicationPrerequisiteError) {
      throw new ArtifactNotVerifiedError(error.attestationId, error.message);
    }
    throw error;
  }
}
