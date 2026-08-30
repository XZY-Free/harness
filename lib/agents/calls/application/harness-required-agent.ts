import { createCreateAgentCall } from "@/lib/agents/calls/application/create-agent-call";
import {
  RequiredAgentUnavailableError,
  type ResolvedRequiredAgentBinding,
  resolveRequiredAgentBinding,
} from "@/lib/agents/calls/application/resolve-agent-call-binding";
import { startAgentCall } from "@/lib/agents/calls/application/start-agent-call";
import {
  type AgentCallDisposition,
  toAgentCallDisposition,
} from "@/lib/agents/calls/domain/agent-call";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
/**
 * invokeRequiredAgent — Harness Loop 消费 required Agent capability。
 *
 * 正式调用链：
 *   Harness Loop → AgentCall application → resolve agent target → exact AgentCallBinding
 *   → AgentCall → AgentTransport/A2A → Agent Result → Harness Loop。
 *
 * 本服务是「Harness Loop → AgentCall」的确定性编排：
 * 1. 解析 Agent Route（target={kind:"agent", agentId}）；unresolved → required 无法满足 → fail closed。
 * 2. 读取 exact AgentContractSnapshot（capabilityDigest + protocol 事实，权威）。
 * 3. 装配 AgentCallBinding candidate，由 createAgentCall 最终事务冻结
 *    （endpoint/identity/credential/network 直接来自 RouteResolution）。
 * 4. createAgentCall（sourceType=user_selected，sourceRef=Turn.id，幂等 logicalCallKey）。
 * 5. startAgentCall（A2A）。
 * 6. 只回读一次当前 durable disposition，并交回 Harness。
 *
 * 结果归一化：
 * - terminal → completed 结果或真实 failed/cancelled/lost 终态。
 * - pending → queued/running + SAME callId，Harness 不得 fallback 到模型。
 * - waiting_user → 返回 call/task/context，由 Harness Loop 转 parent waiting_user，resume 复用 SAME AgentCall。
 *
 * 关键不变量：
 * - AgentCall 是 child fact；AgentCall completed ≠ parent Invocation completed。
 * - A2A taskId → AgentCall.externalTaskRef；contextId → AgentSessionBinding.externalContextRef。
 * - parent ExecutionBinding 保持 runtime-only；Agent evidence 只在 AgentCallBinding。
 */
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";

// re-export 保持 Harness 编排入口的稳定错误类型入口。
// harness-required-agent 作为 Harness Loop 编排入口的既有类型入口不变。
export { RequiredAgentUnavailableError } from "@/lib/agents/calls/application/resolve-agent-call-binding";

export type HarnessRequiredAgentOutcome = AgentCallDisposition;

export interface InvokeRequiredAgentParams {
  tenantId: string;
  parentInvocationId: string;
  threadId: string;
  turnId: string;
  /** capability_requirements 中的 capability_id（= Agent.id）。 */
  agentId: string;
  /** 用户输入文本（A2A start message）。 */
  input: string;
  /** 可信调用主体。 */
  executionSubject: ExecutionSubject | null;
  /** Agent target Route Resolver（唯一 Route Authority）。 */
  resolveRoute: RouteResolver;
  routeScopeKey?: string;
}

const createAgentCall = createCreateAgentCall({ store: mysqlAgentCallStore });

/**
 * 解析 required Agent 路由，创建并启动 AgentCall，然后映射一次 durable disposition。
 */
export async function invokeRequiredAgent(
  params: InvokeRequiredAgentParams,
): Promise<HarnessRequiredAgentOutcome> {
  const now = new Date();
  const { tenantId, parentInvocationId, threadId, turnId, agentId, input } = params;

  // 1-3. 解析 Agent Route（唯一 Route Authority）+ 读取 exact ContractSnapshot +
  //       装配 AgentCallBinding candidate — Harness/Gateway 共享解析链。
  const resolved: ResolvedRequiredAgentBinding = await resolveRequiredAgentBinding({
    tenantId,
    agentId,
    resolveRoute: params.resolveRoute,
    routeScopeKey: params.routeScopeKey ?? "default",
    businessKey: { threadId },
  });
  const binding = resolved.bindingCandidate;

  // 4. createAgentCall（幂等 logicalCallKey：required-agent:<turnId>:<agentId>）。
  const logicalCallKey = `required-agent:${turnId}:${agentId}`;
  const { call } = await createAgentCall({
    tenantId,
    parentInvocationId,
    agentId,
    agentRevisionId: resolved.agentRevisionId,
    sourceType: "user_selected",
    sourceRef: turnId,
    logicalCallKey,
    bindingCandidate: binding,
    now,
  });
  const callId = call.id;

  // 5. startAgentCall（A2A）— detached 流经 AgentCallEventIngress 持久化终态。
  const currentCall = await startAgentCall({
    tenantId,
    callId,
    input,
    contextEnvironment: {
      tenantId,
      executionSubject: params.executionSubject,
      now,
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
    },
  });

  // 6. 一次映射当前 durable disposition；不等待、不推进状态、不制造 timeout failure。
  return toAgentCallDisposition(currentCall);
}
