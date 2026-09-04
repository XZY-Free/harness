/**
 * AgentCall 唯一应用级状态转换入口。
 *
 * 领域判断保持纯函数；持久化、Attempt/Session 映射、Ingress 与 Continuation 原子写入
 * 统一委托给 persistence 层。生产调用方不得直接更新 AgentCall.state。
 */
export {
  decideAgentCallTransition,
  type AgentCallContinuationKind,
  type AgentCallTransitionDecision,
  type AgentCallTransitionInput,
} from "@/lib/agents/calls/domain/agent-call-transition";
import {
  type AgentCallTransitionResult,
  type ApplyAgentCallTransitionCommand,
  applyAgentCallTransition,
} from "@/lib/agents/calls/persistence/apply-agent-call-transition";
import { db } from "@/lib/db/client";

export type TransitionAgentCallCommand = ApplyAgentCallTransitionCommand;
export type { AgentCallTransitionResult };

/** 每次调用只处理一个转换，并在一个数据库事务内提交全部事实。 */
export async function transitionAgentCall(
  command: TransitionAgentCallCommand,
): Promise<AgentCallTransitionResult> {
  return db.transaction((tx) => applyAgentCallTransition(tx, command));
}
