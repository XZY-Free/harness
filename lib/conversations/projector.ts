import { EventSequenceGapError, ProjectionFailureError } from "@/lib/conversations/errors";
import {
  advanceProjectionCheckpoint,
  getProjectionCheckpoint,
  getProjectionCheckpointTx,
  recordDeliveryFailure,
  updateEventStreamFloorLatest,
} from "@/lib/conversations/projection-checkpoint-queries";
import { listThreadEvents } from "@/lib/conversations/thread-queries";
/**
 * V11 会话事件投影器。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §8.1（projection_checkpoint/event_delivery_failure/event_stream_floor）、§9.2（Outbox + checkpoint 协议）、§11（查询读模型）
 * - ../v11-agentkit-platform/14-production-operations-security-and-retention.md §2.1（投影消费协议七条规则）
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §7.4（顺序与去重：Item 投影器按 Event sequence 幂等更新，checkpoint 只在事务提交后前移）
 *
 * 职责：
 * - projectThreadEvent：消费单个 ThreadEvent，按 event sequence 幂等更新 thread_list_projection 和 turn_timeline_projection。
 * - projectThreadEvents：批量投影（按 sequence 升序处理）。
 * - rebuildProjectionsForThread：从权威表重建指定 Thread 的所有读模型。
 *
 * 关键约束（§2.1 投影消费协议）：
 * 1. 按流内 sequence 读取，不按 occurred_at 排序（规则 1）。
 * 2. 投影写入必须幂等，幂等键至少包含 consumer、event_id 和 projection target（规则 2）。
 * 3. 投影写入成功后才前移 checkpoint；同数据库使用同一事务（规则 3）。
 * 4. sequence 出现空洞时停止该流并等待，不猜测丢失事件（规则 4）。
 * 5. Schema 不支持、payload hash 冲突或投影约束失败写 event_delivery_failure（规则 5）。
 * 6. 修复后从原 event sequence 重放（规则 7）。
 *
 * 两个独立消费者：
 * - thread_list_projection（shardKey = threadId）
 * - turn_timeline_projection（shardKey = threadId）
 */
import { db } from "@/lib/db/client";
import type { ThreadEvent } from "@/lib/persistence/schema/conversation";
import {
  type StreamType,
  threadListProjectionTable,
  turnTimelineProjectionTable,
} from "@/lib/persistence/schema/projection";
import { and, asc, eq } from "drizzle-orm";

/** Thread 列表投影的 consumer 名称。 */
const THREAD_LIST_CONSUMER = "thread_list_projection";
/** Turn 时间线投影的 consumer 名称。 */
const TURN_TIMELINE_CONSUMER = "turn_timeline_projection";
/** thread_event 流类型。 */
const THREAD_EVENT_STREAM: StreamType = "thread_event";

/** 投影结果。 */
type ProjectResult = {
  /** 是否实际执行了投影（false = 幂等跳过）。 */
  applied: boolean;
  /** 是否遇到失败（已写入 event_delivery_failure）。 */
  failed: boolean;
};

/**
 * 投影单个 ThreadEvent 到指定消费者。
 *
 * 流程（§2.1 规则 1-5）：
 * 1. db.transaction:
 *    - 获取 checkpoint（FOR UPDATE 语义由事务隔离保证）
 *    - 幂等检查：checkpoint.lastSequence >= event.eventSequence → 跳过（规则 2）
 *    - 空洞检查：checkpoint.lastSequence + 1 !== event.eventSequence → 抛 EventSequenceGapError（规则 4）
 *    - 按 eventType 分派，upsert 对应投影表
 *    - 前移 checkpoint（规则 3）
 * 2. 失败时：recordDeliveryFailure，不前移 checkpoint（规则 5）
 */
