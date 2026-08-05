import type { AgentRevisionPublicationState } from "@/lib/agents/domain/agent-revision-publication-policy";

export interface AgentPublicationRevision {
  id: string;
  agentId: string;
  revisionNo: number;
  revisionState: AgentRevisionPublicationState;
  instructionHash: string;
  agentArtifactRef: string;
  publishedAt: Date | null;
}

export interface AgentPublicationAgent {
  id: string;
  tenantId: string;
  versionNo: number;
}

export interface AgentPublicationAttestation {
  id: string;
  artifactDigest: string;
}

export type AgentPublicationActorType = "user" | "service" | "workload" | "system";

export interface AgentPublicationSession {
  findRevision(tenantId: string, revisionId: string): Promise<AgentPublicationRevision | null>;
  findAgent(tenantId: string, agentId: string): Promise<AgentPublicationAgent | null>;
  findVerifiedAttestation(params: {
    tenantId: string;
    revisionId: string;
    attestationId: string;
  }): Promise<AgentPublicationAttestation | null>;
  appendPublication(params: {
    id: string;
    tenantId: string;
    revisionId: string;
    evidenceSetDigest: string;
    attestationIds: string[];
    publishedByType: AgentPublicationActorType;
    publishedBy: string;
    publishedAt: Date;
    idempotencyKey: string;
    idempotencyRecordId: string | null;
  }): Promise<void>;
  markRevisionPublished(revisionId: string, publishedAt: Date): Promise<boolean>;
  setAgentCurrentRevision(params: {
    tenantId: string;
    agentId: string;
    revisionId: string;
    expectedVersionNo: number;
    updatedAt: Date;
  }): Promise<boolean>;
  appendAudit(params: {
    id: string;
    tenantId: string;
    actorType: AgentPublicationActorType;
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
    /** §3.2: 事件类型 — 必须来自合同，aggregateType 由合同推导。 */
    eventType: "agent.revision.published";
    aggregateId: string;
    /** §3.1: 聚合版本号。 */
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

export interface AgentPublicationStore {
  transaction<T>(operation: (session: AgentPublicationSession) => Promise<T>): Promise<T>;
}
