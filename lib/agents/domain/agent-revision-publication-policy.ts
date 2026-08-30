export type AgentRevisionPublicationState = "draft" | "published" | "withdrawn";

export function assertAgentRevisionPublishable(params: {
  revisionId: string;
  revisionState: AgentRevisionPublicationState;
}): void {
  if (params.revisionState !== "draft") {
    throw new AgentRevisionPublicationStateError(
      params.revisionId,
      params.revisionState,
      "只有 draft 状态可发布",
    );
  }
}

export class AgentRevisionPublicationNotFoundError extends Error {
  constructor(public readonly revisionId: string) {
    super(`AgentRevision 不存在: ${revisionId}`);
    this.name = "AgentRevisionPublicationNotFoundError";
  }
}

export class AgentRevisionPublicationStateError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly fromState: AgentRevisionPublicationState,
    message: string,
  ) {
    super(message);
    this.name = "AgentRevisionPublicationStateError";
  }
}

export class AgentPublicationVersionConflictError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly expectedVersionNo: number,
  ) {
    super(`Agent ${agentId} versionNo 不匹配（期望 ${expectedVersionNo}），乐观锁冲突`);
    this.name = "AgentPublicationVersionConflictError";
  }
}

export class AgentPublicationPrerequisiteError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly attestationId: string,
  ) {
    super(`AgentRevision ${revisionId} 缺少有效且未撤销的 ArtifactAttestation: ${attestationId}`);
    this.name = "AgentPublicationPrerequisiteError";
  }
}

/**
 * AgentRevision 发布缺少绑定的 AgentContractSnapshot（权威外部合同来源）。
 * Revision 未绑定 Snapshot、Snapshot 不存在、或 Snapshot 不属于同 tenant/Agent 时抛出。
 */
export class AgentPublicationContractSnapshotMissingError extends Error {
  constructor(public readonly revisionId: string) {
    super(
      `AgentRevision ${revisionId} 缺少有效且属于同 Agent 的 AgentContractSnapshot 绑定，无法发布`,
    );
    this.name = "AgentPublicationContractSnapshotMissingError";
  }
}

export class AgentPublicationContractSnapshotIntegrityError extends Error {
  constructor(public readonly revisionId: string) {
    super(`AgentRevision ${revisionId} 绑定的 AgentContractSnapshot 摘要与结构化事实不一致`);
    this.name = "AgentPublicationContractSnapshotIntegrityError";
  }
}

export class AgentPublicationIdempotencyCompletionError extends Error {
  constructor(public readonly recordId: string) {
    super(`AgentRevision 发布无法完成 IdempotencyRecord: ${recordId}`);
    this.name = "AgentPublicationIdempotencyCompletionError";
  }
}
