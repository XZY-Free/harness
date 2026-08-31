import {
  type IngestAgentCallEventsInput,
  type IngestAgentCallEventsResult,
  applyAgentCallEvents,
} from "@/lib/agents/calls/persistence/apply-agent-call-events";
/**
 * ingestAgentCallEvents — AgentCallEventIngress 原子应用服务。
 *
 * 包装 applyAgentCallEvents：一个 caller-owned MySQL 事务内原子应用整批 Agent
 * transport 候选事件到 AgentCall 子生命周期。
 *
 * applyAgentCallEvents 事务绝不触碰 Parent；事务提交后，只有 input-required 由显式
 * 应用协调器经 RuntimeEventIngress 创建 UAR 并推进 Parent/Turn waiting_user。
 * A2A mapper 仍无 Parent 生命周期写权限。
 */
import { db } from "@/lib/db/client";
import { logger } from "@/lib/logger";
import { coordinateAgentInputRequired } from "@/lib/runtime/harness-loop/coordinate-agent-input-required";

export type { IngestAgentCallEventsInput, IngestAgentCallEventsResult };

export async function ingestAgentCallEvents(
  input: IngestAgentCallEventsInput,
): Promise<IngestAgentCallEventsResult> {
  const result = await db.transaction(async (tx) => {
    return applyAgentCallEvents(tx, input);
  });
  if (result.finalState === "waiting_user") {
    try {
      await coordinateAgentInputRequired(input.tenantId, input.callId);
    } catch (error) {
      // child waiting_user 已 durable 提交，不能因 Parent 协调暂时失败伪造 child failed。
      // Harness recovery 重放同一 AgentCall 时会再次执行幂等协调。
      logger.warn("Agent input-required Parent 协调暂时失败，等待 Harness recovery", {
        callId: input.callId,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  return result;
}
