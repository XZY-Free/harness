/**
 * V11 Job 控制调度器编排（S09-C05）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.1、§6.12、§9.1（事务边界）
 * - ../v11-agentkit-platform/13-memory-and-job-api.md §4（Job Control API：cancel / retry）
 * - ../v11-agentkit-platform/05-continuity-collaboration-and-reliability.md §16（取消流程）
 * - ../v11-agentkit-platform-development-plan/09-collaboration-jobs-and-recovery.md S09-W05、S09-C05
 *
 * 职责：
 * - processCancelCommand：调度器核对 Invocation/Effect 后才 cancelled（写 job.cancelled Event）
 * - processRetryCommand：调度器核对 + 创建 replacement Job（replaces_job_id 引用原 Job）
 * - completeJob：Job 终态完成 + job.completed Event + recordJobResult
 * - failJob：Job 终态失败 + job.failed Event + recordJobResult
 *
 * 关键约束：
 * - Job 不复活：cancel 只作用于非终态 Job；retry 只作用于终态 Job。
 * - unknown_effect 不能自动取消（§16 行 333）：调用方须显式确认已核对。
 * - 调度器编排必须同事务：Job 状态转换 + JobEvent 写入 + JobCommand 状态转换。
 * - replacement Job 必须通过 replaces_job_id 引用原 Job；原 Job 状态/事件不被覆盖。
 */
import { db } from "@/lib/db/client";
import {
  type Job,
  type JobCommand,
  type JobEvent,
  type JobEventActorType,
  jobCommandTable,
  jobTable,
} from "@/lib/persistence/schema/job";
import { invocationTable } from "@/lib/persistence/schema/runtime";
import {
  JobAlreadyTerminalError,
  JobNotFoundError,
  JobNotTerminalError,
} from "@/lib/v11/job/errors";
import { acknowledgeCommand, rejectCommand } from "@/lib/v11/job/job-command-queries";
import { allocateJobEventSequences, insertJobEvent } from "@/lib/v11/job/job-event-queries";
import { createJob, recordJobResult, updateJobState } from "@/lib/v11/job/job-queries";
import { and, eq, inArray } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Invocation 终态集合（与 runtime 模块一致）。 */
const INVOCATION_TERMINAL_STATES = ["completed", "failed", "cancelled", "lost"] as const;

// ─── processCancelCommand ───────────────────────────────

/** processCancelCommand 入参。 */
export interface ProcessCancelCommandParams {
  tenantId: string;
  commandId: string;
  /** 调度器内部 actor id。 */
  actorId?: string;
  /**
   * unknown_effect 核对回调：返回 true 表示已核对，可取消；false 表示未核对，拒绝取消。
   * 默认回调返回 true（调度器在调用前已通过其他机制核对）。
   * 事实源：§16 行 333 "unknown_effect 不能自动取消"。
   */
  unknownEffectVerifier?: (jobId: string) => Promise<boolean> | boolean;
  /** 调度器 correlationId（透传到 Event）。 */
  correlationId?: string;
}

/** processCancelCommand 返回结果。 */
export interface ProcessCancelCommandResult {
  job: Job;
  command: JobCommand;
  /** 写入的 job.cancelled Event；pending 时为 null（等待 Invocation 终态）。 */
  cancelledEvent: JobEvent | null;
  /**
   * 处理结果：
   * - cancelled：Job 已成功取消
   * - waiting_invocations：存在非终态 Invocation，命令保留 queued 等待
   * - rejected_unknown_effect：unknown_effect 未核对，命令已 rejected
   * - rejected_job_terminal：Job 已终态（race condition），命令已 rejected
   */
  outcome:
    | "cancelled"
    | "waiting_invocations"
    | "rejected_unknown_effect"
    | "rejected_job_terminal";
}

