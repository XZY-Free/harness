/**
 * S09-C04：V11 Job 仓储集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - createJob：成功 + queued Event + lastEventSequence=1；参数校验
 * - getJobById：成功 + 跨租户隔离
 * - listJobsByAgent / listJobsByState / listTerminalJobsByAgent
 * - updateJobState：状态机合法转换 + 非法转换 + 终态拒绝 + 乐观锁
 * - recordJobResult：写 resultRef/resultHash + result_recorded Event
 * - allocateJobEventSequences：原子递增 + FOR UPDATE 锁
 * - insertJobEvent / getJobEvents / getJobEventsSince / getLatestJobEventSequence
 * - createCancelCommand：成功 + cancel_requested Event + 幂等 + Job 终态拒绝
 * - createRetryCommand：成功 + retry_requested Event + 幂等 + Job 非终态拒绝
 * - acknowledgeCommand / rejectCommand：状态转换 + replacementJobId 回填
 * - getJobCommands / getPendingJobCommands / getJobCommandById
 *
 * 不变量（事实源：09 文档 S09-W04 行 62-67、S09-C04 行 129；
 *         10 文档 §6.1、§6.12、§9.1；13 文档 §4）：
 * - Job 创建只能来自所属领域服务（评测/知识/调度/批量）；不提供通用 POST /jobs 入口
 * - Job 不复活：终态 Job 不能改回 queued；retry 通过 replaces_job_id 创建新 Job
 * - JobEvent sequence 通过 SELECT FOR UPDATE Job.last_event_sequence 原子递增
 * - JobCommand UNIQUE(jobId, idempotencyKey)：相同命令重放返回原结果
 * - cancel 命令要求 Job 非终态；retry 命令要求 Job 终态
 * - 跨租户隔离：所有查询按 tenantId 过滤
 */
import { randomUUID } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  JobAlreadyTerminalError,
  JobCommandAlreadyTerminalError,
  JobCommandNotFoundError,
  JobNotFoundError,
  JobNotTerminalError,
  JobStateConflictError,
  JobVersionConflictError,
} from "@/lib/v11/job/errors";
import {
  acknowledgeCommand,
  createCancelCommand,
  createRetryCommand,
  getJobCommandById,
  getJobCommands,
  getPendingJobCommands,
  rejectCommand,
} from "@/lib/v11/job/job-command-queries";
import {
  allocateJobEventSequences,
  getJobEvents,
  getJobEventsSince,
  getLatestJobEventSequence,
  insertJobEvent,
} from "@/lib/v11/job/job-event-queries";
import {
  createJob,
  getJobById,
  listJobsByAgent,
  listJobsByState,
  listTerminalJobsByAgent,
  recordJobResult,
  updateJobState,
} from "@/lib/v11/job/job-queries";
import { v11Job } from "@/lib/v11/schema/job";
import { eq } from "drizzle-orm";
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

/** 创建一个 queued Job（带默认参数）。 */
async function createQueuedJob(
  tenantId: string,
  agentId: string,
  options?: {
    jobType?: "scheduled" | "batch" | "deployment" | "evaluation" | "knowledge_build" | "system";
    triggerRef?: string;
    threadId?: string;
    replacesJobId?: string;
    inputRef?: string;
    inputHash?: string;
    createdBy?: string;
    idempotencyKey?: string;
  },
) {
  return createJob({
    tenantId,
    agentId,
    jobType: options?.jobType ?? "evaluation",
    triggerRef: options?.triggerRef ?? "schedule-001",
    completionPolicyJson: { type: "all_success" },
    threadId: options?.threadId,
    replacesJobId: options?.replacesJobId,
    inputRef: options?.inputRef ?? "input://batch/001",
    inputHash: options?.inputHash ?? "sha256:abc",
    createdBy: options?.createdBy,
    idempotencyKey: options?.idempotencyKey,
  });
}

/** 将 Job 从 queued 推进到 running。 */
async function advanceToRunning(tenantId: string, jobId: string, currentVersionNo: number) {
  return db.transaction(async (tx) => {
    return updateJobState(tx, tenantId, jobId, "running", currentVersionNo);
  });
}

