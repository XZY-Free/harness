/**
 * §5.4: ResolveExecutionPlan — 单次解析执行计划。
 *
 * Dispatcher 和 Employee-turn-dispatcher 必须调用此函数一次性完成：
 * 1. Route 解析（使用统一 ConfiguredRouteResolver）
 * 2. AgentRevision 读取 + 模型信息提取
 *
 * 后续步骤（Invocation + Binding + Attempt + Turn 状态转换）直接使用返回结果，
 * 不再重复查询控制面。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §5.4
 */

import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import type { V11AgentRevision } from "@/lib/v11/schema/agent";
import type { RouteResolution, RouteResolutionAttribute, RouteResolutionOutcome } from "@/lib/routes/domain/route-resolution-policy";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";

// ─── 模型信息 ─────────────────────────────────────────────

/** 从 AgentRevision.modelPolicyJson 提取的模型信息。 */
export interface ModelInfo {
  modelProvider: string;
  modelId: string;
  modelRevisionRef: string | null;
}

const DEFAULT_MODEL_PROVIDER = "default";

/**
 * 从 AgentRevision.modelPolicyJson 和 Thread.defaultModelRef 提取模型信息。
 *
 * modelPolicyJson 形如 { default: "doubao-pro", provider?: "doubao", revision?: "v1" }。
 * 优先级：modelPolicyJson > threadDefaultModelRef > "default" 占位。
 */
export function extractModelInfo(
  modelPolicyJson: unknown,
  threadDefaultModelRef: string | null,
): ModelInfo {
  const policy = (modelPolicyJson ?? {}) as Record<string, unknown>;
  const modelId =
    (typeof policy.default === "string" && policy.default) ||
    (typeof policy.modelId === "string" && policy.modelId) ||
    threadDefaultModelRef ||
    "default";
  const modelProvider =
    (typeof policy.provider === "string" && policy.provider) || DEFAULT_MODEL_PROVIDER;
  const modelRevisionRef =
    typeof policy.revision === "string"
      ? policy.revision
      : typeof policy.modelRevisionRef === "string"
        ? policy.modelRevisionRef
        : null;
  return { modelProvider, modelId, modelRevisionRef };
}

// ─── ResolveExecutionPlan ──────────────────────────────────

/** 解析成功的结果。 */
export interface ResolvedExecutionPlan {
  resolved: true;
  /** 路由解析完整结果。 */
  routeResolution: RouteResolution;
  /** 路由解析原始 Outcome（含 candidateCount）。 */
  routeOutcome: RouteResolutionOutcome;
  /** 冻结的 AgentRevision。 */
  agentRevisionId: string;
  /** 冻结的 AgentRevision 完整对象（供 Runtime dispatch 使用）。 */
  agentRevision: V11AgentRevision;
  /** 冻结的 RuntimeRevisionId。 */
  runtimeRevisionId: string;
  /** 提取的模型信息。 */
  modelInfo: ModelInfo;
  /** §4.6: Projection 版本号。 */
  projectionVersionNo: number | undefined;
}

/** 解析未成功的结果。 */
export interface UnresolvedExecutionPlan {
  resolved: false;
  /** 未解析原因。 */
  reason: "no_effective_route" | "ambiguous_route_configuration" | "invalid_traffic_weight_total" | "agent_revision_not_found";
}

export type ExecutionPlan = ResolvedExecutionPlan | UnresolvedExecutionPlan;

// ─── 输入 ──────────────────────────────────────────────────

export interface ResolveExecutionPlanInput {
  tenantId: string;
  agentId: string;
  routeScopeKey: string;
  businessKey: { threadId?: string; jobId?: string };
  attributes?: Record<string, RouteResolutionAttribute>;
  /** Thread 的 defaultModelRef（模型信息提取用）。 */
  threadDefaultModelRef?: string | null;
  /** 路由解析器（默认使用 §4.6 统一入口）。 */
  routeResolver?: RouteResolver;
}

/**
 * §5.4: 单次解析执行计划。
 *
 * 一次性完成 Route 解析 + AgentRevision 读取 + 模型信息提取。
 * Dispatcher 后续步骤直接使用返回结果，不再重复查询控制面。
 */
export async function resolveExecutionPlan(
  input: ResolveExecutionPlanInput,
  defaultResolver: RouteResolver,
): Promise<ExecutionPlan> {
  // 1. 路由解析
  const routeOutcome = await (input.routeResolver ?? defaultResolver)({
    tenantId: input.tenantId,
    agentId: input.agentId,
    routeScopeKey: input.routeScopeKey,
    businessKey: input.businessKey,
    attributes: input.attributes ?? {},
  });

  if (routeOutcome.status === "unresolved") {
    const reason = routeOutcome.reason === "ambiguous_route_configuration"
      ? "ambiguous_route_configuration"
      : routeOutcome.reason === "invalid_traffic_weight_total"
        ? "invalid_traffic_weight_total"
        : "no_effective_route";
    return { resolved: false, reason };
  }

  const routeResolution = routeOutcome.resolution;

  // 2. 读取 AgentRevision（提取模型信息）
  const agentRevision = await getRevisionById(routeResolution.agentRevisionId);
  if (!agentRevision) {
    return { resolved: false, reason: "agent_revision_not_found" };
  }

  const modelInfo = extractModelInfo(agentRevision.modelPolicyJson, input.threadDefaultModelRef ?? null);

  return {
    resolved: true,
    routeResolution,
    routeOutcome,
    agentRevisionId: routeResolution.agentRevisionId,
    agentRevision,
    runtimeRevisionId: routeResolution.runtimeRevisionId,
    modelInfo,
    projectionVersionNo: routeResolution.projectionVersionNo,
  };
}
