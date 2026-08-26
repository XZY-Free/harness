import { getChatModel } from "@/lib/ai/provider";
import { aiConfig } from "@/lib/config";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getTurnById } from "@/lib/conversations/turn-queries";
import { loadFrozenGovernanceConfig } from "@/lib/governance/governance-repository";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { logger } from "@/lib/logger";
import { type RouteResolver, createResolveRoute } from "@/lib/routes/application/resolve-route";
import { createConfiguredRouteResolver } from "@/lib/routes/infrastructure/configured-route-resolver";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import type { HostedModelContext } from "@/lib/runtime/adapters/hosted-adapter";
import {
  type RuntimeTransportAuth,
  resolveOutboundRuntimeAuth,
} from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import type { InProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import { collectModelText } from "@/lib/runtime/model-text-stream";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  findReusableSessionBinding,
  getSessionBindingById,
} from "@/lib/runtime/session-binding-queries";
import { ingressTransientBatch } from "@/lib/runtime/transient-events";
import { createA2ATransport } from "@/lib/runtime/transport/a2a-transport";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { createRuntimeTransportResolver } from "@/lib/runtime/transport/runtime-transport-resolver";
import { streamText } from "ai";

type ModelFn = (message: string, context: HostedModelContext) => Promise<string>;

/** 使用统一解析入口 — Projection 是唯一数据源。 */
const configuredResolver = createConfiguredRouteResolver({
  projectionStore: mysqlRouteEligibilityResolutionStore,
});
const resolveRoute: RouteResolver = async (input) => {
  const result = await configuredResolver({
    tenantId: input.tenantId,
    agentConstraint: input.agentConstraint ?? null,
    routeScopeKey: input.routeScopeKey,
    businessKey: input.businessKey,
    attributes: input.attributes,
    threadDefaultModelRef: input.threadDefaultModelRef,
  });
  return result.outcome;
};

export interface EmployeeTurnDispatchResult {
  dispatched: boolean;
  /** Agent Loop 的后台执行；HTTP 路由不等待它，测试可等待。 */
  completion: Promise<void>;
}

function configuredModelFn(): ModelFn {
  return async (message, context) => {
    if (!aiConfig.apiKey) {
      throw new Error("LLM_API_KEY 未配置");
    }
    const result = streamText({
      model: getChatModel(context.modelRef),
      prompt: message,
      maxOutputTokens: aiConfig.maxOutputTokens || undefined,
    });
    return collectModelText(result.fullStream, context.emitTextDelta);
  };
}

/**
 * 调度员工发起的会话 Turn。
 *
 * 正式热路径（§9.3）：读取 Thread → Resolve 基础 Harness Route（agentConstraint 默认 null，§8.3）
 * → 创建 Invocation → 创建 ExecutionBinding → Runtime Dispatch。
 * 无 Ready Route 时保持 accepted 并返回未调度（热路径不做 Agent-specific Hosted Provisioning，§11.2/§11.5）；
 * 基础 Harness Route 的供应策略由正式控制面初始化。
 */
