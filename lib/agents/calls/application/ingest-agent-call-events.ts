import {
  type IngestAgentCallEventsInput,
  type IngestAgentCallEventsResult,
  applyAgentCallEvent,
} from "@/lib/agents/calls/persistence/apply-agent-call-events";
/**
 * ingestAgentCallEvents — AgentCallEventIngress 原子应用服务。
 *
 * 批次仅作传输优化；每个候选事件独立开启事务并重新读取 AgentCall version。
 * 状态、Ingress 结果和 Continuation producer 在单事件事务中提交，不在这里同步执行父 Loop。
 */
import { db } from "@/lib/db/client";

export type { IngestAgentCallEventsInput, IngestAgentCallEventsResult };

export async function ingestAgentCallEvents(
  input: IngestAgentCallEventsInput,
): Promise<IngestAgentCallEventsResult> {
  const results = [];
  for (const event of input.events) {
    results.push(
      await db.transaction((tx) =>
        applyAgentCallEvent(tx, {
          tenantId: input.tenantId,
          callId: input.callId,
          event,
        }),
      ),
    );
  }
  const last = results.at(-1);
  if (!last) throw new Error("AgentCall ingress 批次不得为空");
  const applied = results.filter((result) => result.outcome === "applied").length;
  const idempotent = results.filter((result) => result.outcome === "idempotent").length;
  const rejected = results.filter((result) => result.outcome === "rejected").length;
  const failedRetryable = results.filter((result) => result.outcome === "failed_retryable").length;
  return {
    applied,
    idempotent,
    rejected,
    failedRetryable,
    accepted: applied,
    duplicate: idempotent,
    finalState: last.finalState,
    results,
  };
}
