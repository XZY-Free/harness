/**
 * S09-C05：V11 JobResultProjection 仓储集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - projectJobResultToThread system_triggered_turn：成功 + job_result Item + JobResultProjection + 4 条 Event
 *   （turn.accepted + turn.completed + item.created + job_result.published）
 * - projectJobResultToThread existing_source_turn：追加 Item + 2 条 Event（item.created + job_result.published）
 * - 幂等：同 jobId 重入返回原 projection
 * - 错误路径：Job 非终态 / threadId 为空 / resultRef 为空 / sourceTurnId 不属于 Thread
 * - 查询：getJobResultProjectionByJob / getJobResultProjectionByItem
 *
 * 不变量（事实源：09 文档 S09-W06 行 76-80、S09-C05 行 130；
 *         10 文档 §5.4 行 289-297、§7.4 行 555-557、§9.1；13 文档 §4.4）：
 * - 只允许投影到 Job 创建时预先关联的 Thread（threadId 非空）
 * - ThreadItem.itemType="job_result"，invocationId=null，authorType="system"
 * - JobResultProjection.itemId 唯一外键 → ThreadItem.id
 * - JobEvent 不进入员工 Thread SSE；只有 job_result.published 才进入 ThreadEvent
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createAgent } from "@/lib/v11/control-plane/agent-queries";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { acceptUserMessageTurn } from "@/lib/v11/conversation/turn-queries";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { JobResultProjectionConflictError } from "@/lib/v11/job/errors";
import { completeJob } from "@/lib/v11/job/job-control-queries";
import { createJob, updateJobState } from "@/lib/v11/job/job-queries";
import {
  getJobResultProjectionByItem,
  getJobResultProjectionByJob,
  projectJobResultToThread,
} from "@/lib/v11/job/job-result-projection-queries";
import { v11ThreadItem } from "@/lib/v11/schema/conversation";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 租户 + 用户 + Agent + Thread ──────────

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
  const { thread } = await createThread({
    tenantId: tenant.id,
    ownerUserId: identity.id,
    primaryAgentId: agent.id,
    actorId: identity.id,
  });
  return {
    tenantId: tenant.id,
    ownerId: identity.id,
    agentId: agent.id,
    threadId: thread.id,
  };
}

/** 创建 Job + 推进到 running + completeJob（终态 + resultRef/resultHash）。 */
async function createCompletedJob(tenantId: string, agentId: string, threadId: string) {
  const { job } = await createJob({
    tenantId,
    agentId,
    jobType: "evaluation",
    triggerRef: "schedule-001",
    completionPolicyJson: { type: "all_success" },
    threadId,
    inputRef: "input://batch/001",
    inputHash: "sha256:abc",
    idempotencyKey: `create-${randomUUID()}`,
  });

  // 推进到 running
  await db.transaction(async (tx) => {
    await updateJobState(tx, tenantId, job.id, "running", 1);
  });

  // completeJob 写 resultRef/resultHash + job.completed Event
  const completed = await completeJob({
    tenantId,
    jobId: job.id,
    result: {
      resultRef: "result://job/output.json",
      resultHash: "sha256:hash",
      resultSummaryJson: { total: 100, success: 95 },
    },
    actorType: "agent",
    actorId: agentId,
    idempotencyKey: `complete-${randomUUID()}`,
  });

  return completed.job;
}

// ─── system_triggered_turn ─────────────────────────────

