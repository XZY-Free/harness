import {
  AgentCallCancelError,
  type CancelAgentCallResult,
  cancelAgentCall,
} from "@/lib/agents/calls/application/cancel-agent-call";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { db } from "@/lib/db/client";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
import { and, eq, inArray } from "drizzle-orm";

export async function cancelActiveAgentCalls(params: {
  tenantId: string;
  parentInvocationId: string;
}): Promise<CancelAgentCallResult[]> {
  const active = await db
    .select({ id: agentCallTable.id })
    .from(agentCallTable)
    .where(
      and(
        eq(agentCallTable.tenantId, params.tenantId),
        eq(agentCallTable.parentInvocationId, params.parentInvocationId),
        inArray(agentCallTable.state, ["running", "waiting_user"]),
      ),
    );
  const results: CancelAgentCallResult[] = [];
  for (const call of active) {
    try {
      results.push(await cancelAgentCall({ tenantId: params.tenantId, callId: call.id }));
    } catch (error) {
      if (!(error instanceof AgentCallCancelError)) throw error;
      const current = await mysqlAgentCallStore.getById({
        tenantId: params.tenantId,
        callId: call.id,
      });
      if (!current) throw error;
      results.push({ call: current, remoteCancellation: "failed" });
    }
  }
  return results;
}
