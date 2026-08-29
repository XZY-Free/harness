import type { AgentCallBinding } from "@/lib/agents/calls/domain/agent-call-binding";
import { createA2AAgentTransport } from "@/lib/agents/calls/transport/a2a/a2a-client";
import {
  type AgentBackgroundFailureHandler,
  type AgentCallEventSink,
  type AgentCallTransportAuth,
  AgentTransportError,
} from "@/lib/agents/calls/transport/agent-transport";
import type {
  ContextNecessity,
  InvocationContextContract,
} from "@/lib/agents/domain/public-agent-contract";
/**
 * AgentCall 执行共享设施（专题01 Batch8 · Gateway 收口）。
 *
 * startAgentCall / resumeAgentCall / cancelAgentCall 共用的 transport 构造与
 * context 装配辅助。职责边界：
 * - 只按 AgentCallBinding 冻结的事实（endpoint/credential/protocol/contract）构造出站；
 * - 不触碰 parent Invocation / RuntimeSessionBinding / RuntimeEventIngress；
 * - 不透出 Agent endpoint secret / credential 原文给上层调用方。
 *
 * 事实源：
 * - 03_代码级实施方案.md §11（AgentCall 域）、§12（搬迁 A2A）、§16（Gateway）。
 * - 冻结架构：Agent 是 Harness 可调用能力，AgentCall 是 child fact。
 */
import { mysqlAgentContractStore } from "@/lib/agents/persistence/agent-contract-store";
import {
  type PlatformContextEnvironment,
  buildInvocationContextBundle,
} from "@/lib/context/enrichment/build-invocation-context-bundle";
import { externalAgentContextPolicyFilter } from "@/lib/context/enrichment/external-agent-context-policy";
import { resolveOutboundCredential } from "@/lib/identity/resolve-outbound-credential";

/** binding 冻结的调用上下文合同 + 快照能力布尔（来自 ContractSnapshot 权威）。 */
export interface LoadedAgentCallContract {
  contract: InvocationContextContract;
  capabilities: {
    cancel: boolean;
    resume: boolean;
    streamingTransport: boolean;
    inputRequired: boolean;
  };
}

/** 从 binding 冻结 snapshot 读取调用上下文合同（exact，不 list latest）。 */
export async function loadAgentCallContract(
  tenantId: string,
  callId: string,
  binding: {
    agentContractSnapshotId: string;
    agentContractDigest: string;
    agentCapabilityDigest: string;
    agentContextDigest: string;
  },
): Promise<LoadedAgentCallContract> {
  const snapshot = await mysqlAgentContractStore.transaction((s) =>
    s.findContractSnapshotById(tenantId, binding.agentContractSnapshotId),
  );
  if (!snapshot) {
    throw new AgentTransportError("protocol_schema", `AgentContractSnapshot 不存在: ${callId}`);
  }
  if (
    snapshot.contractDigest !== binding.agentContractDigest ||
    snapshot.capabilityDigest !== binding.agentCapabilityDigest ||
    snapshot.contextDigest !== binding.agentContextDigest
  ) {
    throw new AgentTransportError(
      "protocol_schema",
      `AgentCallBinding 与 ContractSnapshot digest 不一致: ${callId}`,
    );
  }
  const rows = await mysqlAgentContractStore.transaction((s) =>
    s.listInvocationContexts(tenantId, binding.agentContractSnapshotId),
  );
  const contract: InvocationContextContract = {
    contexts: rows.map((r) => ({
      contextKind: r.key,
      necessity: r.necessity as ContextNecessity,
    })),
  };
  return {
    contract,
    capabilities: {
      cancel: snapshot.cancel,
      resume: snapshot.resume,
      streamingTransport: snapshot.streamingTransport,
      inputRequired: snapshot.inputRequired,
    },
  };
}

/** 从合同 + trusted environment 装配出站公共 Context metadata。 */
export function buildAgentCallContextMetadata(
  contract: InvocationContextContract,
  environment: PlatformContextEnvironment,
): Record<string, unknown> {
  const bundle = buildInvocationContextBundle({
    contract,
    environment,
    policyFilter: externalAgentContextPolicyFilter(),
  });
  const contextMetadata: Record<string, unknown> = {};
  for (const entry of bundle.entries) {
    if (entry.supplied) contextMetadata[entry.contextKind] = entry.value;
  }
  return contextMetadata;
}

/** 只按 binding 冻结 identityMode + credentialRefId 解析出站凭证（secret 短时内存）。 */
export async function resolveAgentCallOutboundAuth(
  tenantId: string,
  binding: Pick<AgentCallBinding, "identityMode" | "credentialRefId">,
): Promise<AgentCallTransportAuth> {
  return resolveOutboundCredential({
    tenantId,
    identityMode: binding.identityMode,
    credentialRefId: binding.credentialRefId,
  });
}

export interface AgentCallTransportDeps {
  callId: string;
  tenantId: string;
  eventSink: AgentCallEventSink;
  onBackgroundFailure?: AgentBackgroundFailureHandler;
  capabilities: LoadedAgentCallContract["capabilities"];
  streamTimeoutMs?: number;
}

/** 构造 A2A AgentTransport（事件只走 AgentCallEventIngress；background 只合成子域 lost）。 */
export function createAgentCallTransport(deps: AgentCallTransportDeps) {
  // AgentCall 域 steer 恒 false；user_action/streaming 由冻结的有效能力投影（fail closed）。
  return createA2AAgentTransport({
    capabilities: {
      cancel: deps.capabilities.cancel,
      resume: deps.capabilities.resume,
      steer: false,
      user_action: deps.capabilities.inputRequired && deps.capabilities.resume,
      streaming: deps.capabilities.streamingTransport,
    },
    eventSink: deps.eventSink,
    onBackgroundFailure: deps.onBackgroundFailure,
    streamTimeoutMs: deps.streamTimeoutMs ?? 60_000,
  });
}
