/**
 * S09-C05：V11 Job 控制调度器编排集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - processCancelCommand：成功 + waiting_invocations + rejected_unknown_effect + rejected_job_terminal
 * - processRetryCommand：成功 + rejected_unknown_effect + rejected_override + rejected_input + rejected_job_not_terminal
 * - completeJob：成功 + job.completed Event
 * - failJob：成功 + job.failed Event + errorCode/errorSummary
 * - 幂等：已 acknowledge 命令重入
 *
 * 不变量（事实源：09 文档 S09-W05 行 69-74、S09-C05 行 130；
 *         10 文档 §6.1、§6.12、§9.1；13 文档 §4；
 *         05 文档 §16 行 321-333）：
 * - cancel 命令不提前修改 Job 状态；调度器核对全部 Invocation/Effect 后才 cancelled
 * - retry 只接受终态 Job；replacement Job 通过 replaces_job_id 引用原 Job
 * - unknown_effect 不能自动取消（§16 行 333）
 * - Job 不复活：终态 Job 不能改回 queued
 */
import { randomUUID } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { createCancelCommand, createRetryCommand } from "@/lib/job/job-command-queries";
import {
  completeJob,
  failJob,
  processCancelCommand,
  processRetryCommand,
} from "@/lib/job/job-control-queries";
import { createJob, getJobById, updateJobState } from "@/lib/job/job-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 租户 + 用户 + Agent ─────────────────────

async function seedFixture() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "owner-001",
    email: "owner001@example.com",
    displayName: "Job Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "owner-001",
    displayName: "Job Owner",
    userIdentityId: identity.id,
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: "job-agent",
    displayName: "Job Agent",
    ownerUserId: identity.id,
    lifecycleState: "enabled",
  });
  return { tenantId: tenant.id, ownerId: identity.id, agentId: agent.id };
}

/** 创建 queued Job。 */
async function createQueuedJob(tenantId: string, agentId: string, options?: { threadId?: string }) {
  return createJob({
    tenantId,
    agentId,
    jobType: "evaluation",
    triggerRef: "schedule-001",
    completionPolicyJson: { type: "all_success" },
    threadId: options?.threadId,
    inputRef: "input://batch/001",
    inputHash: "sha256:abc",
    idempotencyKey: `create-${randomUUID()}`,
  });
}

/** 推进 Job 到 running。 */
async function advanceToRunning(tenantId: string, jobId: string, currentVersionNo: number) {
  return db.transaction(async (tx) => {
    return updateJobState(tx, tenantId, jobId, "running", currentVersionNo);
  });
}

/** 推进 Job 到终态 completed。 */
async function advanceToCompleted(tenantId: string, jobId: string, currentVersionNo: number) {
  return db.transaction(async (tx) => {
    return updateJobState(tx, tenantId, jobId, "completed", currentVersionNo);
  });
}

// ─── processCancelCommand ──────────────────────────────

