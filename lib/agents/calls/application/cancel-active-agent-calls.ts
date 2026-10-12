import {
  AgentCallCancelError,
  type CancelAgentCallResult,
  cancelAgentCall,
} from "@/lib/agents/calls/application/cancel-agent-call";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { db } from "@/lib/db/client";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
import { and, eq, inArray, lte } from "drizzle-orm";

/**
 * 取消某个父 Invocation 下仍在活动的子 AgentCall。
 *
 * **代际边界（A02 关联问题）**：`parentInvocationId` **不是**代际标识。同一个 Invocation
 * 在接管/换代后会被新的执行者继续运行，它创建的子调用与旧代际的子调用共享同一个
 * `parentInvocationId`。因此"按 parentInvocationId 全量取消"会让一次**针对旧代际**的
 * Interrupt/取消把**后来新代际**创建的子调用一起杀掉。
 *
 * `createdBefore` 就是这条边界：调用方传入"入队该控制命令时"的服务器时间，本函数只取消
 * 该时刻之前创建的子调用。新代际此后创建的子调用不在范围内。
 *
 * 不传 `createdBefore` 表示"取消全部活动子调用"，只应在**整条 Invocation 正在收口**
 * （终态已落地、不会再有新代际）的场景使用。
 */
/**
 * 选出该父 Invocation 下、且落在代际边界内的活动子调用。
 *
 * 与 `cancelActiveAgentCalls` 分开导出，是为了让"代际边界"这条**选择语义**可以在真实
 * 数据上被直接验证，而不必先构造一整套 AgentCall 契约/绑定夹具。
 */
export async function selectActiveAgentCallsForCancellation(params: {
  tenantId: string;
  parentInvocationId: string;
  /** 只选该时刻（含）之前创建的子调用；`datetime(3)` 精度。 */
  createdBefore?: Date;
}): Promise<string[]> {
  const active = await db
    .select({ id: agentCallTable.id })
    .from(agentCallTable)
    .where(
      and(
        eq(agentCallTable.tenantId, params.tenantId),
        eq(agentCallTable.parentInvocationId, params.parentInvocationId),
        inArray(agentCallTable.state, ["queued", "running", "waiting_user"]),
        ...(params.createdBefore ? [lte(agentCallTable.createdAt, params.createdBefore)] : []),
      ),
    );
  return active.map((row) => row.id);
}

export async function cancelActiveAgentCalls(params: {
  tenantId: string;
  parentInvocationId: string;
  /** 只取消该时刻（含）之前创建的子调用；`datetime(3)` 精度。 */
  createdBefore?: Date;
}): Promise<CancelAgentCallResult[]> {
  const active = await selectActiveAgentCallsForCancellation(params);
  const results: CancelAgentCallResult[] = [];
  for (const callId of active) {
    try {
      results.push(await cancelAgentCall({ tenantId: params.tenantId, callId }));
    } catch (error) {
      if (!(error instanceof AgentCallCancelError)) throw error;
      const current = await mysqlAgentCallStore.getById({
        tenantId: params.tenantId,
        callId,
      });
      if (!current) throw error;
      results.push({ call: current, remoteCancellation: "failed" });
    }
  }
  return results;
}