/** 将 Job 从 running 推进到 completed。 */
async function advanceToCompleted(tenantId: string, jobId: string, currentVersionNo: number) {
  return db.transaction(async (tx) => {
    return updateJobState(tx, tenantId, jobId, "completed", currentVersionNo);
  });
}

// ─── createJob 成功路径 ─────────────────────────────────

describe("createJob 成功路径", () => {
  it("成功创建 Job + queued Event + lastEventSequence=1", async () => {
    const fx = await seedFixture();

    const result = await createQueuedJob(fx.tenantId, fx.agentId, {
      idempotencyKey: "create-001",
    });

    // Job 校验
    expect(result.job.tenantId).toBe(fx.tenantId);
    expect(result.job.agentId).toBe(fx.agentId);
    expect(result.job.jobType).toBe("evaluation");
    expect(result.job.triggerRef).toBe("schedule-001");
    expect(result.job.jobState).toBe("queued");
    expect(result.job.completionPolicyJson).toMatchObject({ type: "all_success" });
    expect(result.job.replacesJobId).toBeNull();
    expect(result.job.threadId).toBeNull();
    expect(result.job.inputRef).toBe("input://batch/001");
    expect(result.job.inputHash).toBe("sha256:abc");
    expect(result.job.lastEventSequence).toBe(1);
    expect(result.job.resultRef).toBeNull();
    expect(result.job.resultHash).toBeNull();
    expect(result.job.errorCode).toBeNull();
    expect(result.job.startedAt).toBeNull();
    expect(result.job.finishedAt).toBeNull();
    expect(result.job.versionNo).toBe(1);

    // queued Event 校验
    expect(result.queuedEvent.tenantId).toBe(fx.tenantId);
    expect(result.queuedEvent.jobId).toBe(result.job.id);
    expect(result.queuedEvent.eventSequence).toBe(1);
    expect(result.queuedEvent.eventType).toBe("job.queued");
    expect(result.queuedEvent.actorType).toBe("system");
    expect(result.queuedEvent.payloadJson).toMatchObject({
      job_id: result.job.id,
      tenant_id: fx.tenantId,
      agent_id: fx.agentId,
      job_type: "evaluation",
      trigger_ref: "schedule-001",
      thread_id: null,
      replaces_job_id: null,
      completion_policy: { type: "all_success" },
      input_ref: "input://batch/001",
      input_hash: "sha256:abc",
      created_by: null,
    });
    expect(result.queuedEvent.idempotencyKey).toBe("create-001:job-queued");
  });

  it("replaces_job_id + threadId + createdBy 透传到 Job + Event", async () => {
    const fx = await seedFixture();

    // 先创建原 Job 并推进到 failed 终态
    const original = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, original.job.id, 1);
    // 直接通过 updateJobState 转 failed（running → failed 是合法转换）
    const failed = await db.transaction(async (tx) => {
      return updateJobState(tx, fx.tenantId, original.job.id, "failed", running.versionNo);
    });

    // 创建 replacement Job
    const replacement = await createJob({
      tenantId: fx.tenantId,
      agentId: fx.agentId,
      jobType: "evaluation",
      triggerRef: "schedule-001",
      completionPolicyJson: { type: "all_success" },
      threadId: "thread-001",
      replacesJobId: failed.id,
      inputRef: "input://batch/001",
      inputHash: "sha256:abc",
      createdBy: fx.ownerId,
      idempotencyKey: "replace-001",
    });

    expect(replacement.job.replacesJobId).toBe(failed.id);
    expect(replacement.job.threadId).toBe("thread-001");
    expect(replacement.job.createdBy).toBe(fx.ownerId);
    expect(replacement.queuedEvent.payloadJson).toMatchObject({
      thread_id: "thread-001",
      replaces_job_id: failed.id,
      created_by: fx.ownerId,
    });
  });
});

// ─── createJob 参数校验 ─────────────────────────────────

