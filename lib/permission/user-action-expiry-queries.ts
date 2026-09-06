import { applyAgentCallTransition } from "@/lib/agents/calls/persistence/apply-agent-call-transition";
import { updateToolCallState } from "@/lib/capability/tool-call-queries";
import {
  allocateEventSequences,
  computeEventPayloadHash,
  insertThreadEvent,
} from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { classifyUserActionExpiry } from "@/lib/permission/user-action-expiry-policy";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
import { threadItemTable, threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import {
  type UserActionRequest,
  userActionRequestTable,
} from "@/lib/persistence/schema/user-action-request";
import { updateInvocationState } from "@/lib/runtime/invocation-queries";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const USER_ACTION_EXPIRED_CODE = "USER_ACTION_EXPIRED";

export interface ExpireUserActionResult {
  expired: boolean;
  request: UserActionRequest;
  reason: "expired" | "not_due" | "already_terminal";
}

/** Atomically expire one request and close every local wait owner. */
export async function expireUserActionRequest(params: {
  tenantId: string;
  requestId: string;
  now?: Date;
}): Promise<ExpireUserActionResult> {
  return db.transaction((tx) =>
    expireUserActionRequestInTransaction(tx, params.tenantId, params.requestId, params.now),
  );
}

/**
 * Same lifecycle used by the API deadline path and by the worker. The caller
 * may already hold the UAR lock; this function deliberately reacquires it only
 * when called as a standalone transaction.
 */
export async function expireUserActionRequestInTransaction(
  tx: Tx,
  tenantId: string,
  requestId: string,
  now = new Date(),
): Promise<ExpireUserActionResult> {
  const [request] = await tx
    .select()
    .from(userActionRequestTable)
    .where(
      and(eq(userActionRequestTable.tenantId, tenantId), eq(userActionRequestTable.id, requestId)),
    )
    .for("update")
    .limit(1);
  if (!request) throw new Error(`UserActionRequest 不存在或跨租户不可见: ${requestId}`);
  return expireLockedUserActionRequest(tx, request, now);
}

/** Candidate scanner only: each candidate goes through the transactional service. */
export async function expireDueUserActionRequests(params?: {
  now?: Date;
  limit?: number;
}): Promise<{ scanned: number; expired: number }> {
  const now = params?.now ?? new Date();
  const limit = Math.min(Math.max(params?.limit ?? 50, 1), 200);
  const candidates = await db
    .select({ id: userActionRequestTable.id, tenantId: userActionRequestTable.tenantId })
    .from(userActionRequestTable)
    .where(
      and(
        eq(userActionRequestTable.requestState, "pending"),
        isNotNull(userActionRequestTable.expiresAt),
        lte(userActionRequestTable.expiresAt, now),
      ),
    )
    .orderBy(asc(userActionRequestTable.expiresAt), asc(userActionRequestTable.id))
    .limit(limit);

  let expired = 0;
  for (const candidate of candidates) {
    const result = await expireUserActionRequest({
      tenantId: candidate.tenantId,
      requestId: candidate.id,
      now,
    });
    if (result.expired) expired += 1;
  }
  return { scanned: candidates.length, expired };
}

async function expireLockedUserActionRequest(
  tx: Tx,
  request: UserActionRequest,
  now: Date,
): Promise<ExpireUserActionResult> {
  if (request.requestState !== "pending") {
    return { expired: false, request, reason: "already_terminal" };
  }
  if (!request.expiresAt || request.expiresAt.getTime() > now.getTime()) {
    return { expired: false, request, reason: "not_due" };
  }

  // Thread is the event-stream lock. Invocation/Turn and the child authority
  // are all closed before the UAR transition is committed.
  const [thread] = await tx
    .select()
    .from(threadTable)
    .where(and(eq(threadTable.tenantId, request.tenantId), eq(threadTable.id, request.threadId)))
    .for("update")
    .limit(1);
  if (!thread) throw new Error(`Thread 不存在或跨租户不可见: ${request.threadId}`);

  const policy = classifyUserActionExpiry(request.requestType, request.purpose);
  const prompt = asRecord(request.promptJson);
  if (policy.childKind === "agent_call" && typeof prompt?.agent_call_id === "string") {
    const [call] = await tx
      .select()
      .from(agentCallTable)
      .where(
        and(
          eq(agentCallTable.tenantId, request.tenantId),
          eq(agentCallTable.id, prompt.agent_call_id),
          eq(agentCallTable.parentInvocationId, request.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!call) throw new Error(`AgentCall ${prompt.agent_call_id} 与过期请求不匹配`);
    if (!["completed", "failed", "cancelled", "lost"].includes(call.state)) {
      const transition = await applyAgentCallTransition(tx, {
        tenantId: request.tenantId,
        callId: call.id,
        input: "call.cancelled",
        authority: "local_cancel",
        errorCode: USER_ACTION_EXPIRED_CODE,
        errorSummary: "用户操作已过期",
        now,
      });
      if (transition.finalState !== "cancelled") {
        throw new Error(`AgentCall ${call.id} 无法因用户操作过期而取消`);
      }
    }
  }

  const [invocation] = await tx
    .select()
    .from(invocationTable)
    .where(
      and(
        eq(invocationTable.tenantId, request.tenantId),
        eq(invocationTable.id, request.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!invocation) throw new Error(`Invocation 不存在或跨租户不可见: ${request.invocationId}`);

  const [turn] = await tx
    .select()
    .from(turnTable)
    .where(and(eq(turnTable.id, request.turnId), eq(turnTable.threadId, request.threadId)))
    .for("update")
    .limit(1);
  if (!turn) throw new Error(`Turn 不存在或不属于 Thread: ${request.turnId}`);

  let invocationCancelled = false;
  if (!["completed", "failed", "cancelled", "lost"].includes(invocation.executionState)) {
    await updateInvocationState(tx, request.tenantId, invocation.id, "cancelled", {
      errorCode: USER_ACTION_EXPIRED_CODE,
      errorSummary: "用户操作已过期",
      finishedAt: now,
    });
    invocationCancelled = true;
  }

  let turnCancelled = false;
  if (!["completed", "interrupted", "failed", "cancelled"].includes(turn.turnState)) {
    await tx
      .update(turnTable)
      .set({
        turnState: "cancelled",
        errorCode: USER_ACTION_EXPIRED_CODE,
        versionNo: turn.versionNo + 1,
        finishedAt: now,
      })
      .where(eq(turnTable.id, turn.id));
    turnCancelled = true;
  }

  let itemCancelled = false;
  if (request.itemId) {
    const [item] = await tx
      .select()
      .from(threadItemTable)
      .where(
        and(
          eq(threadItemTable.id, request.itemId),
          eq(threadItemTable.threadId, request.threadId),
          eq(threadItemTable.itemType, "user_action"),
        ),
      )
      .for("update")
      .limit(1);
    if (!item) throw new Error(`UserActionRequest 投影 Item 不存在: ${request.itemId}`);
    if (item.itemState !== "cancelled") {
      const content = {
        ...(asRecord(item.contentJson) ?? {}),
        state: "expired",
        expired_at: now.toISOString(),
      };
      await tx
        .update(threadItemTable)
        .set({
          itemState: "cancelled",
          contentJson: content,
          contentHash: computeEventPayloadHash(content),
          updatedAt: now,
        })
        .where(eq(threadItemTable.id, item.id));
      itemCancelled = true;
    }
  }

  if (policy.childKind === "tool_call" && request.toolCallId) {
    const [toolCall] = await tx
      .select()
      .from(toolCallTable)
      .where(
        and(
          eq(toolCallTable.tenantId, request.tenantId),
          eq(toolCallTable.id, request.toolCallId),
          eq(toolCallTable.invocationId, request.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!toolCall) throw new Error(`ToolCall ${request.toolCallId} 与过期请求不匹配`);
    if (!["succeeded", "failed", "cancelled", "unknown_effect"].includes(toolCall.callState)) {
      await updateToolCallState(
        {
          tenantId: request.tenantId,
          toolCallId: toolCall.id,
          toState: "cancelled",
          errorCode: USER_ACTION_EXPIRED_CODE,
          errorSummary: "用户操作已过期",
          finishedAt: now,
        },
        tx,
      );
    }
  }

  await tx
    .update(userActionRequestTable)
    .set({ requestState: "expired", updatedAt: now, versionNo: request.versionNo + 1 })
    .where(
      and(
        eq(userActionRequestTable.tenantId, request.tenantId),
        eq(userActionRequestTable.id, request.id),
        eq(userActionRequestTable.requestState, "pending"),
        eq(userActionRequestTable.versionNo, request.versionNo),
      ),
    );

  const eventCount =
    1 + (itemCancelled ? 1 : 0) + (invocationCancelled ? 1 : 0) + (turnCancelled ? 1 : 0);
  const start = await allocateEventSequences(tx, request.threadId, eventCount);
  let next = start;
  await insertThreadEvent(tx, request.threadId, next++, {
    eventType: "user_action.expired",
    turnId: request.turnId,
    itemId: request.itemId ?? undefined,
    invocationId: request.invocationId,
    actorType: "system",
    payload: {
      request_id: request.id,
      request_type: request.requestType,
      purpose: request.purpose,
      expires_at: request.expiresAt.toISOString(),
      error_code: USER_ACTION_EXPIRED_CODE,
    },
  });
  if (itemCancelled) {
    await insertThreadEvent(tx, request.threadId, next++, {
      eventType: "item.cancelled",
      turnId: request.turnId,
      itemId: request.itemId ?? undefined,
      invocationId: request.invocationId,
      actorType: "system",
      payload: { item_type: "user_action", request_id: request.id, reason: "expired" },
    });
  }
  if (invocationCancelled) {
    await insertThreadEvent(tx, request.threadId, next++, {
      eventType: "invocation.cancelled",
      turnId: request.turnId,
      invocationId: request.invocationId,
      actorType: "system",
      payload: { reason: USER_ACTION_EXPIRED_CODE, request_id: request.id },
    });
  }
  if (turnCancelled) {
    await insertThreadEvent(tx, request.threadId, next++, {
      eventType: "turn.cancelled",
      turnId: request.turnId,
      invocationId: request.invocationId,
      actorType: "system",
      payload: { reason: USER_ACTION_EXPIRED_CODE, request_id: request.id },
    });
  }

  await tx
    .update(threadTable)
    .set({ lastActivityAt: now, versionNo: thread.versionNo + 1, updatedAt: now })
    .where(eq(threadTable.id, thread.id));

  const [updated] = await tx
    .select()
    .from(userActionRequestTable)
    .where(eq(userActionRequestTable.id, request.id))
    .limit(1);
  if (!updated) throw new Error(`UserActionRequest 过期后回查失败: ${request.id}`);
  return { expired: true, request: updated, reason: "expired" };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