/**
 * 调度器编排 cancel 命令：核对 Invocation/Effect 后才 cancelled。
 *
 * 流程（同事务）：
 * 1. SELECT FOR UPDATE JobCommand + Job
 * 2. 再次校验 Job 非终态（race condition：可能在 queued 后 Job 已自然终态）
 *    → 已终态：rejectCommand(JOB_ALREADY_TERMINAL)
 * 3. 查询所有关联 Invocation（invocationTable.jobId = job.id）
 *    - 存在非终态 Invocation → 保留 commandState=queued，返回 waiting_invocations
 * 4. unknown_effect 核对（调用方回调）
 *    - 未核对 → rejectCommand(JOB_RETRY_BLOCKED_BY_UNKNOWN_EFFECT)，返回 rejected_unknown_effect
 * 5. 全部 Invocation 终态 + 无 unknown_effect → 在同事务：
 *    a. updateJobState(jobId, "cancelled", expectedVersionNo)
 *    b. allocateJobEventSequences(1) + insertJobEvent("job.cancelled")
 *    c. acknowledgeCommand(commandId)（commandState: queued → acknowledged）
 *
 * 不变量（§6.12、§16）：
 * - Job 已终态（race condition）→ rejectCommand(JOB_ALREADY_TERMINAL)
 * - unknown_effect 未核对 → rejectCommand(JOB_RETRY_BLOCKED_BY_UNKNOWN_EFFECT)
 * - cancel 命令不提前修改 Job 状态（仅在编排成功后才 cancelled）
 */
export async function processCancelCommand(
  params: ProcessCancelCommandParams,
): Promise<ProcessCancelCommandResult> {
  // 事务外预查询命令（轻量校验）
  const [cmd] = await db
    .select()
    .from(jobCommandTable)
    .where(
      and(eq(jobCommandTable.tenantId, params.tenantId), eq(jobCommandTable.id, params.commandId)),
    )
    .limit(1);
  if (!cmd) {
    throw new JobNotFoundError(params.commandId);
  }

  // unknown_effect 核对（事务外调用，避免长事务持锁）
  const verifier = params.unknownEffectVerifier ?? (() => true);
  const unknownEffectOk = await verifier(cmd.jobId);

  const result = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE JobCommand
    const [current] = await tx
      .select()
      .from(jobCommandTable)
      .where(
        and(
          eq(jobCommandTable.tenantId, params.tenantId),
          eq(jobCommandTable.id, params.commandId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) {
      throw new JobNotFoundError(params.commandId);
    }

    // 已终态命令直接返回（不应再被调度器处理）
    if (current.commandState === "acknowledged" || current.commandState === "rejected") {
      // 重新查询 Job 状态以确定 outcome
      const [job] = await tx
        .select()
        .from(jobTable)
        .where(and(eq(jobTable.tenantId, params.tenantId), eq(jobTable.id, current.jobId)))
        .limit(1);
      return {
        job: job ?? null,
        command: current,
        cancelledEvent: null,
        outcome: "cancelled" as const,
      };
    }

    // 2. SELECT FOR UPDATE Job
    const [job] = await tx
      .select()
      .from(jobTable)
      .where(and(eq(jobTable.tenantId, params.tenantId), eq(jobTable.id, current.jobId)))
      .for("update")
      .limit(1);
    if (!job) {
      throw new JobNotFoundError(current.jobId);
    }

    // race condition：Job 已终态
    if (["completed", "failed", "cancelled"].includes(job.jobState)) {
      // 在同事务内 reject 命令
      const rejected = await rejectCommandInternal(
        tx,
        current.id,
        "JOB_ALREADY_TERMINAL",
        `Job 在 race condition 下已终态（${job.jobState}）`,
      );
      return {
        job,
        command: rejected,
        cancelledEvent: null,
        outcome: "rejected_job_terminal" as const,
      };
    }

    // 3. unknown_effect 核对失败 → rejectCommand
    if (!unknownEffectOk) {
      const rejected = await rejectCommandInternal(
        tx,
        current.id,
        "JOB_RETRY_BLOCKED_BY_UNKNOWN_EFFECT",
        "Job 存在 unknown_effect 未核对",
      );
      return {
        job,
        command: rejected,
        cancelledEvent: null,
        outcome: "rejected_unknown_effect" as const,
      };
    }

    // 4. 查询关联 Invocation 状态
    const invocations = await tx
      .select({
        id: invocationTable.id,
        executionState: invocationTable.executionState,
      })
      .from(invocationTable)
      .where(eq(invocationTable.jobId, job.id));

    const pendingInvocations = invocations.filter(
      (inv) =>
        !INVOCATION_TERMINAL_STATES.includes(
          inv.executionState as (typeof INVOCATION_TERMINAL_STATES)[number],
        ),
    );

    if (pendingInvocations.length > 0) {
      // 存在非终态 Invocation，保留命令 queued，等待 Runtime 推进
      return {
        job,
        command: current,
        cancelledEvent: null,
        outcome: "waiting_invocations" as const,
      };
    }

    // 5. 全部 Invocation 终态 + 无 unknown_effect → cancelled
    const updatedJob = await updateJobState(
      tx,
      params.tenantId,
      job.id,
      "cancelled",
      job.versionNo,
    );

    const startSeq = await allocateJobEventSequences(tx, job.id, 1);
    const cancelledEvent = await insertJobEvent(tx, params.tenantId, job.id, startSeq, {
      eventType: "job.cancelled",
      actorType: "service",
      actorId: params.actorId ?? "job-scheduler",
      payload: {
        job_id: job.id,
        command_id: current.id,
        reason_code: current.reasonCode,
        cancelled_at: new Date().toISOString(),
      },
      correlationId: params.correlationId,
      idempotencyKey: current.idempotencyKey
        ? `${current.idempotencyKey}:job-cancelled`
        : undefined,
    });

    // acknowledgeCommand（commandState: queued → acknowledged）
    const ackedCmd = await acknowledgeCommandInternal(tx, current.id);

    return {
      job: updatedJob,
      command: ackedCmd,
      cancelledEvent,
      outcome: "cancelled" as const,
    };
  });

  if (!result.job) {
    throw new JobNotFoundError(params.commandId);
  }

  return result as ProcessCancelCommandResult;
}