describe("createJob 参数校验", () => {
  it("tenantId 为空抛错", async () => {
    const fx = await seedFixture();
    await expect(
      createJob({
        tenantId: "",
        agentId: fx.agentId,
        jobType: "evaluation",
        triggerRef: "schedule-001",
        completionPolicyJson: { type: "all_success" },
      }),
    ).rejects.toThrow(/tenantId 不能为空/);
  });

  it("agentId 为空抛错", async () => {
    const fx = await seedFixture();
    await expect(
      createJob({
        tenantId: fx.tenantId,
        agentId: "",
        jobType: "evaluation",
        triggerRef: "schedule-001",
        completionPolicyJson: { type: "all_success" },
      }),
    ).rejects.toThrow(/agentId 不能为空/);
  });

  it("triggerRef 为空抛错", async () => {
    const fx = await seedFixture();
    await expect(
      createJob({
        tenantId: fx.tenantId,
        agentId: fx.agentId,
        jobType: "evaluation",
        triggerRef: "",
        completionPolicyJson: { type: "all_success" },
      }),
    ).rejects.toThrow(/triggerRef 不能为空/);
  });

  it("completionPolicyJson 缺失抛错", async () => {
    const fx = await seedFixture();
    await expect(
      createJob({
        tenantId: fx.tenantId,
        agentId: fx.agentId,
        jobType: "evaluation",
        triggerRef: "schedule-001",
        completionPolicyJson: undefined as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(/completionPolicyJson 不能为空/);
  });
});

// ─── 查询：getJobById / listJobsByAgent ────────────────

describe("查询函数", () => {
  it("getJobById 命中同租户；跨租户返回 null", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    const found = await getJobById(fx.tenantId, job.id);
    expect(found?.id).toBe(job.id);

    // 跨租户查询（伪造 tenantId）
    const crossTenant = await getJobById(randomUUID(), job.id);
    expect(crossTenant).toBeNull();
  });

  it("getJobById 不存在返回 null", async () => {
    const fx = await seedFixture();
    const found = await getJobById(fx.tenantId, randomUUID());
    expect(found).toBeNull();
  });

  it("listJobsByAgent 按 createdAt 降序 + 状态过滤", async () => {
    const fx = await seedFixture();
    const j1 = await createQueuedJob(fx.tenantId, fx.agentId);
    // 加微小延迟保证 createdAt 不同
    await new Promise((r) => setTimeout(r, 10));
    const j2 = await createQueuedJob(fx.tenantId, fx.agentId);

    const all = await listJobsByAgent(fx.tenantId, fx.agentId);
    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBe(j2.job.id); // 最新的在前
    expect(all[1]?.id).toBe(j1.job.id);

    // 按状态过滤
    const queuedOnly = await listJobsByAgent(fx.tenantId, fx.agentId, { jobState: "queued" });
    expect(queuedOnly).toHaveLength(2);
    const runningOnly = await listJobsByAgent(fx.tenantId, fx.agentId, { jobState: "running" });
    expect(runningOnly).toHaveLength(0);
  });

  it("listJobsByState 按状态过滤", async () => {
    const fx = await seedFixture();
    const j1 = await createQueuedJob(fx.tenantId, fx.agentId);
    const j2 = await createQueuedJob(fx.tenantId, fx.agentId);

    // 把 j1 推进到 running
    await advanceToRunning(fx.tenantId, j1.job.id, 1);

    const queued = await listJobsByState(fx.tenantId, "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.id).toBe(j2.job.id);

    const running = await listJobsByState(fx.tenantId, "running");
    expect(running).toHaveLength(1);
    expect(running[0]?.id).toBe(j1.job.id);
  });

  it("listTerminalJobsByAgent 只返回终态 Job", async () => {
    const fx = await seedFixture();
    const j1 = await createQueuedJob(fx.tenantId, fx.agentId);
    const j2 = await createQueuedJob(fx.tenantId, fx.agentId);
    const j3 = await createQueuedJob(fx.tenantId, fx.agentId);

    // j1 → running → completed
    const j1Running = await advanceToRunning(fx.tenantId, j1.job.id, 1);
    await advanceToCompleted(fx.tenantId, j1.job.id, j1Running.versionNo);

    // j2 → running（非终态）
    await advanceToRunning(fx.tenantId, j2.job.id, 1);

    // j3 仍 queued（非终态）
    void j3;

    const terminal = await listTerminalJobsByAgent(fx.tenantId, fx.agentId);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.id).toBe(j1.job.id);
    expect(terminal[0]?.jobState).toBe("completed");
  });
});

// ─── updateJobState 状态机 ──────────────────────────────

describe("updateJobState 状态机", () => {
  it("queued → running：合法 + startedAt 写入", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    const updated = await advanceToRunning(fx.tenantId, job.id, 1);
    expect(updated.jobState).toBe("running");
    expect(updated.startedAt).toBeInstanceOf(Date);
    expect(updated.finishedAt).toBeNull();
    expect(updated.versionNo).toBe(2);
  });

  it("running → waiting_external → running：合法", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);

    const waiting = await db.transaction(async (tx) => {
      return updateJobState(tx, fx.tenantId, job.id, "waiting_external", running.versionNo);
    });
    expect(waiting.jobState).toBe("waiting_external");

    const rerunning = await db.transaction(async (tx) => {
      return updateJobState(tx, fx.tenantId, job.id, "running", waiting.versionNo);
    });
    expect(rerunning.jobState).toBe("running");
    // startedAt 不重写
    expect(rerunning.startedAt?.getTime()).toBe(running.startedAt?.getTime());
  });

  it("running → completed：合法 + finishedAt 写入", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);

    const completed = await advanceToCompleted(fx.tenantId, job.id, running.versionNo);
    expect(completed.jobState).toBe("completed");
    expect(completed.finishedAt).toBeInstanceOf(Date);
    expect(completed.versionNo).toBe(3);
  });

  it("running → failed：合法 + finishedAt 写入", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);

    const failed = await db.transaction(async (tx) => {
      return updateJobState(tx, fx.tenantId, job.id, "failed", running.versionNo);
    });
    expect(failed.jobState).toBe("failed");
    expect(failed.finishedAt).toBeInstanceOf(Date);
  });

  it("queued → cancelled：合法（未启动直接取消）", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    const cancelled = await db.transaction(async (tx) => {
      return updateJobState(tx, fx.tenantId, job.id, "cancelled", 1);
    });
    expect(cancelled.jobState).toBe("cancelled");
    expect(cancelled.finishedAt).toBeInstanceOf(Date);
  });

  it("非法转换 queued → completed 抛 JobStateConflictError", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    await expect(
      db.transaction(async (tx) => {
        return updateJobState(tx, fx.tenantId, job.id, "completed", 1);
      }),
    ).rejects.toMatchObject({ name: "JobStateConflictError" });
  });

  it("非法转换 running → queued 抛 JobStateConflictError", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);

    await expect(
      db.transaction(async (tx) => {
        return updateJobState(tx, fx.tenantId, job.id, "queued", running.versionNo);
      }),
    ).rejects.toMatchObject({ name: "JobStateConflictError" });
  });

  it("终态不可恢复：completed → running 抛 JobStateConflictError", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);
    const completed = await advanceToCompleted(fx.tenantId, job.id, running.versionNo);

    await expect(
      db.transaction(async (tx) => {
        return updateJobState(tx, fx.tenantId, job.id, "running", completed.versionNo);
      }),
    ).rejects.toMatchObject({ name: "JobStateConflictError" });
  });

  it("乐观锁冲突抛 JobVersionConflictError", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    await expect(
      db.transaction(async (tx) => {
        return updateJobState(tx, fx.tenantId, job.id, "running", 999); // 错误 versionNo
      }),
    ).rejects.toMatchObject({ name: "JobVersionConflictError" });
  });

  it("Job 不存在抛 JobNotFoundError", async () => {
    const fx = await seedFixture();
    await expect(
      db.transaction(async (tx) => {
        return updateJobState(tx, fx.tenantId, randomUUID(), "running", 1);
      }),
    ).rejects.toMatchObject({ name: "JobNotFoundError" });
  });
});

