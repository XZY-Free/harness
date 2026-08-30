import { ingestAgentCallEvents } from "@/lib/agents/calls/application/ingest-agent-call-events";
/**
 * AgentCall 子域终态事件持久化共享辅助。
 *
 * startAgentCall / resumeAgentCall / cancelAgentCall 共用的 durable 序列推进与
 * 子域终态合成。全部只落 AgentCall 子域事实，绝不触碰 parent Invocation 终态。
 *
 * 事实源：
 * - docs/architecture/agent-control-plane.md
 * - docs/architecture/api-and-events.md
 * - 冻结架构：AgentCall 是 child fact；AgentCall completed ≠ parent Invocation completed。
 */
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import type { AgentCallCandidateEvent } from "@/lib/agents/calls/transport/agent-transport";
import { db } from "@/lib/db/client";
import { agentCallEventIngressTable } from "@/lib/persistence/schema/agent-calls";
import { and, eq, max } from "drizzle-orm";

/** 该 call durable ingress 的 max producer_sequence + 1（避免序列冲突）。 */
export async function nextAgentCallProducerSequence(
  callId: string,
  tenantId: string,
): Promise<number> {
  const [row] = await db
    .select({ m: max(agentCallEventIngressTable.producerSequence) })
    .from(agentCallEventIngressTable)
    .where(
      and(
        eq(agentCallEventIngressTable.callId, callId),
        eq(agentCallEventIngressTable.tenantId, tenantId),
      ),
    );
  return Number(row?.m ?? 0) + 1;
}

/** 合成子域终态事件（call.failed / call.cancelled / call.lost）并经 ingress 原子落库。 */
export async function synthesizeAgentCallTerminalEvent(
  callId: string,
  tenantId: string,
  type: "call.failed" | "call.cancelled" | "call.lost",
  code: string,
  summary: string,
): Promise<void> {
  const sequence = await nextAgentCallProducerSequence(callId, tenantId);
  const event: AgentCallCandidateEvent = {
    producer_event_id: `a2a:${callId}:${type}:${sequence}`,
    producer_sequence: sequence,
    schema_version: 1,
    type,
    payload: { source: "a2a", error: { code, message: summary } },
  };
  await ingestAgentCallEvents({ tenantId, callId, events: [event] });
}

/** 读取 AgentCallStore（re-export 供 resume/cancel 使用，保持单一 store 引用点）。 */
export const agentCallStore = mysqlAgentCallStore;
