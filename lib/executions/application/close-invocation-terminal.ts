import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
/**
 * Invocation 终态收口的**唯一**实现。
 *
 * R05/R06 的终态语义不是「把 Invocation 行改成 completed/failed/cancelled」这一件事，
 * 而是**一组必须同事务落地的事实**：
 *
 * - `InvocationAttempt` 收口（attemptState + finishedAt）；
 * - `Turn` 收口（turnState + finishedAt + activeInvocationId 清空 + 采用关系）；
 * - canonical Thread 事件 `turn.*` 与 `invocation.*`（产品页/时间线的重建依据）；
 * - `ExecutionOwnership` 失活（只失效 Authority，物理 Writer 由释放 lane 按 W→I 处理）；
 * - `RuntimeSessionBinding` 关闭（单向转换表，closed 不可回 active）；
 * - `Invocation` 终态 + `recoveryVersion` 水位（与终态同一条 UPDATE）；
 * - Job 终态桥（`terminalVersion` 必须等于最终提交版本）。
 *
 * 此前这条链只存在于 `RuntimeEventIngress` 的 `applyLifecycle` 里，而 `transitionInvocation`
 * 只改 Invocation 行并桥 Job；任何走后者的"终态旁路"（Hosted Cancel 就是实例）都会留下
 * Owner/Invocation 已关闭、Turn/Attempt/Session 仍活动的**状态分裂**。因此这里把这条链抽成
 * 单一实现，Ingress 与 Cancel 都调用它——收口边界相同，事实集合才可能相同。
 *
 * 本模块只接受**调用方已在本事务内锁定**的 Invocation 行，且不接受终端态入参：
 * 是否已终态由调用方（各自有不同的错误/空操作语义）判定。
 */
