import { db } from "@/lib/db/client";
import { evaluateJobCompletion } from "@/lib/job/completion-policy";
import { processCancelCommand, processRetryCommand } from "@/lib/job/job-control-queries";
import { allocateJobEventSequences, insertJobEvent } from "@/lib/job/job-event-queries";
import { recordJobResult, updateJobState } from "@/lib/job/job-queries";
import { effectRecordTable } from "@/lib/persistence/schema/effect";
import { invocationTable } from "@/lib/persistence/schema/executions";
import {
  JOB_TERMINAL_STATES,
  type Job,
  type JobCommand,
  jobCommandTable,
  jobTable,
} from "@/lib/persistence/schema/job";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
/** Durable JobCommand consumer. Job is the serialization root for business state. */
import { and, eq } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ConsumeJobCommandInput {
  tenantId: string;
  commandId: string;
  actorId?: string;
  /** Optional external verification for effects that are not represented locally. */
  unknownEffectVerifier?: (jobId: string) => Promise<boolean> | boolean;
}

export type ConsumeJobCommandResult =
  | {
      outcome: "terminal_applied" | "terminal_replayed" | "waiting_external" | "rejected";
      command: JobCommand;
      job: Job;
    }
  | {
      outcome:
        | "cancelled"
        | "waiting_invocations"
        | "rejected_unknown_effect"
        | "rejected_job_terminal"
        | "retry_created"
        | "rejected_override"
        | "rejected_input"
        | "rejected_job_not_terminal";
      command: JobCommand;
      job: Job;
      replacementJobId?: string | null;
    };

/** Consumes one durable command; a crashed transaction leaves the command retryable. */
export async function consumeJobCommand(
  input: ConsumeJobCommandInput,
): Promise<ConsumeJobCommandResult> {
  const [command] = await db
    .select()
    .from(jobCommandTable)
    .where(
      and(eq(jobCommandTable.tenantId, input.tenantId), eq(jobCommandTable.id, input.commandId)),
    )
    .limit(1);
  if (!command) throw new Error("JobCommand 不存在或跨租户不可见");
  if (command.commandType === "cancel") {
    const result = await processCancelCommand({
      tenantId: input.tenantId,
      commandId: input.commandId,
      actorId: input.actorId,
      unknownEffectVerifier: input.unknownEffectVerifier,
    });
    return { outcome: result.outcome, command: result.command, job: result.job };
  }
  if (command.commandType === "retry") {
    const result = await processRetryCommand({
      tenantId: input.tenantId,
      commandId: input.commandId,
      actorId: input.actorId,
      unknownEffectVerifier: input.unknownEffectVerifier,
    });
    return {
      outcome: result.outcome,
      command: result.command,
      job: result.originalJob,
      replacementJobId: result.replacementJob?.id ?? null,
    };
  }
  const externalEffectsResolved = input.unknownEffectVerifier
    ? await input.unknownEffectVerifier(command.jobId)
    : true;
  return consumeTerminalCommand(input, externalEffectsResolved);
}

async function consumeTerminalCommand(
  input: ConsumeJobCommandInput,
  externalEffectsResolved: boolean,
): Promise<
  Extract<
    ConsumeJobCommandResult,
    { outcome: "terminal_applied" | "terminal_replayed" | "waiting_external" | "rejected" }
  >