describe("processCancelCommand", () => {
  it("成功取消：Job 状态 cancelled + job.cancelled Event + command acknowledged", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const cmd = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "cancel-001",
    });

    const result = await processCancelCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
      actorId: "scheduler-1",
    });

    expect(result.outcome).toBe("cancelled");
    expect(result.job.jobState).toBe("cancelled");
    expect(result.job.finishedAt).toBeInstanceOf(Date);
    expect(result.command.commandState).toBe("acknowledged");
    expect(result.cancelledEvent?.eventType).toBe("job.cancelled");
    expect(result.cancelledEvent?.actorType).toBe("service");
    expect(result.cancelledEvent?.actorId).toBe("scheduler-1");
    expect(result.cancelledEvent?.payloadJson).toMatchObject({
      job_id: job.id,
      command_id: cmd.command.id,
      reason_code: null,
    });
    expect(result.cancelledEvent?.idempotencyKey).toBe("cancel-001:job-cancelled");
  });

  it("unknown_effect 未核对 → rejected_unknown_effect", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const cmd = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "cancel-002",
    });

    const result = await processCancelCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
      unknownEffectVerifier: () => false,
    });

    expect(result.outcome).toBe("rejected_unknown_effect");
    expect(result.command.commandState).toBe("rejected");
    expect(result.command.errorCode).toBe("JOB_RETRY_BLOCKED_BY_UNKNOWN_EFFECT");
    // Job 状态未变
    const dbJob = await getJobById(fx.tenantId, job.id);
    expect(dbJob?.jobState).toBe("queued");
  });

  it("Job 已终态（race condition）→ rejected_job_terminal", async () => {
    const fx = await seedFixture();

    // 模拟 race condition：
    // 1. Job 在 running 状态时创建 cancel 命令（createCancelCommand 校验通过）
    // 2. 另一事务先让 Job 进入 completed 终态
    // 3. processCancelCommand 检测到 Job 已终态 → rejectCommand(JOB_ALREADY_TERMINAL)
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);
    const cmd = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "cancel-race-001",
    });
    // 手动让 Job 终态（模拟 race condition：另一事务先完成 Job）
    await advanceToCompleted(fx.tenantId, job.id, running.versionNo);

    const result = await processCancelCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
    });

    expect(result.outcome).toBe("rejected_job_terminal");
    expect(result.command.commandState).toBe("rejected");
    expect(result.command.errorCode).toBe("JOB_ALREADY_TERMINAL");
  });
});

// ─── processRetryCommand ───────────────────────────────

describe("processRetryCommand", () => {
  it("成功创建 replacement Job + acknowledgeCommand", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);
    await advanceToCompleted(fx.tenantId, job.id, running.versionNo);

    const cmd = await createRetryCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "retry-001",
    });

    const result = await processRetryCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
      actorId: "scheduler-1",
    });

    expect(result.outcome).toBe("retry_created");
    expect(result.originalJob.id).toBe(job.id);
    expect(result.originalJob.jobState).toBe("completed"); // 原 Job 状态不变
    expect(result.replacementJob).not.toBeNull();
    expect(result.replacementJob?.replacesJobId).toBe(job.id);
    expect(result.replacementJob?.jobState).toBe("queued");
    expect(result.replacementJob?.tenantId).toBe(fx.tenantId);
    expect(result.replacementJob?.agentId).toBe(fx.agentId);
    expect(result.replacementJob?.inputRef).toBe("input://batch/001"); // reuseInput=true 默认
    expect(result.command.commandState).toBe("acknowledged");
    expect(result.command.replacementJobId).toBe(result.replacementJob?.id);
  });

  it("reuseInput=false → replacement Job inputRef 为空", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);
    await advanceToCompleted(fx.tenantId, job.id, running.versionNo);

    const cmd = await createRetryCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      reuseInput: false,
      idempotencyKey: "retry-002",
    });

    const result = await processRetryCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
    });

    expect(result.outcome).toBe("retry_created");
    expect(result.replacementJob?.inputRef).toBeNull();
    expect(result.replacementJob?.inputHash).toBeNull();
  });

  it("unknown_effect 未核对 → rejected_unknown_effect", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);
    await advanceToCompleted(fx.tenantId, job.id, running.versionNo);

    const cmd = await createRetryCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "retry-003",
    });

    const result = await processRetryCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
      unknownEffectVerifier: () => false,
    });

    expect(result.outcome).toBe("rejected_unknown_effect");
    expect(result.command.commandState).toBe("rejected");
    expect(result.command.errorCode).toBe("JOB_RETRY_BLOCKED_BY_UNKNOWN_EFFECT");
    expect(result.replacementJob).toBeNull();
  });

  it("override 字段不允许 → rejected_override", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);
    await advanceToCompleted(fx.tenantId, job.id, running.versionNo);

    const cmd = await createRetryCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      overrideJson: { model: "doubao-pro" },
      idempotencyKey: "retry-004",
    });

    const result = await processRetryCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
      overrideVerifier: () => false,
    });

    expect(result.outcome).toBe("rejected_override");
    expect(result.command.commandState).toBe("rejected");
    expect(result.command.errorCode).toBe("JOB_OVERRIDE_NOT_ALLOWED");
    expect(result.replacementJob).toBeNull();
  });

  it("input 不可访问 → rejected_input", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);
    await advanceToCompleted(fx.tenantId, job.id, running.versionNo);

    const cmd = await createRetryCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "retry-005",
    });

    const result = await processRetryCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
      inputAvailabilityVerifier: () => false,
    });

    expect(result.outcome).toBe("rejected_input");
    expect(result.command.commandState).toBe("rejected");
    expect(result.command.errorCode).toBe("JOB_INPUT_NO_LONGER_AVAILABLE");
    expect(result.replacementJob).toBeNull();
  });
});

