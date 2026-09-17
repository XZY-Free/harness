/**
 * Thread 级「后续 Invocation 环境选择」的持久事实（schema-design §5.2.20）。
 *
 * 状态语义（本节即"长期生效"与"首次应用记录"的边界）：
 * - `pending`：Schema 默认值。生产唯一入口在接纳的同时完成授权校验，因此不单独落 `pending`。
 * - `accepted_for_next_invocation`：已接纳、尚未被任何 Invocation 使用。
 * - `applied`：已被**首次使用**，并且**继续作为后续默认选择有效，直到新请求取代**。
 *   `firstAppliedInvocationId` 是一次性审计锚点：只记录"首次使用该选择的 Invocation"，
 *   不表达"该选择只在这一次生效"。
 * - `rejected` / `expired`：不再生效。
 *
 * 因此"生效选择" = `accepted_for_next_invocation` ∪ `applied` 中 `selectionSequence` 最大的一条。
 * 新请求天然取代旧选择（序号更大），旧 `applied` 行保留为历史事实而不改状态。
 */
import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { threadTable } from "@/lib/persistence/schema/conversation";
import type { EnvironmentChangeRequest } from "@/lib/persistence/schema/environment-change-request";
import { environmentChangeRequestTable } from "@/lib/persistence/schema/environment-change-request";
import { and, desc, eq, inArray } from "drizzle-orm";

/** 仍是「Thread 当前生效选择」的状态集合（顺序无关，仅用于谓词）。 */
const EFFECTIVE_ENVIRONMENT_SELECTION_STATES = ["accepted_for_next_invocation", "applied"] as const;

/**
 * 提出一次环境选择请求。
 *
 * `selectionSequence` 是「Thread 锁下 MAX+1」（schema-design §5.2.20）：先锁 Thread 行，
 * 再取本 Thread 的最大序号，保证并发请求不会算出同一个序号而触发
 * `EnvironmentChangeRequest_tenant_thread_sequence_uq`。
 */
export async function requestEnvironmentSelection(input: {
  tenantId: string;
  threadId: string;
  requestedRevisionId: string;
  requestedBy: string;
  reasonCode?: string | null;
  expiresAt?: Date | null;
}): Promise<EnvironmentChangeRequest> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    const [thread] = await tx
      .select({ id: threadTable.id })
      .from(threadTable)
      .where(and(eq(threadTable.tenantId, input.tenantId), eq(threadTable.id, input.threadId)))
      .for("update")
      .limit(1);
    if (!thread) throw new Error(`Thread 不存在（id=${input.threadId}）`);
    const [latest] = await tx
      .select({ sequence: environmentChangeRequestTable.selectionSequence })
      .from(environmentChangeRequestTable)
      .where(
        and(
          eq(environmentChangeRequestTable.tenantId, input.tenantId),
          eq(environmentChangeRequestTable.threadId, input.threadId),
        ),
      )
      .orderBy(desc(environmentChangeRequestTable.selectionSequence))
      .limit(1);
    await tx.insert(environmentChangeRequestTable).values({
      id,
      tenantId: input.tenantId,
      threadId: input.threadId,
      selectionSequence: (latest?.sequence ?? 0) + 1,
      requestedRevisionId: input.requestedRevisionId,
      // 生产入口在写请求前已完成"该 Revision 授权可用"的校验，故直接写接纳态。
      requestState: "accepted_for_next_invocation",
      requestedBy: input.requestedBy,
      reasonCode: input.reasonCode ?? null,
      firstAppliedInvocationId: null,
      expiresAt: input.expiresAt ?? null,
      versionNo: 1,
    });
  });
  const row = await getEnvironmentChangeRequestById(input.tenantId, id);
  if (!row) throw new Error(`EnvironmentChangeRequest 写入后回查失败（id=${id}）`);
  return row;
}

export async function getEnvironmentChangeRequestById(
  tenantId: string,
  id: string,
  executor: DbOrTx = db,
): Promise<EnvironmentChangeRequest | null> {
  const [row] = await executor
    .select()
    .from(environmentChangeRequestTable)
    .where(
      and(
        eq(environmentChangeRequestTable.tenantId, tenantId),
        eq(environmentChangeRequestTable.id, id),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 读取 Thread 当前生效的环境选择（最新优先 → 契约的「新请求取代」）。
 *
 * 包含 `applied`：已应用选择在契约中仍是后续默认选择，直到更大的 `selectionSequence`
 * 出现。只读，不改变任何状态。
 */
export async function getEffectiveEnvironmentSelection(
  tenantId: string,
  threadId: string,
  executor: DbOrTx = db,
): Promise<EnvironmentChangeRequest | null> {
  const [row] = await executor
    .select()
    .from(environmentChangeRequestTable)
    .where(
      and(
        eq(environmentChangeRequestTable.tenantId, tenantId),
        eq(environmentChangeRequestTable.threadId, threadId),
        inArray(environmentChangeRequestTable.requestState, [
          ...EFFECTIVE_ENVIRONMENT_SELECTION_STATES,
        ]),
      ),
    )
    .orderBy(desc(environmentChangeRequestTable.selectionSequence))
    .limit(1);
  return row ?? null;
}

/**
 * 记录「该选择首次被某个 Invocation 使用」：推进到 `applied` 并回填 `firstAppliedInvocationId`。
 *
 * - **一次性**：`firstAppliedInvocationId` 已存在时直接返回 `false`（重复调度是幂等重放，
 *   不改写首用锚点，也不改 `versionNo`）；
 * - **CAS**：锁定该行后再复核，并发下只有一个 Invocation 能成为首用者；
 * - 返回 `true` 表示本次就是首次应用。
 */
export async function recordEnvironmentSelectionFirstApplied(input: {
  tenantId: string;
  selectionId: string;
  invocationId: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(environmentChangeRequestTable)
      .where(
        and(
          eq(environmentChangeRequestTable.tenantId, input.tenantId),
          eq(environmentChangeRequestTable.id, input.selectionId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) {
      throw new Error(`EnvironmentChangeRequest 不存在（id=${input.selectionId}）`);
    }
    if (current.firstAppliedInvocationId) return false;
    await tx
      .update(environmentChangeRequestTable)
      .set({
        requestState: "applied",
        firstAppliedInvocationId: input.invocationId,
        versionNo: current.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(environmentChangeRequestTable.id, current.id));
    return true;
  });
}
