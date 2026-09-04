import { aiConfig } from "@/lib/config";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { loadFrozenGovernanceConfig } from "@/lib/governance/governance-repository";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { logger } from "@/lib/logger";
import { type RouteResolver, createResolveRoute } from "@/lib/routes/application/resolve-route";
import { createConfiguredRouteResolver } from "@/lib/routes/infrastructure/configured-route-resolver";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import {
  createConfiguredHostedRuntimeApplicationService,
  hostedRuntimeApplicationService,
} from "@/lib/runtime/application/production-resume-harness-invocation";
import {
  type RuntimeTransportAuth,
  resolveOutboundRuntimeAuth,
} from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import {
  configuredDecisionPort,
  configuredFinalResponsePort,
} from "@/lib/runtime/harness-loop/configured-model-ports";
import type {
  HarnessActionExecutors,
  HarnessDecisionPort,
  HarnessFinalResponsePort,
} from "@/lib/runtime/harness-loop/loop";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import type { InProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { createRuntimeTransportResolver } from "@/lib/runtime/transport/runtime-transport-resolver";

/** 使用统一解析入口 — Projection 是唯一数据源。 */
const configuredResolver = createConfiguredRouteResolver({
  projectionStore: mysqlRouteEligibilityResolutionStore,
});
const resolveRoute: RouteResolver = async (input) => {
  const result = await configuredResolver({
    tenantId: input.tenantId,
    target: input.target,
    routeScopeKey: input.routeScopeKey,
    businessKey: input.businessKey,
    attributes: input.attributes,
    threadDefaultModelRef: input.threadDefaultModelRef,
  });
  return result.outcome;
};

export interface EmployeeTurnDispatchResult {
  dispatched: boolean;
  /** 未调度原因（dispatched=false 时填；06 专项 P2-4 的稳定 route_* 原因码）。 */
  reason?:
    | "no_effective_route"
    | "ambiguous_route_configuration"
    | "invalid_traffic_weight_total"
    | "agent_revision_not_found";
  /** Agent Loop 的后台执行；HTTP 路由不等待它，测试可等待。 */
  completion: Promise<void>;
}

/**
 * 调度员工发起的会话 Turn。
 *
 * 正式热路径（§9.3）：读取 Thread → Resolve 基础 Harness Route（显式 runtime target，冻结架构）
 * → 创建 Invocation → 创建 ExecutionBinding → Runtime Dispatch。
 * 无 Ready Route 时保持 accepted 并返回未调度（热路径不做 Agent-specific Hosted Provisioning，§11.2/§11.5）；
 * 基础 Harness Route 的供应策略由正式控制面初始化。
 */
export async function dispatchEmployeeTurn(params: {
  tenantId: string;
  threadId: string;
  turnId: string;
  /** 入口请求关联 id；进入 Runtime trace_context，贯穿本次 Harness 执行。 */
  correlationId?: string;
  modelRef?: string;
  decisionPort?: HarnessDecisionPort;
  finalResponsePort?: HarnessFinalResponsePort;
  actionExecutors?: HarnessActionExecutors;
  /**
   * ExecutionSubject：由调用方（服务端 route 层）从认证 Principal 生成。
   * 禁止从 Turn JSON / 请求体接受 caller 自报 subject；本层不做校验兜底。
   */
  executionSubject: ExecutionSubject;
}): Promise<EmployeeTurnDispatchResult> {
  const thread = await getThreadById(params.tenantId, params.threadId);
  if (!thread) {
    throw new Error(`Turn 调度失败：会话不存在 (${params.threadId})`);
  }

  // 顶层 Employee Turn 永远解析基础 Harness Route（冻结架构）。
  // 用户选择 Agent 只形成本 Turn 的能力使用偏好，不改变顶层执行目标：
  // 顶层 Invocation 始终由 Harness Runtime 执行，Agent 由 Harness Loop 通过
  // AgentCall 调用（本模块不读取 Turn directive 作为顶层 Route 约束）。
  // ─── 热路径：查询正式 RouteResolver（恒为 runtime target）───
  const routeOutcome = await resolveRoute({
    tenantId: params.tenantId,
    target: { kind: "runtime" },
    routeScopeKey: "default",
    businessKey: { jobId: `employee-turn:${thread.id}` },
    threadDefaultModelRef: thread.defaultModelRef,
  });

  if (routeOutcome.status !== "resolved") {
    // Thread 不绑定 Agent；无 Ready Route 时热路径不发起 Agent-specific Hosted Provisioning。
    // Turn 保持 accepted 并返回未调度（基础 Harness Route 由正式控制面初始化供应策略）；
    // reason 供调用方区分确定性失败（06 专项 P2-4：required Route race 终态化）。
    return {
      dispatched: false,
      reason:
        routeOutcome.status === "unresolved"
          ? routeOutcome.reason === "ambiguous_route_configuration"
            ? "ambiguous_route_configuration"
            : routeOutcome.reason === "invalid_traffic_weight_total"
              ? "invalid_traffic_weight_total"
              : "no_effective_route"
          : undefined,
      completion: Promise.resolve(),
    };
  }

  // ─── 有 Ready Route → 按 protocolType 解析 Transport──────────
  // Dispatcher 不再固定创建 in-process Hosted client；protocolType 真正决定 Transport。
  // 顶层 Employee Turn 只消费 runtime target：resolver 若违反命令返回 Agent 解析
  // （target 或证据 kind 为 agent），必须 fail-closed 抛出，绝不产出 undefined/nullable runtime ID。
  const resolution = routeOutcome.resolution;
  if (resolution.target.kind !== "runtime" || resolution.controlPlaneEvidence.kind !== "runtime") {
    throw new Error(
      "EmployeeTurnDispatcher 只接受 runtime target 的 RouteResolution（顶层执行不冻结 Agent）",
    );
  }
  // runtimeRevisionId 只从收窄后的 target.runtimeRevisionId 读取，禁止 flat fallback。
  const runtimeRevisionId = resolution.target.runtimeRevisionId;
  const runtimeRevision = await getRuntimeRevisionById(runtimeRevisionId);
  if (!runtimeRevision) {
    throw new Error(`Turn 调度失败：RuntimeRevision 不存在（${runtimeRevisionId}）`);
  }
  const isExternalEndpoint = runtimeRevision.runtimeEvidenceKind === "external_endpoint";
  // managed endpoint/identity configuration：
  // external_endpoint → endpointRef 即外部 endpoint；hosted → in-process 引用。
  const managedEndpoint = isExternalEndpoint ? runtimeRevision.endpointRef : "in-process://hosted";

  // External outbound auth 只能来自唯一 resolver（RuntimeRevision.identityMode +
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
      harness_runtime_protocol: () =>
        createInProcessHostedRuntimeClient({
          tenantId: params.tenantId,
          applicationService:
            params.decisionPort || params.finalResponsePort || params.actionExecutors
              ? createConfiguredHostedRuntimeApplicationService({
                  decisionPort:
                    params.decisionPort ??
                    configuredDecisionPort(params.modelRef ?? aiConfig.chatModel),
                  finalResponsePort:
                    params.finalResponsePort ??
                    configuredFinalResponsePort(params.modelRef ?? aiConfig.chatModel),
                  actionExecutors: params.actionExecutors,
                  modelRef: params.modelRef,
                })
              : hostedRuntimeApplicationService,
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
    correlationId: params.correlationId,
    selectedModelRef: params.modelRef,
    executionSubject: params.executionSubject,
    runtimeClient: transport,
    runtimeEndpointResolver: async (binding) => {
      // §24：下发 Binding 冻结的 Governance Revision（非 Tenant current），fail-closed。
      const frozenGovernance = await loadFrozenGovernanceConfig(
        binding.tenantId,
        binding.governanceConfigRevisionId,
      );
      return {
        // protocolType 决定 Transport：external Harness Runtime endpoint 用 managedEndpoint；
        // Hosted 保持 in-process 引用（Hosted 路径无行为回退）。
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
          capability_actions: "in-process://gateway/v1/capability-actions",
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
            runtimeRevisionId: binding.runtimeRevisionId,
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
  // Hosted Transport 需要显式启动 Agent Loop；External Harness Runtime Transport
  // 的事件流由 Transport 内部消费并经归一化 ingress 进入。
  const hostedClient = transport as Partial<InProcessHostedRuntimeClient>;
  if (typeof hostedClient.launchAcceptedInvocation !== "function") {
    return { dispatched: true, completion: Promise.resolve() };
  }
  const completion = hostedClient.launchAcceptedInvocation(result.invocation.id);
  void completion.catch((error) => {
    logger.error("[runtime] Hosted Runtime 执行失败", {
      turnId: params.turnId,
      invocationId: result.invocation?.id,
      error: String(error),
    });
  });
  return { dispatched: true, completion };
}
