/**
 * V11 JobCommand 仓储（S09-C04）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.12（JobCommand 表）、§9（事务边界）
 * - ../v11-agentkit-platform/13-memory-and-job-api.md §4（Job Control API：cancel / retry）
 * - ../v11-agentkit-platform/05-continuity-collaboration-and-reliability.md §16（取消流程）
 * - ../v11-agentkit-platform-development-plan/09-collaboration-jobs-and-recovery.md S09-W04、S09-C04
 *
 * 职责：
 * - createCancelCommand：创建 cancel JobCommand（job.cancel_requested Event + Job 状态未变）。
 * - createRetryCommand：创建 retry JobCommand（job.retry_requested Event + Job 状态未变）。
 * - acknowledgeCommand：调度器确认命令（commandState → acknowledged）。
 * - rejectCommand：调度器拒绝命令（commandState → rejected + errorCode）。
 * - getJobCommands / getPendingJobCommands：查询。
 *
 * 关键约束（§6.12）：
 * - UNIQUE(jobId, idempotencyKey)：相同命令重放返回原结果（幂等）。
 * - cancel 命令：Job 必须非终态；先写 job.cancel_requested，Job 状态未变。
 * - retry 命令：Job 必须终态；同事务创建 replacement Job 并填 replacementJobId。
 * - commandState: queued → dispatched → acknowledged/rejected。
 * - 调度器核对全部 Invocation/Effect 后才 cancelled（不在本仓储层处理）。
 *
 * S09-C04 范围：只提供命令创建和状态更新原语；调度器编排（核对 Invocation/Effect、
 * 创建 replacement Job 等）留给 S09-C05 实现。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  type Job,
  type JobCommand,
  type JobCommandState,
  type JobCommandType,
  type JobEvent,
  type JobEventActorType,
  jobCommandTable,
  jobEventTable,
  jobTable,
} from "@/lib/persistence/schema/job";
import {
  JobAlreadyTerminalError,
  JobCommandAlreadyTerminalError,
  JobCommandNotFoundError,
  JobNotFoundError,
  JobNotTerminalError,
} from "@/lib/v11/job/errors";
import { allocateJobEventSequences, insertJobEvent } from "@/lib/v11/job/job-event-queries";
import { and, desc, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Job 终态集合。 */
const TERMINAL_JOB_STATES: readonly Job["jobState"][] = ["completed", "failed", "cancelled"];

/** JobCommand 终态集合。 */
const TERMINAL_COMMAND_STATES: readonly JobCommandState[] = ["acknowledged", "rejected"];

/** JobCommand 幂等查找条件。 */
interface IdempotentCommandLookup {
  jobId: string;
  idempotencyKey: string;
}

/**
 * 查找幂等键已存在的命令（相同 jobId + idempotencyKey 重放）。
 * 不存在返回 null。
 */