export async function dispatchEmployeeTurn(params: {
  tenantId: string;
  threadId: string;
  turnId: string;
  modelRef?: string;
  modelFn?: ModelFn;
  /**
   * 调用方显式提供的可选 Agent 控制面约束（§8.3）。
   * 默认 null = 解析基础 Harness Route（§9.3 Employee Turn 热路径）。
   * 调用方可显式传 agent.id 以约束 Agent Route，这是长期正式能力。
   */
  agentConstraint?: string | null;
  /**
   * ExecutionSubject（06 §6）：由调用方（服务端 route 层）从认证 Principal 生成。
   * 禁止从 Turn JSON / 请求体接受 caller 自报 subject；本层不做校验兜底。
   */
  executionSubject?: ExecutionSubject;
}): Promise<EmployeeTurnDispatchResult> {
  const thread = await getThreadById(params.tenantId, params.threadId);
  if (!thread) {
    throw new Error(`Turn 调度失败：会话不存在 (${params.threadId})`);
  }

  // Per-Invocation Agent Selection（05 §2/§3）：requestedAgentId 权威来自 Turn 行，
  // 不是 caller 自报；dispatchEmployeeTurn 调用方无需重复传 agentConstraint。
  const turn = await getTurnById(params.tenantId, params.turnId);
  if (!turn) {
    throw new Error(`Turn 调度失败：Turn 不存在 (${params.turnId})`);
  }
  const requestedAgentId = turn.requestedAgentId ?? params.agentConstraint ?? null;

  // ─── 热路径：查询正式 RouteResolver ──────────────────────────
  const routeOutcome = await resolveRoute({
    tenantId: params.tenantId,
    // 线程不绑定 Agent：Turn 无 selection → 基础 Harness Route（05 §11）；
    // Turn 带 required selection → Agent 约束解析（05 §3）。
    agentConstraint: requestedAgentId,
    routeScopeKey: "default",
    businessKey: { jobId: `employee-turn:${thread.id}` },
    threadDefaultModelRef: thread.defaultModelRef,
  });

  if (routeOutcome.status !== "resolved") {
    // Thread 不绑定 Agent；无 Ready Route 时热路径不发起 Agent-specific Hosted Provisioning。
    // Turn 保持 accepted 并返回未调度，
    // 基础 Harness Route 由正式控制面初始化供应策略。
    return { dispatched: false, completion: Promise.resolve() };
  }

  // ─── 有 Ready Route → 按 protocolType 解析 Transport（04 §3/§10）──────────
  // Dispatcher 不再固定创建 in-process Hosted client；protocolType 真正决定 Transport。
  const runtimeRevisionId = routeOutcome.resolution.runtimeRevisionId;
  const runtimeRevision = await getRuntimeRevisionById(runtimeRevisionId);
  if (!runtimeRevision) {
    throw new Error(`Turn 调度失败：RuntimeRevision 不存在（${runtimeRevisionId}）`);
  }
  const isExternalEndpoint = runtimeRevision.runtimeEvidenceKind === "external_endpoint";
  // managed endpoint/identity configuration（04 §3）：
  // external_endpoint → endpointRef 即外部 endpoint；hosted → in-process 引用。
  const managedEndpoint = isExternalEndpoint ? runtimeRevision.endpointRef : "in-process://hosted";

  // 03 §10：External outbound auth 只能来自唯一 resolver（RuntimeRevision.identityMode +
  // credentialRefId → RuntimeTransportAuth）；Hosted 继续签发内部 Workload Token。
  // 每次网络调用前重新解析（Rotation fail closed，03 §13）。
  const resolveOutboundAuth = (): Promise<RuntimeTransportAuth> =>
    isExternalEndpoint
      ? resolveOutboundRuntimeAuth({
          tenantId: params.tenantId,
          identityMode: runtimeRevision.identityMode,
          credentialRefId: runtimeRevision.credentialRefId,
        })
      : Promise.resolve({
          mode: "workload_token",
          token: issueWorkloadToken({
            type: "runtime",
            tenantId: params.tenantId,
            invocationId: "transport-resolution",
            runtimeRevisionId: runtimeRevision.id,
            audience: "runtime",
            expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
          }),
        });

  const resolveTransport = createRuntimeTransportResolver({
    factories: {
      agent_runtime_protocol: () =>
        createInProcessHostedRuntimeClient({
          modelFn: params.modelFn ?? configuredModelFn(),
          ingressEventBatch: async ({ invocationId, events, producerSequenceStart }) => {
            await ingressEventBatch({
              tenantId: params.tenantId,
              invocationId,
              events,
              producerSequenceStart,
            });
          },
          ingressTransientEventBatch: async ({ invocationId, events, transientSequenceStart }) => {
            await ingressTransientBatch({
              tenantId: params.tenantId,
              invocationId,
              events,
              transientSequenceStart,
            });
          },
        }),
      a2a: () =>
        createA2ATransport({
          eventBatchSink: async ({ invocationId, events, producerSequenceStart }) => {
            await ingressEventBatch({
              tenantId: params.tenantId,
              invocationId,
              events,
              producerSequenceStart,
            });
          },
          resolveRuntimeRefs: async (invocationId) => {
            const invocation = await getInvocationById(params.tenantId, invocationId);
            if (!invocation) return null;
            // A2A taskId = Invocation.runtimeExecutionRef；contextId = SessionBinding.externalSessionRef。
            const binding = invocation.runtimeSessionBindingId
              ? await getSessionBindingById(params.tenantId, invocation.runtimeSessionBindingId)
              : null;
            return {
              runtimeExecutionRef: invocation.runtimeExecutionRef,
              runtimeSessionRef: binding?.externalSessionRef ?? null,
            };
          },
          resolveExistingContextId: async (threadId) => {
            // context reuse（04 §5 / 06 §4）：按 Tenant+Thread+AgentRevision+RuntimeRevision
            // 精确匹配 active SessionBinding → 复用 contextId；Turn completed 不关闭。
            const reusable = await findReusableSessionBinding({
              tenantId: params.tenantId,
              threadId,
              agentRevisionId: routeOutcome.resolution.agentRevisionId,
              runtimeRevisionId,
            });
            return reusable?.externalSessionRef ?? null;
          },
        }),
    },
  });
  const transport = await resolveTransport({
    protocolType: runtimeRevision.protocolType,
    endpoint: managedEndpoint,
    auth: await resolveOutboundAuth(),
  });

  const result = await dispatchInvocationForTurn({
    tenantId: params.tenantId,
    turnId: params.turnId,
    selectedModelRef: params.modelRef,
    agentConstraint: requestedAgentId,
    executionSubject: params.executionSubject,
    runtimeClient: transport,
    runtimeEndpointResolver: async (binding) => {
      // §24：下发 Binding 冻结的 Governance Revision（非 Tenant current），fail-closed。
      const frozenGovernance = await loadFrozenGovernanceConfig(
        binding.tenantId,
        binding.governanceConfigRevisionId,
      );
      return {
        // protocolType 决定 Transport：external endpoint（a2a）用 managedEndpoint；
        // Hosted 保持 in-process 引用（04 §10：Hosted 路径无行为回退）。
        runtimeEndpoint: managedEndpoint,
        auth: await resolveOutboundAuth(),
        gatewayEndpoints: {
          events: "in-process://events",
          cancel: "in-process://cancel",
          resume: "in-process://resume",
          steer: "in-process://steer",
          tools: "in-process://gateway/v1/tools",
          tool_calls: "in-process://gateway/v1/tool-calls",
          user_action_requests: "in-process://gateway/v1/user-action-requests",
        },
        governanceConfig: {
          revision_id: binding.governanceConfigRevisionId,
          config_digest: binding.governanceConfigDigest,
          config: frozenGovernance.config as unknown as Record<string, unknown>,
        },
        gatewayAccess: {
          access_token: issueWorkloadToken({
            type: "gateway",
            tenantId: binding.tenantId,
            invocationId: binding.invocationId,
            audience: "gateway",
            expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway,
          }),
          expires_at: new Date(Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway).toISOString(),
        },
      };
    },
  });

  if (!result.dispatched || !result.invocation || result.runtimeDispatch?.skipped) {
    return { dispatched: result.dispatched, completion: Promise.resolve() };
  }

  if (!result.binding) {
    throw new Error(`Turn 调度缺少 ExecutionBinding（turnId=${params.turnId}）`);
  }
  // Hosted Transport 需要显式启动 Agent Loop；A2A Transport 的事件流由
  // Transport 内部消费并经归一化 ingress 进入（04 §10）。
  const hostedClient = transport as Partial<InProcessHostedRuntimeClient>;
  if (typeof hostedClient.launchAcceptedInvocation !== "function") {
    return { dispatched: true, completion: Promise.resolve() };
  }
  const completion = hostedClient.launchAcceptedInvocation(
    result.invocation.id,
    result.binding.modelId,
  );
  void completion.catch((error) => {
    logger.error("[runtime] Hosted Runtime 执行失败", {
      turnId: params.turnId,
      invocationId: result.invocation?.id,
      error: String(error),
    });
  });
  return { dispatched: true, completion };
}
