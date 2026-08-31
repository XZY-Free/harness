import { db } from "@/lib/db/client";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
import { agentTable } from "@/lib/persistence/schema/agents";
import type { Turn } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { and, asc, eq, inArray } from "drizzle-orm";

export interface AgentUseProjection {
  mode: "preferred";
  agent_id: string;
  display_name: string | null;
}

export interface AgentCallSummaryProjection {
  call_id: string;
  parent_invocation_id: string;
  agent_id: string;
  display_name: string | null;
  action_id: string | null;
  state: string;
  created_at: string;
  started_at: string | null;
  waiting_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error_code: string | null;
}

export interface ActualAgentCallsProjection {
  count: number;
  active_call_id: string | null;
  last_state: string | null;
  selected_agent_called: boolean;
  selected_but_unused: boolean;
  calls: AgentCallSummaryProjection[];
}

export interface TurnAgentActivityProjection {
  agent_use: AgentUseProjection | null;
  actual_agent_calls: ActualAgentCallsProjection;
}

const ACTIVE_STATES = new Set(["queued", "running", "waiting_user"]);

/**
 * 一次读取多个 Turn 的 Directive 与实际 AgentCall 投影。
 * Directive 来自不可变 Turn 字段；actual calls 只来自 AgentCall，不用模型文本猜测。
 */
export async function loadTurnAgentActivity(
  tenantId: string,
  turns: readonly Pick<Turn, "id" | "preferredAgentId" | "agentUseMode">[],
): Promise<Map<string, TurnAgentActivityProjection>> {
  if (turns.length === 0) return new Map();

  const selectedAgentIds = Array.from(
    new Set(turns.flatMap((turn) => (turn.preferredAgentId ? [turn.preferredAgentId] : []))),
  );
  const selectedAgents =
    selectedAgentIds.length > 0
      ? await db
          .select({ id: agentTable.id, displayName: agentTable.displayName })
          .from(agentTable)
          .where(and(eq(agentTable.tenantId, tenantId), inArray(agentTable.id, selectedAgentIds)))
      : [];
  const selectedNames = new Map(selectedAgents.map((agent) => [agent.id, agent.displayName]));

  const turnIds = turns.map((turn) => turn.id);
  const rows = await db
    .select({
      turnId: invocationTable.turnId,
      callId: agentCallTable.id,
      parentInvocationId: agentCallTable.parentInvocationId,
      agentId: agentCallTable.agentId,
      displayName: agentTable.displayName,
      actionId: agentCallTable.sourceRef,
      state: agentCallTable.state,
      createdAt: agentCallTable.createdAt,
      startedAt: agentCallTable.startedAt,
      waitingAt: agentCallTable.waitingAt,
      finishedAt: agentCallTable.finishedAt,
      errorCode: agentCallTable.errorCode,
    })
    .from(agentCallTable)
    .innerJoin(
      invocationTable,
      and(
        eq(invocationTable.id, agentCallTable.parentInvocationId),
        eq(invocationTable.tenantId, agentCallTable.tenantId),
      ),
    )
    .leftJoin(
      agentTable,
      and(eq(agentTable.id, agentCallTable.agentId), eq(agentTable.tenantId, tenantId)),
    )
    .where(and(eq(agentCallTable.tenantId, tenantId), inArray(invocationTable.turnId, turnIds)))
    .orderBy(asc(agentCallTable.createdAt), asc(agentCallTable.id));

  const callsByTurn = new Map<string, AgentCallSummaryProjection[]>();
  for (const row of rows) {
    if (!row.turnId) continue;
    const durationMs =
      row.startedAt && row.finishedAt
        ? Math.max(0, row.finishedAt.getTime() - row.startedAt.getTime())
        : null;
    const call: AgentCallSummaryProjection = {
      call_id: row.callId,
      parent_invocation_id: row.parentInvocationId,
      agent_id: row.agentId,
      display_name: row.displayName,
      action_id: row.actionId,
      state: row.state,
      created_at: row.createdAt.toISOString(),
      started_at: row.startedAt?.toISOString() ?? null,
      waiting_at: row.waitingAt?.toISOString() ?? null,
      finished_at: row.finishedAt?.toISOString() ?? null,
      duration_ms: durationMs,
      error_code: row.errorCode,
    };
    callsByTurn.set(row.turnId, [...(callsByTurn.get(row.turnId) ?? []), call]);
  }

  return new Map(
    turns.map((turn) => {
      const calls = callsByTurn.get(turn.id) ?? [];
      const agentUse =
        turn.agentUseMode === "preferred" && turn.preferredAgentId
          ? {
              mode: "preferred" as const,
              agent_id: turn.preferredAgentId,
              display_name: selectedNames.get(turn.preferredAgentId) ?? null,
            }
          : null;
      const selectedAgentCalled = Boolean(
        agentUse && calls.some((call) => call.agent_id === agentUse.agent_id),
      );
      const active = calls.findLast((call) => ACTIVE_STATES.has(call.state)) ?? null;
      const last = calls.at(-1) ?? null;
      return [
        turn.id,
        {
          agent_use: agentUse,
          actual_agent_calls: {
            count: calls.length,
            active_call_id: active?.call_id ?? null,
            last_state: last?.state ?? null,
            selected_agent_called: selectedAgentCalled,
            selected_but_unused: Boolean(agentUse && !selectedAgentCalled),
            calls,
          },
        },
      ];
    }),
  );
}

export function emptyTurnAgentActivity(): TurnAgentActivityProjection {
  return {
    agent_use: null,
    actual_agent_calls: {
      count: 0,
      active_call_id: null,
      last_state: null,
      selected_agent_called: false,
      selected_but_unused: false,
      calls: [],
    },
  };
}
