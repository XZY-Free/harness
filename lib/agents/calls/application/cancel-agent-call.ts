/**
 * cancelAgentCall — 取消既有 AgentCall 子执行（应用服务，专题01 Batch8 · Gateway 收口）。
 *
 * 冻结边界：
 * - 只 tenant-scoped 加载 existing AgentCall + exact AgentCallBinding；endpoint /
 *   credential 来自 binding，绝不读取最新 AgentRevision/Route/Credential。
 * - 只对 running / waiting_user 发起取消（A2A tasks/cancel）。
 * - 取消只把 AgentCall 置为 cancelled（child fact），绝不直接改 parent Invocation/
 *   Turn 终态 —— parent 由 Harness cancel authority 编排。
 * - cancelCall 网络/协议失败 → 合成子域 call.failed（无法取消），parent 不变，由 Harness 收口。
 *
 * 事实源：
 * - 03_代码级实施方案.md §14（Agent cancel）、§16（Gateway）。
 * - 冻结架构：AgentCall 与 parent Invocation 各自有状态 Authority。
 */
import { agentCallStore } from "@/lib/agents/calls/application/agent-call-events-common";
import { synthesizeAgentCallTerminalEvent } from "@/lib/agents/calls/application/agent-call-events-common";
import type { AgentCall } from "@/lib/agents/calls/domain/agent-call";
import { assertAgentCallTransition } from "@/lib/agents/calls/domain/agent-call";
import {
  createAgentCallTransport,
  resolveAgentCallOutboundAuth,
} from "@/lib/agents/calls/transport/agent-call-transport-factory";
import { AgentTransportError } from "@/lib/agents/calls/transport/agent-transport";

/** cancelAgentCall 冻结 API 入参。 */
export interface CancelAgentCallCommand {
  tenantId: string;
  callId: string;
}

/** cancel 失败类别（路由据此映射稳定错误响应）。 */
export class AgentCallCancelError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "call_not_found"
      | "binding_not_found"
      | "state_invalid"
      | "context_missing"
      | "transport",
  ) {
    super(message);
    this.name = "AgentCallCancelError";
  }
}

const CANCELLABLE_STATES = new Set(["running", "waiting_user"]);

/**
 * 取消既有 AgentCall（running / waiting_user → cancelled，A2A tasks/cancel）。
 *
 * 幂等：
 * - call 已 cancelled / 其它终态 → 返回既有 call（不重复 outbound）。
 */
export async function cancelAgentCall(command: CancelAgentCallCommand): Promise<AgentCall> {
  const { tenantId, callId } = command;

  // 1. tenant-scoped 加载 existing call + exact binding。
  const call = await agentCallStore.getById({ callId, tenantId });
  if (!call) throw new AgentCallCancelError("AgentCall 不存在", "call_not_found");
  const binding = await agentCallStore.getBinding({ callId, tenantId });
  if (!binding) throw new AgentCallCancelError("AgentCallBinding 不存在", "binding_not_found");

  // 2. 状态校验：只允许 running / waiting_user 取消；已终态幂等返回。
  if (isTerminal(call.state)) return call;
  if (!CANCELLABLE_STATES.has(call.state)) {
    throw new AgentCallCancelError(
      `AgentCall 当前状态 ${call.state} 不可取消（期望 running/waiting_user）`,
      "state_invalid",
    );
  }

  // 3. cancel 需要 A2A taskId（externalTaskRef）。
  const taskId = call.externalTaskRef;
  if (!taskId) {
    throw new AgentCallCancelError("AgentCall 缺少 externalTaskRef，无法取消", "context_missing");
  }

  // 4. 只按 binding 冻结解析出站凭证。
  const auth = await resolveAgentCallOutboundAuth(tenantId, binding);

  // 5. 构造 transport（cancel 不涉及 context/capabilities；事件走 AgentCallEventIngress）。
  const transport = createAgentCallTransport({
    callId,
    tenantId,
    capabilities: {
      cancel: true,
      resume: false,
      streamingTransport: false,
      inputRequired: false,
    },
    eventSink: async () => {},
    streamTimeoutMs: 60_000,
  });

  // 6. cancelCall（A2A tasks/cancel）；失败归一化为子域 call.failed，parent 不变。
  try {
    await transport.cancelCall({
      callId,
      endpoint: binding.endpointRef,
      auth,
      taskId,
      idempotencyKey: `agentcall:${callId}:cancel`,
    });
  } catch (err) {
    const code =
      err instanceof AgentTransportError
        ? `AGENT_TRANSPORT_${err.kind.toUpperCase()}`
        : "AGENT_CALL_CANCEL_FAILED";
    const summary = err instanceof Error ? err.message : "AgentCall 取消失败";
    await synthesizeAgentCallTerminalEvent(callId, tenantId, "call.failed", code, summary);
    throw new AgentCallCancelError(summary, "transport");
  }

  // 7. 状态转移 → cancelled（domain 校验）。
  assertAgentCallTransition(callId, call.state, "cancelled");
  await agentCallStore.updateState({
    callId,
    tenantId,
    from: call.state,
    to: "cancelled",
    now: new Date(),
    lifecycle: { finishedAt: new Date() },
  });

  const updated = await agentCallStore.getById({ callId, tenantId });
  if (!updated) throw new AgentCallCancelError("AgentCall 读取失败", "call_not_found");
  return updated;
}

function isTerminal(state: string): boolean {
  return ["completed", "failed", "cancelled", "lost"].includes(state);
}