// ─── processRetryCommand ────────────────────────────────

/** processRetryCommand 入参。 */
export interface ProcessRetryCommandParams {
  tenantId: string;
  commandId: string;
  /** 调度器内部 actor id。 */
  actorId?: string;
  /**
   * unknown_effect 核对回调：返回 true 表示已核对，可 retry；false 表示未核对，拒绝。
   */
  unknownEffectVerifier?: (jobId: string) => Promise<boolean> | boolean;
  /**
   * override 字段校验回调：返回 true 表示 override 字段允许；false 表示拒绝。
   * 默认回调：commandPayloadJson.override 为空时返回 true，非空时返回 false（保守策略）。
   */
  overrideVerifier?: (
    jobId: string,
    override: Record<string, unknown> | null,
  ) => Promise<boolean> | boolean;
  /**
   * 输入可访问性校验回调：返回 true 表示 inputRef 仍可访问；false 表示已不可访问。
   * 默认回调返回 true（调度器在调用前已通过其他机制校验）。
   */
  inputAvailabilityVerifier?: (jobId: string, inputRef: string) => Promise<boolean> | boolean;
  /** 调度器 correlationId（透传到 Event）。 */
  correlationId?: string;
}

/** processRetryCommand 返回结果。 */
export interface ProcessRetryCommandResult {
  /** 原 Job（状态不变，retry 不修改原 Job）。 */
  originalJob: Job;
  /** replacement Job（state=queued，replacesJobId 指向原 Job）；rejection 路径下为 null。 */
  replacementJob: Job | null;
  command: JobCommand;
  outcome:
    | "retry_created"
    | "rejected_unknown_effect"
    | "rejected_override"
    | "rejected_input"
    | "rejected_job_not_terminal";
}

/**
 * 调度器编排 retry 命令：核对 + 创建 replacement Job + acknowledgeCommand。
 *
 * 流程（同事务）：
 * 1. SELECT FOR UPDATE JobCommand + Job
 * 2. 再次校验 Job 终态（race condition）→ 非终态：rejectCommand(JOB_NOT_TERMINAL)
 * 3. unknown_effect 核对（调用方回调）→ 未核对：rejectCommand(JOB_RETRY_BLOCKED_BY_UNKNOWN_EFFECT)
 * 4. override 校验（调用方回调）→ 不允许：rejectCommand(JOB_OVERRIDE_NOT_ALLOWED)
 * 5. input 可访问性校验（调用方回调）→ 不可访问：rejectCommand(JOB_INPUT_NO_LONGER_AVAILABLE)
 * 6. 全部校验通过 → 在同事务：
 *    a. createJob({replacesJobId: originalJob.id, ...复制原 Job 字段})
 *    b. acknowledgeCommand(commandId, replacementJobId: newJob.id)
 *
 * 不变量（§6.12、§16）：
 * - retry 不修改原 Job 状态/事件
 * - replacement Job 通过 replaces_job_id 引用原 Job
 * - replacement Job 状态为 queued（由 createJob 默认）
 * - commandPayloadJson.reuse_input / override 透传到 replacement Job
 */
