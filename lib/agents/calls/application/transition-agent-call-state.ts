/**
 * transitionAgentCallState — AgentCall 状态转移应用服务。
 *
 * 先由 domain 状态机校验合法性（assertAgentCallTransition），再交给 Store 原子 CAS。
 * AgentCall 状态独立于 parent Invocation 状态：
 * - AgentCall completed ≠ parent Invocation 自动 completed。
 * - AgentCall failed ≠ 自动修改 parent Invocation。
 * 本服务绝不触碰 parent Invocation 表。
 */
import {
  type AgentCall,
  type AgentCallState,
  assertAgentCallTransition,
} from "@/lib/agents/calls/domain/agent-call";
import type {
  AgentCallStore,
  UpdateAgentCallStateInput,
} from "@/lib/agents/calls/persistence/agent-call-store";

export interface TransitionAgentCallStateCommand {
  callId: string;
  tenantId: string;
  from: AgentCallState;
  to: AgentCallState;
  /** 进入终态时填 finishedAt；waiting_user 填 waitingAt；running 填 startedAt。 */
  lifecycle?: UpdateAgentCallStateInput["lifecycle"];
  agentSessionBindingId?: string | null;
  resultText?: string | null;
  resultJson?: unknown;
  resultDigest?: string | null;
  errorCode?: string | null;
  errorSummary?: string | null;
  now?: Date;
}

export function createTransitionAgentCallState(dependencies: {
  store: AgentCallStore;
  now?: () => Date;
}) {
  const clock = dependencies.now ?? (() => new Date());
  return async function transitionAgentCallState(
    command: TransitionAgentCallStateCommand,
  ): Promise<AgentCall> {
    // domain 状态机合法性校验（fail-closed，非法转移直接抛）。
    assertAgentCallTransition(command.callId, command.from, command.to);
    const now = clock();
    const lifecycle =
      command.lifecycle ??
      (command.to === "completed" ||
      command.to === "failed" ||
      command.to === "cancelled" ||
      command.to === "lost"
        ? { finishedAt: now }
        : command.to === "waiting_user"
          ? { waitingAt: now }
          : command.to === "running"
            ? { startedAt: now }
            : {});
    return dependencies.store.updateState({
      callId: command.callId,
      tenantId: command.tenantId,
      from: command.from,
      to: command.to,
      now,
      lifecycle,
      agentSessionBindingId: command.agentSessionBindingId,
      resultText: command.resultText,
      resultJson: command.resultJson,
      resultDigest: command.resultDigest,
      errorCode: command.errorCode,
      errorSummary: command.errorSummary,
    });
  };
}