// ─── recordJobResult ────────────────────────────────────

describe("recordJobResult", () => {
  it("成功写入 resultRef/resultHash + job.result_recorded Event", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);

    // recordJobResult 在 running 状态调用（不强制要求终态）
    const result = await db.transaction(async (tx) => {
      return recordJobResult(
        tx,
        fx.tenantId,
        job.id,
        {
          resultRef: "result://job/001/output.json",
          resultHash: "sha256:result-hash",
          resultSummaryJson: { total: 100, success: 95 },
        },
        {
          actorType: "agent",
          actorId: fx.agentId,
          idempotencyKey: "result-001",
        },
      );
    });

    expect(result.job.resultRef).toBe("result://job/001/output.json");
    expect(result.job.resultHash).toBe("sha256:result-hash");
    expect(result.resultRecordedEvent.eventType).toBe("job.result_recorded");
    expect(result.resultRecordedEvent.eventSequence).toBe(2); // queued=1, result_recorded=2
    expect(result.resultRecordedEvent.actorType).toBe("agent");
    expect(result.resultRecordedEvent.actorId).toBe(fx.agentId);
    expect(result.resultRecordedEvent.payloadJson).toMatchObject({
      job_id: job.id,
      result_ref: "result://job/001/output.json",
      result_hash: "sha256:result-hash",
      result_summary: { total: 100, success: 95 },
    });
    expect(result.resultRecordedEvent.idempotencyKey).toBe("result-001:job-result-recorded");

    // Job.lastEventSequence 已递增
    const [dbJob] = await db.select().from(v11Job).where(eq(v11Job.id, job.id)).limit(1);
    expect(dbJob?.lastEventSequence).toBe(2);
    void running;
  });

  it("Job 不存在抛 JobNotFoundError", async () => {
    const fx = await seedFixture();
    await expect(
      db.transaction(async (tx) => {
        return recordJobResult(tx, fx.tenantId, randomUUID(), {
          resultRef: "result://job/001/output.json",
          resultHash: "sha256:result-hash",
        });
      }),
    ).rejects.toMatchObject({ name: "JobNotFoundError" });
  });
});

