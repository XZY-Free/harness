/**
 * Interrupt 仓储（事务性，同事务写 Event + InvocationCommand，不立即变更 Turn 状态）。
 *
 * 事实源：
 * - docs/architecture/persistence.md 行 504（InvocationCommand 表）、（Turn 表）
 * - docs/architecture/agent-control-plane.md （Stop/Interrupt）
 *
 * 职责：
 * - requestInterrupt：事务内入队 Interrupt 命令 + 写 turn.interrupt_requested Event。
 *
 * 关键约束（行 388-396）：
 * - Interrupt 不立即改变 Turn 状态：Runtime ack 后才进入终态（interrupted/failed）。
 * - 本阶段 Runtime 未接入：命令停留在 queued，不模拟 Runtime ack，Turn 状态保持原样。
 * - Stop 不撤销已发生的副作用（tool 副作用已生效，行 393）。
 * - 已完成副作用保留：alreadyCompletedEffectsPreserved=true。
 * - 终态 Turn 不允许 Interrupt（completed/interrupted/failed/cancelled → TurnStateConflictError）。
 * - accepted/queued 状态 Turn 也允许 Interrupt（命令入队，Runtime ack 后立即终态）。
 *
 * 与 Steer 的差异（行 366）：
 * - waiting_user Turn 必须用 UserActionRequest 解析，不能用 Steer 绕过；
 * 但 waiting_user Turn 允许 Interrupt（强制中断，不解析 UserActionRequest）。
 */