async function projectToConsumer(
  consumerName: string,
  event: ThreadEvent,
  projectFn: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    event: ThreadEvent,
  ) => Promise<void>,
): Promise<ProjectResult> {
  const shardKey = event.threadId;

  // 先检查是否已处理（幂等快速路径，不开事务）
  const existingCheckpoint = await getProjectionCheckpoint(
    consumerName,
    THREAD_EVENT_STREAM,
    shardKey,
  );
  if (existingCheckpoint && existingCheckpoint.lastSequence >= event.eventSequence) {
    return { applied: false, failed: false };
  }

  // 空洞检查（规则 4）放在 try 块内，确保失败被记录到 event_delivery_failure
  try {
    // 快速路径的空洞检查（避免不必要的事务开销）
    if (existingCheckpoint && existingCheckpoint.lastSequence + 1 !== event.eventSequence) {
      throw new EventSequenceGapError(
        shardKey,
        existingCheckpoint.lastSequence + 1,
        event.eventSequence,
      );
    }

    await db.transaction(async (tx) => {
      // 事务内再次检查（防止并发）
      const txCheckpoint = await getProjectionCheckpointTx(
        tx,
        consumerName,
        THREAD_EVENT_STREAM,
        shardKey,
      );
      if (txCheckpoint && txCheckpoint.lastSequence >= event.eventSequence) {
        // 已被并发处理，跳过
        return;
      }
      if (txCheckpoint && txCheckpoint.lastSequence + 1 !== event.eventSequence) {
        throw new EventSequenceGapError(
          shardKey,
          txCheckpoint.lastSequence + 1,
          event.eventSequence,
        );
      }

      // 执行投影
      await projectFn(tx, event);

      // 前移 checkpoint（规则 3：投影写入成功后才前移）
      await advanceProjectionCheckpoint(
        tx,
        consumerName,
        THREAD_EVENT_STREAM,
        shardKey,
        event.eventSequence,
        event.id,
      );
    });
    return { applied: true, failed: false };
  } catch (error) {
    // 投影失败：记录到 event_delivery_failure，不前移 checkpoint（规则 5）
    const failureClass = classifyFailure(error);
    await recordDeliveryFailure({
      consumerName,
      streamType: THREAD_EVENT_STREAM,
      streamId: shardKey,
      eventId: event.id,
      eventSequence: event.eventSequence,
      failureClass,
      lastErrorCode: error instanceof Error ? error.name : "UNKNOWN",
      lastErrorDetail: error instanceof Error ? { message: error.message } : { raw: String(error) },
    });
    return { applied: false, failed: true };
  }
}

/** 分类失败原因。 */
function classifyFailure(error: unknown): string {
  if (error instanceof EventSequenceGapError) return "sequence_gap";
  if (error instanceof ProjectionFailureError) return error.failureClass;
  if (error instanceof Error) {
    if (error.message.includes("schema_unsupported")) return "schema_unsupported";
    if (error.message.includes("payload_hash_conflict")) return "payload_hash_conflict";
    if (error.message.includes("projection_constraint")) return "projection_constraint";
  }
  return "unknown";
}

// ─── thread_list_projection 投影逻辑 ──────────────────────