// ─── allocateJobEventSequences + insertJobEvent ────────

describe("allocateJobEventSequences + insertJobEvent", () => {
  it("原子递增 lastEventSequence + 连续 sequence", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    // 初始 lastEventSequence=1（createJob 已分配 1 条）

    // 分配 3 条
    const startSeq = await db.transaction(async (tx) => {
      return allocateJobEventSequences(tx, job.id, 3);
    });
    expect(startSeq).toBe(2); // 从 2 开始

    const [dbJob] = await db.select().from(v11Job).where(eq(v11Job.id, job.id)).limit(1);
    expect(dbJob?.lastEventSequence).toBe(4); // 1 + 3 = 4
  });

  it("Job 不存在抛 JobNotFoundError", async () => {
    await expect(
      db.transaction(async (tx) => {
        return allocateJobEventSequences(tx, randomUUID(), 1);
      }),
    ).rejects.toMatchObject({ name: "JobNotFoundError" });
  });

  it("insertJobEvent 写入单条 Event", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    const event = await db.transaction(async (tx) => {
      const seq = await allocateJobEventSequences(tx, job.id, 1);
      return insertJobEvent(tx, fx.tenantId, job.id, seq, {
        eventType: "job.started",
        actorType: "system",
        payload: { job_id: job.id },
        idempotencyKey: "test-started",
      });
    });

    expect(event.tenantId).toBe(fx.tenantId);
    expect(event.jobId).toBe(job.id);
    expect(event.eventSequence).toBe(2);
    expect(event.eventType).toBe("job.started");
    expect(event.actorType).toBe("system");
    expect(event.payloadJson).toMatchObject({ job_id: job.id });
    expect(event.idempotencyKey).toBe("test-started");
  });

  it("getJobEvents 按 sequence 升序", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    // 写入 2 条额外 Event
    await db.transaction(async (tx) => {
      const seq = await allocateJobEventSequences(tx, job.id, 1);
      return insertJobEvent(tx, fx.tenantId, job.id, seq, {
        eventType: "job.started",
        actorType: "system",
        payload: {},
        idempotencyKey: "evt-started",
      });
    });
    await db.transaction(async (tx) => {
      const seq = await allocateJobEventSequences(tx, job.id, 1);
      return insertJobEvent(tx, fx.tenantId, job.id, seq, {
        eventType: "job.completed",
        actorType: "system",
        payload: {},
        idempotencyKey: "evt-completed",
      });
    });

    const events = await getJobEvents(fx.tenantId, job.id);
    expect(events).toHaveLength(3);
    expect(events[0]?.eventSequence).toBe(1);
    expect(events[0]?.eventType).toBe("job.queued");
    expect(events[1]?.eventSequence).toBe(2);
    expect(events[1]?.eventType).toBe("job.started");
    expect(events[2]?.eventSequence).toBe(3);
    expect(events[2]?.eventType).toBe("job.completed");
  });

  it("getJobEventsSince 续读：返回 sequence > afterSequence 的事件", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    await db.transaction(async (tx) => {
      const seq = await allocateJobEventSequences(tx, job.id, 1);
      return insertJobEvent(tx, fx.tenantId, job.id, seq, {
        eventType: "job.started",
        actorType: "system",
        payload: {},
        idempotencyKey: "evt-started",
      });
    });

    // 从 sequence=1 之后开始读
    const since1 = await getJobEventsSince(fx.tenantId, job.id, 1);
    expect(since1).toHaveLength(1);
    expect(since1[0]?.eventSequence).toBe(2);
    expect(since1[0]?.eventType).toBe("job.started");

    // 从 sequence=2 之后开始读（无新事件）
    const since2 = await getJobEventsSince(fx.tenantId, job.id, 2);
    expect(since2).toHaveLength(0);
  });

  it("getJobEventsSince 跨租户返回空数组", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    const events = await getJobEventsSince(randomUUID(), job.id, 0);
    expect(events).toHaveLength(0);
  });

  it("getLatestJobEventSequence 返回最新 sequence", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    expect(await getLatestJobEventSequence(fx.tenantId, job.id)).toBe(1);

    await db.transaction(async (tx) => {
      const seq = await allocateJobEventSequences(tx, job.id, 2);
      await insertJobEvent(tx, fx.tenantId, job.id, seq, {
        eventType: "job.started",
        actorType: "system",
        payload: {},
        idempotencyKey: "evt-1",
      });
      await insertJobEvent(tx, fx.tenantId, job.id, seq + 1, {
        eventType: "job.completed",
        actorType: "system",
        payload: {},
        idempotencyKey: "evt-2",
      });
    });

    expect(await getLatestJobEventSequence(fx.tenantId, job.id)).toBe(3);
  });

  it("getLatestJobEventSequence Job 不存在返回 null", async () => {
    const fx = await seedFixture();
    expect(await getLatestJobEventSequence(fx.tenantId, randomUUID())).toBeNull();
  });
});

