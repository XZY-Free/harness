/**
 * createAgentCall — 创建 AgentCall 子执行（应用服务）。
 *
 * 专题01 冻结架构：AgentCall 是 Parent Harness Invocation 内部的 Agent 能力调用。
 * 创建时：
 * 1. 冻结 AgentCallBinding（不可变证据）。
 * 2. 持久化 AgentCall + Binding + 初始 Attempt(1)。
 * 3. 写 CapabilityUse(type=agent, sourceType=user_selected)（复用现有 CapabilityUse 账本，
 *    不新建第二套 AgentUse 日志）。
 *
 * 幂等：parentInvocationId + logicalCallKey；同一 Invocation 重试不重复创建远端 Task。
 */
import { randomUUID } from "node:crypto";
import type { AgentCall, AgentCallSourceType } from "@/lib/agents/calls/domain/agent-call";
import {
  type AgentCallBindingConfigInput,
  computeAgentCallBindingHash,
} from "@/lib/agents/calls/domain/agent-call-binding";
import type { AgentCallStore } from "@/lib/agents/calls/persistence/agent-call-store";
import { recordCapabilityUse } from "@/lib/capability/capability-use-queries";

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
  /** 冻结的不可变证据。 */
  binding: AgentCallBindingConfigInput;
  now?: Date;
}

export interface CreateAgentCallResult {
  call: AgentCall;
  created: boolean;
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
    const bindingHash = computeAgentCallBindingHash(command.binding);
    const { call, created } = await dependencies.store.createIdempotent({
      id: randomUUID(),
      tenantId: command.tenantId,
      parentInvocationId: command.parentInvocationId,
      agentId: command.agentId,
      agentRevisionId: command.agentRevisionId,
      sourceType: command.sourceType,
      sourceRef: command.sourceRef,
      logicalCallKey: command.logicalCallKey,
      binding: command.binding,
      bindingHash,
      createdAt: now,
    });

    if (created) {
      // 复用现有 CapabilityUse(type=agent) 账本 — 不新建第二套 AgentUse 日志。
      await recordCapabilityUse({
        tenantId: command.tenantId,
        invocationId: command.parentInvocationId,
        capabilityType: "agent",
        capabilityId: command.agentId,
        revisionId: command.agentRevisionId,
        sourceType: command.sourceType,
        sourceRef: command.sourceRef ?? null,
        selectionReasonCode: command.sourceType === "user_selected" ? "explicit_select" : undefined,
      });
    }

    return { call, created };
  };
}