import { randomUUID } from "node:crypto";
import { TurnNotFoundError, TurnStateConflictError } from "@/lib/conversations/errors";
import { computeInvocationCommandPayloadHash } from "@/lib/conversations/regenerate-queries";
import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
import { lockExecutionRootForProductWrite } from "@/lib/executions/persistence/execution-ownership-store";
import type { ThreadEventActorType, TurnState } from "@/lib/persistence/schema/conversation";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import { invocationCommandTable } from "@/lib/persistence/schema/executions";
import { eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Interrupt 的 reason_code（与契约 对齐，本阶段仅记录，不强制枚举）。 */
export type InterruptReasonCode = string;

/** requestInterrupt 返回结果。 */
export interface RequestInterruptResult {
  /** Turn id。 */
  turnId: string;
  /** Turn 当前状态（未变，Interrupt 命令不立即改变 Turn 状态）。 */
  turnState: TurnState;
  /** Interrupt 命令状态（固定 "requested" 表示命令已入队，等 Runtime ack）。 */
  interruptState: "requested";
  /** InvocationCommand 记录（state=queued）。 */
  command: {
    id: string;
    commandState: "queued";
  };
  /** 已完成副作用是否保留（固定 true，行 393：Stop 不撤销已发生副作用）。 */
  alreadyCompletedEffectsPreserved: true;
  /** turn.interrupt_requested 事件 id。 */
  eventId: string;
  /**
   * 本命令**实际指向**的 Invocation（锁内读到的 `Turn.activeInvocationId`）。
   *
   * 调用方不得用请求前置阶段读到的 Turn 快照去关联子对象：那个快照可能已被接管改写。
   */
  targetInvocationId: string;
  /**
   * 代际边界：入队本命令时（执行根加锁之后）的服务器时间。
   *
   * 调用方据此取消子 AgentCall 时只能覆盖**这一刻之前**创建的子调用——同一个
   * `parentInvocationId` 会被后续代际继续使用，按父 id 全量取消会误伤新代际的子调用。
   */
  targetCutoffAt: Date;
}

/** 允许 Interrupt 的 Turn 状态集合（终态 → TurnStateConflictError）。 */
const INTERRUPTIBLE_STATES: readonly TurnState[] = [
  "accepted",
  "queued",
  "running",
  "waiting_user",
];

/**
 * 事务内入队 Interrupt 命令。
 *
 * 流程（**按 R04 §2 固定锁图排序**：执行根在前、产品根在后）：
 * 1. 不加锁定位 Turn + Thread（校验租户 + owner；终态 → TurnStateConflictError）
 * 2. 锁 Invocation 根 → 创建 InvocationCommand（command_type=interrupt, state=queued，锁 Ownership）
 * 3. 锁 Turn → Thread 并复验（定位读与加锁读之间可能被改写）
 * 4. 写 turn.interrupt_requested Event（不立即改变 Turn 状态，Runtime ack 后才进入终态）
 *
 * 隐藏式 404：Turn 跨租户/不存在/非 owner → TurnNotFoundError。
 * Turn 已终态 → TurnStateConflictError（409 TURN_ALREADY_TERMINAL）。
 */
export async function requestInterrupt(params: {
  tenantId: string;
  ownerUserId: string;
  turnId: string;
  reasonCode: InterruptReasonCode;
  preservePendingInputs?: boolean;
  idempotencyKey: string;
  correlationId?: string;
}): Promise<RequestInterruptResult> {
  const commandId = randomUUID();
  const now = new Date();
  const preservePendingInputs = params.preservePendingInputs ?? true;

  const meta = await db.transaction(async (tx) => {
    // R04 §2「固定锁图」：`Invocation → Attempt → Ownership → Session → EnvironmentLease →
    // 必需子执行事实 → Thread/Turn/Item 映射`。**产品根（Thread/Turn）在最后**。
    //
    // 这里先做一次**不加锁**的定位读取得执行根，再按统一顺序加锁：
    // 旧实现是「锁 Turn → 锁 Thread → 建命令（锁 Ownership）」，而 `ingressRuntimeEvents`
    // 的终态分支是「锁 I/O → 写 Turn/Thread」，两条真实路径互等即构成死锁环
    // （Interrupt 持 Turn 等 O；Ingress 持 O 等 Turn）。锁序不能只靠注释声明。
    const [located] = await tx
      .select({
        id: turnTable.id,
        threadId: turnTable.threadId,
        turnState: turnTable.turnState,
        activeInvocationId: turnTable.activeInvocationId,
      })
      .from(turnTable)
      .where(eq(turnTable.id, params.turnId))
      .limit(1);
    if (!located) {
      throw new TurnNotFoundError(params.turnId);
    }
    if (!INTERRUPTIBLE_STATES.includes(located.turnState)) {
      throw new TurnStateConflictError(params.turnId, located.turnState, "interrupt");
    }
    if (!located.activeInvocationId) {
      throw new TurnStateConflictError(params.turnId, located.turnState, "interrupt");
    }
    // 定位阶段做一次不加锁的归属检查：跨租户/非 owner 直接 NotFound，不产生任何副作用。
    const [locatedThread] = await tx
      .select({
        id: threadTable.id,
        tenantId: threadTable.tenantId,
        ownerUserId: threadTable.ownerUserId,
      })
      .from(threadTable)
      .where(eq(threadTable.id, located.threadId))
      .limit(1);
    if (
      !locatedThread ||
      locatedThread.tenantId !== params.tenantId ||
      locatedThread.ownerUserId !== params.ownerUserId
    ) {
      throw new TurnNotFoundError(params.turnId);
    }

    // 1) 执行根：先锁 Invocation → 活跃 Ownership（`createInvocationCommand` 随后对同一行
    //    取锁不会等待）。通过 I 根锁，本事务与 Acquire/Renew/Close/守卫互相串行，
    //    Ownership 快照在锁内稳定，也不会再与 Runtime 路径形成反向持锁。
    await lockExecutionRootForProductWrite(tx, params.tenantId, located.activeInvocationId);
    // 代际边界在执行根加锁之后采样：此刻之后创建的子 AgentCall 属于后续代际，
    // 不属于本命令的取消范围（见 `RequestInterruptResult.targetCutoffAt`）。
    const targetCutoffAt = new Date();

    // 2) InvocationCommand（command_type=cancel, state=queued）。
    // 活动 Turn 必须绑定同一个 Invocation，Hosted local transport 才能执行真实取消。
    const commandPayload: Record<string, unknown> = {
      reason_code: params.reasonCode,
      preserve_pending_inputs: preservePendingInputs,
    };
    const commandPayloadHash = computeInvocationCommandPayloadHash(commandPayload);

    await createInvocationCommandInTransaction(tx, {
      tenantId: params.tenantId,
      invocationId: located.activeInvocationId,
      commandType: "cancel",
      idempotencyKey: params.idempotencyKey,
      payloadJson: commandPayload,
      requestedByType: "user",
      requestedById: params.ownerUserId,
      commandId,
    });

    // 3) 产品根：Turn → Thread。定位读与加锁读之间可能被改写，必须逐项复验后再写事件。
    const [turn] = await tx
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, params.turnId))
      .for("update")
      .limit(1);
    if (
      !turn ||
      turn.threadId !== located.threadId ||
      turn.activeInvocationId !== located.activeInvocationId ||
      !INTERRUPTIBLE_STATES.includes(turn.turnState)
    ) {
      throw new TurnStateConflictError(
        params.turnId,
        turn?.turnState ?? located.turnState,
        "interrupt",
      );
    }

    const [thread] = await tx
      .select()
      .from(threadTable)
      .where(eq(threadTable.id, turn.threadId))
      .for("update")
      .limit(1);

    if (
      !thread ||
      thread.tenantId !== params.tenantId ||
      thread.ownerUserId !== params.ownerUserId
    ) {
      throw new TurnNotFoundError(params.turnId);
    }

    // 4) 写 turn.interrupt_requested Event（不立即改变 Turn 状态）
    // Runtime ack 后才会写 turn.interrupted/failed 终态事件
    const eventSeq = await allocateEventSequences(tx, thread.id, 1);
    const event = await insertThreadEvent(tx, thread.id, eventSeq, {
      eventType: "turn.interrupt_requested",
      turnId: turn.id,
      invocationId: turn.activeInvocationId ?? undefined, // 关联当前活动 invocation（可能为空）
      actorType: "user" as ThreadEventActorType,
      actorId: params.ownerUserId,
      payload: {
        reason_code: params.reasonCode,
        preserve_pending_inputs: preservePendingInputs,
        command_id: commandId,
      },
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId,
    });

    return {
      turnState: turn.turnState,
      eventId: event.id,
      targetInvocationId: located.activeInvocationId,
      targetCutoffAt,
    };
  });

  return {
    turnId: params.turnId,
    turnState: meta.turnState,
    interruptState: "requested",
    command: {
      id: commandId,
      commandState: "queued",
    },
    alreadyCompletedEffectsPreserved: true,
    eventId: meta.eventId,
    targetInvocationId: meta.targetInvocationId,
    targetCutoffAt: meta.targetCutoffAt,
  };
}

// 导出事务句柄类型供外部组合事务使用
export type { Tx };
