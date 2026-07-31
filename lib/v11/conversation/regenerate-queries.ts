/**
 * V11 Regenerate 仓储（事务性，同事务写 Event + InvocationCommand + Turn 状态）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.10 行 504（InvocationCommand 表）、§5.3（Turn 表）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §3.9（Regenerate）
 *
 * 职责：
 * - startRegeneration：事务内启动 Regenerate，生成新 invocationId + 写 InvocationCommand + 更新 Turn 状态 + 写事件。
 *
 * 关键约束（§3.9 行 430-431）：
 * - Regenerate 不复制 user_message Item（一条正式用户消息在默认会话视图中只有一份）。
 * - 旧回答在新回答成功前仍是当前结果（不能先清空再生成）。
 * - cancelled 不可恢复 → TurnStateConflictError。
 * - completed/interrupted/failed → regenerating 状态机允许。
 * - turn.regeneration_started 的 required_refs 含 invocation_id（必须先创建新 invocationId 才能写事件）。
 * - 本阶段 Runtime 未接入：InvocationCommand 停留在 queued，不创建 Invocation 行，仅返回 invocationId 供后续阶段接入。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { TurnNotFoundError, TurnStateConflictError } from "@/lib/v11/conversation/errors";
import { allocateEventSequences, insertThreadEvent } from "@/lib/v11/conversation/thread-queries";
import type { ThreadEventActorType, TurnState } from "@/lib/v11/schema/conversation";
import {
  v11InvocationCommand,
  v11Thread,
  v11ThreadEvent,
  v11Turn,
} from "@/lib/v11/schema/conversation";
import { and, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Regenerate 的 binding_mode 选项（§3.9 行 425）。 */
export type RegenerateBindingMode = "loose" | "strict";

/** startRegeneration 返回结果。 */
export interface StartRegenerationResult {
  /** Turn id。 */
  turnId: string;
  /** 新的 Turn 状态（固定 "regenerating"）。 */
  turnState: "regenerating";
  /** 新生成的 invocationId（本阶段不创建 Invocation 行，仅返回供后续阶段接入）。 */
  invocationId: string;
  /** Invocation 类型（固定 "regenerate"）。 */
  invocationKind: "regenerate";
  /** 被替代的旧 invocationId（即原 turn.latestInvocationId）。 */
  replacesInvocationId: string | null;
  /** 触发本次 Turn 的 user_message Item id（即 turn.triggerItemId）。 */
  originalUserItemId: string | null;
  /** Regenerate 时的当前 final_item id（即 turn.finalItemId；旧回答在新回答成功前仍是当前结果）。 */
  currentFinalItemId: string | null;
  /** turn.regeneration_started 事件 id。 */
  eventId: string;
}

/** 计算 InvocationCommand payload hash（sha256，递归排序 key 保证稳定）。 */
export function computeInvocationCommandPayloadHash(payload: Record<string, unknown>): string {
  const sorted = JSON.stringify(sortKeys(payload));
  return `sha256:${createHash("sha256").update(sorted, "utf8").digest("hex")}`;
}

/** 递归排序对象 key，保证 hash 稳定。 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/** 允许启动 Regenerate 的 Turn 状态集合（§3.9 行 430：cancelled 不可恢复）。 */
const REGENERATABLE_STATES: readonly TurnState[] = ["completed", "interrupted", "failed"];

/**
 * 事务内启动 Regenerate。
 *
 * 流程：
 * 1. SELECT FOR UPDATE Turn + Thread（校验租户 + owner）
 * 2. 校验 Turn 状态为 completed/interrupted/failed（cancelled 不可恢复 → TurnStateConflictError）
 * 3. 生成新 invocationId（randomUUID，本阶段不创建 Invocation 行）
 * 4. 创建 InvocationCommand（command_type=regenerate, state=queued）
 * 5. 更新 Turn：turn_state=regenerating, regeneration_no+=1, latest_invocation_id=newInvocationId, active_invocation_id=null
 *    - 保存 regeneration_base_state = 当前 turn_state
 *    - 清空 finished_at（regenerating 期间无终态时间）
 * 6. 分配并写 turn.regeneration_started Event
 *
 * 隐藏式 404：Turn 跨租户/不存在/非 owner → TurnNotFoundError。
 * Turn 状态不允许 Regenerate → TurnStateConflictError（409 TURN_ALREADY_TERMINAL）。
 */