/** 将事件投影到 thread_list_projection。 */
async function projectToThreadList(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: ThreadEvent,
): Promise<void> {
  const payload = event.payloadJson as Record<string, unknown>;
  const shardKey = event.threadId;

  switch (event.eventType) {
    case "thread.created": {
      // 创建 thread_list_projection 行
      const tenantId = payload.tenant_id as string | undefined;
      const ownerUserId = payload.owner_user_id as string | undefined;
      const primaryAgentId = payload.primary_agent_id as string | undefined;
      const title = (payload.title as string | null | undefined) ?? null;

      if (!tenantId || !ownerUserId || !primaryAgentId) {
        throw new ProjectionFailureError(
          THREAD_LIST_CONSUMER,
          event.id,
          "schema_unsupported",
          new Error("thread.created payload 缺少 tenant_id/owner_user_id/primary_agent_id"),
        );
      }

      await tx
        .insert(threadListProjectionTable)
        .values({
          threadId: shardKey,
          tenantId,
          ownerUserId,
          primaryAgentId,
          title,
          lifecycleState: "active",
          lastActivityAt: event.occurredAt,
          latestEventSequence: event.eventSequence,
          latestEventId: event.id,
          hasUnreadEvents: 0,
        })
        .onDuplicateKeyUpdate({
          set: {
            primaryAgentId,
            title,
            lastActivityAt: event.occurredAt,
            latestEventSequence: event.eventSequence,
            latestEventId: event.id,
            updatedAt: new Date(),
          },
        });
      break;
    }

    case "thread.archived":
    case "thread.deleted": {
      const lifecycleState = event.eventType === "thread.archived" ? "archived" : "deleted";
      await tx
        .update(threadListProjectionTable)
        .set({
          lifecycleState,
          latestEventSequence: event.eventSequence,
          latestEventId: event.id,
          updatedAt: new Date(),
        })
        .where(eq(threadListProjectionTable.threadId, shardKey));
      break;
    }

    case "thread.primary_agent_changed": {
      const primaryAgentId = payload.primary_agent_id as string | undefined;
      if (!primaryAgentId) {
        throw new ProjectionFailureError(
          THREAD_LIST_CONSUMER,
          event.id,
          "schema_unsupported",
          new Error("thread.primary_agent_changed payload 缺少 primary_agent_id"),
        );
      }
      await tx
        .update(threadListProjectionTable)
        .set({
          primaryAgentId,
          latestEventSequence: event.eventSequence,
          latestEventId: event.id,
          updatedAt: new Date(),
        })
        .where(eq(threadListProjectionTable.threadId, shardKey));
      break;
    }

    case "thread.model_changed":
    case "thread.environment_changed": {
      // 设置变化：投影表无对应字段，只前移 cursor（latestEventSequence/Id）
      // 事实源：event-catalog.json（thread.model_changed / thread.environment_changed）
      await tx
        .update(threadListProjectionTable)
        .set({
          latestEventSequence: event.eventSequence,
          latestEventId: event.id,
          updatedAt: new Date(),
        })
        .where(eq(threadListProjectionTable.threadId, shardKey));
      break;
    }

    case "turn.accepted": {
      // 更新 currentTurn*
      const turnId = event.turnId;
      const turnSequence = payload.turn_sequence as number | undefined;
      if (turnId && turnSequence !== undefined) {
        await tx
          .update(threadListProjectionTable)
          .set({
            currentTurnId: turnId,
            currentTurnSequence: turnSequence,
            currentTurnState: "accepted",
            lastActivityAt: event.occurredAt,
            latestEventSequence: event.eventSequence,
            latestEventId: event.id,
            hasUnreadEvents: 1,
            updatedAt: new Date(),
          })
          .where(eq(threadListProjectionTable.threadId, shardKey));
      }
      break;
    }

    case "turn.queued":
    case "turn.running":
    case "turn.waiting_user":
    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted":
    case "turn.cancelled":
    case "turn.regenerating":
    case "turn.resumed": {
      // Turn 状态变化：映射到 currentTurnState
      // turn.resumed：Resume 命令成功后，Turn 从 waiting_user 回到 running（S05-C04）
      const stateMap: Record<string, string> = {
        "turn.queued": "queued",
        "turn.running": "running",
        "turn.waiting_user": "waiting_user",
        "turn.completed": "completed",
        "turn.failed": "failed",
        "turn.interrupted": "interrupted",
        "turn.cancelled": "cancelled",
        "turn.regenerating": "regenerating",
        "turn.resumed": "running",
      };
      const turnState = stateMap[event.eventType];
      if (turnState && event.turnId) {
        await tx
          .update(threadListProjectionTable)
          .set({
            currentTurnState: turnState,
            lastActivityAt: event.occurredAt,
            latestEventSequence: event.eventSequence,
            latestEventId: event.id,
            updatedAt: new Date(),
          })
          .where(eq(threadListProjectionTable.threadId, shardKey));
      }
      break;
    }

    case "item.created":
    case "item.completed":
    case "item.failed":
    case "item.superseded": {
      // 更新 lastItem*（从 payload 取摘要）
      const itemType = payload.item_type as string | undefined;
      const itemSummary = (payload.item_summary as string | undefined) ?? null;
      const itemSequence = payload.item_sequence as number | undefined;
      const authorType = payload.author_type as string | undefined;

      if (itemType) {
        await tx
          .update(threadListProjectionTable)
          .set({
            lastItemType: itemType,
            lastItemSummary: itemSummary,
            lastItemSequence: itemSequence ?? null,
            lastItemAuthorType: authorType ?? null,
            lastItemCreatedAt: event.occurredAt,
            lastActivityAt: event.occurredAt,
            latestEventSequence: event.eventSequence,
            latestEventId: event.id,
            hasUnreadEvents: 1,
            updatedAt: new Date(),
          })
          .where(eq(threadListProjectionTable.threadId, shardKey));
      }
      break;
    }

    case "pending_input.created":
    case "pending_input.updated":
    case "pending_input.reordered":
    case "pending_input.admitted":
    case "pending_input.removed": {
      // PendingInput 不在 thread_list_projection 字段中，只前移 cursor
      // 事实源：§5.6（PendingInput 表，不参与 thread_list_projection 字段）
      await tx
        .update(threadListProjectionTable)
        .set({
          latestEventSequence: event.eventSequence,
          latestEventId: event.id,
          updatedAt: new Date(),
        })
        .where(eq(threadListProjectionTable.threadId, shardKey));
      break;
    }

    case "child_thread.created":
    case "turn.regeneration_started":
    case "turn.regeneration_failed":
    case "turn.interrupt_requested":
    case "turn.steer_queued":
    case "turn.steered": {
      // S04-C06 新增事件类型：thread_list_projection 无对应字段，只前移 cursor
      // 事实源：../v11-agentkit-platform/02-agent-thread-and-runtime.md §3.7-3.10
      // - child_thread.created：父 Thread 流中事件，标记 Fork 关系建立（投影列无 fork 计数）
      // - turn.regeneration_started/failed：Regenerate 进行中/失败（turn 状态由 turn.regenerating 事件更新）
      // - turn.interrupt_requested：Interrupt 命令入队（Turn 状态未变，等 Runtime ack）
      // - turn.steer_queued/steered：Steer 命令入队/已应用（user_guidance Item 由 item.created 投影）
      await tx
        .update(threadListProjectionTable)
        .set({
          latestEventSequence: event.eventSequence,
          latestEventId: event.id,
          updatedAt: new Date(),
        })
        .where(eq(threadListProjectionTable.threadId, shardKey));
      break;
    }

    case "invocation.queued":
    case "invocation.started":
    case "invocation.waiting_user":
    case "invocation.completed":
    case "invocation.failed":
    case "invocation.cancelled":
    case "invocation.lost":
    case "invocation.attempt_started":
    case "invocation.attempt_completed":
    case "invocation.attempt_failed":
    case "invocation.resumed": {
      // S05-C01 新增 Invocation 事件：thread_list_projection 无对应字段，只前移 cursor
      // 事实源：../v11-agentkit-platform/02-agent-thread-and-runtime.md §6（Invocation 生命周期）
      // - invocation.queued/started/waiting_user/completed/failed/cancelled/lost：Invocation 状态机事件
      // - invocation.attempt_*：Attempt 基础设施重调度事件
      // - invocation.resumed：Resume 命令成功后，Invocation 从 waiting_user 回到 running（S05-C04）
      // Turn 状态由 turn.queued/running/completed 等事件更新，Invocation 状态不冗余到投影表
      await tx
        .update(threadListProjectionTable)
        .set({
          latestEventSequence: event.eventSequence,
          latestEventId: event.id,
          updatedAt: new Date(),
        })
        .where(eq(threadListProjectionTable.threadId, shardKey));
      break;
    }

    default: {
      // 未知事件类型：如果是 transient 事件（response.delta/heartbeat 等），忽略
      // 否则视为 schema_unsupported 失败
      if (isTransientEventType(event.eventType)) {
        // transient 事件不投影，直接返回（不写 failure）
        return;
      }
      throw new ProjectionFailureError(
        THREAD_LIST_CONSUMER,
        event.id,
        "schema_unsupported",
        new Error(`未知 eventType: ${event.eventType}`),
      );
    }
  }
}

