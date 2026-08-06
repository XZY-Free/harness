import { createHash, randomUUID } from "node:crypto";
import { extractArtifactDigest, isSha256Digest } from "../domain/artifact";
import type {
  Artifact,
  ArtifactAttestation,
  AttestationRevocationActorType,
  NewArtifactAttestation,
} from "../persistence/artifact-record";

export interface RevisionArtifactBinding {
  revisionState: string;
  artifactRef: string;
  artifactId: string | null;
  artifactDigest: string | null;
}

export interface ArtifactAttestationPersistenceSession {
  findArtifact(tenantId: string, digest: string): Promise<Artifact | null>;
  insertArtifact(params: {
    id: string;
    tenantId: string;
    kind: string;
    digest: string;
    sourceRevision: string | null;
    buildMetadata: Record<string, unknown> | null;
    createdAt: Date;
  }): Promise<Artifact>;
  appendAttestation(params: NewArtifactAttestation): Promise<ArtifactAttestation>;
  findRevisionArtifactBinding(params: {
    tenantId: string;
    artifactType: string;
    revisionId: string;
  }): Promise<RevisionArtifactBinding | null>;
  bindRevisionArtifact(params: {
    artifactType: string;
    revisionId: string;
    artifactId: string;
    artifactDigest: string;
  }): Promise<boolean>;
  appendAudit(params: {
    id: string;
    tenantId: string;
    actorType: AttestationRevocationActorType;
    actorId: string;
    attestationId: string;
    afterHash: string;
    reason: string;
    requestId: string;
    occurredAt: Date;
  }): Promise<void>;
  appendOutbox(params: {
    id: string;
    tenantId: string;
    eventKey: string;
    /** §3.2: 事件类型固定为 artifact.attestation.recorded。 */
    eventType: "artifact.attestation.recorded";
    aggregateId: string;
    /** §3.1: 聚合版本号。 */
    aggregateVersion: number;
    payload: Record<string, unknown>;
    occurredAt: Date;
  }): Promise<void>;
  completeIdempotency?(params: {
    recordId: string;
    httpStatus: number;
    responseRef: string | null;
    responseRedactedJson: string;
    completedAt: Date;
  }): Promise<boolean>;
}

export interface ArtifactAttestationPersistenceStore {
  transaction<T>(
    operation: (session: ArtifactAttestationPersistenceSession) => Promise<T>,
  ): Promise<T>;
}

export interface RecordArtifactAttestationCommand {
  tenantId: string;
  artifactType: string;
  artifactRevisionId: string;
  artifactDigest: string;
  dsseEnvelopeRef: string;
  sbomRef: string;
  provenanceRef: string;
  builderIdentity: string;
  verificationState: "verified" | "failed";
  policyRevisionId: string | null;
  failureCode: string | null;
  verifiedAt: Date;
  sourceRevision: string | null;
  buildPipeline: string | null;
  dependencyLockFileHash: string | null;
  buildTime: Date | null;
  scanSummaryJson: Record<string, unknown> | null;
  actor: {
    tenantId: string;
    actorType: AttestationRevocationActorType;
    actorId: string;
  };
  requestId: string;
  idempotency?: {
    recordId: string;
    httpStatus: number;
    responseRef?: string | null;
    serializeResponse: (attestation: ArtifactAttestation) => string;
  };
}

export class ArtifactAttestationIdempotencyCompletionError extends Error {
  constructor(public readonly recordId: string) {
    super(`ArtifactAttestation 幂等记录完成失败: ${recordId}`);
    this.name = "ArtifactAttestationIdempotencyCompletionError";
  }
}

