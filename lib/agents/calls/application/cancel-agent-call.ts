/**
 * cancelAgentCall — 取消既有 AgentCall 子执行。
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
 * - docs/architecture/agent-control-plane.md
 * - docs/architecture/api-and-events.md
 * - 冻结架构：AgentCall 与 parent Invocation 各自有状态 Authority。
 */
import { agentCallStore } from "@/lib/agents/calls/application/agent-call-events-common";
import { synthesizeAgentCallTerminalEvent } from "@/lib/agents/calls/application/agent-call-events-common";
import type { AgentCall } from "@/lib/agents/calls/domain/agent-call";
import { assertAgentCallTransition } from "@/lib/agents/calls/domain/agent-call";
import { AgentCallStateConcurrencyError } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import {
  createAgentCallTransport,
  loadAgentCallContract,
  resolveAgentCallOutboundAuth,
} from "@/lib/agents/calls/transport/agent-call-transport-factory";
import { AgentTransportError } from "@/lib/agents/calls/transport/agent-transport";

/** cancelAgentCall 冻结 API 入参。 */
export interface CancelAgentCallCommand {
  tenantId: string;
  callId: string;
}

export interface CancelAgentCallResult {
  call: AgentCall;
  remoteCancellation: "cancelled" | "unsupported" | "failed" | "already_terminal";
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
export async function cancelAgentCall(
  command: CancelAgentCallCommand,
): Promise<CancelAgentCallResult> {
  const { tenantId, callId } = command;

  // 1. tenant-scoped 加载 existing call + exact binding。
  const call = await agentCallStore.getById({ callId, tenantId });
  if (!call) throw new AgentCallCancelError("AgentCall 不存在", "call_not_found");
  const binding = await agentCallStore.getBinding({ callId, tenantId });
  if (!binding) throw new AgentCallCancelError("AgentCallBinding 不存在", "binding_not_found");

  // 2. 状态校验：只允许 running / waiting_user 取消；已终态幂等返回。
  if (isTerminal(call.state)) return { call, remoteCancellation: "already_terminal" };
  if (!CANCELLABLE_STATES.has(call.state)) {
    throw new AgentCallCancelError(
      `AgentCall 当前状态 ${call.state} 不可取消（期望 running/waiting_user）`,
      "state_invalid",
    );
  }

  // 3. exact frozen Contract cancel=false：不发伪取消，保留 active child 真值。
  const { capabilities } = await loadAgentCallContract(tenantId, callId, {
    agentContractSnapshotId: binding.agentContractSnapshotId,
    agentContractDigest: binding.agentContractDigest,
    agentCapabilityDigest: binding.agentCapabilityDigest,
    agentContextDigest: binding.agentContextDigest,
  });
  if (!capabilities.cancel) {
    return { call, remoteCancellation: "unsupported" };
  }

  // 4. cancel 需要 A2A taskId（externalTaskRef）。
  const taskId = call.currentAttempt?.externalTaskRef;
  if (!taskId) {
    throw new AgentCallCancelError("AgentCall 缺少 externalTaskRef，无法取消", "context_missing");
  }

  // 5. 只按 binding 冻结解析出站凭证。
  const auth = await resolveAgentCallOutboundAuth(tenantId, binding);

  // 6. 构造 transport，能力完全来自冻结 Contract。
  const transport = createAgentCallTransport({
    callId,
    tenantId,
    capabilities,
    eventSink: async () => {},
    streamTimeoutMs: 60_000,
  });

  // 7. cancelCall（A2A tasks/cancel）；失败归一化为子域 call.failed，parent 不变。
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

  // 8. 远端 cancel ack 可能已由原 stream 先写 cancelled；先回读吸收并发终态。
  const afterTransport = await agentCallStore.getById({ callId, tenantId });
  if (!afterTransport) throw new AgentCallCancelError("AgentCall 读取失败", "call_not_found");
  if (afterTransport.state === "cancelled") {
    return { call: afterTransport, remoteCancellation: "cancelled" };
  }
  if (isTerminal(afterTransport.state)) {
    return { call: afterTransport, remoteCancellation: "already_terminal" };
  }

  // 9. 无回传事件的协议 ack：由 cancel 应用 Authority 转为 cancelled。
  assertAgentCallTransition(callId, afterTransport.state, "cancelled");
  try {
    await agentCallStore.updateState({
      callId,
      tenantId,
      from: afterTransport.state,
      to: "cancelled",
      now: new Date(),
      lifecycle: { finishedAt: new Date() },
    });
  } catch (error) {
    if (!(error instanceof AgentCallStateConcurrencyError)) throw error;
    const raced = await agentCallStore.getById({ callId, tenantId });
    if (raced?.state === "cancelled") {
      return { call: raced, remoteCancellation: "cancelled" };
    }
    throw error;
  }

  const updated = await agentCallStore.getById({ callId, tenantId });
  if (!updated) throw new AgentCallCancelError("AgentCall 读取失败", "call_not_found");
  return { call: updated, remoteCancellation: "cancelled" };
}

function isTerminal(state: string): boolean {
  return ["completed", "failed", "cancelled", "lost"].includes(state);
}