// ─── turn_timeline_projection 投影逻辑 ────────────────────

/** 将事件投影到 turn_timeline_projection。 */
async function projectToTurnTimeline(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: ThreadEvent,
): Promise<void> {
  const payload = event.payloadJson as Record<string, unknown>;

  // turn_timeline_projection 只处理 turn 相关事件
  if (!event.turnId) {
    // 非 Turn 事件（如 thread.created）：turn_timeline_projection 不需要处理
    return;
  }

  const turnId = event.turnId;

  switch (event.eventType) {
    case "turn.accepted": {
      // 创建 turn_timeline_projection 行
      const threadId = event.threadId;
      const tenantId = payload.tenant_id as string | undefined;
      const turnSequence = payload.turn_sequence as number | undefined;
      const triggerType = payload.trigger_type as string | undefined;
      const triggerItemId = (payload.trigger_item_id as string | null | undefined) ?? null;

      if (!tenantId || turnSequence === undefined || !triggerType) {
        throw new ProjectionFailureError(
          TURN_TIMELINE_CONSUMER,
          event.id,
          "schema_unsupported",
          new Error("turn.accepted payload 缺少 tenant_id/turn_sequence/trigger_type"),
        );
      }

      await tx
        .insert(turnTimelineProjectionTable)
        .values({
          turnId,
          threadId,
          tenantId,
          turnSequence,
          turnState: "accepted",
          triggerType,
          triggerItemId,
          itemCount: 0,
          acceptedAt: event.occurredAt,
          latestEventSequence: event.eventSequence,
        })
        .onDuplicateKeyUpdate({
          set: {
            turnState: "accepted",
            acceptedAt: event.occurredAt,
            latestEventSequence: event.eventSequence,
            updatedAt: new Date(),
          },
        });
      break;
    }

    case "turn.queued":
    case "turn.running":
    case "turn.waiting_user":
    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted":
    case "turn.cancelled":
    case "turn.regenerating":
    case "turn.resumed": {
      // turn.resumed：Resume 命令成功后，Turn 从 waiting_user 回到 running（S05-C04）
      const stateMap: Record<string, string> = {
        "turn.queued": "queued",
        "turn.running": "running",
        "turn.waiting_user": "waiting_user",
        "turn.completed": "completed",
        "turn.failed": "failed",
        "turn.interrupted": "interrupted",
        "turn.cancelled": "cancelled",
        "turn.regenerating": "regenerating",
        "turn.resumed": "running",
      };
      const turnState = stateMap[event.eventType];

      const updates: Record<string, unknown> = {
        turnState,
        latestEventSequence: event.eventSequence,
        updatedAt: new Date(),
      };

      // 状态相关的时间戳
      // turn.resumed 与 turn.running 一样：更新 startedAt（恢复运行时间）
      if (event.eventType === "turn.running" || event.eventType === "turn.resumed") {
        updates.startedAt = event.occurredAt;
      } else if (event.eventType === "turn.waiting_user") {
        updates.waitingAt = event.occurredAt;
      } else if (
        event.eventType === "turn.completed" ||
        event.eventType === "turn.failed" ||
        event.eventType === "turn.interrupted" ||
        event.eventType === "turn.cancelled"
      ) {
        updates.finishedAt = event.occurredAt;
      } else if (event.eventType === "turn.regenerating") {
        const regenerationNo = payload.regeneration_no as number | undefined;
        if (regenerationNo !== undefined) {
          updates.regenerationNo = regenerationNo;
        }
      }

      if (event.eventType === "turn.failed") {
        const errorCode = (payload.error_code as string | null | undefined) ?? null;
        updates.errorCode = errorCode;
      }

      await tx
        .update(turnTimelineProjectionTable)
        .set(updates)
        .where(eq(turnTimelineProjectionTable.turnId, turnId));
      break;
    }

    case "item.created":
    case "item.completed":
    case "item.failed":
    case "item.superseded": {
      // 更新 itemCount / lastItem* / triggerItem* / finalItem*
      const itemType = payload.item_type as string | undefined;
      const itemSummary = (payload.item_summary as string | undefined) ?? null;
      const itemSequence = payload.item_sequence as number | undefined;
      const itemId = event.itemId;

      if (!itemType) {
        break;
      }

      // 先读取当前行
      const [current] = await tx
        .select()
        .from(turnTimelineProjectionTable)
        .where(eq(turnTimelineProjectionTable.turnId, turnId))
        .limit(1);

      if (!current) {
        // Turn 投影行不存在，可能是 turn.accepted 未处理，跳过（等待重放）
        break;
      }

      const updates: Record<string, unknown> = {
        lastItemType: itemType,
        lastItemSummary: itemSummary,
        lastItemSequence: itemSequence ?? null,
        lastItemCreatedAt: event.occurredAt,
        latestEventSequence: event.eventSequence,
        updatedAt: new Date(),
      };

      // item.created 时递增 itemCount
      if (event.eventType === "item.created") {
        updates.itemCount = current.itemCount + 1;
      }

      // 触发 Item（通常是 user_message）
      if (
        event.eventType === "item.created" &&
        itemType === "user_message" &&
        !current.triggerItemId
      ) {
        updates.triggerItemId = itemId ?? null;
        updates.triggerItemType = itemType;
        updates.triggerItemSummary = itemSummary;
        updates.triggerItemCreatedAt = event.occurredAt;
      }

      // 最终 Item（agent_message 或 job_result）
      if (
        (event.eventType === "item.completed" || event.eventType === "item.created") &&
        (itemType === "agent_message" || itemType === "job_result")
      ) {
        updates.finalItemId = itemId ?? null;
        updates.finalItemType = itemType;
        updates.finalItemSummary = itemSummary;
        updates.finalItemCreatedAt = event.occurredAt;
      }

      await tx
        .update(turnTimelineProjectionTable)
        .set(updates)
        .where(eq(turnTimelineProjectionTable.turnId, turnId));
      break;
    }

    case "pending_input.created":
    case "pending_input.updated":
    case "pending_input.reordered":
    case "pending_input.admitted":
    case "pending_input.removed": {
      // PendingInput 不在 turn_timeline_projection 字段中，只前移 cursor
      // 事实源：§5.6（PendingInput 表，不参与 turn_timeline_projection 字段）
      // 注意：pending_input 事件通常无 turnId，会在入口处的 !event.turnId 检查时返回；
      // 仅 admitted 事件可能携带 admittedTurnId，此时只前移对应 turn 行的 cursor。
      await tx
        .update(turnTimelineProjectionTable)
        .set({
          latestEventSequence: event.eventSequence,
          updatedAt: new Date(),
        })
        .where(eq(turnTimelineProjectionTable.turnId, turnId));
      break;
    }

    case "turn.regeneration_started":
    case "turn.regeneration_failed":
    case "turn.interrupt_requested":
    case "turn.steer_queued":
    case "turn.steered": {
      // S04-C06 新增 Turn 事件类型：turn_timeline_projection 只前移 cursor
      // - turn.regeneration_started：regeneration_no 由 turn.regenerating 事件更新（payload.regeneration_no）
      // - turn.regeneration_failed：Turn 状态由 turn.failed/interrupted 等终态事件更新
      // - turn.interrupt_requested：Turn 状态未变（Runtime ack 后才进入终态）
      // - turn.steer_queued/steered：user_guidance Item 由 item.created 投影
      // 事实源：../v11-agentkit-platform/02-agent-thread-and-runtime.md §3.7-3.10
      await tx
        .update(turnTimelineProjectionTable)
        .set({
          latestEventSequence: event.eventSequence,
          updatedAt: new Date(),
        })
        .where(eq(turnTimelineProjectionTable.turnId, turnId));
      break;
    }

    case "invocation.queued":
    case "invocation.started":
    case "invocation.waiting_user":
    case "invocation.completed":
    case "invocation.failed":
    case "invocation.cancelled":
    case "invocation.lost":
    case "invocation.attempt_started":
    case "invocation.attempt_completed":
    case "invocation.attempt_failed":
    case "invocation.resumed": {
      // S05-C01 新增 Invocation 事件：turn_timeline_projection 只前移 cursor
      // 事实源：../v11-agentkit-platform/02-agent-thread-and-runtime.md §6（Invocation 生命周期）
      // - Invocation 状态不冗余到 turn_timeline_projection（Turn 状态由 turn.* 事件更新）
      // - Attempt 事件同理，只前移 cursor
      // - invocation.resumed（S05-C04）：Invocation 从 waiting_user 回到 running，
      //   Turn 状态由 turn.resumed 事件单独更新，这里只前移 cursor
      await tx
        .update(turnTimelineProjectionTable)
        .set({
          latestEventSequence: event.eventSequence,
          updatedAt: new Date(),
        })
        .where(eq(turnTimelineProjectionTable.turnId, turnId));
      break;
    }

    default: {
      if (isTransientEventType(event.eventType)) {
        return;
      }
      throw new ProjectionFailureError(
        TURN_TIMELINE_CONSUMER,
        event.id,
        "schema_unsupported",
        new Error(`未知 eventType: ${event.eventType}`),
      );
    }
  }
}

