import type { AgentRevisionPublicationState } from "@/lib/agents/domain/agent-revision-publication-policy";
import type { PublicationActorType } from "@/lib/publications/domain/publication-record";

export interface AgentWithdrawalRevision {
  id: string;
  agentId: string;
  revisionNo: number;
  revisionState: AgentRevisionPublicationState;
  publishedAt: Date | null;
}

export interface AgentWithdrawalAgent {
  id: string;
  tenantId: string;
  currentRevisionId: string | null;
  versionNo: number;
}

export interface AgentWithdrawalPublication {
  id: string;
}

export interface AgentWithdrawalSession {
  findRevision(tenantId: string, revisionId: string): Promise<AgentWithdrawalRevision | null>;
  findAgent(tenantId: string, agentId: string): Promise<AgentWithdrawalAgent | null>;
  findPublication(tenantId: string, revisionId: string): Promise<AgentWithdrawalPublication | null>;
  findLatestPublishedRevisionId(params: {
    tenantId: string;
    agentId: string;
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
  setAgentCurrentRevision(params: {
    tenantId: string;
    agentId: string;
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
    after: unknown;
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

export interface AgentWithdrawalStore {
  transaction<T>(operation: (session: AgentWithdrawalSession) => Promise<T>): Promise<T>;
}