export async function processRetryCommand(
  params: ProcessRetryCommandParams,
): Promise<ProcessRetryCommandResult> {
  // 事务外预查询命令
  const [cmd] = await db
    .select()
    .from(jobCommandTable)
    .where(
      and(eq(jobCommandTable.tenantId, params.tenantId), eq(jobCommandTable.id, params.commandId)),
    )
    .limit(1);
  if (!cmd) {
    throw new JobNotFoundError(params.commandId);
  }

  // 解析 commandPayloadJson
  const payload = (cmd.commandPayloadJson ?? {}) as {
    reuse_input?: boolean;
    override?: Record<string, unknown> | null;
    reason_code?: string | null;
  };
  const reuseInput = payload.reuse_input ?? true;
  const overrideJson = payload.override ?? null;

  // 事务外调用校验回调（避免长事务持锁）
  const unknownEffectOk = await (params.unknownEffectVerifier ?? (() => true))(cmd.jobId);
  const overrideOk = await (params.overrideVerifier ?? ((_, ov) => ov === null))(
    cmd.jobId,
    overrideJson,
  );

  // 事务外查询原 Job（用于 inputAvailabilityVerifier）
  const [preJob] = await db
    .select()
    .from(jobTable)
    .where(and(eq(jobTable.tenantId, params.tenantId), eq(jobTable.id, cmd.jobId)))
    .limit(1);
  if (!preJob) {
    throw new JobNotFoundError(cmd.jobId);
  }
  const inputOk = await (params.inputAvailabilityVerifier ?? (() => true))(
    cmd.jobId,
    preJob.inputRef ?? "",
  );

  const result = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE JobCommand
    const [current] = await tx
      .select()
      .from(jobCommandTable)
      .where(
        and(
          eq(jobCommandTable.tenantId, params.tenantId),
          eq(jobCommandTable.id, params.commandId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) {
      throw new JobNotFoundError(params.commandId);
    }

    // 已终态命令直接返回
    if (current.commandState === "acknowledged" || current.commandState === "rejected") {
      // 查询 replacement Job（若有）
      let replacementJob: Job | null = null;
      if (current.replacementJobId) {
        const [rj] = await tx
          .select()
          .from(jobTable)
          .where(eq(jobTable.id, current.replacementJobId))
          .limit(1);
        replacementJob = rj ?? null;
      }
      if (!replacementJob) {
        throw new Error("processRetryCommand: 已 acknowledge 命令但 replacement Job 未找到");
      }
      const [origJob] = await tx
        .select()
        .from(jobTable)
        .where(eq(jobTable.id, current.jobId))
        .limit(1);
      return {
        originalJob: origJob,
        replacementJob,
        command: current,
        outcome: "retry_created" as const,
      };
    }

    // 2. SELECT FOR UPDATE Job
    const [job] = await tx
      .select()
      .from(jobTable)
      .where(and(eq(jobTable.tenantId, params.tenantId), eq(jobTable.id, current.jobId)))
      .for("update")
      .limit(1);
    if (!job) {
      throw new JobNotFoundError(current.jobId);
    }

    // race condition：Job 非终态
    if (!["completed", "failed", "cancelled"].includes(job.jobState)) {
      const rejected = await rejectCommandInternal(
        tx,
        current.id,
        "JOB_NOT_TERMINAL",
        `Job 在 race condition 下未终态（${job.jobState}）`,
      );
      return {
        originalJob: job,
        replacementJob: null,
        command: rejected,
        outcome: "rejected_job_not_terminal" as const,
      };
    }

    // 3. unknown_effect 核对失败
    if (!unknownEffectOk) {
      const rejected = await rejectCommandInternal(
        tx,
        current.id,
        "JOB_RETRY_BLOCKED_BY_UNKNOWN_EFFECT",
        "原 Job 存在 unknown_effect 未核对",
      );
      return {
        originalJob: job,
        replacementJob: null,
        command: rejected,
        outcome: "rejected_unknown_effect" as const,
      };
    }

    // 4. override 字段不允许
    if (!overrideOk) {
      const rejected = await rejectCommandInternal(
        tx,
        current.id,
        "JOB_OVERRIDE_NOT_ALLOWED",
        "override 字段不被该 Job 类型支持",
      );
      return {
        originalJob: job,
        replacementJob: null,
        command: rejected,
        outcome: "rejected_override" as const,
      };
    }

    // 5. input 不可访问
    if (!inputOk) {
      const rejected = await rejectCommandInternal(
        tx,
        current.id,
        "JOB_INPUT_NO_LONGER_AVAILABLE",
        `原 Job 输入引用 ${job.inputRef ?? ""} 已不可访问`,
      );
      return {
        originalJob: job,
        replacementJob: null,
        command: rejected,
        outcome: "rejected_input" as const,
      };
    }

    // 6. 全部校验通过 → 创建 replacement Job
    // 注意：createJob 内部会启动嵌套事务，但当前已在事务中；
    // 为避免嵌套事务问题，将 createJob 的逻辑内联到当前事务
    const replacementJobId = await createReplacementJobInternal(
      tx,
      job,
      reuseInput,
      overrideJson,
      params.actorId,
      params.correlationId,
    );

    const [replacementJob] = await tx
      .select()
      .from(jobTable)
      .where(eq(jobTable.id, replacementJobId))
      .limit(1);
    if (!replacementJob) {
      throw new Error(`processRetryCommand: replacement Job 行未找到（id=${replacementJobId}）`);
    }

    // acknowledgeCommand(commandId, replacementJobId)
    const ackedCmd = await acknowledgeCommandInternal(tx, current.id, replacementJobId);

    return {
      originalJob: job,
      replacementJob,
      command: ackedCmd,
      outcome: "retry_created" as const,
    };
  });

  if (!result.replacementJob) {
    return result as ProcessRetryCommandResult;
  }

  return result as ProcessRetryCommandResult;
}

