export const ALL_CONFORMANCE_CASES = [
  "dispatch-binds-immutable-config",
  "event-batch-idempotent",
  "event-payload-hash-conflict",
  "attempt-sequence-continuity",
  "steer-requires-ack",
  "unsupported-steer",
  "cancel-request-not-terminal",
  "tool-schema-refresh",
  "unknown-effect-no-replay",
  "capability-search-not-use",
  "memory-proposal-only",
  "child-thread-isolation",
  "child-cancel-requires-ack",
  "credential-never-in-model-data",
  "execution-ownership-epoch",
  "session-does-not-claim-filesystem-recovery",
] as const;

export type ConformanceCaseId = (typeof ALL_CONFORMANCE_CASES)[number];

export const MANDATORY_GATE_CASES: readonly ConformanceCaseId[] = ALL_CONFORMANCE_CASES;

export interface ConformanceCaseResult {
  caseId: ConformanceCaseId;
  passed: boolean;
  reason?: string;
}

export interface ConformanceGateResult {
  passed: boolean;
  failedCases: ConformanceCaseId[];
}

export function validateConformanceGate(results: ConformanceCaseResult[]): ConformanceGateResult {
  const resultMap = new Map(results.map((result) => [result.caseId, result]));
  const failedCases = MANDATORY_GATE_CASES.filter((caseId) => !resultMap.get(caseId)?.passed);
  return { passed: failedCases.length === 0, failedCases };
}

export type RuntimeRevisionPublicationState = "draft" | "published" | "withdrawn";

export class ConformanceGateError extends Error {
  constructor(public readonly failedCases: ConformanceCaseId[]) {
    super(`Conformance 门禁失败，缺失/失败的 mandatory case：${failedCases.join(", ")}`);
    this.name = "ConformanceGateError";
  }
}

export class RuntimeRevisionNotFoundError extends Error {
  constructor(public readonly revisionId: string) {
    super(`RuntimeRevision 不存在: ${revisionId}`);
    this.name = "RuntimeRevisionNotFoundError";
  }
}

export class RuntimeRevisionStateError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly fromState: RuntimeRevisionPublicationState,
    public readonly toState: RuntimeRevisionPublicationState,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeRevisionStateError";
  }
}

export class RuntimeVersionConflictError extends Error {
  constructor(
    public readonly runtimeId: string,
    public readonly expectedVersionNo: number,
  ) {
    super(`Runtime ${runtimeId} versionNo 不匹配（期望 ${expectedVersionNo}），乐观锁冲突`);
    this.name = "RuntimeVersionConflictError";
  }
}

export class RuntimePublicationPrerequisiteError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly attestationId: string,
  ) {
    super(`RuntimeRevision ${revisionId} 缺少有效制品证明 ${attestationId}`);
    this.name = "RuntimePublicationPrerequisiteError";
  }
}

export class RuntimePublicationIdempotencyCompletionError extends Error {
  constructor(public readonly recordId: string) {
    super(`RuntimeRevision 发布幂等记录无法完成: ${recordId}`);
    this.name = "RuntimePublicationIdempotencyCompletionError";
  }
}
