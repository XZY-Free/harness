import { getChatModel } from "@/lib/ai/provider";
import { aiConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { getThreadById } from "@/lib/v11/conversation/thread-queries";
import {
  WORKLOAD_TOKEN_DEFAULT_TTL_MS,
  issueWorkloadToken,
} from "@/lib/identity/workload-token";
import type { HostedModelContext } from "@/lib/v11/runtime/adapters/hosted-adapter";
import { dispatchInvocationForTurn } from "@/lib/v11/runtime/dispatcher";
import { ingressEventBatch } from "@/lib/v11/runtime/event-ingress-queries";
import { createInProcessHostedRuntimeClient } from "@/lib/v11/runtime/in-process-hosted-runtime";
import { ingressTransientBatch } from "@/lib/v11/runtime/transient-events";
import { createResolveRoute, type RouteResolver } from "@/lib/routes/application/resolve-route";
import { mysqlRouteResolutionStore } from "@/lib/routes/persistence/mysql-route-resolution-store";
import {
  createConfiguredRouteResolver,
} from "@/lib/routes/infrastructure/configured-route-resolver";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { createRequestHostedProvisioning } from "@/lib/runtimes/application/request-hosted-provisioning";
import { mysqlHostedProvisioningRequestStore } from "@/lib/runtimes/persistence/mysql-hosted-provisioning-request-store";
import { createRevisionValidator } from "@/lib/runtimes/application/validate-hosted-provisioning-revision";
import { db } from "@/lib/db/client";
import { agentTable } from "@/lib/persistence/schema/agents";
import { and, eq } from "drizzle-orm";
import { streamText } from "ai";

type ModelFn = (message: string, context: HostedModelContext) => Promise<string>;

/** §4.6: 使用统一解析入口 — Shadow 对比在内部自动执行。 */
const configuredResolver = createConfiguredRouteResolver({
  authorityStore: mysqlRouteResolutionStore,
  projectionStore: mysqlRouteEligibilityResolutionStore,
});
const resolveRoute: RouteResolver = async (input) => {
  const result = await configuredResolver({
    tenantId: input.tenantId,
    agentId: input.agentId,
    routeScopeKey: input.routeScopeKey,
    businessKey: input.businessKey,
    attributes: input.attributes,
  });
  return result.outcome;
};

/**
 * §6.1: 注入 Revision 验证器的 ProvisioningRequest 工厂。
 * 禁止 agentRevisionId = "unknown"。
 */
const requestHostedProvisioning = createRequestHostedProvisioning({
  store: mysqlHostedProvisioningRequestStore,
  revisionValidator: createRevisionValidator(),
});

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
      model: getChatModel(aiConfig.chatModel),
      prompt: message,
      maxOutputTokens: aiConfig.maxOutputTokens || undefined,
    });
    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
      await context.emitTextDelta?.(delta);
    }
    return text;
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
}): Promise<EmployeeTurnDispatchResult> {
  const thread = await getThreadById(params.tenantId, params.threadId);
  if (!thread) {
    throw new Error(`Turn 调度失败：会话不存在 (${params.threadId})`);
  }

  // ─── 热路径：查询正式 RouteResolver ──────────────────────────
  const routeOutcome = await resolveRoute({
    tenantId: params.tenantId,
    agentId: thread.primaryAgentId,
    routeScopeKey: "default",
    businessKey: { jobId: `hosted-provision:${thread.primaryAgentId}` },
  });

  if (routeOutcome.status !== "resolved") {
    // §6.1: 无 Ready Route → 读取当前 AgentRevision，验证后幂等请求 Hosted Provisioning
    const agentRevisionId = await loadCurrentAgentRevisionId(
      params.tenantId,
      thread.primaryAgentId,
    );

    if (!agentRevisionId) {
      // §6.1: Agent 无当前 Revision — 无法创建供应请求，返回明确失败
      logger.warn("[v11] Agent 无当前 AgentRevision，无法请求 Hosted 供应", {
        tenantId: params.tenantId,
        agentId: thread.primaryAgentId,
      });
      return {
        dispatched: false,
        completion: Promise.resolve(),
      };
    }

    const provisioningResult = await requestHostedProvisioning({
      tenantId: params.tenantId,
      agentId: thread.primaryAgentId,
      agentRevisionId,
      routeScopeKey: "default",
    });

    // §6.1: Revision 验证失败 — 返回明确失败而非创建无效请求
    if (!("requestId" in provisioningResult)) {
      logger.warn("[v11] AgentRevision 验证失败，无法请求 Hosted 供应", {
        tenantId: params.tenantId,
        agentId: thread.primaryAgentId,
        validationCode: provisioningResult.code,
        validationReason: provisioningResult.reason,
      });
      return {
        dispatched: false,
        completion: Promise.resolve(),
      };
    }

    logger.info("[v11] Hosted Route 未就绪，已请求异步供应", {
      tenantId: params.tenantId,
      agentId: thread.primaryAgentId,
      provisioningRequestId: provisioningResult.requestId,
      provisioningState: provisioningResult.state,
    });

    return {
      dispatched: false,
      completion: Promise.resolve(),
      provisioningRequestId: provisioningResult.requestId,
      provisioningState: provisioningResult.state,
      retryAfterMs: provisioningResult.retryAfterMs,
    };
  }

  // ─── 有 Ready Route → 继续调度（不变） ──────────────────────
  const modelRef = params.modelRef ?? aiConfig.chatModel;
  const client = createInProcessHostedRuntimeClient({
    modelRef,
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
    runtimeClient: client,
    runtimeEndpointResolver: async (binding) => ({
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
      },
    }),
  });

  if (!result.dispatched || !result.invocation || result.runtimeDispatch?.skipped) {
    return { dispatched: result.dispatched, completion: Promise.resolve() };
  }

  const completion = client.launchAcceptedInvocation(result.invocation.id);
  void completion.catch((error) => {
    logger.error("[v11] Hosted Runtime 执行失败", {
      turnId: params.turnId,
      invocationId: result.invocation?.id,
      error: String(error),
    });
  });
  return { dispatched: true, completion };
}

/** 读取 Agent 当前 AgentRevision ID（用于 ProvisioningRequest）。 */
async function loadCurrentAgentRevisionId(
  tenantId: string,
  agentId: string,
): Promise<string | null> {
  const [agent] = await db
    .select({ currentRevisionId: agentTable.currentRevisionId })
    .from(agentTable)
    .where(and(eq(agentTable.tenantId, tenantId), eq(agentTable.id, agentId)))
    .limit(1);
  return agent?.currentRevisionId ?? null;
}