import type { db } from "@/lib/db/client";
import { registerEnvironmentLeaseCleanupForAttemptInTransaction } from "@/lib/environment/environment-lease-store";
import { bridgeInvocationTerminalToJob } from "@/lib/job/job-terminal-bridge";
import { threadItemTable, turnTable } from "@/lib/persistence/schema/conversation";
import {
  type Invocation,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import { closeRuntimeSessionBindingInTransaction } from "@/lib/runtime/persistence/runtime-session-store";
import { and, desc, eq, sql } from "drizzle-orm";

export type TerminalTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 非 `lost` 的终态：`lost` 由失权收口路径（`markInvocationLost`）负责，语义不同。 */
export type InvocationTerminalState = "completed" | "failed" | "cancelled";

/**
 * R05：Turn 状态变换必须**同时**写入 canonical ThreadEvent（`turn.*`）。
 *
 * 权威 Turn 表与 Thread 事件流是同一事实的两个投影面。Runtime 事件改写 Turn 表却不写
 * 事件时，`rebuildProjectionsForThread`（刷新产品页/从 DB 重建时间线）重放后 Turn 时间线
 * 仍停在旧状态，页面与正式输出不一致 —— 而这类不一致只靠 SSE 内存态是看不出来的。
 */
export async function appendTurnStateEvent(
  tx: TerminalTx,
  input: {
    threadId: string;
    turnId: string;
    invocationId: string;
    eventType:
      | "turn.started"
      | "turn.waiting"
      | "turn.completed"
      | "turn.failed"
      | "turn.cancelled";
    itemId?: string | null;
    errorCode?: string | null;
  },
): Promise<void> {
  const sequence = await allocateEventSequences(tx, input.threadId);
  await insertThreadEvent(tx, input.threadId, sequence, {
    eventType: input.eventType,
    turnId: input.turnId,
    itemId: input.itemId ?? undefined,
    invocationId: input.invocationId,
    actorType: "service",
    payload: { error_code: input.errorCode ?? null },
  });
}

/**
 * R05：Invocation 终态必须**同时**写入 canonical ThreadEvent（`invocation.*`）。
 *
 * 权威依据：
 * - `docs/architecture/api-and-events.md` §「Runtime Candidate Event 映射」：
 *   `execution.completed` 的公开 Event 是 **`invocation.completed` + `turn.completed`**
 *   （`execution.failed` → `invocation.failed + turn.failed`、
 *   `execution.cancelled` → `invocation.cancelled + turn.*`）；
 * - `docs/architecture/persistence.md` §「完成 Agent 回答/Regenerate」：
 *   同一事务写 `item.completed、item.superseded、invocation.completed、turn.completed`；
 * - `docs/contracts/event-catalog.json` 把 `invocation.completed` 登记为 thread 流的
 *   canonical 事件（`required_refs: thread_id、invocation_id`，且不可跳过投影）。
 *
 * 只写 `turn.completed` 会让事件流的 invocation 家族只有创建期的
 * `invocation.queued` 而没有终态：员工端/排障按 invocation 过滤时永远等不到收口信号，
 * 也无法从事件流判断某次 Invocation 是完成、失败还是被取消。
 * 注意与 `appendTurnStateEvent` 的分工：两者是同一终态的两个投影面，缺一不可。
 */
export async function appendInvocationStateEvent(
  tx: TerminalTx,
  input: {
    threadId: string;
    turnId: string;
    invocationId: string;
    eventType: "invocation.completed" | "invocation.failed" | "invocation.cancelled";
    finishReason?: string | null;
    itemId?: string | null;
    errorCode?: string | null;
  },
): Promise<void> {
  const sequence = await allocateEventSequences(tx, input.threadId);
  await insertThreadEvent(tx, input.threadId, sequence, {
    eventType: input.eventType,
    turnId: input.turnId,
    itemId: input.itemId ?? undefined,
    invocationId: input.invocationId,
    actorType: "service",
    payload: {
      finish_reason: input.finishReason ?? null,
      error_code: input.errorCode ?? null,
    },
  });
}

/**
 * 在同一事务内把 Invocation 及其全部从属事实收口到 `completed` / `failed` / `cancelled`。
 *
 * `invocation` 必须是本事务已 `SELECT … FOR UPDATE` 得到的当前行；函数内部按固定锁图
 * （Invocation → Attempt/Ownership/Session → Turn/Item）写入，**不回读 Invocation 之外的
 * 行锁**，因此不会引入新的反向序。
 *
 * 不解锁 WorkspaceWriteLock（R04 §3）：终态只失效 Authority，物理 Writer 的 stop/drain
 * 由持久释放 lane 按 W→I 顺序处理并留存真实回执。
 */
export async function closeInvocationTerminalInTransaction(
  tx: TerminalTx,
  input: {
    invocation: Invocation;
    attemptId: string;
    ownershipId: string;
    sessionBindingId: string;
    state: InvocationTerminalState;
    now: Date;
    resultRef?: string | null;
    resultDigest?: string | null;
    errorCode?: string | null;
    /** 终态错误摘要；不传则保持 Invocation 原值（Ingress 路径从不覆盖它）。 */
    errorSummary?: string | null;
    /** 终态事件的 `finish_reason`，按 Runtime 自报值原样透传（不臆造、不归一化）。 */
    finishReason?: string | null;
    /** R02 §8 CAS：调用方已锁到的 Session 行版本；不传则只做行锁 + 单向转换。 */
    sessionVersionNo?: number;
  },
): Promise<Invocation> {
  const { invocation, state, now } = input;
  let resultRef = input.resultRef ?? null;
  let resultDigest = input.resultDigest ?? null;
  // R06 §1：Job 的"真正结果"必须是**已持久内容与 digest**。Job 没有 Thread 可挂
  // assistant 消息，其产物的唯一事实源就是本 Invocation 已提交的 `response.completed`
  // Ingress 记录（`payloadHash` 就是该内容的正式摘要）。Runtime 自报的 resultRef
  // 若已给出则以其为准，绝不覆盖；只有当结果缺失时才从已持久事实推导，
  // 也从不在测试或生产填一个"没有对应内容"的引用就声明业务完成。
  if (state === "completed" && invocation.subjectType === "job" && (!resultRef || !resultDigest)) {
    const [produced] = await tx
      .select({
        id: runtimeEventIngressTable.id,
        payloadHash: runtimeEventIngressTable.payloadHash,
      })
      .from(runtimeEventIngressTable)
      .where(
        and(
          eq(runtimeEventIngressTable.tenantId, invocation.tenantId),
          eq(runtimeEventIngressTable.invocationId, invocation.id),
          eq(runtimeEventIngressTable.candidateType, "response.completed"),
        ),
      )
      .orderBy(desc(runtimeEventIngressTable.producerSequence))
      .limit(1);
    if (produced) {
      resultRef = resultRef ?? `runtime-event:${produced.id}`;
      resultDigest = resultDigest ?? produced.payloadHash;
    }
  }
  const errorCode = input.errorCode ?? null;
  const finishReason = input.finishReason ?? null;
  // 先收口从属事实（Attempt/Turn/Ownership/Session 与物理 Writer），
  // 最后才写 Invocation 终态并桥接 Job——terminalVersion 必须等于最终提交版本。
  await tx
    .update(invocationAttemptTable)
    .set({ attemptState: state, finishedAt: now, updatedAt: now })
    .where(eq(invocationAttemptTable.id, input.attemptId));
  const turnId = invocation.turnId;
  const threadId = invocation.threadId;
  if (turnId && threadId) {
    // R05：产品页（`GET /api/threads/{id}/turns`）读的是**权威 Turn 表**，因此
    // 终态收口必须同时落地 Turn 的"采用关系"——否则页面刷新后看不到正式输出：
    // - `adoptedInvocationId` = 产出当前 final_item 的会话执行（本 Invocation）；
    // - `finalItemId` = 本 Invocation 已提交的 `response.completed` 对应的
    //   assistant_message Item；没有正式回答（失败/取消）时保持原值不动，
    //   绝不把失败的半截回答抬成"当前正式回答"。
    // - `activeInvocationId` 终态必须为空（列语义：只在 queued/running/waiting 有值）。
    const [produced] =
      state === "completed"
        ? await tx
            .select({ id: threadItemTable.id })
            .from(threadItemTable)
            .where(
              and(
                eq(threadItemTable.threadId, threadId),
                eq(threadItemTable.invocationId, invocation.id),
                eq(threadItemTable.itemType, "assistant_message"),
              ),
            )
            .orderBy(desc(threadItemTable.itemSequence))
            .limit(1)
        : [];
    await tx
      .update(turnTable)
      .set({
        turnState:
          state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed",
        finishedAt: now,
        activeInvocationId: null,
        ...(produced ? { finalItemId: produced.id, adoptedInvocationId: invocation.id } : {}),
      })
      .where(eq(turnTable.id, turnId));
    await appendTurnStateEvent(tx, {
      threadId,
      turnId,
      invocationId: invocation.id,
      eventType:
        state === "completed"
          ? "turn.completed"
          : state === "cancelled"
            ? "turn.cancelled"
            : "turn.failed",
      itemId: produced?.id ?? null,
      errorCode,
    });
    // 同一终态的另一个投影面：Invocation 家族必须有终态事件，见 appendInvocationStateEvent。
    await appendInvocationStateEvent(tx, {
      threadId,
      turnId,
      invocationId: invocation.id,
      eventType:
        state === "completed"
          ? "invocation.completed"
          : state === "cancelled"
            ? "invocation.cancelled"
            : "invocation.failed",
      finishReason,
      itemId: produced?.id ?? null,
      errorCode,
    });
  }
  // R04 §3：同上——终态事务不释放 WorkspaceWriteLock，只把 Authority 置为终态；
  // 物理 Writer 由持久释放 lane 按 W→I 顺序撤销并留存真实 stop/drain 回执。
  await tx
    .update(executionOwnershipTable)
    .set({
      ownershipState: "released",
      releasedAt: now,
      reasonCode: "execution_terminal",
      versionNo: sql`${executionOwnershipTable.versionNo} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(executionOwnershipTable.tenantId, invocation.tenantId),
        eq(executionOwnershipTable.id, input.ownershipId),
        eq(executionOwnershipTable.invocationId, invocation.id),
      ),
    );
  // R02 §8：终态收口同样只经仓储方法（行锁 + 单向转换表）。
  await closeRuntimeSessionBindingInTransaction(tx, {
    tenantId: invocation.tenantId,
    id: input.sessionBindingId,
    ...(input.sessionVersionNo === undefined ? {} : { expectedVersionNo: input.sessionVersionNo }),
  });
  // A08 8.1：终态是本 Attempt 的**正式生命周期出口**，必须在这里登记真实清理工作。
  //
  // 只登记、不声明已释放：`releasing` 是非终态，真实容器是否消失由清理 Worker
  // 经 Backend 回执确认后才写 `released`。少了这一步，正常完成的执行会留下
  // 永不被回收的真实容器（审查报告 8.1）。
  //
  // 位置在 Session 收口之后、Invocation 终态之前：按 R04 §2 的固定锁图
  // `Invocation → Attempt → Ownership → Session → EnvironmentLease`，Lease 写在 Session 之后；
  // 且 `registerEnvironmentLeaseCleanupForAttemptInTransaction` 只改本 Attempt 的 Lease 行，
  // 不引入跨表行锁（Lease 行本身在锁图中位于 Session 之后）。
  await registerEnvironmentLeaseCleanupForAttemptInTransaction(tx, {
    tenantId: invocation.tenantId,
    invocationId: invocation.id,
    attemptId: input.attemptId,
    errorCode: errorCode ?? "InvocationTerminal",
    now,
  });
  await tx
    .update(invocationTable)
    .set({
      executionState: state,
      finishedAt: now,
      resultRef,
      resultDigest,
      errorCode,
      ...(input.errorSummary === undefined ? {} : { errorSummary: input.errorSummary }),
      // §3：终态也是"已应用事实"，但水位必须与终态**同一条** UPDATE 提交——
      // 下面紧跟 bridgeInvocationTerminalToJob，JobCommand.terminalVersion 必须
      // 等于最终提交版本，桥接之后再写 Invocation 会让它落后。
      recoveryVersion: invocation.recoveryVersion + 1,
      versionNo: invocation.versionNo + 1,
      updatedAt: now,
    })
    .where(eq(invocationTable.id, invocation.id));
  const [terminalRow] = await tx
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, invocation.id))
    .limit(1);
  if (!terminalRow) {
    throw new Error(`Invocation 终态回读失败：${invocation.id}`);
  }
  await bridgeInvocationTerminalToJob(tx, terminalRow, now);
  return terminalRow;
}
