/**
 * V11 JobResultProjection 仓储（S09-C05）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §5.4（job_result Item 关联）、§7.4（job_result_projection Turn）、§9.1（事务边界）
 * - ../v11-agentkit-platform/13-memory-and-job-api.md §4.4（Job 结果显式投影到 Thread）
 * - ../v11-agentkit-platform/contracts/event-catalog.json（item.created 行 30、job_result.published 行 67）
 * - ../v11-agentkit-platform-development-plan/09-collaboration-jobs-and-recovery.md S09-W06、S09-C05
 *
 * 职责：
 * - projectJobResultToThread：Job 终态时创建 job_result ThreadItem + JobResultProjection 行 +
 *   item.created + job_result.published ThreadEvent
 * - getJobResultProjectionByJob / getJobResultProjectionByItem：查询
 *
 * 关键约束（§5.4、§7.4、§9.1）：
 * - 只允许投影到 Job 创建时预先关联的 Thread（threadId 非空）
 * - ThreadItem.itemType="job_result"，invocationId=null，authorType="system"
 * - JobResultProjection.itemId 一对一外键 → ThreadItem.id（UNIQUE 约束）
 * - Turn triggerType="job_result_projection" 允许无 Invocation 从 accepted 直接 completed
 * - existing_source_turn：追加 Item 到现有 Turn；system_triggered_turn：创建新 Turn
 * - 跨域事务：Job 域调用 Conversation 域的 sequence 分配/Event 写入函数，必须在同事务
 * - JobEvent 不进入员工 Thread SSE；只有 job_result.published 才进入 ThreadEvent
 */
