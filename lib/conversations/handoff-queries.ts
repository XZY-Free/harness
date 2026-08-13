/**
 * 主 Agent Handoff 应用服务（S09-C03）。
 *
 * 事实源：
 * - docs/architecture/conversations.md §12（Handoff 规则）
 * - docs/architecture/domain-model.md （父子 Thread；Handoff 不创建第二个 Thread）
 * - docs/architecture/persistence.md （thread.primary_agent_id）、
 * （thread_relation：handoff 不创建 ThreadRelation）、（user_action_request.purpose）
 * - docs/architecture/api-and-events.md （更换主 Agent 命令）、
 * （解析 UserActionRequest）、（发起 UserActionRequest）、（handoff.requested / handoff.completed Event）
 * - docs/architecture/capability-and-collaboration-api.md §5（Handoff 统一规则）
 * - docs/architecture/decision-ledger.md 行 52、174（Workflow Handoff 必须员工确认；统一 UserActionRequest）
 * - docs/architecture/conversations.md 、S09-C03
 *
 * 职责：
 * - requestHandoff：Workflow/Runtime 发起 handoff 请求 → 创建 purpose=handoff 的 confirmation
 * UserActionRequest + user_action ThreadItem + handoff.requested/user_action.requested/item.created
 * Event；当前 Invocation 进入 waiting_user。
 * - resolveHandoff：员工解析 handoff 请求（approve/deny）。
 * - approve：原子更新 Thread.primary_agent_id + 写 thread.primary_agent_changed +
 * handoff.completed + user_action.resolved Event + 入队 resume InvocationCommand。
 * - deny：仅写 user_action.resolved Event + 入队 resume InvocationCommand；主 Agent、Workspace、
 * Memory、Tool 权限保持不变。
 *
 * 关键约束（05 文档 §12 行 250-260；12 文档 §5 行 296-305）：
 * - Workflow/Runtime 不能直接调用 change-primary-agent 命令；必须先创建 UserActionRequest 等待员工解析。
 * - 员工主动调用 :change-primary-agent 路径走 changePrimaryAgentWithEvent（thread-settings-queries.ts），
 * 不经过本模块（员工主动调用即是显式确认）。
 * - Handoff 不创建第二个 Thread，不创建 ThreadRelation（09 文档 行 254）。
 * - 不因交接自动扩大 Workspace、Memory 或 Tool 权限（05 文档 §12 行 258）。
 * - Child Thread 完成不等同于接管主责；只有员工确认才修改 Thread.primary_agent_id。
 * - 同一 UserActionRequest 只能解析一次（原子 UPDATE WHERE requestState='pending'）。
 * - 当前 Thread 必须为 active；当前 Invocation 必须 running（running → waiting_user）。
 * - 目标 Agent 必须存在、同租户、lifecycleState=enabled，且不能等于当前主 Agent。
 */
