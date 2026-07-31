/**
 * V11 Fork 仓储（事务性，同事务写 Event + ThreadRelation）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §5.2（ThreadRelation 表）、§6.10 行 504（InvocationCommand 表）
 * - ../v11-agentkit-platform/05-continuity-collaboration-and-reliability.md §4（Fork 语义）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §3.10（Fork）
 *
 * 职责：
 * - forkThread：事务内创建子 Thread + 父子关系 + 两条 Event（thread.created/child_thread.created）。
 *
 * 关键约束（§3.10 行 461-466、§4 行 60-66）：
 * - Fork 不默认复制文件系统（filesystem_checkpoint_id 仅 workspace_mode=checkpoint_copy 时返回，本阶段为 null）。
 * - child Thread 获得独立主 Agent、Goal、Workspace（同 primaryAgentId，独立 activeGoalId/Workspace）。
 * - parent 与 child 不能相同；UNIQUE(parent_thread_id, child_thread_id, relation_type)。
 * - child_thread.created 的 required_refs 含 turn_id/item_id/invocation_id（本阶段简化：child 不复制历史 Item，全设 null）。
 * - Fork 不复制 user_message Item（§3.9 行 430 适用于 Regenerate；Fork 阶段简化：只创建空 child Thread）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { ForkSourceTurnMismatchError, ThreadNotFoundError } from "@/lib/v11/conversation/errors";
import { allocateEventSequences, insertThreadEvent } from "@/lib/v11/conversation/thread-queries";
import type {
  ThreadEventActorType,
  V11Thread,
  V11ThreadEvent,
  V11ThreadRelation,
} from "@/lib/v11/schema/conversation";
import {
  v11Thread,
  v11ThreadEvent,
  v11ThreadRelation,
  v11Turn,
} from "@/lib/v11/schema/conversation";
import { and, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Fork 的 workspace_mode 选项。 */
export type ForkWorkspaceMode = "none" | "checkpoint_copy";

/** forkThread 返回结果。 */
export interface ForkThreadResult {
  /** 新建的子 Thread。 */
  thread: V11Thread;
  /** Fork 关系记录（relation_type=fork, state=active）。 */
  relation: V11ThreadRelation;
  /** 复制截止 Turn id（子 Thread 不复制历史 Item，仅记录 fork 起源）。 */
  copiedThroughTurnId: string;
  /**
   * 文件系统检查点 id（仅 workspace_mode=checkpoint_copy 时返回）。
   * 本阶段 Environment 未接入，固定返回 null（§3.10 行 461）。
   */
  filesystemCheckpointId: string | null;
  /** 子 Thread 的 thread.created Event。 */
  childCreatedEvent: V11ThreadEvent;
  /** 父 Thread 流中的 child_thread.created Event。 */
  parentChildThreadCreatedEvent: V11ThreadEvent;
}

/**
 * 事务内 Fork Thread：创建子 Thread + 父子关系 + 两条 Event。
 *
 * 流程：
 * 1. SELECT FOR UPDATE 源 Thread（校验 active + owner）
 * 2. 校验 fromTurnId 属于源 Thread
 * 3. 创建子 Thread（新 id，ownerUserId 相同，primaryAgentId 相同，title 或继承）
 * 4. 分配子 Thread 的 sequence（thread.created 用 sequence=1）
 * 5. 写子 Thread 的 thread.created Event（payload 标记 fork_child=true）
 * 6. 在父 Thread 的事件流中写 child_thread.created Event
 * 7. 创建 ThreadRelation（relation_type=fork, parent=源, child=新, source_turn_id=fromTurnId, state=active）
 * 8. filesystem_checkpoint_id 仅当 workspace_mode=checkpoint_copy 时返回（本阶段返回 null）
 *
 * 隐藏式 404：源 Thread 跨租户/不存在 → ThreadNotFoundError。
 * Fork 源 Turn 不属于源 Thread → ForkSourceTurnMismatchError（409 BUSINESS_CONSTRAINT_VIOLATION）。
 */