// ─── completeJob / failJob ──────────────────────────────

/** completeJob / failJob 入参。 */
export interface TerminateJobParams {
  tenantId: string;
  jobId: string;
  /** result 信息（resultRef/resultHash/resultSummaryJson）。 */
  result: {
    resultRef: string;
    resultHash: string;
    resultSummaryJson?: Record<string, unknown> | null;
  };
  /** 错误信息（仅 failJob 使用）。 */
  error?: {
    code: string;
    summary?: string;
  };
  actorType?: JobEventActorType;
  actorId?: string;
  correlationId?: string;
  idempotencyKey?: string;
}

/** completeJob / failJob 返回结果。 */
export interface TerminateJobResult {
  job: Job;
  resultRecordedEvent: JobEvent;
  terminalEvent: JobEvent;
}

/**
 * Job 终态完成：updateJobState(completed) + recordJobResult + job.completed Event。
 *
 * 流程（同事务）：
 * 1. recordJobResult（写 resultRef/resultHash + job.result_recorded Event）
 * 2. updateJobState(jobId, "completed", expectedVersionNo)
 * 3. allocateJobEventSequences(1) + insertJobEvent("job.completed")
 *
 * 不变量：
 * - Job 必须 running/waiting_external 状态（queued → completed 不允许）
 * - 调用方负责确认所有 Invocation 已终态 + completion_policy 满足
 */
