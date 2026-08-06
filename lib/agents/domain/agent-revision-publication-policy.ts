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

export class AgentPublicationIdempotencyCompletionError extends Error {
 constructor(public readonly recordId: string) {
 super(`AgentRevision 发布无法完成 IdempotencyRecord: ${recordId}`);
 this.name = "AgentPublicationIdempotencyCompletionError";
 }
}
