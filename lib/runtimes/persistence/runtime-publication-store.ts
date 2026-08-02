import type {
  ConformanceCaseResult,
  RuntimeRevisionPublicationState,
} from "@/lib/runtimes/domain/runtime-revision-publication-policy";

export type RuntimePublicationActorType = "user" | "service" | "workload" | "system";

export interface RuntimePublicationRevision {
  id: string;
  runtimeId: string;
  revisionNo: number;
  revisionState: RuntimeRevisionPublicationState;
  runtimeArtifactRef: string;
  configHash: string;
  publishedAt: Date | null;
}

export interface RuntimePublicationRuntime {
  id: string;
  tenantId: string;
  versionNo: number;
}

export interface RuntimePublicationAttestation {
  id: string;
  artifactDigest: string;
}

export interface RuntimePublicationConformanceOptions {
  adapterDigest: string | null;
  testEnvironment: string | null;
  evidenceRef: string | null;
}

export interface StoredRuntimeConformanceResult {
  caseId: ConformanceCaseResult["caseId"];
  passed: boolean;
  reason: string | null;
  adapterDigest: string | null;
  testEnvironment: string | null;
  evidenceRef: string | null;
  testedAt: Date;
}

export interface RuntimePublicationSession {
  findRevision(tenantId: string, revisionId: string): Promise<RuntimePublicationRevision | null>;
  findRuntime(tenantId: string, runtimeId: string): Promise<RuntimePublicationRuntime | null>;
  findVerifiedAttestation(params: {
    tenantId: string;
    revisionId: string;
    attestationId: string;
  }): Promise<RuntimePublicationAttestation | null>;
  persistConformanceResults(params: {
    tenantId: string;
    revisionId: string;
    results: ConformanceCaseResult[];
    options: RuntimePublicationConformanceOptions;
    testedAt: Date;
  }): Promise<StoredRuntimeConformanceResult[]>;
  appendPublication(params: {
    id: string;
    tenantId: string;
    revisionId: string;
    evidenceSetDigest: string;
    attestationIds: string[];
    publishedByType: RuntimePublicationActorType;
    publishedBy: string;
    publishedAt: Date;
    idempotencyKey: string;
    idempotencyRecordId: string | null;
  }): Promise<void>;
  markRevisionPublished(revisionId: string, publishedAt: Date): Promise<boolean>;
  setRuntimeCurrentRevision(params: {
    tenantId: string;
    runtimeId: string;
    revisionId: string;
    expectedVersionNo: number;
    updatedAt: Date;
  }): Promise<boolean>;
  appendAudit(params: {
    id: string;
    tenantId: string;
    actorType: RuntimePublicationActorType;
    actorId: string;
    revisionId: string;
    after: unknown;
    reason: string;
    requestId: string;
    occurredAt: Date;
  }): Promise<void>;
  appendOutbox(params: {
    id: string;
    tenantId: string;
    eventKey: string;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: unknown;
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

export interface RuntimePublicationStore {
  transaction<T>(operation: (session: RuntimePublicationSession) => Promise<T>): Promise<T>;
}