export function createRecordArtifactAttestation(dependencies: {
  store: ArtifactAttestationPersistenceStore;
  newId?: () => string;
}) {
  const newId = dependencies.newId ?? randomUUID;

  return async function recordArtifactAttestation(
    command: RecordArtifactAttestationCommand,
  ): Promise<ArtifactAttestation> {
    if (command.actor.tenantId !== command.tenantId) {
      throw new Error("ArtifactAttestation actor tenant 与命令 tenant 不一致");
    }
    if (command.verificationState === "verified" && !isSha256Digest(command.artifactDigest)) {
      throw new Error("verified ArtifactAttestation 必须引用有效 sha256 digest");
    }

    return dependencies.store.transaction(async (session) => {
      let authority: Artifact | null = null;
      if (isSha256Digest(command.artifactDigest)) {
        authority = await session.findArtifact(command.tenantId, command.artifactDigest);
        if (!authority) {
          authority = await session.insertArtifact({
            id: newId(),
            tenantId: command.tenantId,
            kind: command.artifactType,
            digest: command.artifactDigest,
            sourceRevision: command.sourceRevision,
            buildMetadata: {
              buildPipeline: command.buildPipeline,
              dependencyLockFileHash: command.dependencyLockFileHash,
              buildTime: command.buildTime?.toISOString() ?? null,
            },
            createdAt: command.verifiedAt,
          });
        }
      }

      const attestation = await session.appendAttestation({
        id: newId(),
        tenantId: command.tenantId,
        artifactId: authority?.id ?? null,
        artifactType: command.artifactType,
        artifactRevisionId: command.artifactRevisionId,
        artifactDigest: command.artifactDigest,
        dsseEnvelopeRef: command.dsseEnvelopeRef,
        sbomRef: command.sbomRef,
        provenanceRef: command.provenanceRef,
        builderIdentity: command.builderIdentity,
        verificationState: command.verificationState,
        policyRevisionId: command.policyRevisionId,
        failureCode: command.failureCode,
        verifiedAt: command.verifiedAt,
        sourceRevision: command.sourceRevision,
        buildPipeline: command.buildPipeline,
        dependencyLockFileHash: command.dependencyLockFileHash,
        buildTime: command.buildTime,
        scanSummaryJson: command.scanSummaryJson,
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
        createdAt: command.verifiedAt,
      });

      if (authority && command.verificationState === "verified") {
        const binding = await session.findRevisionArtifactBinding({
          tenantId: command.tenantId,
          artifactType: command.artifactType,
          revisionId: command.artifactRevisionId,
        });
        if (shouldBindRevision(binding, authority)) {
          await session.bindRevisionArtifact({
            artifactType: command.artifactType,
            revisionId: command.artifactRevisionId,
            artifactId: authority.id,
            artifactDigest: authority.digest,
          });
        }
      }

      await session.appendAudit({
        id: newId(),
        tenantId: command.tenantId,
        actorType: command.actor.actorType,
        actorId: command.actor.actorId,
        attestationId: attestation.id,
        afterHash: hashFact({
          attestationId: attestation.id,
          artifactId: authority?.id ?? null,
          artifactType: command.artifactType,
          artifactRevisionId: command.artifactRevisionId,
          artifactDigest: command.artifactDigest,
          builderIdentity: command.builderIdentity,
          verificationState: command.verificationState,
          failureCode: command.failureCode,
        }),
        reason: command.verificationState === "verified" ? "制品证明验证通过" : "制品证明验证失败",
        requestId: command.requestId,
        occurredAt: command.verifiedAt,
      });
      await session.appendOutbox({
        id: newId(),
        tenantId: command.tenantId,
        eventKey: `artifact-attestation-recorded:${attestation.id}`,
        eventType: "artifact.attestation.recorded",
        aggregateId: attestation.id,
        aggregateVersion: 0,
        payload: {
          attestation_id: attestation.id,
          artifact_id: authority?.id ?? "",
          verification_state: command.verificationState,
        },
        occurredAt: command.verifiedAt,
      });

      if (command.idempotency && session.completeIdempotency) {
        const completed = await session.completeIdempotency({
          recordId: command.idempotency.recordId,
          httpStatus: command.idempotency.httpStatus,
          responseRef: command.idempotency.responseRef ?? attestation.id,
          responseRedactedJson: command.idempotency.serializeResponse(attestation),
          completedAt: command.verifiedAt,
        });
        if (!completed) {
          throw new ArtifactAttestationIdempotencyCompletionError(command.idempotency.recordId);
        }
      }

      return attestation;
    });
  };
}

function shouldBindRevision(binding: RevisionArtifactBinding | null, authority: Artifact): boolean {
  if (!binding || binding.revisionState !== "draft") return false;
  if (binding.artifactId || binding.artifactDigest) {
    return binding.artifactId === authority.id && binding.artifactDigest === authority.digest;
  }
  const declaredDigest = extractArtifactDigest(binding.artifactRef);
  return declaredDigest === null || declaredDigest === authority.digest;
}

function hashFact(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortKeys(value)), "utf8")
    .digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortKeys(nested)]),
    );
  }
  return value;
}