async function findExistingCommand(lookup: IdempotentCommandLookup): Promise<JobCommand | null> {
  const [row] = await db
    .select()
    .from(jobCommandTable)
    .where(
      and(
        eq(jobCommandTable.jobId, lookup.jobId),
        eq(jobCommandTable.idempotencyKey, lookup.idempotencyKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ─── createCancelCommand ────────────────────────────────────

/** createCancelCommand 入参。 */
export interface CreateCancelCommandParams {
  tenantId: string;
  jobId: string;
  requestedBy: string;
  reasonCode?: string;
  idempotencyKey: string; // cancel 命令必须提供幂等键
  actorType?: JobEventActorType;
  actorId?: string;
  correlationId?: string;
}

/** createCancelCommand 返回结果。 */
export interface CreateCancelCommandResult {
  command: JobCommand;
  /** 写入的 job.cancel_requested Event。 */
  cancelRequestedEvent: JobEvent;
  /** 是否为幂等重放（true 时 command 是已有命令，未创建新命令）。 */
  replayed: boolean;
}

/**
 * 创建 cancel JobCommand。
 *
 * 流程（同事务）：
 * 1. SELECT FOR UPDATE Job（必须非终态）
 * 2. 幂等检查：相同 (jobId, idempotencyKey) 命令已存在 → 返回原命令（replayed=true）
 * 3. INSERT JobCommand（commandType=cancel, commandState=queued）
 * 4. allocateJobEventSequences(1) + insertJobEvent(job.cancel_requested)
 *
 * 不变量（§6.12）：
 * - Job 终态时抛 JobAlreadyTerminalError（cancel 不能作用于终态 Job）。
 * - Job 状态未变（cancel_requested 不修改 jobState；调度器核对后才能 cancelled）。
 * - 相同 idempotencyKey 重放返回原结果。
 */
export async function createCancelCommand(
  params: CreateCancelCommandParams,
): Promise<CreateCancelCommandResult> {
  // 幂等检查（事务外先查一次，减少长事务持锁）
  const existing = await findExistingCommand({
    jobId: params.jobId,
    idempotencyKey: params.idempotencyKey,
  });
  if (existing) {
    // 幂等重放：返回原命令，不创建新命令、不写新 Event
    // 注意：原命令的 cancel_requested Event 已在第一次创建时写入
    const [firstEvent] = await db
      .select()
      .from(jobEventTable)
      .where(
        and(
          eq(jobEventTable.jobId, params.jobId),
          eq(jobEventTable.idempotencyKey, `${params.idempotencyKey}:job-cancel-requested`),
        ),
      )
      .limit(1);
    return {
      command: existing,
      cancelRequestedEvent: firstEvent as JobEvent,
      replayed: true,
    };
  }

  const actorType: JobEventActorType = params.actorType ?? "system";
  const now = new Date();

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

    // 校验非终态
    if (TERMINAL_JOB_STATES.includes(job.jobState)) {
      throw new JobAlreadyTerminalError(params.jobId, job.jobState);
    }

    // 2. 事务内再次幂等检查（防 race condition）
    const [raceExisting] = await tx
      .select()
      .from(jobCommandTable)
      .where(
        and(
          eq(jobCommandTable.jobId, params.jobId),
          eq(jobCommandTable.idempotencyKey, params.idempotencyKey),
        ),
      )
      .limit(1);
    if (raceExisting) {
      // 另一事务已创建相同幂等键命令；回读关联 Event
      const [firstEvent] = await tx
        .select()
        .from(jobEventTable)
        .where(
          and(
            eq(jobEventTable.jobId, params.jobId),
            eq(jobEventTable.idempotencyKey, `${params.idempotencyKey}:job-cancel-requested`),
          ),
        )
        .limit(1);
      return {
        command: raceExisting,
        cancelRequestedEvent: firstEvent as JobEvent,
        replayed: true,
      };
    }

    // 3. INSERT JobCommand
    const commandId = randomUUID();
    await tx.insert(jobCommandTable).values({
      id: commandId,
      tenantId: params.tenantId,
      jobId: params.jobId,
      commandType: "cancel",
      commandState: "queued",
      idempotencyKey: params.idempotencyKey,
      requestedBy: params.requestedBy,
      reasonCode: params.reasonCode ?? null,
      replacementJobId: null,
      errorCode: null,
      errorSummary: null,
      commandPayloadJson: params.reasonCode ? { reason_code: params.reasonCode } : null,
      createdAt: now,
      dispatchedAt: null,
      acknowledgedAt: null,
    });

    // 4. allocateJobEventSequences(1) + insertJobEvent(job.cancel_requested)
    const startSeq = await allocateJobEventSequences(tx, params.jobId, 1);
    const cancelRequestedEvent = await insertJobEvent(tx, params.tenantId, params.jobId, startSeq, {
      eventType: "job.cancel_requested",
      actorType,
      actorId: params.actorId ?? params.requestedBy,
      payload: {
        job_id: params.jobId,
        command_id: commandId,
        requested_by: params.requestedBy,
        reason_code: params.reasonCode ?? null,
      },
      correlationId: params.correlationId,
      idempotencyKey: `${params.idempotencyKey}:job-cancel-requested`,
    });

    // 回读 command
    const [command] = await tx
      .select()
      .from(jobCommandTable)
      .where(eq(jobCommandTable.id, commandId))
      .limit(1);
    if (!command) {
      throw new Error(`createCancelCommand: JobCommand 行未找到（id=${commandId}）`);
    }

    return { command, cancelRequestedEvent, replayed: false };
  });

  return result;
}

// ─── createRetryCommand ─────────────────────────────────────

/** createRetryCommand 入参。 */
export interface CreateRetryCommandParams {
  tenantId: string;
  jobId: string;
  requestedBy: string;
  reasonCode?: string;
  /** 是否复用原 Job 输入（默认 true）。 */
  reuseInput?: boolean;
  /** override 字段（必须由该 Job 类型声明支持，本仓储不校验）。 */
  overrideJson?: Record<string, unknown> | null;
  idempotencyKey: string;
  actorType?: JobEventActorType;
  actorId?: string;
  correlationId?: string;
}

/** createRetryCommand 返回结果。 */
export interface CreateRetryCommandResult {
  command: JobCommand;
  /** 写入的 job.retry_requested Event。 */
  retryRequestedEvent: JobEvent;
  /** 是否为幂等重放。 */
  replayed: boolean;
}

/**
 * 创建 retry JobCommand。
 *
 * 流程（同事务）：
 * 1. SELECT FOR UPDATE Job（必须终态）
 * 2. 幂等检查：相同 (jobId, idempotencyKey) 命令已存在 → 返回原命令（replayed=true）
 * 3. INSERT JobCommand（commandType=retry, commandState=queued）
 * 4. allocateJobEventSequences(1) + insertJobEvent(job.retry_requested)
 *
 * 不变量（§6.12）：
 * - Job 非终态时抛 JobNotTerminalError（retry 只接受终态 Job）。
 * - 不在此函数创建 replacement Job（S09-C05 实现调度器编排）；replacementJobId 留空，
 *   由调度器 acknowledge 命令时创建 replacement Job 并回填。
 * - unknown_effect 校验由调度器负责（S09-C05）；本仓储只创建命令。
 * - override 字段校验由该 Job 类型领域服务负责（S09-C05）；本仓储只存储。
 * - 相同 idempotencyKey 重放返回原结果。
 */
export async function createRetryCommand(
  params: CreateRetryCommandParams,
): Promise<CreateRetryCommandResult> {
  // 幂等检查（事务外）
  const existing = await findExistingCommand({
    jobId: params.jobId,
    idempotencyKey: params.idempotencyKey,
  });
  if (existing) {
    const [firstEvent] = await db
      .select()
      .from(jobEventTable)
      .where(
        and(
          eq(jobEventTable.jobId, params.jobId),
          eq(jobEventTable.idempotencyKey, `${params.idempotencyKey}:job-retry-requested`),
        ),
      )
      .limit(1);
    return {
      command: existing,
      retryRequestedEvent: firstEvent as JobEvent,
      replayed: true,
    };
  }

  const actorType: JobEventActorType = params.actorType ?? "system";
  const now = new Date();
  const reuseInput = params.reuseInput ?? true;

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

    // 校验终态
    if (!TERMINAL_JOB_STATES.includes(job.jobState)) {
      throw new JobNotTerminalError(params.jobId, job.jobState);
    }

    // 2. 事务内幂等检查
    const [raceExisting] = await tx
      .select()
      .from(jobCommandTable)
      .where(
        and(
          eq(jobCommandTable.jobId, params.jobId),
          eq(jobCommandTable.idempotencyKey, params.idempotencyKey),
        ),
      )
      .limit(1);
    if (raceExisting) {
      const [firstEvent] = await tx
        .select()
        .from(jobEventTable)
        .where(
          and(
            eq(jobEventTable.jobId, params.jobId),
            eq(jobEventTable.idempotencyKey, `${params.idempotencyKey}:job-retry-requested`),
          ),
        )
        .limit(1);
      return {
        command: raceExisting,
        retryRequestedEvent: firstEvent as JobEvent,
        replayed: true,
      };
    }

    // 3. INSERT JobCommand（replacementJobId 留空，由调度器 acknowledge 时回填）
    const commandId = randomUUID();
    await tx.insert(jobCommandTable).values({
      id: commandId,
      tenantId: params.tenantId,
      jobId: params.jobId,
      commandType: "retry",
      commandState: "queued",
      idempotencyKey: params.idempotencyKey,
      requestedBy: params.requestedBy,
      reasonCode: params.reasonCode ?? null,
      replacementJobId: null,
      errorCode: null,
      errorSummary: null,
      commandPayloadJson: {
        reuse_input: reuseInput,
        override: params.overrideJson ?? null,
        reason_code: params.reasonCode ?? null,
      },
      createdAt: now,
      dispatchedAt: null,
      acknowledgedAt: null,
    });

    // 4. allocateJobEventSequences(1) + insertJobEvent(job.retry_requested)
    const startSeq = await allocateJobEventSequences(tx, params.jobId, 1);
    const retryRequestedEvent = await insertJobEvent(tx, params.tenantId, params.jobId, startSeq, {
      eventType: "job.retry_requested",
      actorType,
      actorId: params.actorId ?? params.requestedBy,
      payload: {
        job_id: params.jobId,
        command_id: commandId,
        requested_by: params.requestedBy,
        reason_code: params.reasonCode ?? null,
        reuse_input: reuseInput,
        override: params.overrideJson ?? null,
      },
      correlationId: params.correlationId,
      idempotencyKey: `${params.idempotencyKey}:job-retry-requested`,
    });

    // 回读 command
    const [command] = await tx
      .select()
      .from(jobCommandTable)
      .where(eq(jobCommandTable.id, commandId))
      .limit(1);
    if (!command) {
      throw new Error(`createRetryCommand: JobCommand 行未找到（id=${commandId}）`);
    }

    return { command, retryRequestedEvent, replayed: false };
  });

  return result;
}

