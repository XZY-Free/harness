import { db } from "@/lib/db/client";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallTable,
  agentSessionBindingTable,
} from "@/lib/persistence/schema/agent-calls";
import { capabilityUseTable } from "@/lib/persistence/schema/capability-use";
import {
  threadEventTable,
  threadItemTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import { and, asc, desc, eq } from "drizzle-orm";

const HARNESS_ACTION_EVENT_TYPES = new Set([
  "harness.action.proposed",
  "harness.action.started",
  "harness.action.completed",
  "harness.action.failed",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 从现有 Authority 只读拼装一次 Harness 执行 Trace。
 *
 * 不创建第二套执行事实，也不返回 action payload、Agent result、Tool 参数/结果、endpoint、
 * Credential 或模型隐藏内容。trace_id 来自 ThreadEvent.correlationId；缺失时稳定回落到
 * Parent Invocation id。AgentCall 通过 parentInvocationId + sourceRef(actionId) 成为子节点。
 */
export async function loadHarnessExecutionTraceForAgentCall(tenantId: string, callId: string) {
  const [root] = await db
    .select({
      callId: agentCallTable.id,
      parentInvocationId: agentCallTable.parentInvocationId,
      turnId: invocationTable.turnId,
      threadId: invocationTable.threadId,
      invocationState: invocationTable.executionState,
      invocationKind: invocationTable.invocationKind,
      outputItemId: invocationTable.outputItemId,
      invocationStartedAt: invocationTable.startedAt,
      invocationFinishedAt: invocationTable.finishedAt,
      invocationErrorCode: invocationTable.errorCode,
    })
    .from(agentCallTable)
    .innerJoin(
      invocationTable,
      and(
        eq(invocationTable.id, agentCallTable.parentInvocationId),
        eq(invocationTable.tenantId, agentCallTable.tenantId),
      ),
    )
    .where(and(eq(agentCallTable.tenantId, tenantId), eq(agentCallTable.id, callId)))
    .limit(1);
  if (!root || !root.turnId || !root.threadId) return null;

  const [turnRows, eventRows, callRows, capabilityRows, toolRows, finalRows] = await Promise.all([
    db
      .select({
        id: turnTable.id,
        sequence: turnTable.turnSequence,
        state: turnTable.turnState,
        agentId: turnTable.preferredAgentId,
        agentUseMode: turnTable.agentUseMode,
      })
      .from(turnTable)
      .where(and(eq(turnTable.id, root.turnId), eq(turnTable.threadId, root.threadId)))
      .limit(1),
    db
      .select({
        eventId: threadEventTable.id,
        eventSequence: threadEventTable.eventSequence,
        eventType: threadEventTable.eventType,
        payload: threadEventTable.payloadJson,
        correlationId: threadEventTable.correlationId,
        occurredAt: threadEventTable.occurredAt,
      })
      .from(threadEventTable)
      .where(
        and(
          eq(threadEventTable.threadId, root.threadId),
          eq(threadEventTable.invocationId, root.parentInvocationId),
        ),
      )
      .orderBy(asc(threadEventTable.eventSequence)),
    db
      .select({
        callId: agentCallTable.id,
        agentId: agentCallTable.agentId,
        actionId: agentCallTable.sourceRef,
        state: agentCallTable.state,
        taskId: agentCallAttemptTable.externalTaskRef,
        attemptNo: agentCallAttemptTable.attemptNo,
        contextId: agentSessionBindingTable.externalContextRef,
        errorCode: agentCallTable.errorCode,
        createdAt: agentCallTable.createdAt,
        startedAt: agentCallTable.startedAt,
        waitingAt: agentCallTable.waitingAt,
        finishedAt: agentCallTable.finishedAt,
        agentRevisionId: agentCallBindingTable.agentRevisionId,
        routeRevisionId: agentCallBindingTable.routeRevisionId,
        policyRevisionId: agentCallBindingTable.policyRevisionId,
        governanceRevisionId: agentCallBindingTable.governanceConfigRevisionId,
      })
      .from(agentCallTable)
      .leftJoin(
        agentCallBindingTable,
        and(
          eq(agentCallBindingTable.callId, agentCallTable.id),
          eq(agentCallBindingTable.tenantId, agentCallTable.tenantId),
        ),
      )
      .leftJoin(
        agentCallAttemptTable,
        and(
          eq(agentCallAttemptTable.callId, agentCallTable.id),
          eq(agentCallAttemptTable.tenantId, agentCallTable.tenantId),
        ),
      )
      .leftJoin(
        agentSessionBindingTable,
        and(
          eq(agentSessionBindingTable.id, agentCallTable.agentSessionBindingId),
          eq(agentSessionBindingTable.tenantId, agentCallTable.tenantId),
        ),
      )
      .where(
        and(
          eq(agentCallTable.tenantId, tenantId),
          eq(agentCallTable.parentInvocationId, root.parentInvocationId),
        ),
      )
      .orderBy(
        asc(agentCallTable.createdAt),
        asc(agentCallTable.id),
        desc(agentCallAttemptTable.attemptNo),
      ),
    db
      .select()
      .from(capabilityUseTable)
      .where(
        and(
          eq(capabilityUseTable.tenantId, tenantId),
          eq(capabilityUseTable.invocationId, root.parentInvocationId),
        ),
      )
      .orderBy(asc(capabilityUseTable.firstUsedAt), asc(capabilityUseTable.id)),
    db
      .select()
      .from(toolCallTable)
      .where(
        and(
          eq(toolCallTable.tenantId, tenantId),
          eq(toolCallTable.invocationId, root.parentInvocationId),
        ),
      )
      .orderBy(asc(toolCallTable.callSequence), asc(toolCallTable.id)),
    root.outputItemId
      ? db
          .select({
            id: threadItemTable.id,
            state: threadItemTable.itemState,
            createdAt: threadItemTable.createdAt,
          })
          .from(threadItemTable)
          .where(
            and(
              eq(threadItemTable.id, root.outputItemId),
              eq(threadItemTable.threadId, root.threadId),
              eq(threadItemTable.itemType, "assistant_message"),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);

  const turn = turnRows[0] ?? null;
  const traceId =
    eventRows.find((event) => event.correlationId)?.correlationId ?? root.parentInvocationId;
  const finalItem = finalRows[0] ?? null;

  const currentCallRows = Array.from(
    callRows.reduce((byCall, call) => {
      if (!byCall.has(call.callId)) byCall.set(call.callId, call);
      return byCall;
    }, new Map<string, (typeof callRows)[number]>()),
  ).map(([, call]) => call);

  return {
    trace_id: traceId,
    turn: {
      turn_id: root.turnId,
      turn_sequence: turn?.sequence ?? null,
      state: turn?.state ?? null,
      agent_use:
        turn?.agentUseMode === "preferred" && turn.agentId
          ? { mode: "preferred" as const, agent_id: turn.agentId, source: "user_selected" as const }
          : null,
    },
    parent_invocation: {
      invocation_id: root.parentInvocationId,
      invocation_kind: root.invocationKind,
      state: root.invocationState,
      started_at: root.invocationStartedAt?.toISOString() ?? null,
      finished_at: root.invocationFinishedAt?.toISOString() ?? null,
      error_code: root.invocationErrorCode,
    },
    harness_actions: eventRows
      .filter((event) => HARNESS_ACTION_EVENT_TYPES.has(event.eventType))
      .map((event) => {
        const payload = record(event.payload);
        return {
          event_id: event.eventId,
          event_sequence: event.eventSequence,
          action_id: typeof payload.action_id === "string" ? payload.action_id : null,
          step_no: typeof payload.step_no === "number" ? payload.step_no : null,
          action_type: typeof payload.action_type === "string" ? payload.action_type : null,
          purpose_code: typeof payload.purpose_code === "string" ? payload.purpose_code : null,
          state: typeof payload.state === "string" ? payload.state : null,
          authority_ref: typeof payload.authority_ref === "string" ? payload.authority_ref : null,
          error_code: typeof payload.error_code === "string" ? payload.error_code : null,
          occurred_at: event.occurredAt.toISOString(),
        };
      }),
    agent_calls: currentCallRows.map((call) => ({
      call_id: call.callId,
      parent_invocation_id: root.parentInvocationId,
      action_id: call.actionId,
      agent_id: call.agentId,
      state: call.state,
      a2a_task_id: call.taskId,
      a2a_context_id: call.contextId,
      exact_binding: call.agentRevisionId
        ? {
            agent_revision_id: call.agentRevisionId,
            route_revision_id: call.routeRevisionId,
            policy_revision_id: call.policyRevisionId,
            governance_revision_id: call.governanceRevisionId,
          }
        : null,
      error_code: call.errorCode,
      created_at: call.createdAt.toISOString(),
      started_at: call.startedAt?.toISOString() ?? null,
      waiting_at: call.waitingAt?.toISOString() ?? null,
      finished_at: call.finishedAt?.toISOString() ?? null,
    })),
    capability_uses: capabilityRows.map((use) => ({
      capability_use_id: use.id,
      capability_type: use.capabilityType,
      capability_id: use.capabilityId,
      revision_id: use.revisionId,
      source_type: use.sourceType,
      source_ref: use.sourceRef,
      selection_reason_code: use.selectionReasonCode,
      first_used_at: use.firstUsedAt.toISOString(),
    })),
    tool_calls: toolRows.map((call) => ({
      call_id: call.id,
      tool_id: call.toolId,
      tool_schema_revision_id: call.toolSchemaRevisionId,
      state: call.callState,
      started_at: call.startedAt?.toISOString() ?? null,
      finished_at: call.finishedAt?.toISOString() ?? null,
      error_code: call.errorCode,
    })),
    final_response: finalItem
      ? {
          item_id: finalItem.id,
          state: finalItem.state,
          created_at: finalItem.createdAt.toISOString(),
        }
      : null,
  };
}
