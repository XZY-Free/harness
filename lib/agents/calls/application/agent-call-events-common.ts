import { transitionAgentCall } from "@/lib/agents/calls/application/agent-call-transition";
/**
 * AgentCall 子域终态事件持久化共享辅助。
 *
 * startAgentCall / resumeAgentCall / cancelAgentCall 共用的 durable 序列推进与
 * 子域失败命令。全部只落 AgentCall 子域事实，绝不触碰 parent Invocation 终态。
 *
 * 事实源：
 * - docs/architecture/agent-control-plane.md
 * - docs/architecture/api-and-events.md
 * - 冻结架构：AgentCall 是 child fact；AgentCall completed ≠ parent Invocation completed。
 */
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
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

/** 把本地失败/取消交给唯一转换入口；不得伪造成供应方 ingress 事件。 */
export async function synthesizeAgentCallTerminalEvent(
  callId: string,
  tenantId: string,
  type: "call.failed" | "call.cancelled" | "call.lost",
  code: string,
  summary: string,
): Promise<void> {
  await transitionAgentCall({
    tenantId,
    callId,
    input: type,
    authority: type === "call.cancelled" ? "local_cancel" : "local_failure",
    errorCode: code,
    errorSummary: summary,
  });
}

/** 读取 AgentCallStore（re-export 供 resume/cancel 使用，保持单一 store 引用点）。 */
export const agentCallStore = mysqlAgentCallStore;