describe("projectJobResultToThread system_triggered_turn", () => {
  it("成功投影 + job_result Item + JobResultProjection + 4 条 Event（turn.accepted + turn.completed + item.created + job_result.published）", async () => {
    const fx = await seedFixture();
    const job = await createCompletedJob(fx.tenantId, fx.agentId, fx.threadId);

    const result = await projectJobResultToThread({
      tenantId: fx.tenantId,
      jobId: job.id,
      projectionKind: "system_triggered_turn",
      actorType: "service",
      actorId: "job-scheduler",
      createdBy: fx.ownerId,
      idempotencyKey: "proj-001",
    });

    expect(result.replayed).toBe(false);

    // job_result ThreadItem
    expect(result.item.threadId).toBe(fx.threadId);
    expect(result.item.itemType).toBe("job_result");
    expect(result.item.itemState).toBe("completed");
    expect(result.item.authorType).toBe("system"); // service → system 映射
    expect(result.item.authorId).toBe("job-scheduler");
    expect(result.item.contentJson).toMatchObject({
      job_id: job.id,
      result_ref: "result://job/output.json",
      result_hash: "sha256:hash",
      projection_kind: "system_triggered_turn",
    });

    // JobResultProjection
    expect(result.projection.tenantId).toBe(fx.tenantId);
    expect(result.projection.itemId).toBe(result.item.id);
    expect(result.projection.jobId).toBe(job.id);
    expect(result.projection.sourceTurnId).toBe(result.turn.id);
    expect(result.projection.projectionKind).toBe("system_triggered_turn");
    expect(result.projection.resultRef).toBe("result://job/output.json");
    expect(result.projection.resultHash).toBe("sha256:hash");
    expect(result.projection.createdBy).toBe(fx.ownerId);

    // Turn（triggerType=job_result_projection, state=completed）
    expect(result.turn.threadId).toBe(fx.threadId);
    expect(result.turn.triggerType).toBe("job_result_projection");
    expect(result.turn.triggerRef).toBe(`job:${job.id}`);
    expect(result.turn.turnState).toBe("completed");

    // 4 条 Event
    expect(result.events).toHaveLength(4);
    expect(result.events[0]?.eventType).toBe("turn.accepted");
    expect(result.events[0]?.turnId).toBe(result.turn.id);
    expect(result.events[1]?.eventType).toBe("turn.completed");
    expect(result.events[1]?.turnId).toBe(result.turn.id);
    expect(result.events[2]?.eventType).toBe("item.created");
    expect(result.events[2]?.itemId).toBe(result.item.id);
    expect(result.events[2]?.payloadJson).toMatchObject({
      item_type: "job_result",
      item_state: "completed",
      job_id: job.id,
      result_ref: "result://job/output.json",
      projection_kind: "system_triggered_turn",
    });
    expect(result.events[3]?.eventType).toBe("job_result.published");
    expect(result.events[3]?.itemId).toBe(result.item.id);
    expect(result.events[3]?.payloadJson).toMatchObject({
      thread_id: fx.threadId,
      turn_id: result.turn.id,
      item_id: result.item.id,
      job_id: job.id,
      result_ref: "result://job/output.json",
      projection_kind: "system_triggered_turn",
    });
  });

  it("幂等：同 jobId 重入返回原 projection + replayed=true", async () => {
    const fx = await seedFixture();
    const job = await createCompletedJob(fx.tenantId, fx.agentId, fx.threadId);

    const first = await projectJobResultToThread({
      tenantId: fx.tenantId,
      jobId: job.id,
      projectionKind: "system_triggered_turn",
      idempotencyKey: "proj-002",
    });

    const second = await projectJobResultToThread({
      tenantId: fx.tenantId,
      jobId: job.id,
      projectionKind: "system_triggered_turn",
      idempotencyKey: "proj-002-retry", // 不同 idempotencyKey 但同 jobId
    });

    expect(second.replayed).toBe(true);
    expect(second.projection.id).toBe(first.projection.id);
    expect(second.item.id).toBe(first.item.id);
    expect(second.turn.id).toBe(first.turn.id);
  });
});

// ─── existing_source_turn ──────────────────────────────

describe("projectJobResultToThread existing_source_turn", () => {
  it("成功追加到现有 Turn + 2 条 Event（item.created + job_result.published）", async () => {
    const fx = await seedFixture();
    const job = await createCompletedJob(fx.tenantId, fx.agentId, fx.threadId);

    // 先创建一个 user_message Turn 作为 sourceTurn
    const { turn: sourceTurn } = await acceptUserMessageTurn({
      tenantId: fx.tenantId,
      threadId: fx.threadId,
      ownerUserId: fx.ownerId,
      content: { text: "测试追加投影" } as unknown as Parameters<
        typeof acceptUserMessageTurn
      >[0]["content"],
      actorId: fx.ownerId,
    });

    const result = await projectJobResultToThread({
      tenantId: fx.tenantId,
      jobId: job.id,
      projectionKind: "existing_source_turn",
      sourceTurnId: sourceTurn.id,
      actorType: "system",
      actorId: "job-scheduler",
      idempotencyKey: "proj-003",
    });

    expect(result.replayed).toBe(false);
    expect(result.turn.id).toBe(sourceTurn.id); // 复用 sourceTurn，不创建新 Turn

    // job_result ThreadItem 关联到 sourceTurn
    expect(result.item.turnId).toBe(sourceTurn.id);
    expect(result.item.itemType).toBe("job_result");

    // JobResultProjection.sourceTurnId = sourceTurn.id
    expect(result.projection.sourceTurnId).toBe(sourceTurn.id);
    expect(result.projection.projectionKind).toBe("existing_source_turn");

    // 2 条 Event（无 turn.accepted / turn.completed）
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.eventType).toBe("item.created");
    expect(result.events[1]?.eventType).toBe("job_result.published");
  });

  it("sourceTurnId 不属于 Thread 抛 JobResultProjectionConflictError", async () => {
    const fx = await seedFixture();
    const job = await createCompletedJob(fx.tenantId, fx.agentId, fx.threadId);

    await expect(
      projectJobResultToThread({
        tenantId: fx.tenantId,
        jobId: job.id,
        projectionKind: "existing_source_turn",
        sourceTurnId: randomUUID(), // 不存在
        idempotencyKey: "proj-004",
      }),
    ).rejects.toMatchObject({ name: "JobResultProjectionConflictError" });
  });

  it("existing_source_turn 未提供 sourceTurnId 抛 JobResultProjectionConflictError", async () => {
    const fx = await seedFixture();
    const job = await createCompletedJob(fx.tenantId, fx.agentId, fx.threadId);

    await expect(
      projectJobResultToThread({
        tenantId: fx.tenantId,
        jobId: job.id,
        projectionKind: "existing_source_turn",
        // sourceTurnId 缺失
        idempotencyKey: "proj-005",
      }),
    ).rejects.toMatchObject({ name: "JobResultProjectionConflictError" });
  });
});