> {
  return db.transaction(async (tx) => {
    // The lock order is Job → JobCommand → Invocation → Effect facts.
    const [commandHeader] = await tx
      .select()
      .from(jobCommandTable)
      .where(
        and(eq(jobCommandTable.tenantId, input.tenantId), eq(jobCommandTable.id, input.commandId)),
      )
      .limit(1);
    if (!commandHeader) throw new Error("JobCommand 不存在或跨租户不可见");
    const [job] = await tx
      .select()
      .from(jobTable)
      .where(and(eq(jobTable.tenantId, input.tenantId), eq(jobTable.id, commandHeader.jobId)))
      .for("update")
      .limit(1);
    if (!job) throw new Error("Job 不存在或跨租户不可见");
    const [command] = await tx
      .select()
      .from(jobCommandTable)
      .where(
        and(
          eq(jobCommandTable.tenantId, input.tenantId),
          eq(jobCommandTable.id, commandHeader.id),
          eq(jobCommandTable.jobId, job.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!command) throw new Error("JobCommand 不存在或不属于目标 Job");
    if (command.commandType !== "execution_terminal" || !command.invocationId) {
      return {
        outcome: "rejected" as const,
        command: await rejectCommand(tx, command, "InputDigestMismatch"),
        job,
      };
    }
    if (command.commandState === "acknowledged" || command.commandState === "rejected") {
      return { outcome: "terminal_replayed" as const, command, job };
    }

    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, command.invocationId),
          eq(invocationTable.jobId, job.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!invocation) {
      return {
        outcome: "rejected" as const,
        command: await rejectCommand(tx, command, "InputDigestMismatch"),
        job,
      };
    }
    const payload = command.payloadJson as Record<string, unknown>;
    if (
      command.payloadHash !== protocolDigest(payload) ||
      payload.invocationId !== invocation.id ||
      payload.terminalState !== invocation.executionState ||
      payload.terminalVersion !== invocation.versionNo ||
      payload.resultRef !== invocation.resultRef ||
      payload.resultDigest !== invocation.resultDigest ||
      payload.errorCode !== invocation.errorCode
    ) {
      return {
        outcome: "rejected" as const,
        command: await rejectCommand(tx, command, "InputDigestMismatch"),
        job,
      };
    }
    if (!JOB_TERMINAL_STATES.includes(job.jobState) && !externalEffectsResolved) {
      const nextAttemptAt = new Date(Date.now() + 30_000);
      const waitingJob = await moveJobToWaiting(tx, job, invocation.id, input.actorId);
      const waitingCommand = await updateCommand(tx, command, {
        commandState: "waiting",
        nextAttemptAt,
        lastErrorCode: "EffectUnresolved",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      return { outcome: "waiting_external" as const, command: waitingCommand, job: waitingJob };
    }
    // 关联执行范围内的未确定外部 Effect：按 EffectRecord.invocationId 直接读取两类
    // owner（tool_call 与 job_step），不再 INNER JOIN ToolCall，否则 job_step Effect
    // 会被静默丢弃。Unknown 一律等待，绝不伪成功也绝不当作失败重跑。
    let hasUnknownEffect = false;
    if (!JOB_TERMINAL_STATES.includes(job.jobState)) {
      const [unknown] = await tx
        .select({ id: effectRecordTable.id })
        .from(effectRecordTable)
        .where(
          and(
            eq(effectRecordTable.tenantId, input.tenantId),
            eq(effectRecordTable.invocationId, invocation.id),
            eq(effectRecordTable.effectState, "unknown_effect"),
          ),
        )
        .limit(1);
      hasUnknownEffect = Boolean(unknown);
      if (hasUnknownEffect) {
        const nextAttemptAt = new Date(Date.now() + 30_000);
        const waitingJob = await moveJobToWaiting(tx, job, invocation.id, input.actorId);
        const waitingCommand = await updateCommand(tx, command, {
          commandState: "waiting",
          nextAttemptAt,
          lastErrorCode: "EffectUnresolved",
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        return { outcome: "waiting_external" as const, command: waitingCommand, job: waitingJob };
      }
    } else {
      // Job 已终态：命令仍须幂等确认（acknowledged/noop）并保存处理结果，
      // 不能每次返回 terminal_replayed 却永久留 queued/waiting。
      return {
        outcome: "terminal_replayed" as const,
        command: await acknowledgeReplayedCommand(tx, command, job.jobState),
        job,
      };
    }

    let currentJob = job;
    if (currentJob.jobState === "queued") {
      currentJob = await updateJobState(
        tx,
        input.tenantId,
        currentJob.id,
        "running",
        currentJob.versionNo,
      );
      await appendJobEvent(
        tx,
        currentJob,
        "job.started",
        { invocationId: invocation.id },
        input.actorId,
      );
    }
    if (
      !(["completed", "failed", "cancelled", "lost"] as string[]).includes(
        invocation.executionState,
      )
    ) {
      return {
        outcome: "rejected" as const,
        command: await rejectCommand(tx, command, "InputDigestMismatch"),
        job: currentJob,
      };
    }

    // R06 §5：终态不由"顶层 Invocation completed"直接映射。按 Job 创建时冻结的
    // completionPolicyJson 与**必需子执行集合**判定；Unknown 已在上方先行等待。
    const decision = await evaluateJobCompletion(
      {
        tenantId: input.tenantId,
        jobId: currentJob.id,
        invocationId: invocation.id,
        policyJson: currentJob.completionPolicyJson,
        rootInvocation: {
          executionState: invocation.executionState,
          resultRef: invocation.resultRef,
          resultDigest: invocation.resultDigest,
          errorCode: invocation.errorCode,
        },
        hasUnknownEffect,
      },
      tx,
    );

    if (decision.kind === "waiting_external") {
      const nextAttemptAt = new Date(Date.now() + 30_000);
      const waitingJob = await moveJobToWaiting(
        tx,
        currentJob,
        invocation.id,
        input.actorId,
        decision.reasonCode,
      );
      const waitingCommand = await updateCommand(tx, command, {
        commandState: "waiting",
        nextAttemptAt,
        lastErrorCode: decision.reasonCode,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      return { outcome: "waiting_external" as const, command: waitingCommand, job: waitingJob };
    }

    if (decision.kind === "cancelled") {
      currentJob = await updateJobState(
        tx,
        input.tenantId,
        currentJob.id,
        "cancelled",
        currentJob.versionNo,
      );
      await appendJobEvent(
        tx,
        currentJob,
        "job.cancelled",
        { invocationId: invocation.id, reasonCode: decision.reasonCode },
        input.actorId,
      );
    } else if (decision.kind === "completed") {
      if (!invocation.resultRef || !invocation.resultDigest)
        return {
          outcome: "rejected" as const,
          command: await rejectCommand(tx, command, "InputDigestMismatch"),
          job: currentJob,
        };
      const withResult = await recordJobResult(
        tx,
        input.tenantId,
        currentJob.id,
        { resultRef: invocation.resultRef, resultHash: invocation.resultDigest },
        {
          actorType: "service",
          actorId: input.actorId ?? "job-command-consumer",
          idempotencyKey: command.id,
        },
      );
      currentJob = await updateJobState(
        tx,
        input.tenantId,
        currentJob.id,
        "completed",
        withResult.job.versionNo,
      );
      await appendJobEvent(
        tx,
        currentJob,
        "job.completed",
        {
          invocationId: invocation.id,
          resultRef: invocation.resultRef,
          resultDigest: invocation.resultDigest,
          completionPolicy: decision.reasonCode,
          requiredMembers: decision.members.members.length,
        },
        input.actorId,
      );
    } else {
      currentJob = await updateJobState(
        tx,
        input.tenantId,
        currentJob.id,
        "failed",
        currentJob.versionNo,
      );
      await tx
        .update(jobTable)
        .set({
          errorCode: decision.reasonCode,
          errorSummary: invocation.errorSummary,
          updatedAt: new Date(),
        })
        .where(eq(jobTable.id, currentJob.id));
      // 回读失败字段：错误码是随本次收口提交的事实，返回值必须与落库一致，
      // 否则调用方拿到的 `result.job` 会缺 `errorCode`（与库里的终态不自洽）。
      const [failedJob] = await tx
        .select()
        .from(jobTable)
        .where(eq(jobTable.id, currentJob.id))
        .limit(1);
      if (failedJob) currentJob = failedJob;
      await appendJobEvent(
        tx,
        currentJob,
        "job.failed",
        {
          invocationId: invocation.id,
          reasonCode: decision.reasonCode,
          errorCode: invocation.errorCode,
          errorSummary: invocation.errorSummary,
        },
        input.actorId,
      );
    }
    const acknowledged = await updateCommand(tx, command, {
      commandState: "acknowledged",
      completedAt: new Date(),
      resultJson: {
        terminalState: invocation.executionState,
        invocationId: invocation.id,
        completionReason: decision.reasonCode,
      },
      lastErrorCode: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    return { outcome: "terminal_applied" as const, command: acknowledged, job: currentJob };
  });
}

/**
 * Job 已终态时对迟到/重复终态命令的幂等确认。
 *
 * R06 §4：不能每次返回 `terminal_replayed` 却把命令永久留在 queued/waiting
 * ——那会让队列永远无法排空。这里按当前 Job 终态落一条持久处理结果。
 */
async function acknowledgeReplayedCommand(
  tx: Tx,
  command: JobCommand,
  jobState: string,
): Promise<JobCommand> {
  if (command.commandState === "acknowledged" || command.commandState === "rejected")
    return command;
  return updateCommand(tx, command, {
    commandState: "acknowledged",
    completedAt: new Date(),
    resultJson: { terminalState: jobState, replayedAgainstTerminalJob: true },
    lastErrorCode: null,
    leaseOwner: null,
    leaseExpiresAt: null,
  });
}

async function moveJobToWaiting(
  tx: Tx,
  job: Job,
  invocationId: string,
  actorId?: string,
  reasonCode = "EffectUnresolved",
): Promise<Job> {
  if (job.jobState === "waiting_external") return job;
  let current = job;
  if (current.jobState === "queued") {
    current = await updateJobState(tx, job.tenantId, job.id, "running", current.versionNo);
    await appendJobEvent(tx, current, "job.started", { invocationId }, actorId);
  }
  current = await updateJobState(tx, job.tenantId, job.id, "waiting_external", current.versionNo);
  await appendJobEvent(tx, current, "job.waiting_external", { invocationId, reasonCode }, actorId);
  return current;
}

async function updateCommand(
  tx: Tx,
  command: JobCommand,
  updates: Partial<JobCommand>,
): Promise<JobCommand> {
  await tx
    .update(jobCommandTable)
    .set({ ...updates, versionNo: command.versionNo + 1, updatedAt: new Date() })
    .where(eq(jobCommandTable.id, command.id));
  const [updated] = await tx
    .select()
    .from(jobCommandTable)
    .where(eq(jobCommandTable.id, command.id))
    .limit(1);
  if (!updated) throw new Error("JobCommand 更新后回查失败");
  return updated;
}

async function rejectCommand(tx: Tx, command: JobCommand, errorCode: string): Promise<JobCommand> {
  return updateCommand(tx, command, {
    commandState: "rejected",
    lastErrorCode: errorCode,
    completedAt: new Date(),
    resultJson: { errorCode },
    leaseOwner: null,
    leaseExpiresAt: null,
  });
}

async function appendJobEvent(
  tx: Tx,
  job: Job,
  eventType: string,
  payload: Record<string, unknown>,
  actorId?: string,
): Promise<void> {
  const sequence = await allocateJobEventSequences(tx, job.id, 1);
  await insertJobEvent(tx, job.tenantId, job.id, sequence, {
    eventType,
    actorType: "service",
    actorId: actorId ?? "job-command-consumer",
    payload,
    idempotencyKey: `${eventType}:${payload.commandId ?? payload.invocationId ?? job.id}`,
  });
}
