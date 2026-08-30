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
 * 绝不触碰 parent Invocation / RuntimeSessionBinding / RuntimeEventIngress /
 * Turn / ThreadItems。任何事件非法/不匹配 → 整批回滚。
 */
import { db } from "@/lib/db/client";

export type { IngestAgentCallEventsInput, IngestAgentCallEventsResult };

export async function ingestAgentCallEvents(
  input: IngestAgentCallEventsInput,
): Promise<IngestAgentCallEventsResult> {
  return db.transaction(async (tx) => {
    return applyAgentCallEvents(tx, input);
  });
}