// ─── createCancelCommand ───────────────────────────────

describe("createCancelCommand", () => {
  it("成功创建 cancel 命令 + cancel_requested Event + 幂等重放", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    const result = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      reasonCode: "user_request",
      idempotencyKey: "cancel-001",
    });

    expect(result.command.tenantId).toBe(fx.tenantId);
    expect(result.command.jobId).toBe(job.id);
    expect(result.command.commandType).toBe("cancel");
    expect(result.command.commandState).toBe("queued");
    expect(result.command.idempotencyKey).toBe("cancel-001");
    expect(result.command.requestedBy).toBe(fx.ownerId);
    expect(result.command.reasonCode).toBe("user_request");
    expect(result.command.replacementJobId).toBeNull();
    expect(result.replayed).toBe(false);

    // cancel_requested Event
    expect(result.cancelRequestedEvent.eventType).toBe("job.cancel_requested");
    expect(result.cancelRequestedEvent.eventSequence).toBe(2); // queued=1, cancel_requested=2
    expect(result.cancelRequestedEvent.actorType).toBe("system");
    expect(result.cancelRequestedEvent.payloadJson).toMatchObject({
      job_id: job.id,
      command_id: result.command.id,
      requested_by: fx.ownerId,
      reason_code: "user_request",
    });
    expect(result.cancelRequestedEvent.idempotencyKey).toBe("cancel-001:job-cancel-requested");

    // Job 状态未变
    const dbJob = await getJobById(fx.tenantId, job.id);
    expect(dbJob?.jobState).toBe("queued");

    // 幂等重放
    const replay = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      reasonCode: "user_request",
      idempotencyKey: "cancel-001",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.command.id).toBe(result.command.id);
    expect(replay.cancelRequestedEvent.id).toBe(result.cancelRequestedEvent.id);
  });

  it("Job 终态抛 JobAlreadyTerminalError", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);
    await advanceToCompleted(fx.tenantId, job.id, running.versionNo);

    await expect(
      createCancelCommand({
        tenantId: fx.tenantId,
        jobId: job.id,
        requestedBy: fx.ownerId,
        idempotencyKey: "cancel-002",
      }),
    ).rejects.toMatchObject({ name: "JobAlreadyTerminalError" });
  });

  it("Job 不存在抛 JobNotFoundError", async () => {
    const fx = await seedFixture();
    await expect(
      createCancelCommand({
        tenantId: fx.tenantId,
        jobId: randomUUID(),
        requestedBy: fx.ownerId,
        idempotencyKey: "cancel-003",
      }),
    ).rejects.toMatchObject({ name: "JobNotFoundError" });
  });
});

