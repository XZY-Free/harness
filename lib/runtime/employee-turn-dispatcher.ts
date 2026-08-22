import { getChatModel } from "@/lib/ai/provider";
import { aiConfig } from "@/lib/config";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { loadFrozenGovernanceConfig } from "@/lib/governance/governance-repository";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { logger } from "@/lib/logger";
import { type RouteResolver, createResolveRoute } from "@/lib/routes/application/resolve-route";
import { createConfiguredRouteResolver } from "@/lib/routes/infrastructure/configured-route-resolver";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import type { HostedModelContext } from "@/lib/runtime/adapters/hosted-adapter";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { collectModelText } from "@/lib/runtime/model-text-stream";
import { ingressTransientBatch } from "@/lib/runtime/transient-events";
import { streamText } from "ai";

type ModelFn = (message: string, context: HostedModelContext) => Promise<string>;

/** : 使用统一解析入口 — Projection 是唯一数据源。 */
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
  /** 当 dispatched=false 且 Hosted Route 尚未就绪时的供应状态。 */
  provisioningRequestId?: string;
  provisioningState?: string;
  retryAfterMs?: number;
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
 * 第二批改造：移除同步 Hosted 供应调用。
 * 热路径只允许：读取 Ready Route → 创建 Invocation/Binding → 调度。
 * 无 Ready Route 时幂等创建 ProvisioningRequest（不执行外部调用）。
 */
export async function dispatchEmployeeTurn(params: {
  tenantId: string;
  threadId: string;
  turnId: string;
  modelRef?: string;
  modelFn?: ModelFn;
  /**
   * : 调用方显式提供的可选 Agent 控制面约束（§8.3）。
   * 默认 null = 解析基础 Harness Route（§9.3 Employee Turn 热路径）。
   * 测试可显式传 agent.id 以覆盖旧 Agent-specific 路由（E 阶段解绑后移除）。
   */
  agentConstraint?: string | null;
}): Promise<EmployeeTurnDispatchResult> {
  const thread = await getThreadById(params.tenantId, params.threadId);
  if (!thread) {
    throw new Error(`Turn 调度失败：会话不存在 (${params.threadId})`);
  }

  // ─── 热路径：查询正式 RouteResolver ──────────────────────────
  const routeOutcome = await resolveRoute({
    tenantId: params.tenantId,
    // : 线程不再绑定 Agent（§8.3），默认按基础 Harness Route 解析（§9.3）。
    // 调用方显式传 agentConstraint 时按 Agent 约束解析（测试过渡用，E 阶段移除）。
    agentConstraint: params.agentConstraint ?? null,
    routeScopeKey: "default",
    businessKey: { jobId: `employee-turn:${thread.id}` },
    threadDefaultModelRef: thread.defaultModelRef,
  });

  if (routeOutcome.status !== "resolved") {
    // : 线程不再绑定 Agent（§8.3）；无 Ready Route 时不再为某个 Agent 发起
    // Hosted Provisioning（旧 thread.primaryAgentId 已移除）。返回未调度，
    // 基础 Harness Route 的供应策略由后续阶段决定。
    return { dispatched: false, completion: Promise.resolve() };
  }

  // ─── 有 Ready Route → 继续调度（不变） ──────────────────────
  const client = createInProcessHostedRuntimeClient({
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
  });

  const result = await dispatchInvocationForTurn({
    tenantId: params.tenantId,
    turnId: params.turnId,
    selectedModelRef: params.modelRef,
    agentConstraint: params.agentConstraint ?? null,
    runtimeClient: client,
    runtimeEndpointResolver: async (binding) => {
      // §24：下发 Binding 冻结的 Governance Revision（非 Tenant current），fail-closed。
      const frozenGovernance = await loadFrozenGovernanceConfig(
        binding.tenantId,
        binding.governanceConfigRevisionId,
      );
      return {
        runtimeEndpoint: "in-process://hosted",
        authToken: issueWorkloadToken({
          type: "runtime",
          tenantId: params.tenantId,
          invocationId: binding.invocationId,
          runtimeRevisionId: binding.runtimeRevisionId,
          audience: "runtime",
          expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
        }),
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
  const completion = client.launchAcceptedInvocation(result.invocation.id, result.binding.modelId);
  void completion.catch((error) => {
    logger.error("[runtime] Hosted Runtime 执行失败", {
      turnId: params.turnId,
      invocationId: result.invocation?.id,
      error: String(error),
    });
  });
  return { dispatched: true, completion };
}