export async function startRegeneration(params: {
  tenantId: string;
  ownerUserId: string;
  turnId: string;
  bindingMode: RegenerateBindingMode;
  reason?: string | null;
  idempotencyKey: string;
  correlationId?: string;
}): Promise<StartRegenerationResult> {
  const newInvocationId = randomUUID();
  const commandId = randomUUID();
  const now = new Date();

  const meta = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE Turn
    const [turn] = await tx
      .select()
      .from(v11Turn)
      .where(eq(v11Turn.id, params.turnId))
      .for("update")
      .limit(1);

    if (!turn) {
      throw new TurnNotFoundError(params.turnId);
    }

    // SELECT FOR UPDATE Thread（隐藏式 404：跨租户/非 owner → NotFound）
    const [thread] = await tx
      .select()
      .from(v11Thread)
      .where(eq(v11Thread.id, turn.threadId))
      .for("update")
      .limit(1);

    if (
      !thread ||
      thread.tenantId !== params.tenantId ||
      thread.ownerUserId !== params.ownerUserId
    ) {
      throw new TurnNotFoundError(params.turnId);
    }

    // 2. 校验 Turn 状态为 completed/interrupted/failed（cancelled 不可恢复）
    if (!REGENERATABLE_STATES.includes(turn.turnState)) {
      throw new TurnStateConflictError(params.turnId, turn.turnState, "regenerate");
    }

    const regenerationBaseState = turn.turnState as "completed" | "interrupted" | "failed";
    const replacesInvocationId = turn.latestInvocationId;
    const newRegenerationNo = turn.regenerationNo + 1;

    // 3. 创建 InvocationCommand（command_type=regenerate, state=queued）
    const commandPayload: Record<string, unknown> = {
      binding_mode: params.bindingMode,
      reason: params.reason ?? null,
      new_invocation_id: newInvocationId,
      replaces_invocation_id: replacesInvocationId,
    };
    const commandPayloadHash = computeInvocationCommandPayloadHash(commandPayload);

    await tx.insert(v11InvocationCommand).values({
      id: commandId,
      invocationId: newInvocationId, // regenerate 命令目标即新 invocationId
      threadId: thread.id,
      turnId: turn.id,
      commandType: "regenerate",
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

    // 4. 更新 Turn：turn_state=regenerating, regeneration_no+=1, latest_invocation_id=newInvocationId, active_invocation_id=null
    //    - 保存 regeneration_base_state = 当前 turn_state
    //    - 清空 finished_at（regenerating 期间无终态时间）
    await tx
      .update(v11Turn)
      .set({
        turnState: "regenerating",
        regenerationNo: newRegenerationNo,
        regenerationBaseState,
        latestInvocationId: newInvocationId,
        activeInvocationId: null, // Runtime 未接入
        finishedAt: null, // regenerating 期间无终态时间
        versionNo: turn.versionNo + 1,
      })
      .where(eq(v11Turn.id, turn.id));

    // 5. 分配并写 turn.regeneration_started Event
    const eventSeq = await allocateEventSequences(tx, thread.id, 1);
    await insertThreadEvent(tx, thread.id, eventSeq, {
      eventType: "turn.regeneration_started",
      turnId: turn.id,
      invocationId: newInvocationId, // required_refs 含 invocation_id
      actorType: "user" as ThreadEventActorType,
      actorId: params.ownerUserId,
      payload: {
        regeneration_no: newRegenerationNo,
        replaces_invocation_id: replacesInvocationId,
        new_invocation_id: newInvocationId,
        binding_mode: params.bindingMode,
        reason: params.reason ?? null,
        original_user_item_id: turn.triggerItemId,
        current_final_item_id: turn.finalItemId,
        regeneration_base_state: regenerationBaseState,
      },
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId,
    });

    return {
      thread,
      turn,
      replacesInvocationId,
      originalUserItemId: turn.triggerItemId,
      currentFinalItemId: turn.finalItemId,
      commandId,
    };
  });

  // 回读事件确认（事件 id 在 insertThreadEvent 内部生成，按 invocationId + eventType 查询）
  const [eventRow] = await db
    .select()
    .from(v11ThreadEvent)
    .where(
      and(
        eq(v11ThreadEvent.invocationId, newInvocationId),
        eq(v11ThreadEvent.eventType, "turn.regeneration_started"),
      ),
    )
    .limit(1);
  if (!eventRow) {
    throw new Error(
      `startRegeneration: turn.regeneration_started Event 行未找到（invocationId=${newInvocationId}）`,
    );
  }

  return {
    turnId: params.turnId,
    turnState: "regenerating",
    invocationId: newInvocationId,
    invocationKind: "regenerate",
    replacesInvocationId: meta.replacesInvocationId,
    originalUserItemId: meta.originalUserItemId,
    currentFinalItemId: meta.currentFinalItemId,
    eventId: eventRow.id,
  };
}

// 导出事务句柄类型供外部组合事务使用
export type { Tx };
