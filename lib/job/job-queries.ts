/**
 * Job 仓储（S09-C04）。
 *
 * 事实源：
 * - docs/architecture/persistence.md （Job 表）、（事务边界）
 * - docs/architecture/memory-and-job-api.md §4（Job Control API）
 * - docs/architecture/domain-model.md 、
 * - docs/architecture/capability-and-collaboration-api.md §4、§5
 * - docs/architecture/conversations.md §16（取消流程）
 * - docs/architecture/conversations.md 、S09-C04
 *
 * 职责：
 * - createJob：领域服务调用，创建 Job + 写 job.queued Event（不提供通用 POST /jobs）。
 * - getJobById / listJobsByTenant / listJobsByAgent：跨租户隔离查询。
 * - updateJobState：状态机转换（queued → running → waiting_external → running → 终态）。
 * - recordJobResult：终态时写入 resultRef/resultHash + job.result_recorded Event。
 *
 * 关键约束：
 * - Job 创建只能来自所属领域服务（评测/知识/调度/批量）；Runtime 不能调用通用 Job 创建接口。
 * - Job 不复活：终态 Job 不能改回 queued；retry 通过 replaces_job_id 创建新 Job。
 * - JobEvent 不出现在员工 Thread SSE；只有 job_result projection 才进入 ThreadEvent。
 * - completion_policy_json 决定整个 Job 终态；单 Invocation 终态只写 job.invocation_*。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */
import { randomUUID } from "node:crypto";
import { computeJobInputDigest } from "@/lib/job/job-input-digest";
import { db } from "@/lib/db/client";
import { encodeCursor } from "@/lib/http";
import { parseCompletionPolicy } from "@/lib/job/completion-policy";
import { JobNotFoundError, JobStateConflictError, JobVersionConflictError } from "@/lib/job/errors";
import { allocateJobEventSequences, insertJobEvent } from "@/lib/job/job-event-queries";
import {
  type Job,
  type JobEvent,
  type JobEventActorType,
  type JobInputKind,
  type JobState,
  type JobType,
  jobEventTable,
  jobTable,
} from "@/lib/persistence/schema/job";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Job 终态集合。 */
const TERMINAL_STATES: readonly JobState[] = ["completed", "failed", "cancelled"];

/** Job 状态机合法转换映射。 */
const STATE_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["running", "cancelled"], // queued 可直接 cancel（未启动）
  running: ["waiting_external", "completed", "failed", "cancelled"],
  waiting_external: ["running", "completed", "failed", "cancelled"],
  completed: [], // 终态
  failed: [], // 终态
  cancelled: [], // 终态
};

// ─── createJob ──────────────────────────────────────────────

/** createJob 入参。 */
export interface CreateJobParams {
  tenantId: string;
  /**
   * 可选 Agent 引用。null/缺省表示该 Job 不需要 Agent——无 Agent 不等于无权限，
   * service Principal、正式输入、ExecutionBinding 仍是必需事实。
   */
  agentId?: string | null;
  jobType: JobType;
  /** 领域触发引用（如 schedule_id、batch_id、deployment_id）。 */
  triggerRef: string;
  /** Stable business creation identity used to deduplicate scheduler delivery. */
  creationKey?: string;
  /** 完成策略：all_success / fail_fast / threshold / 自定义。 */
  completionPolicyJson: Record<string, unknown>;
  /** 结果需要进入员工会话时预先关联的 Thread（可选）。 */
  threadId?: string;
  /** retry 时指向原 Job；原 Job 状态/事件不被覆盖。 */
  replacesJobId?: string;
  /** Job 输入引用（领域服务保证输入仍可访问）。 */
  inputRef?: string;
  inputJson?: unknown;
  inputKind?: JobInputKind;
  /**
   * **仅 reference 输入可用**：创建方冻结的内容摘要（定位符不含内容，摘要无法从 inputRef 推导）。
   * inline 输入必须由 `inputJson` 经规范摘要推导，传入本字段会被拒绝。
   */
  inputHash?: string;
  createdBy?: string;
  /** Event actor（默认 system，因领域服务触发）。 */
  actorType?: JobEventActorType;
  actorId?: string;
  correlationId?: string;
  idempotencyKey?: string;
}

