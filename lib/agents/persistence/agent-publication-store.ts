import type { AgentRevisionPublicationState } from "@/lib/agents/domain/agent-revision-publication-policy";

export interface AgentPublicationRevision {
  id: string;
  agentId: string;
  revisionNo: number;
  revisionState: AgentRevisionPublicationState;
  instructionHash: string;
  agentArtifactRef: string;
  /** 绑定的不可变 AgentDescriptorSnapshot id；null 表示旧 Revision（Batch 2 发布强约束前）。 */
  agentDescriptorSnapshotId: string | null;
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

/** 发布冻结的 Agent Descriptor 证据（Batch 2 权威外部合同来源，替代 source Artifact/Attestation）。 */
export interface AgentPublicationDescriptorSnapshot {
  id: string;
  agentId: string;
  providerDescriptorDigest: string;
  capabilityManifestDigest: string;
  invocationContextContractDigest: string;
}

export type AgentPublicationActorType = "user" | "service" | "workload" | "system";

/** Agent Descriptor 证据字段（随 PublicationRecord 冻结）。 */
export interface AgentPublicationDescriptorEvidence {
  agentDescriptorSnapshotId: string;
  agentProviderDescriptorDigest: string;
  agentCapabilityManifestDigest: string;
  agentInvocationContextContractDigest: string;
}

export interface AgentPublicationSession {
  findRevision(tenantId: string, revisionId: string): Promise<AgentPublicationRevision | null>;
  findAgent(tenantId: string, agentId: string): Promise<AgentPublicationAgent | null>;
  /** 加载绑定 AgentDescriptorSnapshot 的发布证据；不存在返回 null。 */
  findDescriptorSnapshot(
    tenantId: string,
    snapshotId: string,
  ): Promise<AgentPublicationDescriptorSnapshot | null>;
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
    descriptorEvidence: AgentPublicationDescriptorEvidence;
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