// ─── createRetryCommand ────────────────────────────────

describe("createRetryCommand", () => {
  it("成功创建 retry 命令 + retry_requested Event + 幂等重放", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);
    await advanceToCompleted(fx.tenantId, job.id, running.versionNo);

    const result = await createRetryCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      reasonCode: "transient_error",
      reuseInput: true,
      idempotencyKey: "retry-001",
    });

    expect(result.command.commandType).toBe("retry");
    expect(result.command.commandState).toBe("queued");
    expect(result.command.idempotencyKey).toBe("retry-001");
    expect(result.command.reasonCode).toBe("transient_error");
    expect(result.command.replacementJobId).toBeNull(); // S09-C05 在 acknowledge 时回填
    expect(result.command.commandPayloadJson).toMatchObject({
      reuse_input: true,
      override: null,
      reason_code: "transient_error",
    });
    expect(result.replayed).toBe(false);

    // retry_requested Event
    expect(result.retryRequestedEvent.eventType).toBe("job.retry_requested");
    expect(result.retryRequestedEvent.payloadJson).toMatchObject({
      job_id: job.id,
      command_id: result.command.id,
      requested_by: fx.ownerId,
      reason_code: "transient_error",
      reuse_input: true,
      override: null,
    });
    expect(result.retryRequestedEvent.idempotencyKey).toBe("retry-001:job-retry-requested");

    // 幂等重放
    const replay = await createRetryCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "retry-001",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.command.id).toBe(result.command.id);
    expect(replay.retryRequestedEvent.id).toBe(result.retryRequestedEvent.id);
  });

  it("Job 非终态抛 JobNotTerminalError", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    await expect(
      createRetryCommand({
        tenantId: fx.tenantId,
        jobId: job.id,
        requestedBy: fx.ownerId,
        idempotencyKey: "retry-002",
      }),
    ).rejects.toMatchObject({ name: "JobNotTerminalError" });
  });

  it("Job 不存在抛 JobNotFoundError", async () => {
    const fx = await seedFixture();
    await expect(
      createRetryCommand({
        tenantId: fx.tenantId,
        jobId: randomUUID(),
        requestedBy: fx.ownerId,
        idempotencyKey: "retry-003",
      }),
    ).rejects.toMatchObject({ name: "JobNotFoundError" });
  });
});

// ─── acknowledgeCommand / rejectCommand ───────────────