/** createJob 返回结果。 */
export interface CreateJobResult {
  job: Job;
  /** 写入的 job.queued Event（sequence=1）。 */
  queuedEvent: JobEvent;
}

export class JobCreationConflictError extends Error {
  constructor(public readonly creationKey: string) {
    super(`Job creationKey 已绑定不同 inputHash：${creationKey}`);
    this.name = "InputDigestMismatch";
  }
}

/**
 * 领域服务创建 Job。
 *
 * 流程（同事务）：
 * 1. INSERT Job（jobState=queued，lastEventSequence=0）
 * 2. allocateJobEventSequences(1) → sequence=1
 * 3. insertJobEvent(job.queued) → JobEvent
 * 4. UPDATE Job.lastEventSequence（已在 allocateJobEventSequences 内完成）
 *
 * 不变量：
 * - 不提供通用 POST /jobs 入口；调用方必须是所属领域服务。
 * - 不在此函数校验 Agent 存在性（由调用方领域服务校验）。
 * - 不修改 Thread（threadId 仅记录关联）。
 */
export async function createJob(params: CreateJobParams): Promise<CreateJobResult> {
  if (!params.tenantId) {
    throw new Error("createJob: tenantId 不能为空");
  }
  const agentId = params.agentId ?? null;
  if (agentId !== null && (typeof agentId !== "string" || agentId.trim().length === 0)) {
    throw new Error("createJob: agentId 只能为 null 或非空字符串");
  }
  if (!params.triggerRef) {
    throw new Error("createJob: triggerRef 不能为空");
  }
  if (!params.completionPolicyJson) {
    throw new Error("createJob: completionPolicyJson 不能为空");
  }
  // R06 §5：策略在创建时冻结，且必须是**可判定**的策略。把校验放在创建处（而不是
  // 等到终态消费时才失败）才能保证"冻结的完成条件"从第一天起就有效——否则会存下
  // 一个永远无法解释的 Job，终态只能靠猜。
  parseCompletionPolicy(params.completionPolicyJson);

  const actorType: JobEventActorType = params.actorType ?? "system";
  const now = new Date();
  const jobId = randomUUID();
  const inputKind: JobInputKind = params.inputRef ? "reference" : (params.inputKind ?? "inline");
  if (inputKind === "reference" && !params.inputRef) {
    throw new Error("createJob: reference input 必须提供 inputRef");
  }
  if (inputKind === "inline" && params.inputRef) {
    throw new Error("createJob: inline input 不得提供 inputRef");
  }
  const inputJson = inputKind === "inline" ? (params.inputJson ?? {}) : null;
  // A10：Job 输入的摘要必须是**JSON 语义稳定**的。`Job.inputJson` 是 MySQL JSON 列，
  // 回读时对象键会被服务端规范化重排；若创建时用 `JSON.stringify`（依赖属性插入顺序），
  // 同一个合法对象 round-trip 后字节序改变就会被判成 `InputDigestMismatch`。
  // 因此创建、重复接纳（creationKey 比对）与运行时复验共用同一条 RFC 8785 规范化摘要。
  //
  // `inputHash` 只对 **reference** 输入开放：定位符本身不含内容，冻结的内容摘要是独立事实
  // （JOB-07 义务依赖它）。**inline 输入一律拒绝自报摘要**——其 payload 就在行内，
  // 推导出来的摘要才是可信的，自报 hash 是纯粹的旁路。
  if (params.inputHash !== undefined && inputKind !== "reference") {
    throw new Error(
      "createJob: 只有 reference 输入可声明内容摘要；inline 输入的 inputHash 必须由 inputJson 推导",
    );
  }
  const inputHash =
    params.inputHash ?? computeJobInputDigest(inputKind === "inline" ? inputJson : params.inputRef);

  const result = await db.transaction(async (tx) => {
    // creationKey 来自领域服务的正式业务触发身份（09 §8.2）；未提供时用 Job 自身 id
    // 满足 NOT NULL/UNIQUE，不形成隐式去重（同 triggerRef 的 replacement Job 必须可创建）。
    const creationKey = params.creationKey ?? jobId;
    const [existing] = params.creationKey
      ? await tx
          .select()
          .from(jobTable)
          .where(and(eq(jobTable.tenantId, params.tenantId), eq(jobTable.creationKey, creationKey)))
          .for("update")
          .limit(1)
      : [];
    if (existing) {
      if (existing.inputHash !== inputHash) throw new JobCreationConflictError(creationKey);
      const [queuedEvent] = await tx
        .select()
        .from(jobEventTable)
        .where(
          and(
            eq(jobEventTable.tenantId, params.tenantId),
            eq(jobEventTable.jobId, existing.id),
            eq(jobEventTable.eventType, "job.queued"),
          ),
        )
        .orderBy(jobEventTable.eventSequence)
        .limit(1);
      if (!queuedEvent)
        throw new Error(`createJob: 已存在 Job 但缺少 job.queued Event（id=${existing.id}）`);
      return { job: existing, queuedEvent };
    }

    // 1. INSERT Job
    await tx.insert(jobTable).values({
      id: jobId,
      tenantId: params.tenantId,
      agentId,
      jobType: params.jobType,
      triggerRef: params.triggerRef,
      creationKey,
      jobState: "queued",
      replacesJobId: params.replacesJobId ?? null,
      threadId: params.threadId ?? null,
      completionPolicyJson: params.completionPolicyJson,
      inputKind,
      inputJson,
      inputRef: params.inputRef ?? null,
      inputHash,
      lastEventSequence: 0,
      resultRef: null,
      resultHash: null,
      errorCode: null,
      errorSummary: null,
      createdBy: params.createdBy ?? "system",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
      versionNo: 1,
    });

    // 2. allocateJobEventSequences(1) → sequence=1
    const startSeq = await allocateJobEventSequences(tx, jobId, 1);

    // 3. insertJobEvent(job.queued)
    const queuedEvent = await insertJobEvent(tx, params.tenantId, jobId, startSeq, {
      eventType: "job.queued",
      actorType,
      actorId: params.actorId,
      payload: {
        job_id: jobId,
        tenant_id: params.tenantId,
        agent_id: agentId,
        job_type: params.jobType,
        trigger_ref: params.triggerRef,
        thread_id: params.threadId ?? null,
        replaces_job_id: params.replacesJobId ?? null,
        completion_policy: params.completionPolicyJson,
        input_ref: params.inputRef ?? null,
        input_hash: inputHash,
        input_kind: inputKind,
        input_json: inputJson,
        created_by: params.createdBy ?? null,
      },
      correlationId: params.correlationId,
      idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:job-queued` : undefined,
    });

    // 4. 回读 Job
    const [job] = await tx.select().from(jobTable).where(eq(jobTable.id, jobId)).limit(1);
    if (!job) {
      throw new Error(`createJob: Job 行未找到（id=${jobId}）`);
    }

    return { job, queuedEvent };
  });

  return result;
}

// ─── 查询 ────────────────────────────────────────────────────

/** 按 id 获取 Job。不存在返回 null。 */
export async function getJobById(tenantId: string, jobId: string): Promise<Job | null> {
  const [row] = await db
    .select()
    .from(jobTable)
    .where(and(eq(jobTable.tenantId, tenantId), eq(jobTable.id, jobId)))
    .limit(1);
  return row ?? null;
}

/** 按 agent 列出 Job（按 createdAt 降序）。 */
export async function listJobsByAgent(
  tenantId: string,
  agentId: string,
  options?: { limit?: number; jobState?: JobState },
): Promise<Job[]> {
  const conditions = [eq(jobTable.tenantId, tenantId), eq(jobTable.agentId, agentId)];
  if (options?.jobState) {
    conditions.push(eq(jobTable.jobState, options.jobState));
  }
  return db
    .select()
    .from(jobTable)
    .where(and(...conditions))
    .orderBy(desc(jobTable.createdAt))
    .limit(options?.limit ?? 100);
}

/** 按状态列出 Job（按 createdAt 降序）。 */
export async function listJobsByState(
  tenantId: string,
  jobState: JobState,
  options?: { limit?: number },
): Promise<Job[]> {
  return db
    .select()
    .from(jobTable)
    .where(and(eq(jobTable.tenantId, tenantId), eq(jobTable.jobState, jobState)))
    .orderBy(desc(jobTable.createdAt))
    .limit(options?.limit ?? 100);
}

/** 列出 Job 终态集合内的 Job（用于 retry 候选查询）。 */
export async function listTerminalJobsByAgent(
  tenantId: string,
  agentId: string,
  options?: { limit?: number },
): Promise<Job[]> {
  return db
    .select()
    .from(jobTable)
    .where(
      and(
        eq(jobTable.tenantId, tenantId),
        eq(jobTable.agentId, agentId),
        inArray(jobTable.jobState, [...TERMINAL_STATES]),
      ),
    )
    .orderBy(desc(jobTable.createdAt))
    .limit(options?.limit ?? 100);
}

// ─── 状态机 ──────────────────────────────────────────────────

/**
 * 更新 Job 状态（状态机校验 + 乐观锁）。
 *
 * 必须在 db.transaction 内调用；调用方负责写对应的 JobEvent（如 job.started、job.completed）。
 *
 * 不变量：
 * - 终态不可恢复（job 不复活）。
 * - 状态转换必须符合 STATE_TRANSITIONS 映射。
 *
 * @returns 更新后的 Job；versionNo 冲突返回 null
 */
export async function updateJobState(
  tx: Tx,
  tenantId: string,
  jobId: string,
  nextState: JobState,
  expectedVersionNo: number,
): Promise<Job> {
  const [current] = await tx
    .select()
    .from(jobTable)
    .where(and(eq(jobTable.tenantId, tenantId), eq(jobTable.id, jobId)))
    .for("update")
    .limit(1);
  if (!current) {
    throw new JobNotFoundError(jobId);
  }

  if (current.versionNo !== expectedVersionNo) {
    throw new JobVersionConflictError(jobId, expectedVersionNo, current.versionNo);
  }

  // 终态不可恢复
  if (TERMINAL_STATES.includes(current.jobState)) {
    throw new JobStateConflictError(jobId, current.jobState, `转换到 ${nextState}`);
  }

  // 状态转换合法性校验
  const allowed = STATE_TRANSITIONS[current.jobState];
  if (!allowed.includes(nextState)) {
    throw new JobStateConflictError(jobId, current.jobState, `转换到 ${nextState}`);
  }

  // 计算 startedAt / finishedAt
  const now = new Date();
  const updates: Partial<Job> = {
    jobState: nextState,
    versionNo: current.versionNo + 1,
    updatedAt: now,
  };
  if (nextState === "running" && !current.startedAt) {
    updates.startedAt = now;
  }
  if (TERMINAL_STATES.includes(nextState)) {
    updates.finishedAt = now;
  }

  await tx.update(jobTable).set(updates).where(eq(jobTable.id, jobId));

  const [updated] = await tx.select().from(jobTable).where(eq(jobTable.id, jobId)).limit(1);
  if (!updated) {
    throw new Error(`updateJobState: Job 行未找到（id=${jobId}）`);
  }
  return updated;
}

/**
 * 记录 Job 结果（job.result_recorded Event + 写 resultRef/resultHash）。
 *
 * 不变量：
 * - resultRef/resultHash 写入后不可修改（调用方负责校验）。
 * - 调用方应在 Job 进入终态前调用本函数。
 */
export async function recordJobResult(
  tx: Tx,
  tenantId: string,
  jobId: string,
  result: {
    resultRef: string;
    resultHash: string;
    resultSummaryJson?: Record<string, unknown> | null;
  },
  options?: {
    actorType?: JobEventActorType;
    actorId?: string;
    correlationId?: string;
    idempotencyKey?: string;
  },
): Promise<{ job: Job; resultRecordedEvent: JobEvent }> {
  const [current] = await tx
    .select()
    .from(jobTable)
    .where(and(eq(jobTable.tenantId, tenantId), eq(jobTable.id, jobId)))
    .for("update")
    .limit(1);
  if (!current) {
    throw new JobNotFoundError(jobId);
  }

  // 写 resultRef/resultHash
  await tx
    .update(jobTable)
    .set({
      resultRef: result.resultRef,
      resultHash: result.resultHash,
      updatedAt: new Date(),
    })
    .where(eq(jobTable.id, jobId));

  // 写 job.result_recorded Event
  const startSeq = await allocateJobEventSequences(tx, jobId, 1);
  const resultRecordedEvent = await insertJobEvent(tx, tenantId, jobId, startSeq, {
    eventType: "job.result_recorded",
    actorType: options?.actorType ?? "system",
    actorId: options?.actorId,
    payload: {
      job_id: jobId,
      result_ref: result.resultRef,
      result_hash: result.resultHash,
      result_summary: result.resultSummaryJson ?? null,
    },
    correlationId: options?.correlationId,
    idempotencyKey: options?.idempotencyKey
      ? `${options.idempotencyKey}:job-result-recorded`
      : undefined,
  });

  const [updated] = await tx.select().from(jobTable).where(eq(jobTable.id, jobId)).limit(1);
  if (!updated) {
    throw new Error(`recordJobResult: Job 行未找到（id=${jobId}）`);
  }

  return { job: updated, resultRecordedEvent };
}

// ─── re-export 供外部统一从本模块引入类型 ───────────────────

export type {
  Job,
  JobEvent,
  JobState,
  JobType,
  JobEventActorType,
} from "@/lib/persistence/schema/job";

// ─── S11-W04 管理面排障：跨 agent 列出租户所有 Job ─────────

/**
 * 跨 agent 列出租户所有 Job（按 createdAt 降序，跨租户隔离）。
 *
 * 事实源：S11-W04 管理面排障端点 /admin/api/jobs 使用本函数。
 *
 * 选项：
 * - jobState：过滤 Job 状态。
 * - limit：默认 50，最大 200。
 * - afterCreatedAt：游标分页（createdAt < afterCreatedAt 取下一页）。
 *
 * @returns `{ items, nextCursor }`，nextCursor 为不透明 cursor（base64url(JSON)），无更多数据时为 null。
 */
export async function listJobsByTenant(
  tenantId: string,
  options?: {
    jobState?: JobState;
    limit?: number;
    afterCreatedAt?: Date;
  },
): Promise<{ items: Job[]; nextCursor: string | null }> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [eq(jobTable.tenantId, tenantId)];
  if (options?.jobState) {
    conditions.push(eq(jobTable.jobState, options.jobState));
  }
  if (options?.afterCreatedAt) {
    // 按 createdAt 降序取下一页：游标为上一页最后一条的 createdAt
    conditions.push(sql`${jobTable.createdAt} < ${options.afterCreatedAt}`);
  }

  // 取 limit+1 行：第 limit+1 行存在说明有下一页，其 createdAt 即下一个 cursor
  const rows = await db
    .select()
    .from(jobTable)
    .where(and(...conditions))
    .orderBy(desc(jobTable.createdAt))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  let items = rows;
  if (rows.length > limit) {
    items = rows.slice(0, limit);
    const lastKept = items[items.length - 1];
    if (lastKept) {
      nextCursor = encodeCursor({
        created_at: lastKept.createdAt.toISOString(),
        id: lastKept.id,
      });
    }
  }

  return { items, nextCursor };
}
