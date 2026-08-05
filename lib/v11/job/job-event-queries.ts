/**
 * V11 JobEvent 仓储（S09-C04）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.1 文末（JobEvent 表）、§9.1（事务边界）
 * - ../v11-agentkit-platform/09-unified-domain-model.md §5.3（JobEvent 与 ThreadEvent 平行）
 * - ../v11-agentkit-platform/contracts/event-catalog.json（18 个 job.* 事件）
 * - ../v11-agentkit-platform-development-plan/09-collaboration-jobs-and-recovery.md S09-W04
 *
 * 职责：
 * - allocateJobEventSequences：锁定 Job.lastEventSequence 原子递增（与 Thread 模式一致）。
 * - insertJobEvent：在事务内写入单条 JobEvent（调用方先 allocateJobEventSequences）。
 * - getJobEvents / getJobEventsSince：按 sequence 升序查询，支持 SSE 续读。
 * - getLatestJobEventSequence：返回 Job 最新 event sequence（用于 projection checkpoint）。
 *
 * sequence 分配策略（§9.1）：
 * - 锁定 Job.last_event_sequence 原子递增，不用 max(sequence)+1。
 * - 在事务内 SELECT ... FOR UPDATE 锁定 Job 行，递增 lastEventSequence 后写入。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  type JobEvent,
  type JobEventActorType,
  type JobEventType,
  jobEventTable,
  jobTable,
} from "@/lib/persistence/schema/job";
import { JobNotFoundError } from "@/lib/v11/job/errors";
import { and, asc, eq, sql } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** insertJobEvent 写入参数。 */
export interface JobEventInput {
  eventType: JobEventType;
  invocationId?: string;
  actorType: JobEventActorType;
  actorId?: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
}

/**
 * 锁定 Job 行并原子分配 event sequence。
 *
 * 事实源：§9.1 行 633 "锁定 Job.last_event_sequence 原子递增，不用 max(sequence)+1"。
 *
 * 必须在 db.transaction 内调用，FOR UPDATE 锁定持续到事务提交。
 *
 * @param tx 事务句柄
 * @param jobId Job id
 * @param count 要分配的 event sequence 数量（默认 1）
 * @returns 分配的起始 sequence（连续）
 */
export async function allocateJobEventSequences(tx: Tx, jobId: string, count = 1): Promise<number> {
  // SELECT ... FOR UPDATE 锁定 Job 行
  const [row] = await tx
    .select({ lastEventSequence: jobTable.lastEventSequence })
    .from(jobTable)
    .where(eq(jobTable.id, jobId))
    .for("update")
    .limit(1);

  if (!row) {
    throw new JobNotFoundError(jobId);
  }

  const startSequence = row.lastEventSequence + 1;
  const newLast = row.lastEventSequence + count;

  await tx.update(jobTable).set({ lastEventSequence: newLast }).where(eq(jobTable.id, jobId));

  return startSequence;
}

/**
 * 在事务内写入单个 JobEvent。
 *
 * 调用方必须先通过 allocateJobEventSequences 获取 sequence。
 *
 * 注意：idempotencyKey 在同事务内多 Event 间不能共享（UNIQUE(jobId, idempotencyKey) 约束）。
 * 调用方应为不同 eventType 加后缀（如 `${base}:${eventType}`）。
 */
export async function insertJobEvent(
  tx: Tx,
  tenantId: string,
  jobId: string,
  sequence: number,
  input: JobEventInput,
): Promise<JobEvent> {
  const id = randomUUID();
  const now = new Date();
  await tx.insert(jobEventTable).values({
    id,
    tenantId,
    jobId,
    eventSequence: sequence,
    eventType: input.eventType,
    schemaVersion: 1,
    invocationId: input.invocationId ?? null,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    payloadJson: input.payload,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    occurredAt: now,
    ingestedAt: now,
  });

  const [row] = await tx.select().from(jobEventTable).where(eq(jobEventTable.id, id)).limit(1);
  if (!row) {
    throw new Error(`insertJobEvent: 行未找到（id=${id}）`);
  }
  return row;
}

/**
 * 查询 Job 全部 Event（按 sequence 升序）。
 * 跨租户隔离：按 tenantId + jobId 过滤。
 *
 * @param limit 默认 100
 */
export async function getJobEvents(
  tenantId: string,
  jobId: string,
  options?: { limit?: number },
): Promise<JobEvent[]> {
  const limit = options?.limit ?? 100;
  return db
    .select()
    .from(jobEventTable)
    .where(and(eq(jobEventTable.tenantId, tenantId), eq(jobEventTable.jobId, jobId)))
    .orderBy(asc(jobEventTable.eventSequence))
    .limit(limit);
}

/**
 * 查询 Job Event（从 afterSequence+1 开始，按 sequence 升序）。
 * 用于 SSE 续读：客户端发 Last-Event-ID=N，服务端返回 sequence > N 的事件。
 *
 * 跨租户隔离：先校验 Job 属于该 tenantId。
 */
export async function getJobEventsSince(
  tenantId: string,
  jobId: string,
  afterSequence: number,
  options?: { limit?: number },
): Promise<JobEvent[]> {
  const limit = options?.limit ?? 100;
  // 先校验 Job 跨租户可见
  const [job] = await db
    .select({ id: jobTable.id })
    .from(jobTable)
    .where(and(eq(jobTable.tenantId, tenantId), eq(jobTable.id, jobId)))
    .limit(1);
  if (!job) return [];

  return db
    .select()
    .from(jobEventTable)
    .where(
      and(
        eq(jobEventTable.tenantId, tenantId),
        eq(jobEventTable.jobId, jobId),
        sql`${jobEventTable.eventSequence} > ${afterSequence}`,
      ),
    )
    .orderBy(asc(jobEventTable.eventSequence))
    .limit(limit);
}

/** 获取 Job 最新 event sequence（用于 projection checkpoint）。 */
export async function getLatestJobEventSequence(
  tenantId: string,
  jobId: string,
): Promise<number | null> {
  const [job] = await db
    .select({ lastEventSequence: jobTable.lastEventSequence })
    .from(jobTable)
    .where(and(eq(jobTable.tenantId, tenantId), eq(jobTable.id, jobId)))
    .limit(1);
  if (!job) return null;
  return job.lastEventSequence;
}