import { randomUUID } from "node:crypto";
import { ThreadNotAcceptingTurnsError, ThreadNotFoundError } from "@/lib/conversations/errors";
import {
  allocateEventSequences,
  allocateItemSequence,
  allocateTurnSequence,
  computeEventPayloadHash,
  insertThreadEvent,
} from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import {
  type ThreadEventActorType,
  type ThreadItemAuthorType,
  threadEventTable,
  threadItemTable,
  threadTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import {
  type Job,
  type JobResultProjection,
  jobResultProjectionTable,
  jobTable,
} from "@/lib/persistence/schema/job";
import { JobNotFoundError, JobResultProjectionConflictError } from "@/lib/v11/job/errors";
import { and, asc, eq } from "drizzle-orm";

/** 投影类型。 */
export type ProjectionKind = "existing_source_turn" | "system_triggered_turn";

/** projectJobResultToThread 入参。 */
export interface ProjectJobResultToThreadParams {
  tenantId: string;
  jobId: string;
  /**
   * 投影类型：
   * - system_triggered_turn：创建 triggerType="job_result_projection" 的新 Turn
   * - existing_source_turn：追加到现有 Turn（必须提供 sourceTurnId）
   */
  projectionKind: ProjectionKind;
  /** projectionKind=existing_source_turn 时必填。 */
  sourceTurnId?: string;
  /** Event actor（默认 system）。 */
  actorType?: ThreadEventActorType;
  actorId?: string;
  /** 创建 JobResultProjection 的 createdBy 字段。 */
  createdBy?: string;
  correlationId?: string;
  idempotencyKey?: string;
}

/** projectJobResultToThread 返回结果。 */
export interface ProjectJobResultToThreadResult {
  job: Job;
  /** 创建的 job_result ThreadItem。 */
  item: ThreadItem;
  /** 创建的 JobResultProjection 行。 */
  projection: JobResultProjection;
  /** 创建的 Turn（system_triggered_turn 时新创建；existing_source_turn 时回读现有）。 */
  turn: Turn;
  /** ThreadEvent 列表：system_triggered_turn 写 4 条；existing_source_turn 写 2 条。 */
  events: ThreadEvent[];
  /** 是否为幂等重放（已存在同 itemId 投影）。 */
  replayed: boolean;
}

// 为了类型完整，从 conversation schema 重新引入 ThreadItem / Turn / ThreadEvent
import type { ThreadEvent, ThreadItem, Turn } from "@/lib/persistence/schema/conversation";

/**
 * Job 终态时将结果投影到 Thread。
 *
 * 流程（同事务）：
 * 1. SELECT FOR UPDATE Job（校验终态 + threadId 非空 + resultRef 非空）
 * 2. SELECT FOR UPDATE Thread（锁定事件流）
 * 3. 幂等检查：SELECT JobResultProjection WHERE jobId = ?
 *    - 已存在：返回现有 projection（幂等）
 * 4. projectionKind 分支：
 *    a. system_triggered_turn：allocateTurnSequence + INSERT Turn（triggerType=job_result_projection, state=completed）
 *       + INSERT ThreadEvent turn.accepted + turn.completed
 *    b. existing_source_turn：校验 sourceTurnId 非空 + 属于 threadId；回读 Turn
 * 5. allocateItemSequence + INSERT ThreadItem（itemType=job_result, state=completed, authorType=system, invocationId=null）
 * 6. INSERT JobResultProjection（itemId=新 Item.id, jobId, sourceTurnId, projectionKind, resultRef, resultHash）
 * 7. allocateEventSequences(2) + INSERT ThreadEvent item.created + job_result.published
 * 8. UPDATE Thread.lastActivityAt
 *
 * 不变量（§5.4、§7.4）：
 * - Job 必须 completed/failed 终态（cancelled 不投影）
 * - Job.threadId 非空（必须预先关联 Thread）
 * - Job.resultRef/resultHash 非空（必须先调用 recordJobResult）
 * - ThreadItem.invocationId=null（Job 结果不绑定特定 Invocation）
 * - JobResultProjection.itemId 唯一外键 → ThreadItem.id
 */
export async function projectJobResultToThread(
  params: ProjectJobResultToThreadParams,
): Promise<ProjectJobResultToThreadResult> {
  // 事务外预查询 Job（轻量校验）
  const [preJob] = await db
    .select()
    .from(jobTable)
    .where(and(eq(jobTable.tenantId, params.tenantId), eq(jobTable.id, params.jobId)))
    .limit(1);
  if (!preJob) {
    throw new JobNotFoundError(params.jobId);
  }

  // 幂等检查（事务外预查询，减少长事务持锁）
  const [existingProjection] = await db
    .select()
    .from(jobResultProjectionTable)
    .where(eq(jobResultProjectionTable.jobId, params.jobId))
    .limit(1);

  const actorType: ThreadEventActorType = params.actorType ?? "system";
  // ThreadItem.authorType 不含 service；service → system 映射
  const itemAuthorType: ThreadItemAuthorType =
    actorType === "service" ? "system" : (actorType as ThreadItemAuthorType);
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

    // 校验 Job 终态（completed/failed；cancelled 不投影）
    if (job.jobState !== "completed" && job.jobState !== "failed") {
      throw new JobResultProjectionConflictError(
        params.jobId,
        `Job 状态非 completed/failed（当前=${job.jobState}）`,
      );
    }

    // 校验 threadId 非空
    if (!job.threadId) {
      throw new JobResultProjectionConflictError(
        params.jobId,
        "Job 未关联 Thread（threadId 为空）",
      );
    }

    // 校验 resultRef/resultHash 非空
    if (!job.resultRef || !job.resultHash) {
      throw new JobResultProjectionConflictError(
        params.jobId,
        "Job 未记录结果（resultRef/resultHash 为空）",
      );
    }

    // 2. SELECT FOR UPDATE Thread
    const [thread] = await tx
      .select()
      .from(threadTable)
      .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, job.threadId)))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new ThreadNotFoundError(job.threadId);
    }
    if (thread.lifecycleState !== "active") {
      throw new ThreadNotAcceptingTurnsError(thread.id, thread.lifecycleState);
    }

    // 3. 事务内幂等检查
    const [txExistingProjection] = await tx
      .select()
      .from(jobResultProjectionTable)
      .where(eq(jobResultProjectionTable.jobId, job.id))
      .limit(1);
    if (txExistingProjection) {
      // 幂等：回读现有 Item + Turn + Events
      const [existingItem] = await tx
        .select()
        .from(threadItemTable)
        .where(eq(threadItemTable.id, txExistingProjection.itemId))
        .limit(1);
      if (!existingItem) {
        throw new JobResultProjectionConflictError(
          txExistingProjection.itemId,
          "幂等回读 ThreadItem 失败",
        );
      }
      const [existingTurn] = await tx
        .select()
        .from(turnTable)
        .where(eq(turnTable.id, txExistingProjection.sourceTurnId))
        .limit(1);
      if (!existingTurn) {
        throw new JobResultProjectionConflictError(
          txExistingProjection.sourceTurnId,
          "幂等回读 Turn 失败",
        );
      }
      const existingEvents = await tx
        .select()
        .from(threadEventTable)
        .where(eq(threadEventTable.itemId, existingItem.id))
        .orderBy(asc(threadEventTable.eventSequence));
      return {
        job,
        item: existingItem,
        projection: txExistingProjection,
        turn: existingTurn,
        events: existingEvents,
        replayed: true,
      };
    }

    // 4. projectionKind 分支
    let turnId: string;
    let turnAcceptedSeq: number | null = null;
    let turnCompletedSeq: number | null = null;
    let turnCreated = false;
    if (params.projectionKind === "system_triggered_turn") {
      // 创建新 Turn：triggerType=job_result_projection, state=completed
      turnId = randomUUID();
      const turnSequence = await allocateTurnSequence(tx, thread.id);
      turnAcceptedSeq = await allocateEventSequences(tx, thread.id, 1);
      turnCompletedSeq = await allocateEventSequences(tx, thread.id, 1);

      await tx.insert(turnTable).values({
        id: turnId,
        threadId: thread.id,
        turnSequence,
        triggerType: "job_result_projection",
        triggerRef: `job:${job.id}`,
        turnState: "completed",
        acceptedAt: now,
        finishedAt: now,
        versionNo: 1,
      });

      // 写 turn.accepted Event
      await insertThreadEvent(tx, thread.id, turnAcceptedSeq, {
        eventType: "turn.accepted",
        turnId,
        actorType,
        actorId: params.actorId,
        payload: {
          tenant_id: params.tenantId,
          turn_sequence: turnSequence,
          trigger_type: "job_result_projection",
          trigger_ref: `job:${job.id}`,
        },
        idempotencyKey: params.idempotencyKey
          ? `${params.idempotencyKey}:turn-accepted`
          : undefined,
      });

      // 写 turn.completed Event
      await insertThreadEvent(tx, thread.id, turnCompletedSeq, {
        eventType: "turn.completed",
        turnId,
        actorType,
        actorId: params.actorId,
        payload: {
          turn_sequence: turnSequence,
        },
        idempotencyKey: params.idempotencyKey
          ? `${params.idempotencyKey}:turn-completed`
          : undefined,
      });
      turnCreated = true;
    } else {
      // existing_source_turn：校验 sourceTurnId 非空 + 属于 threadId
      if (!params.sourceTurnId) {
        throw new JobResultProjectionConflictError(
          job.id,
          "projectionKind=existing_source_turn 时 sourceTurnId 必填",
        );
      }
      const [existingTurn] = await tx
        .select()
        .from(turnTable)
        .where(and(eq(turnTable.threadId, thread.id), eq(turnTable.id, params.sourceTurnId)))
        .limit(1);
      if (!existingTurn) {
        throw new JobResultProjectionConflictError(
          params.sourceTurnId,
          "sourceTurnId 不属于 Job 关联的 Thread",
        );
      }
      turnId = existingTurn.id;
    }

    // 5. allocateItemSequence + INSERT ThreadItem（job_result）
    const itemId = randomUUID();
    const itemSequence = await allocateItemSequence(tx, thread.id);
    const itemContent = {
      job_id: job.id,
      result_ref: job.resultRef,
      result_hash: job.resultHash,
      result_summary: null,
      projection_kind: params.projectionKind,
      source_turn_id: turnId,
    };
    const itemContentHash = computeEventPayloadHash(itemContent);
    await tx.insert(threadItemTable).values({
      id: itemId,
      threadId: thread.id,
      turnId,
      itemSequence,
      itemType: "job_result",
      itemState: "completed",
      authorType: itemAuthorType,
      authorId: params.actorId ?? null,
      contentJson: itemContent,
      contentHash: itemContentHash,
      contextPolicy: "include",
      createdAt: now,
      updatedAt: now,
    });

    // 6. INSERT JobResultProjection
    const projectionId = randomUUID();
    await tx.insert(jobResultProjectionTable).values({
      id: projectionId,
      tenantId: params.tenantId,
      itemId,
      jobId: job.id,
      sourceTurnId: turnId,
      projectionKind: params.projectionKind,
      resultRef: job.resultRef,
      resultHash: job.resultHash,
      resultSummaryJson: null,
      createdBy: params.createdBy ?? null,
      createdAt: now,
    });

    // 7. allocateEventSequences(2) + INSERT ThreadEvent item.created + job_result.published
    const itemCreatedSeq = await allocateEventSequences(tx, thread.id, 1);
    const publishedSeq = await allocateEventSequences(tx, thread.id, 1);

    const itemCreatedEvent = await insertThreadEvent(tx, thread.id, itemCreatedSeq, {
      eventType: "item.created",
      itemId,
      turnId,
      actorType,
      actorId: params.actorId,
      payload: {
        item_type: "job_result",
        item_state: "completed",
        job_id: job.id,
        result_ref: job.resultRef,
        result_hash: job.resultHash,
        projection_kind: params.projectionKind,
      },
      idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:item-created` : undefined,
      correlationId: params.correlationId,
    });

    const publishedEvent = await insertThreadEvent(tx, thread.id, publishedSeq, {
      eventType: "job_result.published",
      itemId,
      turnId,
      actorType,
      actorId: params.actorId,
      payload: {
        thread_id: thread.id,
        turn_id: turnId,
        item_id: itemId,
        job_id: job.id,
        result_ref: job.resultRef,
        result_hash: job.resultHash,
        projection_kind: params.projectionKind,
      },
      idempotencyKey: params.idempotencyKey
        ? `${params.idempotencyKey}:job-result-published`
        : undefined,
      correlationId: params.correlationId,
    });

    // 8. UPDATE Thread.lastActivityAt
    await tx
      .update(threadTable)
      .set({ lastActivityAt: now, updatedAt: now })
      .where(eq(threadTable.id, thread.id));

    // 回读创建的行
    const [createdItem] = await tx
      .select()
      .from(threadItemTable)
      .where(eq(threadItemTable.id, itemId))
      .limit(1);
    if (!createdItem) {
      throw new Error(`projectJobResultToThread: ThreadItem 行未找到（id=${itemId}）`);
    }
    const [createdProjection] = await tx
      .select()
      .from(jobResultProjectionTable)
      .where(eq(jobResultProjectionTable.id, projectionId))
      .limit(1);
    if (!createdProjection) {
      throw new Error(
        `projectJobResultToThread: JobResultProjection 行未找到（id=${projectionId}）`,
      );
    }
    const [createdTurn] = await tx
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, turnId))
      .limit(1);
    if (!createdTurn) {
      throw new Error(`projectJobResultToThread: Turn 行未找到（id=${turnId}）`);
    }

    // 收集所有写入的 Event
    const events: ThreadEvent[] = [];
    if (turnCreated && turnAcceptedSeq !== null && turnCompletedSeq !== null) {
      const [ta] = await tx
        .select()
        .from(threadEventTable)
        .where(
          and(
            eq(threadEventTable.threadId, thread.id),
            eq(threadEventTable.eventSequence, turnAcceptedSeq),
          ),
        )
        .limit(1);
      if (ta) events.push(ta);
      const [tc] = await tx
        .select()
        .from(threadEventTable)
        .where(
          and(
            eq(threadEventTable.threadId, thread.id),
            eq(threadEventTable.eventSequence, turnCompletedSeq),
          ),
        )
        .limit(1);
      if (tc) events.push(tc);
    }
    events.push(itemCreatedEvent);
    events.push(publishedEvent);

    return {
      job,
      item: createdItem,
      projection: createdProjection,
      turn: createdTurn,
      events,
      replayed: false,
    };
  });

  // 如果事务外已查到 existingProjection，但事务内未命中（已被并发删除等极端情况），
  // 这里仍以事务内结果为准。
  void existingProjection;

  return result;
}

// ─── 查询 ────────────────────────────────────────────────────

/** 按 jobId 查询 JobResultProjection。不存在返回 null。 */
export async function getJobResultProjectionByJob(
  tenantId: string,
  jobId: string,
): Promise<JobResultProjection | null> {
  const [row] = await db
    .select()
    .from(jobResultProjectionTable)
    .where(
      and(
        eq(jobResultProjectionTable.tenantId, tenantId),
        eq(jobResultProjectionTable.jobId, jobId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 按 itemId 查询 JobResultProjection。不存在返回 null。 */
export async function getJobResultProjectionByItem(
  tenantId: string,
  itemId: string,
): Promise<JobResultProjection | null> {
  const [row] = await db
    .select()
    .from(jobResultProjectionTable)
    .where(
      and(
        eq(jobResultProjectionTable.tenantId, tenantId),
        eq(jobResultProjectionTable.itemId, itemId),
      ),
    )
    .limit(1);
  return row ?? null;
}