describe("acknowledgeCommand / rejectCommand", () => {
  it("acknowledgeCommand：cancel 命令 → acknowledged", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const cmd = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "ack-cancel-001",
    });

    const acked = await acknowledgeCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
    });

    expect(acked.commandState).toBe("acknowledged");
    expect(acked.acknowledgedAt).toBeInstanceOf(Date);
    expect(acked.replacementJobId).toBeNull(); // cancel 无 replacement
  });

  it("acknowledgeCommand：retry 命令 → acknowledged + replacementJobId 回填", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const running = await advanceToRunning(fx.tenantId, job.id, 1);
    await advanceToCompleted(fx.tenantId, job.id, running.versionNo);

    const cmd = await createRetryCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "ack-retry-001",
    });

    const replacementJobId = randomUUID();
    const acked = await acknowledgeCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
      replacementJobId,
    });

    expect(acked.commandState).toBe("acknowledged");
    expect(acked.replacementJobId).toBe(replacementJobId);
  });

  it("acknowledgeCommand：终态命令抛 JobCommandAlreadyTerminalError", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const cmd = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "ack-terminal-001",
    });

    await acknowledgeCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
    });

    await expect(
      acknowledgeCommand({
        tenantId: fx.tenantId,
        commandId: cmd.command.id,
      }),
    ).rejects.toMatchObject({ name: "JobCommandAlreadyTerminalError" });
  });

  it("acknowledgeCommand：命令不存在抛 JobCommandNotFoundError", async () => {
    const fx = await seedFixture();
    await expect(
      acknowledgeCommand({
        tenantId: fx.tenantId,
        commandId: randomUUID(),
      }),
    ).rejects.toMatchObject({ name: "JobCommandNotFoundError" });
  });

  it("rejectCommand：命令 → rejected + errorCode/errorSummary", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const cmd = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "reject-001",
    });

    const rejected = await rejectCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
      errorCode: "JOB_ALREADY_TERMINAL",
      errorSummary: "Job 在 race condition 下已终态",
    });

    expect(rejected.commandState).toBe("rejected");
    expect(rejected.errorCode).toBe("JOB_ALREADY_TERMINAL");
    expect(rejected.errorSummary).toBe("Job 在 race condition 下已终态");
    expect(rejected.acknowledgedAt).toBeInstanceOf(Date);
  });

  it("rejectCommand：终态命令抛 JobCommandAlreadyTerminalError", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const cmd = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "reject-terminal-001",
    });

    await rejectCommand({
      tenantId: fx.tenantId,
      commandId: cmd.command.id,
      errorCode: "JOB_ALREADY_TERMINAL",
    });

    await expect(
      rejectCommand({
        tenantId: fx.tenantId,
        commandId: cmd.command.id,
        errorCode: "JOB_ALREADY_TERMINAL",
      }),
    ).rejects.toMatchObject({ name: "JobCommandAlreadyTerminalError" });
  });
});

// ─── 查询：getJobCommands / getPendingJobCommands ─────

describe("JobCommand 查询", () => {
  it("getJobCommandById 命中 + 跨租户返回 null", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);
    const cmd = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "get-001",
    });

    const found = await getJobCommandById(fx.tenantId, cmd.command.id);
    expect(found?.id).toBe(cmd.command.id);

    const crossTenant = await getJobCommandById(randomUUID(), cmd.command.id);
    expect(crossTenant).toBeNull();
  });

  it("getJobCommandById 不存在返回 null", async () => {
    const fx = await seedFixture();
    const found = await getJobCommandById(fx.tenantId, randomUUID());
    expect(found).toBeNull();
  });

  it("getJobCommands 列出 Job 全部命令（按 createdAt 降序）", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    const c1 = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "list-001",
    });
    await new Promise((r) => setTimeout(r, 10));
    const c2 = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "list-002",
    });

    const commands = await getJobCommands(fx.tenantId, job.id);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.id).toBe(c2.command.id); // 最新的在前
    expect(commands[1]?.id).toBe(c1.command.id);
  });

  it("getPendingJobCommands 只返回 queued/dispatched 命令", async () => {
    const fx = await seedFixture();
    const { job } = await createQueuedJob(fx.tenantId, fx.agentId);

    const c1 = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "pending-001",
    });
    const c2 = await createCancelCommand({
      tenantId: fx.tenantId,
      jobId: job.id,
      requestedBy: fx.ownerId,
      idempotencyKey: "pending-002",
    });

    // acknowledge c1 → 不再 pending
    await acknowledgeCommand({
      tenantId: fx.tenantId,
      commandId: c1.command.id,
    });

    const pending = await getPendingJobCommands(fx.tenantId, job.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(c2.command.id);
  });
});
