import { db } from "@/lib/db/client";
import { TURN_TERMINAL_STATES, turnTable } from "@/lib/persistence/schema/conversation";
import {
  INVOCATION_TERMINAL_STATES,
  executionOwnershipTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import {
  type ThreadGenerationBaseline,
  type ThreadTurnGeneration,
  nextThreadGenerationRevision,
} from "@/lib/runtime/thread-generation";
/**
 * A11：读取 Thread 的权威执行代际事实，并发出可用作 SSE 基线的快照。
 *
 * 事实源是**正式执行事实**，不是"第一条 delta 自报"：
 * - 当前活动执行 = `Turn.activeInvocationId`（schema 注释：当前 queued/running/waiting 执行）；
 * - 当前代际 = 该 Invocation 的 **active** `ExecutionOwnership`（Attempt/Ownership/leaseEpoch）；
 * - `baselineSequence` 由调用方传入（SSE 路由已经持有它），不在这里多查一次。
 *
 * 无活动执行的 Turn 明确输出 `generation: null`：消费侧据此丢弃迟到 delta，而不是把它们
 * 拼进上一代的正文里。终态 Turn 不进基线（终态执行不可能再产生合法 transient）。
 */
import { and, asc, desc, eq, notInArray } from "drizzle-orm";

interface TurnGenerationRow {
  readonly turnId: string;
  readonly activeInvocationId: string | null;
  readonly executionState: string | null;
  readonly ownershipId: string | null;
  readonly attemptId: string | null;
  readonly leaseEpoch: number | null;
}

/**
 * 该 Thread 每个**非终态** Turn 的当前代际（无活动执行 → null）。
 *
 * 单次查询完成：Turn ←(activeInvocationId)→ Invocation ←(active Ownership)→ Ownership。
 * `leaseEpoch DESC` 保证同一个 Turn 真出现多条 active Ownership 时取最新一代；
 * 正常情况每个 Turn 至多一条。
 */
export async function readThreadTurnGenerations(
  tenantId: string,
  threadId: string,
): Promise<ThreadTurnGeneration[]> {
  const rows = await db
    .select({
      turnId: turnTable.id,
      activeInvocationId: turnTable.activeInvocationId,
      executionState: invocationTable.executionState,
      ownershipId: executionOwnershipTable.id,
      attemptId: executionOwnershipTable.attemptId,
      leaseEpoch: executionOwnershipTable.leaseEpoch,
    })
    .from(turnTable)
    .leftJoin(
      invocationTable,
      and(
        eq(invocationTable.id, turnTable.activeInvocationId),
        eq(invocationTable.tenantId, tenantId),
      ),
    )
    .leftJoin(
      executionOwnershipTable,
      and(
        eq(executionOwnershipTable.invocationId, invocationTable.id),
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .where(
      and(
        eq(turnTable.threadId, threadId),
        notInArray(turnTable.turnState, [...TURN_TERMINAL_STATES]),
      ),
    )
    .orderBy(asc(turnTable.turnSequence), desc(executionOwnershipTable.leaseEpoch));

  const byTurn = new Map<string, TurnGenerationRow>();
  for (const row of rows) {
    // 排序已按 (turnSequence ASC, leaseEpoch DESC)：每个 Turn 的第一行就是当前代际。
    if (!byTurn.has(row.turnId)) byTurn.set(row.turnId, row);
  }

  return [...byTurn.values()].map((row) => ({
    turnId: row.turnId,
    generation: resolveRowGeneration(row),
  }));
}

/** 行 → 代际；Invocation/Attempt/Ownership 任一缺失或 Invocation 已终态 → 明确 null。 */
function resolveRowGeneration(row: TurnGenerationRow): ThreadTurnGeneration["generation"] {
  if (
    !row.activeInvocationId ||
    !row.ownershipId ||
    !row.attemptId ||
    row.leaseEpoch === null ||
    row.executionState === null ||
    INVOCATION_TERMINAL_STATES.includes(
      row.executionState as (typeof INVOCATION_TERMINAL_STATES)[number],
    )
  ) {
    return null;
  }
  return {
    invocationId: row.activeInvocationId,
    attemptId: row.attemptId,
    ownershipId: row.ownershipId,
    // epoch 线上是十进制字符串：DB bigint → 字符串，绝不经 Number 再转。
    leaseEpoch: String(row.leaseEpoch),
  };
}

/** 读事实 + 发号，得到可直接下发的一条基线。 */
export async function issueThreadGenerationBaseline(input: {
  tenantId: string;
  threadId: string;
  baselineSequence: number;
}): Promise<ThreadGenerationBaseline> {
  const generations = await readThreadTurnGenerations(input.tenantId, input.threadId);
  return {
    threadId: input.threadId,
    baselineSequence: input.baselineSequence,
    issuedRevision: nextThreadGenerationRevision(),
    generations,
  };
}