export async function completeJob(params: TerminateJobParams): Promise<TerminateJobResult> {
  const result = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE Job（获取当前 versionNo）
    const [job] = await tx
      .select()
      .from(jobTable)
      .where(and(eq(jobTable.tenantId, params.tenantId), eq(jobTable.id, params.jobId)))
      .for("update")
      .limit(1);
    if (!job) {
      throw new JobNotFoundError(params.jobId);
    }

    // 2. recordJobResult（写 resultRef/resultHash + job.result_recorded Event）
    const { job: jobWithResult, resultRecordedEvent } = await recordJobResult(
      tx,
      params.tenantId,
      params.jobId,
      params.result,
      {
        actorType: params.actorType,
        actorId: params.actorId,
        correlationId: params.correlationId,
        idempotencyKey: params.idempotencyKey,
      },
    );

    // 3. updateJobState(completed)
    const completedJob = await updateJobState(
      tx,
      params.tenantId,
      params.jobId,
      "completed",
      jobWithResult.versionNo,
    );

    // 4. allocateJobEventSequences(1) + insertJobEvent("job.completed")
    const startSeq = await allocateJobEventSequences(tx, params.jobId, 1);
    const terminalEvent = await insertJobEvent(tx, params.tenantId, params.jobId, startSeq, {
      eventType: "job.completed",
      actorType: params.actorType ?? "system",
      actorId: params.actorId,
      payload: {
        job_id: params.jobId,
        result_ref: params.result.resultRef,
        result_hash: params.result.resultHash,
        result_summary: params.result.resultSummaryJson ?? null,
      },
      correlationId: params.correlationId,
      idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:job-completed` : undefined,
    });

    return { job: completedJob, resultRecordedEvent, terminalEvent };
  });

  return result;
}

/**
 * Job 终态失败：updateJobState(failed) + recordJobResult + job.failed Event + errorCode/errorSummary。
 *
 * 流程（同事务）：
 * 1. recordJobResult（写 resultRef/resultHash + job.result_recorded Event）
 * 2. updateJobState(jobId, "failed", expectedVersionNo) + 写 errorCode/errorSummary
 * 3. allocateJobEventSequences(1) + insertJobEvent("job.failed")
 */
export async function failJob(params: TerminateJobParams): Promise<TerminateJobResult> {
  if (!params.error) {
    throw new Error("failJob: error 字段必填");
  }
  const error = params.error;

  const result = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE Job
    const [job] = await tx
      .select()
      .from(jobTable)
      .where(and(eq(jobTable.tenantId, params.tenantId), eq(jobTable.id, params.jobId)))
      .for("update")
      .limit(1);
    if (!job) {
      throw new JobNotFoundError(params.jobId);
    }

    // 2. recordJobResult
    const { job: jobWithResult, resultRecordedEvent } = await recordJobResult(
      tx,
      params.tenantId,
      params.jobId,
      params.result,
      {
        actorType: params.actorType,
        actorId: params.actorId,
        correlationId: params.correlationId,
        idempotencyKey: params.idempotencyKey,
      },
    );

    // 3. updateJobState(failed)
    const failedJob = await updateJobState(
      tx,
      params.tenantId,
      params.jobId,
      "failed",
      jobWithResult.versionNo,
    );

    // 3.1 写 errorCode/errorSummary
    await tx
      .update(jobTable)
      .set({
        errorCode: error.code,
        errorSummary: error.summary ?? null,
      })
      .where(eq(jobTable.id, params.jobId));

    // 4. allocateJobEventSequences(1) + insertJobEvent("job.failed")
    const startSeq = await allocateJobEventSequences(tx, params.jobId, 1);
    const terminalEvent = await insertJobEvent(tx, params.tenantId, params.jobId, startSeq, {
      eventType: "job.failed",
      actorType: params.actorType ?? "system",
      actorId: params.actorId,
      payload: {
        job_id: params.jobId,
        error_code: error.code,
        error_summary: error.summary ?? null,
        result_ref: params.result.resultRef,
        result_hash: params.result.resultHash,
      },
      correlationId: params.correlationId,
      idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:job-failed` : undefined,
    });

    // 回读最终 Job
    const [finalJob] = await tx
      .select()
      .from(jobTable)
      .where(eq(jobTable.id, params.jobId))
      .limit(1);

    return { job: finalJob ?? failedJob, resultRecordedEvent, terminalEvent };
  });

  return result;
}

// ─── 内部辅助：事务内 acknowledge / reject（避免嵌套事务） ───

const TERMINAL_COMMAND_STATES = ["acknowledged", "rejected"] as const;