// ─── 错误路径 ──────────────────────────────────────────

describe("projectJobResultToThread 错误路径", () => {
  it("Job 非终态抛 JobResultProjectionConflictError", async () => {
    const fx = await seedFixture();
    // 创建 queued Job（未推进终态）
    const { job } = await createJob({
      tenantId: fx.tenantId,
      agentId: fx.agentId,
      jobType: "evaluation",
      triggerRef: "schedule-001",
      completionPolicyJson: { type: "all_success" },
      threadId: fx.threadId,
      idempotencyKey: `create-${randomUUID()}`,
    });

    await expect(
      projectJobResultToThread({
        tenantId: fx.tenantId,
        jobId: job.id,
        projectionKind: "system_triggered_turn",
        idempotencyKey: "proj-006",
      }),
    ).rejects.toMatchObject({ name: "JobResultProjectionConflictError" });
  });

  it("Job threadId 为空抛 JobResultProjectionConflictError", async () => {
    const fx = await seedFixture();
    // 创建无 threadId 的 Job
    const { job } = await createJob({
      tenantId: fx.tenantId,
      agentId: fx.agentId,
      jobType: "evaluation",
      triggerRef: "schedule-001",
      completionPolicyJson: { type: "all_success" },
      // threadId 缺失
      inputRef: "input://batch/001",
      inputHash: "sha256:abc",
      idempotencyKey: `create-${randomUUID()}`,
    });

    // 推进到 running + completed
    await db.transaction(async (tx) => {
      await updateJobState(tx, fx.tenantId, job.id, "running", 1);
    });
    await completeJob({
      tenantId: fx.tenantId,
      jobId: job.id,
      result: {
        resultRef: "result://job/output.json",
        resultHash: "sha256:hash",
      },
      idempotencyKey: `complete-${randomUUID()}`,
    });

    await expect(
      projectJobResultToThread({
        tenantId: fx.tenantId,
        jobId: job.id,
        projectionKind: "system_triggered_turn",
        idempotencyKey: "proj-007",
      }),
    ).rejects.toMatchObject({ name: "JobResultProjectionConflictError" });
  });

  it("Job 不存在抛 JobNotFoundError", async () => {
    const fx = await seedFixture();

    await expect(
      projectJobResultToThread({
        tenantId: fx.tenantId,
        jobId: randomUUID(),
        projectionKind: "system_triggered_turn",
        idempotencyKey: "proj-008",
      }),
    ).rejects.toMatchObject({ name: "JobNotFoundError" });
  });
});

// ─── 查询 ──────────────────────────────────────────────

describe("JobResultProjection 查询", () => {
  it("getJobResultProjectionByJob 命中 + 跨租户返回 null", async () => {
    const fx = await seedFixture();
    const job = await createCompletedJob(fx.tenantId, fx.agentId, fx.threadId);
    const result = await projectJobResultToThread({
      tenantId: fx.tenantId,
      jobId: job.id,
      projectionKind: "system_triggered_turn",
      idempotencyKey: "proj-009",
    });

    const found = await getJobResultProjectionByJob(fx.tenantId, job.id);
    expect(found?.id).toBe(result.projection.id);

    const crossTenant = await getJobResultProjectionByJob(randomUUID(), job.id);
    expect(crossTenant).toBeNull();
  });

  it("getJobResultProjectionByItem 命中", async () => {
    const fx = await seedFixture();
    const job = await createCompletedJob(fx.tenantId, fx.agentId, fx.threadId);
    const result = await projectJobResultToThread({
      tenantId: fx.tenantId,
      jobId: job.id,
      projectionKind: "system_triggered_turn",
      idempotencyKey: "proj-010",
    });

    const found = await getJobResultProjectionByItem(fx.tenantId, result.item.id);
    expect(found?.id).toBe(result.projection.id);
    expect(found?.itemId).toBe(result.item.id);

    // 直接查 ThreadItem 验证 itemType
    const [dbItem] = await db
      .select()
      .from(v11ThreadItem)
      .where(eq(v11ThreadItem.id, result.item.id))
      .limit(1);
    expect(dbItem?.itemType).toBe("job_result");
    expect(dbItem?.invocationId).toBeNull();
  });

  it("getJobResultProjectionByJob 不存在返回 null", async () => {
    const fx = await seedFixture();
    const found = await getJobResultProjectionByJob(fx.tenantId, randomUUID());
    expect(found).toBeNull();
  });
});
