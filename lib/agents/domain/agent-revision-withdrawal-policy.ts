import type { AgentRevisionPublicationState } from "@/lib/agents/domain/agent-revision-publication-policy";

export function assertAgentRevisionWithdrawable(params: {
  revisionId: string;
  revisionState: AgentRevisionPublicationState;
  reasonCode: string;
  reason: string;
}): void {
  if (params.revisionState !== "published") {
    throw new AgentRevisionWithdrawalStateError(params.revisionId, params.revisionState);
  }
  if (!params.reasonCode.trim() || !params.reason.trim()) {
    throw new AgentRevisionWithdrawalValidationError("撤回原因码和原因均不能为空");
  }
}

export class AgentRevisionWithdrawalNotFoundError extends Error {
  constructor(public readonly revisionId: string) {
    super(`AgentRevision 不存在: ${revisionId}`);
    this.name = "AgentRevisionWithdrawalNotFoundError";
  }
}

export class AgentRevisionWithdrawalStateError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly fromState: AgentRevisionPublicationState,
  ) {
    super(`AgentRevision ${revisionId} 当前为 ${fromState}，只有 published 状态可撤回`);
    this.name = "AgentRevisionWithdrawalStateError";
  }
}

export class AgentRevisionWithdrawalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRevisionWithdrawalValidationError";
  }
}

export class AgentRevisionWithdrawalPublicationNotFoundError extends Error {
  constructor(public readonly revisionId: string) {
    super(`AgentRevision ${revisionId} 没有权威 PublicationRecord，不能撤回`);
    this.name = "AgentRevisionWithdrawalPublicationNotFoundError";
  }
}

export class AgentWithdrawalVersionConflictError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly expectedVersionNo: number,
  ) {
    super(`Agent ${agentId} versionNo 不匹配（期望 ${expectedVersionNo}），乐观锁冲突`);
    this.name = "AgentWithdrawalVersionConflictError";
  }
}

export class AgentWithdrawalIdempotencyCompletionError extends Error {
  constructor(public readonly recordId: string) {
    super(`AgentRevision 撤回无法完成 IdempotencyRecord: ${recordId}`);
    this.name = "AgentWithdrawalIdempotencyCompletionError";
  }
}