/** 判断是否为 transient 事件类型（不写永久 Event，投影器不应遇到）。 */
function isTransientEventType(eventType: string): boolean {
  const transientPrefixes = [
    "response.delta",
    "reasoning.delta",
    "heartbeat",
    "tool.stdout",
    "tool.stderr",
    "tool.log",
  ];
  return transientPrefixes.some((prefix) => eventType.startsWith(prefix));
}

// ─── 主入口 ───────────────────────────────────────────────

/**
 * 投影单个 ThreadEvent 到所有读模型。
 *
 * 事实源：§7.4 规则 5（Item 投影器按 Event sequence 幂等更新，checkpoint 只在事务提交后前移）。
 *
 * 流程：
 * 1. 并行投影到 thread_list_projection 和 turn_timeline_projection
 * 2. 两者都成功后更新 event_stream_floor.latestSequence
 */
export async function projectThreadEvent(event: ThreadEvent): Promise<void> {
  const [threadListResult, turnTimelineResult] = await Promise.all([
    projectToConsumer(THREAD_LIST_CONSUMER, event, projectToThreadList),
    projectToConsumer(TURN_TIMELINE_CONSUMER, event, projectToTurnTimeline),
  ]);

  // 两者都处理（或幂等跳过）后，更新 event_stream_floor.latestSequence
  if (
    !threadListResult.failed &&
    !turnTimelineResult.failed &&
    (threadListResult.applied || turnTimelineResult.applied)
  ) {
    await updateEventStreamFloorLatest(THREAD_EVENT_STREAM, event.threadId, event.eventSequence);
  }
}

