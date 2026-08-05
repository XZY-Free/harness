/**
 * V11 Job 域共享错误类（S09-C04）。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §6.1、§6.12、§9、
 *         ../v11-agentkit-platform/13-memory-and-job-api.md §4、
 *         ../v11-agentkit-platform/11-api-and-event-boundaries.md §2.5。
 *
 * Route 层根据 error 实例映射 HTTP 状态码和稳定 error_code。
 */
import type { JobCommandState, JobState } from "@/lib/persistence/schema/job";

/** Job 不存在或跨租户不可见。映射 404 RESOURCE_NOT_FOUND（不泄露存在）。 */
export class JobNotFoundError extends Error {
  constructor(public readonly jobId: string) {
    super(`Job 不存在或不可见：${jobId}`);
    this.name = "JobNotFoundError";
  }
}

/**
 * Job 状态机非法转换（§6.1）。
 * - queued → running → waiting_external → running → completed/failed/cancelled
 * - 终态不可恢复（job 不复活）；retry 通过 replaces_job_id 创建新 Job。
 * 映射 409 JOB_STATE_CONFLICT。
 */
export class JobStateConflictError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly currentState: JobState,
    public readonly attemptedAction: string,
  ) {
    super(`Job ${jobId} 状态为 ${currentState}，不允许 ${attemptedAction}`);
    this.name = "JobStateConflictError";
  }
}

/**
 * Job 已终态（completed/failed/cancelled），不能再次取消（§6.12）。
 * 映射 409 JOB_ALREADY_TERMINAL。
 */
export class JobAlreadyTerminalError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly currentState: JobState,
  ) {
    super(`Job ${jobId} 已终态（${currentState}），不能取消或重跑`);
    this.name = "JobAlreadyTerminalError";
  }
}

/**
 * Job 非终态，不能重跑（§6.12）。
 * retry 只接受 completed/failed/cancelled Job。
 * 映射 409 JOB_NOT_TERMINAL。
 */
export class JobNotTerminalError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly currentState: JobState,
  ) {
    super(`Job ${jobId} 状态为 ${currentState}，未进入终态，不能重跑`);
    this.name = "JobNotTerminalError";
  }
}

/**
 * Job 重跑被 unknown_effect 阻断（§6.12、§16）。
 * 原 Job 存在 unknown_effect 时必须先核对，或由所属领域证明新 Job 不会重复副作用。
 * 映射 409 JOB_RETRY_BLOCKED_BY_UNKNOWN_EFFECT。
 */
export class JobRetryBlockedByUnknownEffectError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly reason: string,
  ) {
    super(`Job ${jobId} 重跑被 unknown_effect 阻断：${reason}`);
    this.name = "JobRetryBlockedByUnknownEffectError";
  }
}

/**
 * Job retry override 字段不被该 Job 类型支持（§6.12）。
 * override 字段必须由该 Job 类型声明。
 * 映射 409 JOB_OVERRIDE_NOT_ALLOWED。
 */
export class JobOverrideNotAllowedError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly overrideField: string,
    public readonly reason: string,
  ) {
    super(`Job ${jobId} 不允许 override 字段 ${overrideField}：${reason}`);
    this.name = "JobOverrideNotAllowedError";
  }
}

/**
 * Job 输入已不可访问（§6.12、§13 §4）。
 * retry 时 reuse_input=true，但原 Job 输入引用已过期或被清理。
 * 映射 409 JOB_INPUT_NO_LONGER_AVAILABLE。
 */
export class JobInputNoLongerAvailableError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly inputRef: string,
  ) {
    super(`Job ${jobId} 输入引用 ${inputRef} 已不可访问`);
    this.name = "JobInputNoLongerAvailableError";
  }
}

/**
 * JobCommand 不存在或跨租户不可见。
 * 映射 404 RESOURCE_NOT_FOUND。
 */
export class JobCommandNotFoundError extends Error {
  constructor(public readonly commandId: string) {
    super(`JobCommand 不存在或不可见：${commandId}`);
    this.name = "JobCommandNotFoundError";
  }
}

/**
 * JobCommand 已终态（acknowledged/rejected），不能再处理（§6.12）。
 * 相同命令重放返回原结果（幂等）。
 * 映射 409 JOB_COMMAND_ALREADY_TERMINAL。
 */
export class JobCommandAlreadyTerminalError extends Error {
  constructor(
    public readonly commandId: string,
    public readonly currentState: JobCommandState,
  ) {
    super(`JobCommand ${commandId} 状态为 ${currentState}，已终态`);
    this.name = "JobCommandAlreadyTerminalError";
  }
}

/**
 * Job 乐观锁冲突（versionNo 不匹配）。
 * 映射 412 ETAG_MISMATCH。
 */
export class JobVersionConflictError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`Job ${jobId} 版本冲突：期望 ${expected}，实际 ${actual}`);
    this.name = "JobVersionConflictError";
  }
}

/**
 * JobResultProjection 已存在（同 itemId 重复投影）。
 * 幂等重放返回原 projection；非幂等重投影抛本错误。
 * 映射 409 JOB_RESULT_PROJECTION_CONFLICT。
 */
export class JobResultProjectionConflictError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly existingProjectionId: string,
  ) {
    super(`JobResultProjection 已存在：itemId=${itemId} projectionId=${existingProjectionId}`);
    this.name = "JobResultProjectionConflictError";
  }
}
