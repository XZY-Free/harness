import type { ControlPlaneEventType } from "@/lib/control-plane/events/control-plane-event";
import type { PublicationActorType } from "@/lib/publications/domain/publication-record";

export interface RuntimeWithdrawalRevision {
  id: string;
  runtimeId: string;
  revisionNo: number;
  revisionState: string;
}

export interface RuntimeWithdrawalSession {
  findRevision(tenantId: string, revisionId: string): Promise<RuntimeWithdrawalRevision | null>;
  findRuntime(
    tenantId: string,
    runtimeId: string,
  ): Promise<{ id: string; versionNo: number } | null>;
  findPublication(tenantId: string, revisionId: string): Promise<{ id: string } | null>;
  findLatestPublishedRevisionId(params: {
    tenantId: string;
    runtimeId: string;
    excludingRevisionId: string;
  }): Promise<string | null>;
  appendWithdrawal(params: {
    id: string;
    tenantId: string;
    publicationRecordId: string;
    revisionId: string;
    reasonCode: string;
    reason: string;
    withdrawnByType: PublicationActorType;
    withdrawnBy: string;
    withdrawnAt: Date;
  }): Promise<void>;
  markRevisionWithdrawn(revisionId: string): Promise<boolean>;
  setRuntimeCurrentRevision(params: {
    tenantId: string;
    runtimeId: string;
    currentRevisionId: string | null;
    expectedVersionNo: number;
    updatedAt: Date;
  }): Promise<boolean>;
  appendAudit(params: {
    id: string;
    tenantId: string;
    actorType: PublicationActorType;
    actorId: string;
    revisionId: string;
    reasonCode: string;
    reason: string;
    after: Record<string, unknown>;
    requestId: string;
    occurredAt: Date;
  }): Promise<void>;
  appendOutbox(params: {
    id: string;
    tenantId: string;
    eventKey: string;
    eventType: ControlPlaneEventType;
    aggregateId: string;
    aggregateVersion: number;
    payload: Record<string, unknown>;
    occurredAt: Date;
  }): Promise<void>;
  completeIdempotency(params: {
    recordId: string;
    httpStatus: number;
    responseRef: string | null;
    responseRedactedJson: string;
    completedAt: Date;
  }): Promise<boolean>;
}

export interface RuntimeWithdrawalStore {
  transaction<T>(operation: (session: RuntimeWithdrawalSession) => Promise<T>): Promise<T>;
}