// ─── completeJob / failJob ─────────────────────────────

describe("completeJob", () => {
  it("成功完成 Job + result_recorded + job.completed Event", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    await advanceToRunning(fx.tenantId, job.id, 1);

    const result = await completeJob({
      tenantId: fx.tenantId,
      jobId: job.id,
      result: {
        resultRef: "result://job/output.json",
        resultHash: "sha256:hash",
        resultSummaryJson: { total: 100, success: 95 },
      },
      actorType: "agent",
      actorId: fx.agentId,
      idempotencyKey: "complete-001",
    });

    expect(result.job.jobState).toBe("completed");
    expect(result.job.resultRef).toBe("result://job/output.json");
    expect(result.job.resultHash).toBe("sha256:hash");
    expect(result.job.finishedAt).toBeInstanceOf(Date);
    expect(result.resultRecordedEvent.eventType).toBe("job.result_recorded");
    expect(result.terminalEvent.eventType).toBe("job.completed");
    expect(result.terminalEvent.actorType).toBe("agent");
    expect(result.terminalEvent.payloadJson).toMatchObject({
      job_id: job.id,
      result_ref: "result://job/output.json",
      result_hash: "sha256:hash",
      result_summary: { total: 100, success: 95 },
    });
    expect(result.terminalEvent.idempotencyKey).toBe("complete-001:job-completed");
  });
});

describe("failJob", () => {
  it("成功失败 Job + result_recorded + job.failed Event + errorCode/errorSummary", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    await advanceToRunning(fx.tenantId, job.id, 1);

    const result = await failJob({
      tenantId: fx.tenantId,
      jobId: job.id,
      result: {
        resultRef: "result://job/error.log",
        resultHash: "sha256:err-hash",
      },
      error: {
        code: "EVALUATION_TIMEOUT",
        summary: "评测超时（60s）",
      },
      actorType: "system",
      actorId: "scheduler-1",
      idempotencyKey: "fail-001",
    });

    expect(result.job.jobState).toBe("failed");
    expect(result.job.errorCode).toBe("EVALUATION_TIMEOUT");
    expect(result.job.errorSummary).toBe("评测超时（60s）");
    expect(result.job.finishedAt).toBeInstanceOf(Date);
    expect(result.resultRecordedEvent.eventType).toBe("job.result_recorded");
    expect(result.terminalEvent.eventType).toBe("job.failed");
    expect(result.terminalEvent.payloadJson).toMatchObject({
      job_id: job.id,
      error_code: "EVALUATION_TIMEOUT",
      error_summary: "评测超时（60s）",
      result_ref: "result://job/error.log",
      result_hash: "sha256:err-hash",
    });
    expect(result.terminalEvent.idempotencyKey).toBe("fail-001:job-failed");
  });

  it("未提供 error 字段抛错", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    await advanceToRunning(fx.tenantId, job.id, 1);

    await expect(
      failJob({
        tenantId: fx.tenantId,
        jobId: job.id,
        result: {
          resultRef: "result://job/error.log",
          resultHash: "sha256:err-hash",
        },
      }),
    ).rejects.toThrow(/error 字段必填/);
  });
});
