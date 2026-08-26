import type { AgentRevisionPublicationState } from "@/lib/agents/domain/agent-revision-publication-policy";

export interface AgentPublicationRevision {
  id: string;
  agentId: string;
  revisionNo: number;
  revisionState: AgentRevisionPublicationState;
  /** 绑定的不可变 AgentContractSnapshot id；发布强约束（NOT NULL）。 */
  agentContractSnapshotId: string;
  publishedAt: Date | null;
}

export interface AgentPublicationAgent {
  id: string;
  tenantId: string;
  versionNo: number;
}

/** 发布冻结的 Agent Contract 证据（权威外部合同来源）。 */
export interface AgentPublicationContractSnapshot {
  id: string;
  agentId: string;
  contractDigest: string;
  capabilityDigest: string;
  contextDigest: string;
}

export type AgentPublicationActorType = "user" | "service" | "workload" | "system";

/** Agent Contract 证据字段（随 PublicationRecord 冻结）。 */
export interface AgentPublicationContractEvidence {
  agentContractSnapshotId: string;
  agentContractDigest: string;
  agentCapabilityDigest: string;
  agentContextDigest: string;
}

export interface AgentPublicationSession {
  findRevision(tenantId: string, revisionId: string): Promise<AgentPublicationRevision | null>;
  findAgent(tenantId: string, agentId: string): Promise<AgentPublicationAgent | null>;
  /** 加载绑定 AgentContractSnapshot 的发布证据；不存在返回 null。 */
  findContractSnapshot(
    tenantId: string,
    snapshotId: string,
  ): Promise<AgentPublicationContractSnapshot | null>;
  appendPublication(params: {
    id: string;
    tenantId: string;
    revisionId: string;
    evidenceSetDigest: string;
    contractEvidence: AgentPublicationContractEvidence;
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
    /** : 事件类型 — 必须来自合同，aggregateType 由合同推导。 */
    eventType: "agent.revision.published";
    aggregateId: string;
    /** : 聚合版本号。 */
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