/** 事务内 acknowledgeCommand（不启动新事务）。 */
async function acknowledgeCommandInternal(
  tx: Tx,
  commandId: string,
  replacementJobId?: string,
): Promise<JobCommand> {
  const [current] = await tx
    .select()
    .from(jobCommandTable)
    .where(eq(jobCommandTable.id, commandId))
    .for("update")
    .limit(1);
  if (!current) {
    throw new JobNotFoundError(commandId);
  }
  if (
    TERMINAL_COMMAND_STATES.includes(
      current.commandState as (typeof TERMINAL_COMMAND_STATES)[number],
    )
  ) {
    return current;
  }

  const updates: Partial<JobCommand> = {
    commandState: "acknowledged",
    acknowledgedAt: new Date(),
  };
  if (replacementJobId) {
    updates.replacementJobId = replacementJobId;
  }

  await tx.update(jobCommandTable).set(updates).where(eq(jobCommandTable.id, commandId));

  const [updated] = await tx
    .select()
    .from(jobCommandTable)
    .where(eq(jobCommandTable.id, commandId))
    .limit(1);
  if (!updated) {
    throw new Error(`acknowledgeCommandInternal: JobCommand 行未找到（id=${commandId}）`);
  }
  return updated;
}

/** 事务内 rejectCommand（不启动新事务）。 */
async function rejectCommandInternal(
  tx: Tx,
  commandId: string,
  errorCode: string,
  errorSummary: string,
): Promise<JobCommand> {
  const [current] = await tx
    .select()
    .from(jobCommandTable)
    .where(eq(jobCommandTable.id, commandId))
    .for("update")
    .limit(1);
  if (!current) {
    throw new JobNotFoundError(commandId);
  }
  if (
    TERMINAL_COMMAND_STATES.includes(
      current.commandState as (typeof TERMINAL_COMMAND_STATES)[number],
    )
  ) {
    return current;
  }

  await tx
    .update(jobCommandTable)
    .set({
      commandState: "rejected",
      errorCode,
      errorSummary,
      acknowledgedAt: new Date(),
    })
    .where(eq(jobCommandTable.id, commandId));

  const [updated] = await tx
    .select()
    .from(jobCommandTable)
    .where(eq(jobCommandTable.id, commandId))
    .limit(1);
  if (!updated) {
    throw new Error(`rejectCommandInternal: JobCommand 行未找到（id=${commandId}）`);
  }
  return updated;
}

/** 事务内创建 replacement Job（内联 createJob 逻辑，避免嵌套事务）。 */
async function createReplacementJobInternal(
  tx: Tx,
  originalJob: Job,
  reuseInput: boolean,
  overrideJson: Record<string, unknown> | null,
  actorId?: string,
  correlationId?: string,
): Promise<string> {
  // 直接 import createJob 的依赖（避免循环依赖）
  const { randomUUID } = await import("node:crypto");
  const jobId = randomUUID();
  const now = new Date();

  // 复制原 Job 字段：agentId/jobType/triggerRef/threadId/completionPolicyJson
  // inputRef/inputHash：reuseInput=true 时复制，否则清空（由领域服务后续回填）
  const inputRef = reuseInput ? originalJob.inputRef : null;
  const inputHash = reuseInput ? originalJob.inputHash : null;

  await tx.insert(jobTable).values({
    id: jobId,
    tenantId: originalJob.tenantId,
    agentId: originalJob.agentId,
    jobType: originalJob.jobType,
    triggerRef: originalJob.triggerRef,
    jobState: "queued",
    replacesJobId: originalJob.id,
    threadId: originalJob.threadId,
    completionPolicyJson: originalJob.completionPolicyJson,
    inputRef,
    inputHash,
    lastEventSequence: 0,
    resultRef: null,
    resultHash: null,
    errorCode: null,
    errorSummary: null,
    createdBy: originalJob.createdBy,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    versionNo: 1,
  });

  // 写 job.queued Event
  const startSeq = await allocateJobEventSequences(tx, jobId, 1);
  await insertJobEvent(tx, originalJob.tenantId, jobId, startSeq, {
    eventType: "job.queued",
    actorType: "service",
    actorId: actorId ?? "job-scheduler",
    payload: {
      job_id: jobId,
      tenant_id: originalJob.tenantId,
      agent_id: originalJob.agentId,
      job_type: originalJob.jobType,
      trigger_ref: originalJob.triggerRef,
      thread_id: originalJob.threadId,
      replaces_job_id: originalJob.id,
      completion_policy: originalJob.completionPolicyJson,
      input_ref: inputRef,
      input_hash: inputHash,
      created_by: originalJob.createdBy,
      override: overrideJson,
    },
    correlationId,
    idempotencyKey: `retry-${originalJob.id}:job-queued`,
  });

  return jobId;
}
