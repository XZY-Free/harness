/**
 * V11 Interrupt 仓储（事务性，同事务写 Event + InvocationCommand，不立即变更 Turn 状态）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md 行 504（InvocationCommand 表）、（Turn 表）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md （Stop/Interrupt）
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
import type { ThreadEventActorType, TurnState } from "@/lib/persistence/schema/conversation";
import {
 invocationCommandTable,
 threadTable,
 turnTable,
} from "@/lib/persistence/schema/conversation";
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
 * 流程：
 * 1. SELECT FOR UPDATE Turn + Thread（校验租户 + owner）
 * 2. 校验 Turn 状态为 accepted/queued/running/waiting_user（终态 → TurnStateConflictError）
 * 3. 创建 InvocationCommand（command_type=interrupt, state=queued）
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
 // 1. SELECT FOR UPDATE Turn
 const [turn] = await tx
 .select()
 .from(turnTable)
 .where(eq(turnTable.id, params.turnId))
 .for("update")
 .limit(1);

 if (!turn) {
 throw new TurnNotFoundError(params.turnId);
 }

 // SELECT FOR UPDATE Thread（隐藏式 404：跨租户/非 owner → NotFound）
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

 // 2. 校验 Turn 状态为 accepted/queued/running/waiting_user（终态 → TurnStateConflictError）
 if (!INTERRUPTIBLE_STATES.includes(turn.turnState)) {
 throw new TurnStateConflictError(params.turnId, turn.turnState, "interrupt");
 }

 // 3. 创建 InvocationCommand（command_type=interrupt, state=queued）
 // invocation_id 为空（Runtime 拉取后才绑定；本阶段 Runtime 未接入）
 const commandPayload: Record<string, unknown> = {
 reason_code: params.reasonCode,
 preserve_pending_inputs: preservePendingInputs,
 };
 const commandPayloadHash = computeInvocationCommandPayloadHash(commandPayload);

 await tx.insert(invocationCommandTable).values({
 id: commandId,
 invocationId: null, // queued 状态 invocation_id 可空
 threadId: thread.id,
 turnId: turn.id,
 commandType: "interrupt",
 commandPayloadJson: commandPayload,
 commandPayloadHash,
 commandState: "queued",
 runtimeExecutionRef: null,
 idempotencyKey: params.idempotencyKey,
 errorCode: null,
 errorMessage: null,
 createdAt: now,
 dispatchedAt: null,
 acknowledgedAt: null,
 failedAt: null,
 updatedAt: now,
 });

 // 4. 写 turn.interrupt_requested Event（不立即改变 Turn 状态）
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
 };
}

// 导出事务句柄类型供外部组合事务使用
export type { Tx };