import { randomUUID } from "node:crypto";
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import {
  HandoffAlreadyResolvedError,
  HandoffValidationError,
  HandoffVersionConflictError,
  ThreadNotFoundError,
} from "@/lib/conversations/errors";
import {
  allocateEventSequences,
  allocateItemSequence,
  computeEventPayloadHash,
  insertThreadEvent,
} from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import {
  type InvocationCommand,
  type Thread,
  type ThreadEvent,
  type ThreadEventActorType,
  type ThreadItem,
  type ThreadItemAuthorType,
  invocationCommandTable,
  threadEventTable,
  threadItemTable,
  threadTable,
} from "@/lib/persistence/schema/conversation";
import { type Invocation, invocationTable } from "@/lib/persistence/schema/runtime";
import {
  type UserActionRequest,
  userActionRequestTable,
} from "@/lib/persistence/schema/user-action-request";
import { updateInvocationState } from "@/lib/runtime/invocation-queries";
import { and, asc, desc, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Handoff 业务意图标识（user_action_request.purpose 字段值）。 */
export const HANDOFF_PURPOSE = "handoff";

// ─── requestHandoff ───────────────────────────────────────

/** requestHandoff 入参。 */
export interface RequestHandoffParams {
  tenantId: string;
  /** 当前 Thread；必须 active。 */
  threadId: string;
  /** 当前 Turn 的 Invocation；必须 running。 */
  invocationId: string;
  /** 当前 Turn id（用于关联 UserActionRequest 和 Event）。 */
  turnId: string;
  /** 目标 Agent id；必须存在、同租户、lifecycleState=enabled，且不等于当前主 Agent。 */
  targetAgentId: string;
  /** 员工可理解的交接原因（写入 promptJson.summary）。 */
  reason: string;
  /** 员工可理解的影响说明（写入 promptJson.impact；可选）。 */
  impact?: string;
  /** 触发事件的 actor 类型（默认 system，因 Workflow/Runtime 触发）。 */
  actorType?: ThreadEventActorType;
  actorId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  /** UserActionRequest 过期时间；不传则永不过期。 */
  expiresAt?: Date | null;
}

/** requestHandoff 返回结果。 */
export interface RequestHandoffResult {
  /** 新建的 UserActionRequest（purpose=handoff, request_type=confirmation, state=pending）。 */
  request: UserActionRequest;
  /** 新建的 user_action ThreadItem（员工可见投影）。 */
  item: ThreadItem;
  /** 更新后的 Invocation（executionState=waiting_user）。 */
  invocation: Invocation;
  /** 写入的 ThreadEvent（按 sequence 升序）：item.created + user_action.requested + handoff.requested。 */
  events: ThreadEvent[];
  /** 更新后的 Thread（versionNo 递增）。 */
  thread: Thread;
}

/**
 * 发起 Handoff 请求（Workflow/Runtime 触发）。
 *
 * 流程（同事务）：
 * 1. SELECT FOR UPDATE Thread（锁定事件流 + 乐观锁基线）
 * 2. 校验 Thread.lifecycleState == active
 * 3. 查询目标 Agent：存在、同租户、lifecycleState=enabled
 * 4. 校验 targetAgentId != Thread.primaryAgentId（同 Agent 无需 handoff）
 * 5. SELECT FOR UPDATE 当前 Invocation（必须 running；running → waiting_user）
 * 6. allocateItemSequence + INSERT user_action ThreadItem
 * 7. INSERT UserActionRequest（purpose=handoff, request_type=confirmation, itemId 关联）
 * 8. UPDATE Invocation: running → waiting_user
 * 9. allocateEventSequences(3) → 写入 item.created + user_action.requested + handoff.requested Event
 * 10. UPDATE Thread.lastActivityAt + versionNo 递增
 *
 * 不变量（12 文档 §5）：
 * - 不创建 ThreadRelation；不修改 Thread.primary_agent_id（由 resolveHandoff approve 时修改）。
 * - 不扩大 Workspace/Memory/Tool 权限（不在本函数修改这些字段）。
 * - UserActionRequest 只能 resolveHandoff 或通用 :resolve 接口解析一次。
 */
export async function requestHandoff(params: RequestHandoffParams): Promise<RequestHandoffResult> {
  if (!params.tenantId) {
    throw new HandoffValidationError("tenantId 不能为空", "RESOLUTION_NOT_ALLOWED");
  }
  if (!params.threadId) {
    throw new HandoffValidationError("threadId 不能为空", "RESOLUTION_NOT_ALLOWED");
  }
  if (!params.invocationId) {
    throw new HandoffValidationError("invocationId 不能为空", "RESOLUTION_NOT_ALLOWED");
  }
  if (!params.turnId) {
    throw new HandoffValidationError("turnId 不能为空", "RESOLUTION_NOT_ALLOWED");
  }
  if (!params.targetAgentId) {
    throw new HandoffValidationError("targetAgentId 不能为空", "RESOLUTION_NOT_ALLOWED");
  }
  if (!params.reason || params.reason.trim().length === 0) {
    throw new HandoffValidationError("reason 不能为空", "RESOLUTION_NOT_ALLOWED");
  }
  if (params.expiresAt && params.expiresAt.getTime() <= Date.now()) {
    throw new HandoffValidationError("expiresAt 必须是未来时间", "RESOLUTION_NOT_ALLOWED");
  }

  const actorType: ThreadEventActorType = params.actorType ?? "system";
  const now = new Date();

  // 事务外预校验目标 Agent（避免长事务持锁）
  const targetAgent = await getAgentById(params.tenantId, params.targetAgentId);
  if (!targetAgent) {
    throw new HandoffValidationError(
      `目标 Agent 不存在或跨租户不可见：${params.targetAgentId}`,
      "AGENT_NOT_AVAILABLE",
    );
  }
  if (targetAgent.lifecycleState !== "enabled") {
    throw new HandoffValidationError(
      `目标 Agent ${params.targetAgentId} lifecycleState=${targetAgent.lifecycleState}，不允许 handoff`,
      "AGENT_NOT_AVAILABLE",
    );
  }

  const result = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE Thread
    const [thread] = await tx
      .select()
      .from(threadTable)
      .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, params.threadId)))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new ThreadNotFoundError(params.threadId);
    }

    // 2. 校验 Thread.lifecycleState == active
    if (thread.lifecycleState !== "active") {
      throw new HandoffValidationError(
        `Thread ${params.threadId} lifecycleState=${thread.lifecycleState}，不允许 handoff`,
        "THREAD_NOT_ACTIVE",
      );
    }

    // 4. 校验 targetAgentId != Thread.primaryAgentId
    if (params.targetAgentId === thread.primaryAgentId) {
      throw new HandoffValidationError(
        `目标 Agent ${params.targetAgentId} 与当前主 Agent 相同，无需 handoff`,
        "SAME_AGENT",
      );
    }

    // 5. SELECT FOR UPDATE 当前 Invocation（校验 running）
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, params.tenantId),
          eq(invocationTable.id, params.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!invocation) {
      throw new HandoffValidationError(
        `Invocation ${params.invocationId} 不存在或跨租户不可见`,
        "INVOCATION_NOT_RUNNING",
      );
    }
    if (invocation.threadId !== params.threadId) {
      throw new HandoffValidationError(
        `Invocation ${params.invocationId} 不属于 Thread ${params.threadId}`,
        "INVOCATION_NOT_RUNNING",
      );
    }
    if (invocation.executionState !== "running") {
      throw new HandoffValidationError(
        `Invocation ${params.invocationId} executionState=${invocation.executionState}，仅 running 可触发 handoff`,
        "INVOCATION_NOT_RUNNING",
      );
    }

    // 6. allocateItemSequence + INSERT user_action ThreadItem
    const itemId = randomUUID();
    const itemSequence = await allocateItemSequence(tx, params.threadId);
    const itemContent = {
      request_type: "confirmation",
      purpose: HANDOFF_PURPOSE,
      target_agent_id: params.targetAgentId,
      target_agent_display_name: targetAgent.displayName,
      previous_agent_id: thread.primaryAgentId,
      reason: params.reason,
      impact: params.impact ?? null,
      state: "pending",
    };
    const itemContentHash = computeEventPayloadHash(itemContent);
    // ThreadItem.authorType 仅接受 user/agent/system/tool（不含 service）；
    // 当 actorType=service（如 Workflow 服务身份）时映射为 system。
    const itemAuthorType: ThreadItemAuthorType = actorType === "service" ? "system" : actorType;
    await tx.insert(threadItemTable).values({
      id: itemId,
      threadId: params.threadId,
      turnId: params.turnId,
      itemSequence,
      itemType: "user_action",
      itemState: "completed",
      authorType: itemAuthorType,
      authorId: params.actorId ?? null,
      contentJson: itemContent,
      contentHash: itemContentHash,
      contextPolicy: "include",
      createdAt: now,
      updatedAt: now,
    });

    // 7. INSERT UserActionRequest
    const requestId = randomUUID();
    const promptJson = {
      title: "主 Agent 交接请求",
      summary: params.reason,
      impact:
        params.impact ?? `主 Agent 将从 ${thread.primaryAgentId} 更改为 ${params.targetAgentId}`,
      target_agent_id: params.targetAgentId,
      target_agent_display_name: targetAgent.displayName,
      previous_agent_id: thread.primaryAgentId,
    };
    await tx.insert(userActionRequestTable).values({
      id: requestId,
      tenantId: params.tenantId,
      threadId: params.threadId,
      turnId: params.turnId,
      invocationId: params.invocationId,
      toolCallId: null,
      itemId,
      requestType: "confirmation",
      purpose: HANDOFF_PURPOSE,
      requestState: "pending",
      promptJson,
      inputSchemaJson: null,
      authStateHash: null,
      nonceHash: null,
      expiresAt: params.expiresAt ?? null,
    });

    // 8. UPDATE Invocation: running → waiting_user
    const updatedInvocation = await updateInvocationState(
      tx,
      params.tenantId,
      params.invocationId,
      "waiting_user",
    );

    // 9. allocateEventSequences(3) → 写入 3 条 Event
    const events: ThreadEvent[] = [];
    const startSeq = await allocateEventSequences(tx, params.threadId, 3);
    let seqCursor = startSeq;

    // 9.1 item.created
    const itemCreatedEvent = await insertThreadEvent(tx, params.threadId, seqCursor, {
      eventType: "item.created",
      turnId: params.turnId,
      itemId,
      invocationId: params.invocationId,
      actorType,
      actorId: params.actorId,
      payload: {
        item_type: "user_action",
        content_hash: itemContentHash,
        request_type: "confirmation",
        purpose: HANDOFF_PURPOSE,
        target_agent_id: params.targetAgentId,
      },
      idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:item-created` : undefined,
      correlationId: params.correlationId,
    });
    events.push(itemCreatedEvent);
    seqCursor += 1;

    // 9.2 user_action.requested
    const userActionRequestedEvent = await insertThreadEvent(tx, params.threadId, seqCursor, {
      eventType: "user_action.requested",
      turnId: params.turnId,
      itemId,
      invocationId: params.invocationId,
      actorType,
      actorId: params.actorId,
      payload: {
        request_id: requestId,
        request_type: "confirmation",
        purpose: HANDOFF_PURPOSE,
        target_agent_id: params.targetAgentId,
        previous_agent_id: thread.primaryAgentId,
        prompt: promptJson,
        expires_at: params.expiresAt ? params.expiresAt.toISOString() : null,
      },
      idempotencyKey: params.idempotencyKey
        ? `${params.idempotencyKey}:user-action-requested`
        : undefined,
      correlationId: params.correlationId,
    });
    events.push(userActionRequestedEvent);
    seqCursor += 1;

    // 9.3 handoff.requested
    const handoffRequestedEvent = await insertThreadEvent(tx, params.threadId, seqCursor, {
      eventType: "handoff.requested",
      turnId: params.turnId,
      itemId,
      invocationId: params.invocationId,
      actorType,
      actorId: params.actorId,
      payload: {
        request_id: requestId,
        thread_id: params.threadId,
        previous_agent_id: thread.primaryAgentId,
        target_agent_id: params.targetAgentId,
        target_agent_display_name: targetAgent.displayName,
        reason: params.reason,
        impact: params.impact ?? null,
      },
      idempotencyKey: params.idempotencyKey
        ? `${params.idempotencyKey}:handoff-requested`
        : undefined,
      correlationId: params.correlationId,
    });
    events.push(handoffRequestedEvent);

    // 10. UPDATE Thread.lastActivityAt + versionNo 递增
    await tx
      .update(threadTable)
      .set({
        lastActivityAt: now,
        versionNo: thread.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(threadTable.id, params.threadId));

    // 11. 回读 Thread / UserActionRequest / ThreadItem
    const [updatedThread] = await tx
      .select()
      .from(threadTable)
      .where(eq(threadTable.id, params.threadId))
      .limit(1);
    if (!updatedThread) {
      throw new Error(`requestHandoff: Thread 行未找到（id=${params.threadId}）`);
    }

    const [updatedRequest] = await tx
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.id, requestId))
      .limit(1);
    if (!updatedRequest) {
      throw new Error(`requestHandoff: UserActionRequest 行未找到（id=${requestId}）`);
    }

    const [updatedItem] = await tx
      .select()
      .from(threadItemTable)
      .where(eq(threadItemTable.id, itemId))
      .limit(1);
    if (!updatedItem) {
      throw new Error(`requestHandoff: ThreadItem 行未找到（id=${itemId}）`);
    }

    return {
      request: updatedRequest,
      item: updatedItem,
      invocation: updatedInvocation,
      events,
      thread: updatedThread,
    };
  });

  return result;
}

// ─── resolveHandoff ───────────────────────────────────────

/** resolveHandoff 入参。 */
export interface ResolveHandoffParams {
  tenantId: string;
  /** UserActionRequest id（必须 purpose=handoff, request_type=confirmation, state=pending）。 */
  requestId: string;
  /** resolution：approve=员工同意交接；deny=员工拒绝。 */
  resolution: "approve" | "deny";
  /** 解析人 userId（员工身份）。 */
  resolvedBy: string;
  /** 触发事件的 actor 类型（默认 user，员工解析）。 */
  actorType?: ThreadEventActorType;
  actorId?: string;
  idempotencyKey?: string;
  correlationId?: string;
}

/** resolveHandoff 返回结果。 */
export interface ResolveHandoffResult {
  /** 更新后的 UserActionRequest（requestState=resolved, resolution=approve/deny）。 */
  request: UserActionRequest;
  /** 写入的 ThreadEvent（按 sequence 升序）。
   * approve：user_action.resolved + thread.primary_agent_changed + handoff.completed（3 条）。
   * deny：user_action.resolved（1 条）。 */
  events: ThreadEvent[];
  /** 更新后的 Thread（仅 approve 时 primary_agent_id 变化；deny 时与原值相同）。 */
  thread: Thread;
  /** 更新后的 Invocation（executionState=running，由 waiting_user 恢复）。 */
  invocation: Invocation;
  /** 入队的 resume InvocationCommand（让 Runtime 继续执行）。 */
  resumeCommand: InvocationCommand;
  /** 是否实际交接（approve=true；deny=false）。 */
  handedOff: boolean;
}

/**
 * 解析 Handoff 请求（员工 :resolve 接口入口）。
 *
 * approve 流程（同事务）：
 * 1. SELECT FOR UPDATE UserActionRequest（校验 pending + purpose=handoff + request_type=confirmation）
 * 2. SELECT FOR UPDATE Thread（锁定事件流 + 乐观锁基线）
 * 3. 校验 Thread.primary_agent_id 仍为请求时的 previous_agent_id（防并发已被其他 handoff 修改）
 * 4. 原子 UPDATE UserActionRequest: pending → resolved（resolution=approve, resolvedBy, resolvedAt）
 * 5. UPDATE Thread.primary_agent_id = target_agent_id + versionNo 递增
 * 6. UPDATE Invocation: waiting_user → running
 * 7. allocateEventSequences(3) → 写入 user_action.resolved + thread.primary_agent_changed + handoff.completed
 * 8. INSERT InvocationCommand（commandType=resume，让 Runtime 恢复执行）
 *
 * deny 流程（同事务）：
 * 1. SELECT FOR UPDATE UserActionRequest（同 approve）
 * 2. 原子 UPDATE UserActionRequest: pending → resolved（resolution=deny, resolvedBy, resolvedAt）
 * 3. UPDATE Invocation: waiting_user → running
 * 4. allocateEventSequences(1) → 写入 user_action.resolved
 * 5. INSERT InvocationCommand（commandType=resume，让 Runtime 恢复执行）
 * 6. 主 Agent、Workspace、Memory、Tool 权限保持不变（不修改任何 Thread 字段）
 *
 * 不变量（12 文档 §5 行 303）：
 * - 拒绝只写解析结果并恢复原 Invocation；不修改 Thread.primary_agent_id。
 * - 不创建 ThreadRelation；不创建新 Thread。
 * - UserActionRequest 只能解析一次；并发场景抛 HandoffAlreadyResolvedError。
 */
export async function resolveHandoff(params: ResolveHandoffParams): Promise<ResolveHandoffResult> {
  if (!params.tenantId) {
    throw new HandoffValidationError("tenantId 不能为空", "RESOLUTION_NOT_ALLOWED");
  }
  if (!params.requestId) {
    throw new HandoffValidationError("requestId 不能为空", "RESOLUTION_NOT_ALLOWED");
  }
  if (!params.resolvedBy) {
    throw new HandoffValidationError("resolvedBy 不能为空", "RESOLUTION_NOT_ALLOWED");
  }
  if (params.resolution !== "approve" && params.resolution !== "deny") {
    throw new HandoffValidationError(
      `resolution 仅接受 approve/deny，实际=${params.resolution}`,
      "RESOLUTION_NOT_ALLOWED",
    );
  }

  const actorType: ThreadEventActorType = params.actorType ?? "user";
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE UserActionRequest
    const [request] = await tx
      .select()
      .from(userActionRequestTable)
      .where(
        and(
          eq(userActionRequestTable.tenantId, params.tenantId),
          eq(userActionRequestTable.id, params.requestId),
        ),
      )
      .for("update")
      .limit(1);
    if (!request) {
      throw new ThreadNotFoundError(params.requestId);
    }

    // 校验 purpose=handoff
    if (request.purpose !== HANDOFF_PURPOSE) {
      throw new HandoffValidationError(
        `UserActionRequest ${params.requestId} purpose=${request.purpose}，非 handoff 请求`,
        "PURPOSE_MISMATCH",
      );
    }

    // 校验 request_type=confirmation
    if (request.requestType !== "confirmation") {
      throw new HandoffValidationError(
        `UserActionRequest ${params.requestId} requestType=${request.requestType}，非 confirmation`,
        "PURPOSE_MISMATCH",
      );
    }

    // 校验 pending 状态
    if (request.requestState !== "pending") {
      throw new HandoffAlreadyResolvedError(params.requestId, request.requestState);
    }

    // 过期检查
    if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) {
      throw new HandoffAlreadyResolvedError(params.requestId, "expired");
    }

    // 2. SELECT FOR UPDATE Thread
    const [thread] = await tx
      .select()
      .from(threadTable)
      .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, request.threadId)))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new ThreadNotFoundError(request.threadId);
    }

    // 3. SELECT FOR UPDATE Invocation
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, params.tenantId),
          eq(invocationTable.id, request.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!invocation) {
      throw new HandoffValidationError(
        `Invocation ${request.invocationId} 不存在或跨租户不可见`,
        "INVOCATION_NOT_RUNNING",
      );
    }
    if (invocation.executionState !== "waiting_user") {
      throw new HandoffValidationError(
        `Invocation ${request.invocationId} executionState=${invocation.executionState}，仅 waiting_user 可 resolve handoff`,
        "INVOCATION_NOT_RUNNING",
      );
    }

    // 提取目标 Agent id（从 promptJson）
    const promptJson = request.promptJson as {
      target_agent_id?: string;
      previous_agent_id?: string;
    };
    const targetAgentId = promptJson.target_agent_id;
    if (!targetAgentId) {
      throw new HandoffValidationError(
        `UserActionRequest ${params.requestId} promptJson 缺少 target_agent_id`,
        "PURPOSE_MISMATCH",
      );
    }

    const events: ThreadEvent[] = [];
    let updatedThread = thread;
    let handedOff = false;

    if (params.resolution === "approve") {
      // 校验 Thread.primary_agent_id 仍为请求时的 previous_agent_id
      const previousAgentId = promptJson.previous_agent_id ?? thread.primaryAgentId;
      if (thread.primaryAgentId !== previousAgentId) {
        // 并发场景：另一个 handoff 已修改主 Agent
        throw new HandoffVersionConflictError(
          thread.id,
          thread.versionNo,
          thread.versionNo, // 当前值；调用方需重新读取
        );
      }

      // 校验目标 Agent 仍可用（避免 race：approve 时 Agent 已被禁用）
      const targetAgent = await getAgentById(params.tenantId, targetAgentId);
      if (!targetAgent || targetAgent.lifecycleState !== "enabled") {
        throw new HandoffValidationError(
          `目标 Agent ${targetAgentId} 不存在或已禁用，无法完成 handoff`,
          "AGENT_NOT_AVAILABLE",
        );
      }

      // 4. 原子 UPDATE UserActionRequest: pending → resolved (approve)
      const approveUpdateResult = await tx
        .update(userActionRequestTable)
        .set({
          requestState: "resolved",
          resolution: "approve",
          resolvedBy: params.resolvedBy,
          resolvedAt: now,
          versionNo: request.versionNo + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(userActionRequestTable.id, request.id),
            eq(userActionRequestTable.tenantId, params.tenantId),
            eq(userActionRequestTable.requestState, "pending"),
            eq(userActionRequestTable.versionNo, request.versionNo),
          ),
        );
      if ((approveUpdateResult[0]?.affectedRows ?? 0) === 0) {
        const [after] = await tx
          .select()
          .from(userActionRequestTable)
          .where(eq(userActionRequestTable.id, request.id))
          .limit(1);
        throw new HandoffAlreadyResolvedError(
          request.id,
          after?.requestState ?? request.requestState,
        );
      }

      // 5. UPDATE Thread.primary_agent_id = target_agent_id + versionNo 递增
      await tx
        .update(threadTable)
        .set({
          primaryAgentId: targetAgentId,
          versionNo: thread.versionNo + 1,
          updatedAt: now,
        })
        .where(eq(threadTable.id, thread.id));

      // 6. UPDATE Invocation: waiting_user → running
      const updatedInvocation = await updateInvocationState(
        tx,
        params.tenantId,
        invocation.id,
        "running",
      );

      // 7. allocateEventSequences(3) → 写入 user_action.resolved + thread.primary_agent_changed + handoff.completed
      const startSeq = await allocateEventSequences(tx, thread.id, 3);
      let seqCursor = startSeq;

      // 7.1 user_action.resolved
      const userActionResolvedEvent = await insertThreadEvent(tx, thread.id, seqCursor, {
        eventType: "user_action.resolved",
        turnId: request.turnId,
        itemId: request.itemId ?? undefined,
        invocationId: request.invocationId,
        actorType,
        actorId: params.actorId ?? params.resolvedBy,
        payload: {
          request_id: request.id,
          request_type: "confirmation",
          purpose: HANDOFF_PURPOSE,
          resolution: "approve",
          resolved_by: params.resolvedBy,
        },
        idempotencyKey: params.idempotencyKey
          ? `${params.idempotencyKey}:user-action-resolved`
          : undefined,
        correlationId: params.correlationId,
      });
      events.push(userActionResolvedEvent);
      seqCursor += 1;

      // 7.2 thread.primary_agent_changed
      const primaryAgentChangedEvent = await insertThreadEvent(tx, thread.id, seqCursor, {
        eventType: "thread.primary_agent_changed",
        turnId: request.turnId,
        itemId: request.itemId ?? undefined,
        invocationId: request.invocationId,
        actorType,
        actorId: params.actorId ?? params.resolvedBy,
        payload: {
          primary_agent_id: targetAgentId,
          previous_agent_id: thread.primaryAgentId,
          reason: `handoff approved (request_id=${request.id})`,
        },
        idempotencyKey: params.idempotencyKey
          ? `${params.idempotencyKey}:primary-agent-changed`
          : undefined,
        correlationId: params.correlationId,
      });
      events.push(primaryAgentChangedEvent);
      seqCursor += 1;

      // 7.3 handoff.completed
      const handoffCompletedEvent = await insertThreadEvent(tx, thread.id, seqCursor, {
        eventType: "handoff.completed",
        turnId: request.turnId,
        itemId: request.itemId ?? undefined,
        invocationId: request.invocationId,
        actorType,
        actorId: params.actorId ?? params.resolvedBy,
        payload: {
          request_id: request.id,
          thread_id: thread.id,
          previous_agent_id: thread.primaryAgentId,
          target_agent_id: targetAgentId,
          target_agent_display_name: targetAgent.displayName,
          resolution: "approve",
          resolved_by: params.resolvedBy,
        },
        idempotencyKey: params.idempotencyKey
          ? `${params.idempotencyKey}:handoff-completed`
          : undefined,
        correlationId: params.correlationId,
      });
      events.push(handoffCompletedEvent);

      // 8. INSERT InvocationCommand (resume)
      const resumeCommandId = randomUUID();
      const resumePayload = {
        request_id: request.id,
        resolution: "approve",
        handoff: {
          previous_agent_id: thread.primaryAgentId,
          target_agent_id: targetAgentId,
        },
        resumed_by: params.resolvedBy,
      };
      const resumePayloadHash = computeEventPayloadHash(resumePayload);
      await tx.insert(invocationCommandTable).values({
        id: resumeCommandId,
        invocationId: invocation.id,
        threadId: thread.id,
        turnId: request.turnId,
        commandType: "resume",
        commandPayloadJson: resumePayload,
        commandPayloadHash: resumePayloadHash,
        commandState: "queued",
        runtimeExecutionRef: null,
        idempotencyKey: params.idempotencyKey ?? null,
        errorCode: null,
        errorMessage: null,
        dispatchedAt: null,
        acknowledgedAt: null,
        failedAt: null,
      });

      // 回读 Thread / UserActionRequest / InvocationCommand
      const [refreshedThread] = await tx
        .select()
        .from(threadTable)
        .where(eq(threadTable.id, thread.id))
        .limit(1);
      if (!refreshedThread) {
        throw new Error(`resolveHandoff: Thread 行未找到（id=${thread.id}）`);
      }
      updatedThread = refreshedThread;

      const [refreshedRequest] = await tx
        .select()
        .from(userActionRequestTable)
        .where(eq(userActionRequestTable.id, request.id))
        .limit(1);
      if (!refreshedRequest) {
        throw new Error(`resolveHandoff: UserActionRequest 行未找到（id=${request.id}）`);
      }

      const [resumeCommand] = await tx
        .select()
        .from(invocationCommandTable)
        .where(eq(invocationCommandTable.id, resumeCommandId))
        .limit(1);
      if (!resumeCommand) {
        throw new Error(`resolveHandoff: InvocationCommand 行未找到（id=${resumeCommandId}）`);
      }

      handedOff = true;
      return {
        request: refreshedRequest,
        events,
        thread: updatedThread,
        invocation: updatedInvocation,
        resumeCommand,
        handedOff,
      };
    }

    // ─── deny 路径 ───

    // 4. 原子 UPDATE UserActionRequest: pending → resolved (deny)
    const denyUpdateResult = await tx
      .update(userActionRequestTable)
      .set({
        requestState: "resolved",
        resolution: "deny",
        resolvedBy: params.resolvedBy,
        resolvedAt: now,
        versionNo: request.versionNo + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(userActionRequestTable.id, request.id),
          eq(userActionRequestTable.tenantId, params.tenantId),
          eq(userActionRequestTable.requestState, "pending"),
          eq(userActionRequestTable.versionNo, request.versionNo),
        ),
      );
    if ((denyUpdateResult[0]?.affectedRows ?? 0) === 0) {
      const [after] = await tx
        .select()
        .from(userActionRequestTable)
        .where(eq(userActionRequestTable.id, request.id))
        .limit(1);
      throw new HandoffAlreadyResolvedError(
        request.id,
        after?.requestState ?? request.requestState,
      );
    }

    // 5. UPDATE Invocation: waiting_user → running
    const updatedInvocation = await updateInvocationState(
      tx,
      params.tenantId,
      invocation.id,
      "running",
    );

    // 6. allocateEventSequences(1) → 写入 user_action.resolved
    const startSeq = await allocateEventSequences(tx, thread.id, 1);
    const userActionResolvedEvent = await insertThreadEvent(tx, thread.id, startSeq, {
      eventType: "user_action.resolved",
      turnId: request.turnId,
      itemId: request.itemId ?? undefined,
      invocationId: request.invocationId,
      actorType,
      actorId: params.actorId ?? params.resolvedBy,
      payload: {
        request_id: request.id,
        request_type: "confirmation",
        purpose: HANDOFF_PURPOSE,
        resolution: "deny",
        resolved_by: params.resolvedBy,
      },
      idempotencyKey: params.idempotencyKey
        ? `${params.idempotencyKey}:user-action-resolved`
        : undefined,
      correlationId: params.correlationId,
    });
    events.push(userActionResolvedEvent);

    // 7. INSERT InvocationCommand (resume)
    const resumeCommandId = randomUUID();
    const resumePayload = {
      request_id: request.id,
      resolution: "deny",
      handoff_rejected: true,
      resumed_by: params.resolvedBy,
    };
    const resumePayloadHash = computeEventPayloadHash(resumePayload);
    await tx.insert(invocationCommandTable).values({
      id: resumeCommandId,
      invocationId: invocation.id,
      threadId: thread.id,
      turnId: request.turnId,
      commandType: "resume",
      commandPayloadJson: resumePayload,
      commandPayloadHash: resumePayloadHash,
      commandState: "queued",
      runtimeExecutionRef: null,
      idempotencyKey: params.idempotencyKey ?? null,
      errorCode: null,
      errorMessage: null,
      dispatchedAt: null,
      acknowledgedAt: null,
      failedAt: null,
    });

    // 回读 UserActionRequest / InvocationCommand
    const [refreshedRequest] = await tx
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.id, request.id))
      .limit(1);
    if (!refreshedRequest) {
      throw new Error(`resolveHandoff: UserActionRequest 行未找到（id=${request.id}）`);
    }

    const [resumeCommand] = await tx
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, resumeCommandId))
      .limit(1);
    if (!resumeCommand) {
      throw new Error(`resolveHandoff: InvocationCommand 行未找到（id=${resumeCommandId}）`);
    }

    return {
      request: refreshedRequest,
      events,
      thread: updatedThread,
      invocation: updatedInvocation,
      resumeCommand,
      handedOff: false,
    };
  });

  return result;
}

// ─── 查询 ─────────────────────────────────────────────────

/**
 * 查询 Thread 当前 pending 的 handoff 请求（最多 1 个；同 Turn 内不应有多个）。
 *
 * 返回 null 表示无 pending handoff 请求。
 */
export async function getPendingHandoffRequest(
  tenantId: string,
  threadId: string,
): Promise<UserActionRequest | null> {
  const [row] = await db
    .select()
    .from(userActionRequestTable)
    .where(
      and(
        eq(userActionRequestTable.tenantId, tenantId),
        eq(userActionRequestTable.threadId, threadId),
        eq(userActionRequestTable.purpose, HANDOFF_PURPOSE),
        eq(userActionRequestTable.requestState, "pending"),
      ),
    )
    .orderBy(desc(userActionRequestTable.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * 查询 Thread 历史所有 handoff 请求（按 createdAt 升序）。
 */
export async function listHandoffRequests(
  tenantId: string,
  threadId: string,
): Promise<UserActionRequest[]> {
  return db
    .select()
    .from(userActionRequestTable)
    .where(
      and(
        eq(userActionRequestTable.tenantId, tenantId),
        eq(userActionRequestTable.threadId, threadId),
        eq(userActionRequestTable.purpose, HANDOFF_PURPOSE),
      ),
    )
    .orderBy(asc(userActionRequestTable.createdAt));
}