export async function forkThread(params: {
  tenantId: string;
  ownerUserId: string;
  parentThreadId: string;
  fromTurnId: string;
  title?: string | null;
  workspaceMode: ForkWorkspaceMode;
  idempotencyKey?: string;
  correlationId?: string;
}): Promise<ForkThreadResult> {
  const childThreadId = randomUUID();
  const childCreatedEventId = randomUUID();
  const relationId = randomUUID();
  const now = new Date();

  const parentChildThreadCreatedEvent = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE 源 Thread（校验 active + owner）
    const [parentThread] = await tx
      .select()
      .from(v11Thread)
      .where(and(eq(v11Thread.tenantId, params.tenantId), eq(v11Thread.id, params.parentThreadId)))
      .for("update")
      .limit(1);

    if (!parentThread) {
      throw new ThreadNotFoundError(params.parentThreadId);
    }
    // 隐藏式 404：非 owner 一律 NotFound
    if (parentThread.ownerUserId !== params.ownerUserId) {
      throw new ThreadNotFoundError(params.parentThreadId);
    }
    if (parentThread.lifecycleState !== "active") {
      throw new ThreadNotFoundError(params.parentThreadId);
    }

    // 2. 校验 fromTurnId 属于源 Thread
    const [sourceTurn] = await tx
      .select({ id: v11Turn.id, threadId: v11Turn.threadId })
      .from(v11Turn)
      .where(eq(v11Turn.id, params.fromTurnId))
      .limit(1);

    if (!sourceTurn || sourceTurn.threadId !== params.parentThreadId) {
      throw new ForkSourceTurnMismatchError(params.parentThreadId, params.fromTurnId);
    }

    // 3. 创建子 Thread（新 id，ownerUserId 相同，primaryAgentId 相同，title 或继承）
    //    child Thread 的 lastEventSequence 从 1 开始（thread.created 占 sequence=1）
    const childTitle = params.title ?? parentThread.title ?? null;
    await tx.insert(v11Thread).values({
      id: childThreadId,
      tenantId: params.tenantId,
      ownerUserId: parentThread.ownerUserId,
      primaryAgentId: parentThread.primaryAgentId,
      title: childTitle,
      defaultWorkspaceId: null, // child 获得独立 Workspace（§4 行 60-66），本阶段不复制
      defaultModelRef: parentThread.defaultModelRef,
      defaultEnvironmentDefinitionId: parentThread.defaultEnvironmentDefinitionId,
      lifecycleState: "active",
      lastActivityAt: now,
      lastTurnSequence: 0,
      lastItemSequence: 0,
      lastEventSequence: 1, // thread.created 占 sequence=1
      pendingQueueVersionNo: 1,
      versionNo: 1,
      createdAt: now,
      updatedAt: now,
    });

    // 4. 写子 Thread 的 thread.created Event（payload 标记 fork_child=true）
    await tx.insert(v11ThreadEvent).values({
      id: childCreatedEventId,
      threadId: childThreadId,
      eventSequence: 1,
      eventType: "thread.created",
      schemaVersion: 1,
      turnId: null,
      itemId: null,
      invocationId: null,
      actorType: "user" as ThreadEventActorType,
      actorId: params.ownerUserId,
      payloadJson: {
        // 投影上下文（thread_list_projection 需要 tenant_id/owner_user_id 创建行）
        tenant_id: params.tenantId,
        owner_user_id: parentThread.ownerUserId,
        primary_agent_id: parentThread.primaryAgentId,
        title: childTitle,
        default_workspace_id: null,
        default_model_ref: parentThread.defaultModelRef,
        // Fork 标记：本 Thread 是 fork 子 Thread，由 parent_thread_id 标识源
        fork_child: true,
        parent_thread_id: params.parentThreadId,
        source_turn_id: params.fromTurnId,
      },
      idempotencyKey: params.idempotencyKey ?? null,
      occurredAt: now,
      ingestedAt: now,
    });

    // 5. 在父 Thread 的事件流中写 child_thread.created Event
    //    先锁定父 Thread 行原子分配 sequence（allocateEventSequences 内部已 SELECT FOR UPDATE）
    const parentEventSeq = await allocateEventSequences(tx, params.parentThreadId, 1);
    const parentEvent = await insertThreadEvent(tx, params.parentThreadId, parentEventSeq, {
      eventType: "child_thread.created",
      actorType: "user" as ThreadEventActorType,
      actorId: params.ownerUserId,
      payload: {
        // required_refs（§契约）：turn_id/item_id/invocation_id 本阶段为 null（Fork 不复制历史 Item）
        turn_id: null,
        item_id: null,
        invocation_id: null,
        child_thread_id: childThreadId,
        parent_thread_id: params.parentThreadId,
        source_turn_id: params.fromTurnId,
        workspace_mode: params.workspaceMode,
      },
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId,
    });

    // 6. 更新父 Thread 的 lastActivityAt（lastEventSequence 已在 allocateEventSequences 内更新）
    await tx
      .update(v11Thread)
      .set({
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(v11Thread.id, params.parentThreadId));

    // 7. 创建 ThreadRelation（relation_type=fork, parent=源, child=新, source_turn_id=fromTurnId, state=active）
    //    直接在事务内 INSERT，跳过 createThreadRelation helper（该 helper 用 db 而非 tx，无法纳入本事务）
    //    parent 与 child 不能相同（已由 childThreadId=randomUUID 保证）
    await tx.insert(v11ThreadRelation).values({
      id: relationId,
      parentThreadId: params.parentThreadId,
      childThreadId: childThreadId,
      relationType: "fork",
      sourceTurnId: params.fromTurnId,
      sourceItemId: null,
      sourceInvocationId: null,
      targetAgentId: null, // fork 继承主 Agent，target_agent_id 为空
      taskPayloadRef: null,
      taskPayloadHash: null,
      contextTransferPolicyJson: null,
      budgetPolicyJson: null,
      relationState: "active", // Fork 事务完成即 active
      itemId: null,
      resultItemId: null,
      resultRef: null,
      resultHash: null,
      createdAt: now,
      completedAt: null,
    });

    return parentEvent;
  });

  // 事务外回读
  const [childThread] = await db
    .select()
    .from(v11Thread)
    .where(eq(v11Thread.id, childThreadId))
    .limit(1);
  if (!childThread) {
    throw new Error(`forkThread: 子 Thread 行未找到（id=${childThreadId}）`);
  }

  const [relation] = await db
    .select()
    .from(v11ThreadRelation)
    .where(eq(v11ThreadRelation.id, relationId))
    .limit(1);
  if (!relation) {
    throw new Error(`forkThread: ThreadRelation 行未找到（id=${relationId}）`);
  }

  const [childCreatedEvent] = await db
    .select()
    .from(v11ThreadEvent)
    .where(eq(v11ThreadEvent.id, childCreatedEventId))
    .limit(1);
  if (!childCreatedEvent) {
    throw new Error(`forkThread: 子 thread.created Event 行未找到（id=${childCreatedEventId}）`);
  }

  // parentChildThreadCreatedEvent 由事务返回值直接提供（insertThreadEvent 内部生成 id）

  // filesystem_checkpoint_id：仅 workspace_mode=checkpoint_copy 时返回；本阶段 Environment 未接入，固定 null
  const filesystemCheckpointId = null;

  return {
    thread: childThread,
    relation,
    copiedThroughTurnId: params.fromTurnId,
    filesystemCheckpointId,
    childCreatedEvent,
    parentChildThreadCreatedEvent,
  };
}

// 导出事务句柄类型供外部组合事务使用
export type { Tx };
