/**
 * Steer 仓储（事务性，同事务写 user_guidance Item + InvocationCommand + Event）。
 *
 * 事实源：
 * - docs/architecture/persistence.md 行 504（InvocationCommand 表）、（ThreadItem 表）
 * - docs/architecture/agent-control-plane.md （Steer）
 *
 * 职责：
 * - queueSteer：事务内创建 user_guidance Item + 入队 Steer 命令 + 写 turn.steer_queued Event。
 *
 * 关键约束（行 360-376）：
 * - Steer 只能作用于 running Turn（waiting_user → TurnRequiresUserActionError，必须解析 UserActionRequest）。
 * - Steer 不创建第二个 Turn（行 366），将 user_guidance Item 加入当前 Turn。
 * - user_guidance Item 初始 item_state=pending，pending 状态不进入模型上下文（行 362）。
 * - Runtime ack 后 Item 状态变为 completed（进入上下文），由后续阶段接入。
 * - 本阶段 Runtime 未接入：InvocationCommand 停留在 queued，Item 保持 pending。
 * - 终态 Turn 不允许 Steer（completed/interrupted/failed/cancelled → TurnStateConflictError）。
 * - accepted/queued 状态 Turn 也不允许 Steer（必须 running 才能加引导）。
 *
 * 与 Interrupt 的差异（）：
 * - Interrupt 可作用于 accepted/queued/running/waiting_user；Steer 只能作用于 running。
 * - Interrupt 不创建 Item；Steer 创建 user_guidance Item。
 * - waiting_user Turn 允许 Interrupt（强制中断），但禁止 Steer（必须解析 UserActionRequest）。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  TurnNotFoundError,
  TurnRequiresUserActionError,
  TurnStateConflictError,
} from "@/lib/conversations/errors";
import { computeInvocationCommandPayloadHash } from "@/lib/conversations/regenerate-queries";
import {
  allocateEventSequences,
  allocateItemSequence,
  insertThreadEvent,
} from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import type {
  ThreadEventActorType,
  ThreadItemAuthorType,
  TurnState,
} from "@/lib/persistence/schema/conversation";
import {
  invocationCommandTable,
  threadItemTable,
  threadTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import { eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** user_guidance Item 内容。 */
export interface GuidanceContent {
  /** 文本内容（非空）。 */
  text: string;
  /** 可选附件引用（结构与 user_message attachments 一致）。 */
  attachments?: Array<{
    workspace_attachment_id: string;
    resource_type: string;
    resource_ref: string;
  }>;
}

/** queueSteer 返回结果。 */
export interface QueueSteerResult {
  /** Turn id。 */
  turnId: string;
  /** Turn 当前状态（未变，Steer 命令不立即改变 Turn 状态）。 */
  turnState: TurnState;
  /** Steer 命令状态（固定 "queued" 表示命令已入队，等 Runtime ack）。 */
  steerState: "queued";
  /** 新建的 user_guidance Item id（item_state=pending，pending 状态不进入模型上下文）。 */
  guidanceItemId: string;
  /** InvocationCommand 记录（state=queued）。 */
  command: {
    id: string;
    commandState: "queued";
  };
  /** turn.steer_queued 事件 id。 */
  eventId: string;
}

