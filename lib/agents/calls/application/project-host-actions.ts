import { randomUUID } from "node:crypto";
import {
  HOST_ACTION_TARGET_CATALOG,
  HOST_ACTION_TYPES,
  type HostAction,
  type HostActionPlatformPolicy,
  defaultHostActionPlatformPolicy,
  isTrustedExternalUrl,
} from "@/lib/agents/calls/transport/a2a/host-control-contract";
import {
  allocateEventSequences,
  allocateItemSequence,
  insertThreadEvent,
} from "@/lib/conversations/thread-queries";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { db } from "@/lib/db/client";
import {
  threadEventTable,
  threadItemTable,
  threadTable,
} from "@/lib/persistence/schema/conversation";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { and, eq } from "drizzle-orm";

/**
 * 把 AgentCall completed 结果中的已规范化 Host Action 投影为 ThreadItem。
 * AgentCall.resultJson 仍是唯一动作事实；ThreadItem 只是员工可见、可重建投影。
 */
export async function projectAgentHostActions(params: {
  tenantId: string;
  threadId: string;
  turnId: string;
  invocationId: string;
  agentCallId: string;
  actions: readonly HostAction[];
  /** 仅由执行 Binding 冻结的可信主体传入，绝不接受 Agent 或 ThreadItem 自报主体。 */
  executionSubject: ExecutionSubject;
}): Promise<string[]> {
  if (params.actions.length === 0) return [];
  const platformPolicy = defaultHostActionPlatformPolicy();
  return db.transaction(async (tx) => {
    const [thread] = await tx
      .select({ id: threadTable.id, ownerUserId: threadTable.ownerUserId })
      .from(threadTable)
      .where(and(eq(threadTable.id, params.threadId), eq(threadTable.tenantId, params.tenantId)))
      .limit(1)
      .for("update");
    if (!thread) throw new Error("Host Action 投影 Thread 不存在或不属于租户");

    const itemIds: string[] = [];
    for (const action of params.actions) {
      const projectedAction = projectHostActionForThread(action, {
        tenantId: params.tenantId,
        threadId: params.threadId,
        threadOwnerUserId: thread.ownerUserId,
        executionSubject: params.executionSubject,
        platformPolicy,
      });
      const idempotencyKey = `host-action:${params.agentCallId}:${action.action_id}`;
      const [existing] = await tx
        .select({ itemId: threadEventTable.itemId })
        .from(threadEventTable)
        .where(
          and(
            eq(threadEventTable.threadId, params.threadId),
            eq(threadEventTable.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing?.itemId) {
        itemIds.push(existing.itemId);
        continue;
      }

      const itemId = randomUUID();
      const itemSequence = await allocateItemSequence(tx, params.threadId);
      const content = { kind: "host_action", ...projectedAction };
      const contentHash = computeCanonicalDigest(content);
      await tx.insert(threadItemTable).values({
        id: itemId,
        threadId: params.threadId,
        turnId: params.turnId,
        itemSequence,
        itemType: "host_action",
        itemState: "completed",
        authorType: "assistant",
        authorId: null,
        contentJson: content,
        contentHash,
        contextPolicy: "include",
        invocationId: params.invocationId,
        supersededByItemId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const eventStart = await allocateEventSequences(tx, params.threadId, 2);
      await insertThreadEvent(tx, params.threadId, eventStart, {
        eventType: "item.created",
        turnId: params.turnId,
        itemId,
        invocationId: params.invocationId,
        actorType: "agent",
        payload: { item_type: "host_action", content_hash: contentHash },
        idempotencyKey,
      });
      await insertThreadEvent(tx, params.threadId, eventStart + 1, {
        eventType: "item.completed",
        turnId: params.turnId,
        itemId,
        invocationId: params.invocationId,
        actorType: "agent",
        payload: { item_type: "host_action", content_hash: contentHash },
        idempotencyKey: `${idempotencyKey}:completed`,
      });
      itemIds.push(itemId);
    }
    return itemIds;
  });
}

export class HostActionProjectionAuthorizationError extends Error {
  readonly code = "host_action_target_unauthorized";

  constructor(message: string) {
    super(message);
    this.name = "HostActionProjectionAuthorizationError";
  }
}

/**
 * 将 Agent 已解析的提议投影为当前 Thread 的实际动作。动态路径和 target 权限只在
 * 这里决定，避免 Agent 输出携带静态路由或绕过当前执行主体。
 */
export function projectHostActionForThread(
  action: HostAction,
  params: {
    tenantId: string;
    threadId: string;
    threadOwnerUserId: string;
    executionSubject: ExecutionSubject;
    platformPolicy?: HostActionPlatformPolicy;
  },
): HostAction {
  const platformPolicy = params.platformPolicy ?? defaultHostActionPlatformPolicy();
  assertHostAction(action, platformPolicy);
  if (params.executionSubject.tenantId !== params.tenantId) {
    throw new HostActionProjectionAuthorizationError("Host Action 主体租户不一致");
  }
  if (action.action_type !== "navigate") return action;

  const target = action.target_key ? HOST_ACTION_TARGET_CATALOG[action.target_key] : undefined;
  if (!target || target.requiredPrincipalPermission !== "thread_owner") {
    throw new HostActionProjectionAuthorizationError("Host Action 导航目标未登记授权规则");
  }
  if (
    params.executionSubject.subjectType !== "user" ||
    params.executionSubject.subjectId !== params.threadOwnerUserId
  ) {
    throw new HostActionProjectionAuthorizationError("当前主体无权访问 Host Action 导航目标");
  }
  return { ...action, web_path: `/chat/${params.threadId}` };
}

function assertHostAction(action: HostAction, platformPolicy: HostActionPlatformPolicy): void {
  if (!action || typeof action !== "object") throw new Error("Host Action 结构非法");
  if (!HOST_ACTION_TYPES.includes(action.action_type)) throw new Error("Host Action 类型非法");
  if (!action.action_id || !action.title || !action.label)
    throw new Error("Host Action 缺少展示字段");
  if (action.action_type === "navigate") {
    const target = action.target_key ? HOST_ACTION_TARGET_CATALOG[action.target_key] : undefined;
    if (!target || action.web_path !== null || action.url !== null) {
      throw new Error("Host Action 导航目标非法");
    }
  } else if (action.action_type === "open_external_link") {
    if (
      !action.url ||
      action.target_key !== null ||
      action.web_path !== null ||
      !isTrustedExternalUrl(action.url, platformPolicy.externalAllowedHosts)
    ) {
      throw new Error("Host Action 外链非法");
    }
  } else if (
    action.target_key !== null ||
    action.web_path !== null ||
    !platformPolicy.humanSupportUrl ||
    action.url !== platformPolicy.humanSupportUrl ||
    !isTrustedExternalUrl(action.url, platformPolicy.externalAllowedHosts)
  ) {
    throw new Error("Host Action 人工帮助入口负载非法");
  }
}
