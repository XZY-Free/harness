import { createHash, randomUUID } from "node:crypto";
import type {
  ArtifactAttestation,
  AttestationRevocationActorType,
  AttestationRevocationRecord,
} from "../persistence/artifact-record";

export interface RevocableAttestation {
  attestation: ArtifactAttestation;
  revocation: AttestationRevocationRecord | null;
}

export interface AttestationRevocationSession {
  findForUpdate(tenantId: string, attestationId: string): Promise<RevocableAttestation | null>;
  appendRevocation(params: {
    id: string;
    tenantId: string;
    attestationId: string;
    revokedByType: AttestationRevocationActorType;
    revokedBy: string;
    reason: string;
    requestId: string;
    revokedAt: Date;
  }): Promise<AttestationRevocationRecord>;
  appendAudit(params: {
    id: string;
    tenantId: string;
    actorType: AttestationRevocationActorType;
    actorId: string;
    attestationId: string;
    beforeHash: string;
    afterHash: string;
    reason: string;
    requestId: string;
    occurredAt: Date;
  }): Promise<void>;
  appendOutbox(params: {
    id: string;
    tenantId: string;
    eventKey: string;
    /** §3.2: 事件类型固定为 artifact.attestation.revoked。 */
    eventType: "artifact.attestation.revoked";
    aggregateId: string;
    /** §3.1: 聚合版本号。 */
    aggregateVersion: number;
    payload: Record<string, unknown>;
    occurredAt: Date;
  }): Promise<void>;
}

export interface AttestationRevocationStore {
  transaction<T>(operation: (session: AttestationRevocationSession) => Promise<T>): Promise<T>;
}

export class AttestationNotFoundError extends Error {
  constructor(public readonly attestationId: string) {
    super(`attestation 不存在或跨租户: ${attestationId}`);
    this.name = "AttestationNotFoundError";
  }
}

export class AttestationAlreadyRevokedError extends Error {
  constructor(
    public readonly attestationId: string,
    public readonly revokedAt: Date,
  ) {
    super(`attestation 已撤销（revokedAt=${revokedAt.toISOString()}）`);
    this.name = "AttestationAlreadyRevokedError";
  }
}

export function createRevokeArtifactAttestation(dependencies: {
  store: AttestationRevocationStore;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;

  return async function revokeArtifactAttestation(command: {
    tenantId: string;
    attestationId: string;
    actor: {
      tenantId: string;
      actorType: AttestationRevocationActorType;
      actorId: string;
    };
    reason: string;
    requestId: string;
  }): Promise<RevocableAttestation> {
    if (command.actor.tenantId !== command.tenantId) {
      throw new Error("Attestation 撤销 actor tenant 与命令 tenant 不一致");
    }

    return dependencies.store.transaction(async (session) => {
      const current = await session.findForUpdate(command.tenantId, command.attestationId);
      if (!current) throw new AttestationNotFoundError(command.attestationId);
      const legacyRevokedAt = current.attestation.revokedAt;
      if (current.revocation || legacyRevokedAt) {
        throw new AttestationAlreadyRevokedError(
          command.attestationId,
          current.revocation?.revokedAt ?? legacyRevokedAt ?? now(),
        );
      }

      const revokedAt = now();
      const revocation = await session.appendRevocation({
        id: newId(),
        tenantId: command.tenantId,
        attestationId: command.attestationId,
        revokedByType: command.actor.actorType,
        revokedBy: command.actor.actorId,
        reason: command.reason,
        requestId: command.requestId,
        revokedAt,
      });
      await session.appendAudit({
        id: newId(),
        tenantId: command.tenantId,
        actorType: command.actor.actorType,
        actorId: command.actor.actorId,
        attestationId: command.attestationId,
        beforeHash: hashFact({
          artifactId: current.attestation.artifactId,
          artifactDigest: current.attestation.artifactDigest,
          verificationState: current.attestation.verificationState,
        }),
        afterHash: hashFact({
          revocationId: revocation.id,
          revokedAt: revokedAt.toISOString(),
          revokedBy: command.actor.actorId,
          reason: command.reason,
        }),
        reason: command.reason,
        requestId: command.requestId,
        occurredAt: revokedAt,
      });
      await session.appendOutbox({
        id: newId(),
        tenantId: command.tenantId,
        eventKey: `artifact-attestation-revoked:${command.attestationId}`,
        eventType: "artifact.attestation.revoked",
        aggregateId: command.attestationId,
        aggregateVersion: 0,
        payload: {
          attestation_id: command.attestationId,
          artifact_id: current.attestation.artifactId ?? "",
          revoked_at: revokedAt.toISOString(),
          reason: command.reason,
        },
        occurredAt: revokedAt,
      });
      return { attestation: current.attestation, revocation };
    });
  };
}

function hashFact(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