// ─── acknowledge / reject ───────────────────────────────────

/** acknowledge 入参。 */
export interface AcknowledgeCommandParams {
  tenantId: string;
  commandId: string;
  /** retry 命令：调度器创建的 replacement Job id（cancel 命令不需要）。 */
  replacementJobId?: string;
  /** 调度器内部 actor id。 */
  actorId?: string;
}

/**
 * 调度器确认 JobCommand（commandState: queued/dispatched → acknowledged）。
 *
 * 不变量：
 * - 命令已终态（acknowledged/rejected）抛 JobCommandAlreadyTerminalError。
 * - retry 命令的 replacementJobId 在 acknowledge 时回填。
 */
export async function acknowledgeCommand(params: AcknowledgeCommandParams): Promise<JobCommand> {
  const result = await db.transaction(async (tx) => {
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
      throw new JobCommandNotFoundError(params.commandId);
    }
    if (TERMINAL_COMMAND_STATES.includes(current.commandState)) {
      throw new JobCommandAlreadyTerminalError(params.commandId, current.commandState);
    }

    const updates: Partial<JobCommand> = {
      commandState: "acknowledged",
      acknowledgedAt: new Date(),
    };
    if (current.commandType === "retry" && params.replacementJobId) {
      updates.replacementJobId = params.replacementJobId;
    }

    await tx.update(jobCommandTable).set(updates).where(eq(jobCommandTable.id, params.commandId));

    const [updated] = await tx
      .select()
      .from(jobCommandTable)
      .where(eq(jobCommandTable.id, params.commandId))
      .limit(1);
    if (!updated) {
      throw new Error(`acknowledgeCommand: JobCommand 行未找到（id=${params.commandId}）`);
    }
    return updated;
  });

  return result;
}

