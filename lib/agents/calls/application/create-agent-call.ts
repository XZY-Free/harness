/**
 * createAgentCall — 创建 AgentCall 子执行（应用服务）。
 *
 * 专题01 冻结架构：AgentCall 是 Parent Harness Invocation 内部的 Agent 能力调用。
 * 创建时：
 * 1. 把 candidate 交给 Store 在单一事务中锁定并最终验证全部 Authority。
 * 2. 原子持久化 AgentCall + Binding + 初始 Attempt(1)。
 * 3. 同事务写 CapabilityUse(type=agent)（复用现有 CapabilityUse 账本，
 *    不新建第二套 AgentUse 日志）。
 *
 * 幂等：parentInvocationId + logicalCallKey；同一 Invocation 重试不重复创建远端 Task。
 */
import { randomUUID } from "node:crypto";
import type { AgentCall, AgentCallSourceType } from "@/lib/agents/calls/domain/agent-call";
import {
  type AgentCallBindingCandidate,
  computeAgentCallBindingHash,
} from "@/lib/agents/calls/domain/agent-call-binding";
import type { AgentCallStore } from "@/lib/agents/calls/persistence/agent-call-store";

export interface CreateAgentCallCommand {
  tenantId: string;
  parentInvocationId: string;
  agentId: string;
  agentRevisionId: string;
  sourceType: AgentCallSourceType;
  /** user_selected → Turn.id。 */
  sourceRef: string | null;
  /** 业务幂等键（如 required-agent:<turnId>:<agentId>）。 */
  logicalCallKey: string | null;
  /** 待最终事务验证的候选证据。 */
  bindingCandidate: AgentCallBindingCandidate;
  now?: Date;
}

export interface CreateAgentCallResult {
  call: AgentCall;
  status: "created" | "replayed";
}

export function createCreateAgentCall(dependencies: {
  store: AgentCallStore;
  now?: () => Date;
}) {
  const clock = dependencies.now ?? (() => new Date());
  return async function createAgentCall(
    command: CreateAgentCallCommand,
  ): Promise<CreateAgentCallResult> {
    const now = clock();
    const bindingHash = computeAgentCallBindingHash(command.bindingCandidate);
    const { call, status } = await dependencies.store.finalizeAgentCall({
      id: randomUUID(),
      tenantId: command.tenantId,
      parentInvocationId: command.parentInvocationId,
      agentId: command.agentId,
      agentRevisionId: command.agentRevisionId,
      sourceType: command.sourceType,
      sourceRef: command.sourceRef,
      logicalCallKey: command.logicalCallKey,
      bindingCandidate: command.bindingCandidate,
      bindingHash,
      createdAt: now,
    });

    return { call, status };
  };
}