/**
 * 批量投影（按 sequence 升序处理）。
 *
 * 事实源：§2.1 规则 1（按流内 sequence 读取，不按 occurred_at 排序）。
 * 调用方必须保证 events 按 eventSequence 升序。
 */
export async function projectThreadEvents(events: ThreadEvent[]): Promise<void> {
  // 按 sequence 升序排序（防御性，调用方应已保证）
  const sorted = [...events].sort((a, b) => a.eventSequence - b.eventSequence);
  for (const event of sorted) {
    await projectThreadEvent(event);
  }
}

/**
 * 从权威表重建指定 Thread 的所有读模型。
 *
 * 流程：
 * 1. 删除该 Thread 的所有投影行（thread_list_projection + turn_timeline_projection）
 * 2. 重置 checkpoint 到 0（删除 checkpoint 行）
 * 3. 查询该 Thread 的所有 ThreadEvent（按 sequence 升序）
 * 4. 逐个调用 projectThreadEvent 重建
 */
export async function rebuildProjectionsForThread(
  tenantId: string,
  threadId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. 删除投影行
    await tx
      .delete(threadListProjectionTable)
      .where(eq(threadListProjectionTable.threadId, threadId));
    await tx
      .delete(turnTimelineProjectionTable)
      .where(eq(turnTimelineProjectionTable.threadId, threadId));
  });

  // 2. 重置 checkpoint（通过重新初始化，advanceProjectionCheckpoint 会在首次前移时创建）
  // 注意：这里不直接删除 checkpoint 行，因为 projectThreadEvent 的幂等检查需要 lastSequence=0
  // 实际上删除投影行后，projectThreadEvent 会重新 upsert，幂等检查会因 lastSequence >= eventSequence 而跳过
  // 所以需要先删除 checkpoint 行
  // 由于 ProjectionCheckpoint 没有 delete helper，这里直接用 db.delete
  const { projectionCheckpointTable } = await import("@/lib/persistence/schema/projection");
  await db
    .delete(projectionCheckpointTable)
    .where(and(eq(projectionCheckpointTable.shardKey, threadId)));

  // 3. 查询所有 ThreadEvent（按 sequence 升序）
  const events = await listThreadEvents(tenantId, threadId, { limit: 10000 });

  // 4. 逐个投影重建
  for (const event of events) {
    await projectThreadEvent(event);
  }
}

// 导出常量供其他模块使用
export { THREAD_LIST_CONSUMER, TURN_TIMELINE_CONSUMER, THREAD_EVENT_STREAM };