/** reject 入参。 */
export interface RejectCommandParams {
  tenantId: string;
  commandId: string;
  errorCode: string;
  errorSummary?: string;
  actorId?: string;
}

/**
 * 调度器拒绝 JobCommand（commandState: queued/dispatched → rejected）。
 *
 * 拒绝原因码（§6.12）：
 * - JOB_ALREADY_TERMINAL：cancel 时 Job 已终态（race condition）
 * - JOB_RETRY_BLOCKED_BY_UNKNOWN_EFFECT：retry 时 unknown_effect 未核对
 * - JOB_OVERRIDE_NOT_ALLOWED：retry override 字段不被该 Job 类型支持
 * - JOB_INPUT_NO_LONGER_AVAILABLE：retry reuse_input 但输入已不可访问
 */
export async function rejectCommand(params: RejectCommandParams): Promise<JobCommand> {
  const result = await db.transaction(async (tx) => {
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
      throw new JobCommandNotFoundError(params.commandId);
    }
    if (TERMINAL_COMMAND_STATES.includes(current.commandState)) {
      throw new JobCommandAlreadyTerminalError(params.commandId, current.commandState);
    }

    await tx
      .update(jobCommandTable)
      .set({
        commandState: "rejected",
        errorCode: params.errorCode,
        errorSummary: params.errorSummary ?? null,
        acknowledgedAt: new Date(),
      })
      .where(eq(jobCommandTable.id, params.commandId));

    const [updated] = await tx
      .select()
      .from(jobCommandTable)
      .where(eq(jobCommandTable.id, params.commandId))
      .limit(1);
    if (!updated) {
      throw new Error(`rejectCommand: JobCommand 行未找到（id=${params.commandId}）`);
    }
    return updated;
  });

  return result;
}

// ─── 查询 ────────────────────────────────────────────────────

/** 按 id 获取 JobCommand。不存在返回 null。 */
export async function getJobCommandById(
  tenantId: string,
  commandId: string,
): Promise<JobCommand | null> {
  const [row] = await db
    .select()
    .from(jobCommandTable)
    .where(and(eq(jobCommandTable.tenantId, tenantId), eq(jobCommandTable.id, commandId)))
    .limit(1);
  return row ?? null;
}

/** 列出 Job 的全部 Command（按 createdAt 降序）。 */
export async function getJobCommands(
  tenantId: string,
  jobId: string,
  options?: { limit?: number },
): Promise<JobCommand[]> {
  return db
    .select()
    .from(jobCommandTable)
    .where(and(eq(jobCommandTable.tenantId, tenantId), eq(jobCommandTable.jobId, jobId)))
    .orderBy(desc(jobCommandTable.createdAt))
    .limit(options?.limit ?? 100);
}

/** 列出 Job 的 pending 命令（queued/dispatched 状态）。 */
export async function getPendingJobCommands(
  tenantId: string,
  jobId: string,
): Promise<JobCommand[]> {
  const all = await getJobCommands(tenantId, jobId);
  return all.filter((c) => !TERMINAL_COMMAND_STATES.includes(c.commandState));
}

// ─── re-export 供外部统一从本模块引入类型 ───────────────────

export type { JobCommand, JobCommandType, JobCommandState } from "@/lib/persistence/schema/job";