/** 计算 user_guidance 内容 hash（sha256，递归排序 key 保证稳定）。 */
function computeGuidanceHash(content: GuidanceContent): string {
  const sorted = JSON.stringify(sortKeys(content));
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

/**
 * 事务内入队 Steer 命令（员工引导）。
 *
 * 流程：
 * 1. SELECT FOR UPDATE Turn + Thread（校验租户 + owner）
 * 2. 校验 Turn 状态：
 * - waiting_user → TurnRequiresUserActionError（必须解析 UserActionRequest，不能用 Steer 绕过）
 * - 非 running（accepted/queued/regenerating/终态）→ TurnStateConflictError
 * 3. 创建 user_guidance ThreadItem（item_state=pending，pending 状态不进入模型上下文）
 * 4. 创建 InvocationCommand（command_type=steer, command_payload_json={guidance_item_id}, state=queued）
 * 5. 写 turn.steer_queued Event（payload: guidance_item_id, command_id）
 *
 * 隐藏式 404：Turn 跨租户/不存在/非 owner → TurnNotFoundError。
 * waiting_user Turn → TurnRequiresUserActionError（409 TURN_REQUIRES_USER_ACTION）。
 * 非 running Turn → TurnStateConflictError（409 TURN_ALREADY_TERMINAL）。
 */
export async function queueSteer(params: {
  tenantId: string;
  ownerUserId: string;
  turnId: string;
  guidanceText: string;
  authorType?: ThreadItemAuthorType;
  idempotencyKey: string;
  correlationId?: string;
}): Promise<QueueSteerResult> {
  const commandId = randomUUID();
  const guidanceItemId = randomUUID();
  const now = new Date();
  const authorType: ThreadItemAuthorType = params.authorType ?? "user";

  const content: GuidanceContent = { text: params.guidanceText };
  const contentHash = computeGuidanceHash(content);

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

    // 2. 校验 Turn 状态
    // waiting_user → TurnRequiresUserActionError（不能用 Steer 绕过 UserActionRequest）
    if (turn.turnState === "waiting_user") {
      throw new TurnRequiresUserActionError(params.turnId, turn.turnState);
    }
    // 非 running（accepted/queued/regenerating/终态）→ TurnStateConflictError
    if (turn.turnState !== "running") {
      throw new TurnStateConflictError(params.turnId, turn.turnState, "steer");
    }

    // 3. 创建 user_guidance ThreadItem（item_state=pending，pending 状态不进入模型上下文）
    // 分配 itemSequence（锁定 Thread 行原子递增）
    const itemSequence = await allocateItemSequence(tx, thread.id);

    await tx.insert(threadItemTable).values({
      id: guidanceItemId,
      threadId: thread.id,
      turnId: turn.id,
      itemSequence,
      itemType: "user_guidance",
      itemState: "pending", // pending 状态不进入模型上下文，Runtime ack 后变 completed
      authorType,
      authorId: params.ownerUserId,
      contentJson: content as unknown as Record<string, unknown>,
      contentHash,
      contextPolicy: "include", // ack 后进入上下文；pending 期间由调用方/投影层过滤
      invocationId: turn.activeInvocationId,
      createdAt: now,
      updatedAt: now,
    });

    // 4. 创建 InvocationCommand（command_type=steer, state=queued）
    // invocation_id 关联当前活动 invocation（running Turn 必有 activeInvocationId）
    const commandPayload: Record<string, unknown> = {
      guidance_item_id: guidanceItemId,
      turn_id: turn.id,
    };
    const commandPayloadHash = computeInvocationCommandPayloadHash(commandPayload);

    await tx.insert(invocationCommandTable).values({
      id: commandId,
      invocationId: turn.activeInvocationId, // running Turn 必有活动 invocation
      threadId: thread.id,
      turnId: turn.id,
      commandType: "steer",
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

    // 5. 写 turn.steer_queued Event
    const eventSeq = await allocateEventSequences(tx, thread.id, 1);
    const event = await insertThreadEvent(tx, thread.id, eventSeq, {
      eventType: "turn.steer_queued",
      turnId: turn.id,
      itemId: guidanceItemId, // 关联 user_guidance Item
      invocationId: turn.activeInvocationId ?? undefined,
      actorType: "user" as ThreadEventActorType,
      actorId: params.ownerUserId,
      payload: {
        guidance_item_id: guidanceItemId,
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
    steerState: "queued",
    guidanceItemId,
    command: {
      id: commandId,
      commandState: "queued",
    },
    eventId: meta.eventId,
  };
}

// 导出事务句柄类型供外部组合事务使用
export type { Tx };
