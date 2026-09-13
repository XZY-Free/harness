import {
  type ActivityEntry,
  mergeActionEntries,
  mergeThinkEntries,
  projectActivityEvent,
  projectProgressItem,
} from "@/lib/client/activity-projection";
import type { ClientEvent } from "@/lib/client/types";
import {
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { threadEventTable, threadItemTable } from "@/lib/persistence/schema/conversation";
import { and, asc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ threadId: string; turnId: string }>;
}

/**
 * GET /api/threads/{threadId}/turns/{turnId}/activity — 过程透明历史重建（只读）。
 *
 * 活跃回合的日志流由客户端 live ring 承载；历史回合展开折叠摘要时懒加载本端点：
 * 服务端读该 turn 的 ThreadEvent（harness.action.* / user_action.requested）与
 * user_guidance progress Item，复用与 live 完全相同的纯投影函数，保证两路结构一致。
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = getRequestId(request);
  const { threadId, turnId } = await context.params;

  let principal: Awaited<ReturnType<typeof resolveEmployeePrincipal>>;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const thread = await getThreadById(principal.tenantId, threadId);
  if (!thread || thread.ownerUserId !== principal.userIdentityId) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  const [eventRows, itemRows] = await Promise.all([
    db
      .select()
      .from(threadEventTable)
      .where(and(eq(threadEventTable.threadId, threadId), eq(threadEventTable.turnId, turnId)))
      .orderBy(asc(threadEventTable.eventSequence)),
    db
      .select()
      .from(threadItemTable)
      .where(and(eq(threadItemTable.threadId, threadId), eq(threadItemTable.turnId, turnId))),
  ]);

  const entries: ActivityEntry[] = [];
  for (const row of eventRows) {
    const event = {
      event_id: row.id,
      sequence: row.eventSequence,
      schema_version: row.schemaVersion,
      thread_id: row.threadId,
      turn_id: row.turnId,
      item_id: row.itemId,
      occurred_at: row.occurredAt.toISOString(),
      event_type: row.eventType,
      payload: row.payloadJson,
    } as unknown as ClientEvent;
    const entry = projectActivityEvent(event);
    if (entry) entries.push(entry);
  }
  for (const item of itemRows) {
    const entry = projectProgressItem({
      id: item.id,
      turn_id: item.turnId,
      content: item.contentJson,
      created_at: item.createdAt.toISOString(),
    });
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  return apiSuccess(
    { entries: mergeThinkEntries(mergeActionEntries(entries)) },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
