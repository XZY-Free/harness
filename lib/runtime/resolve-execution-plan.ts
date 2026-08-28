/**
 * ResolveExecutionPlan — 单次解析执行计划（Harness 语义）。
 *
 * Dispatcher 和 Employee-turn-dispatcher 必须调用此函数一次性完成：
 * 1. Route 解析（使用统一 ConfiguredRouteResolver，顶层恒为 runtime target）
 * 2. 模型信息提取
 *
 * Invocation、Binding、Attempt 与 Turn 状态转换直接使用返回结果，
 * 不再重复查询控制面。
 *
 * 事实源：docs/architecture/runtime-control-plane.md。
 *
 * 架构边界：顶层执行计划只属于 SnowHarness Harness。
 * Agent 是 Harness 可调用的能力资产，不进入顶层 ExecutionPlan。
 * 冻结 exact AgentRevision 是 AgentCall 的职责，不在本层发生。
 */

import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type {
  RouteResolution,
  RouteResolutionAttribute,
  RouteResolutionOutcome,
} from "@/lib/routes/domain/route-resolution-policy";

// ─── 模型信息 ─────────────────────────────────────────────

/** 从 Thread 模型事实与平台默认提取的模型信息。 */
export interface ModelInfo {
  modelProvider: string;
  modelId: string;
  modelRevisionRef: string | null;
}

const DEFAULT_MODEL_PROVIDER = "default";

/**
 * 从 Thread.defaultModelRef 和平台默认提取模型信息。
 *
 * 优先级：员工为本次 Invocation 选择的模型 / 会话默认模型 > 平台默认模型
 * > "default" 占位。
 *
 * Harness 顶层执行不再从任何 AgentRevision 模型策略提取模型（专题01 冻结架构）：
 * Agent 是能力资产，不是顶层执行目标；顶层模型只由 Thread 事实与平台默认决定。
 */
export function extractModelInfo(
  modelPolicyJson: unknown,
  threadDefaultModelRef: string | null,
  platformDefaultModelRef?: string,
): ModelInfo {
  const policy = (modelPolicyJson ?? {}) as Record<string, unknown>;
  const modelId =
    threadDefaultModelRef ||
    (typeof policy.default === "string" && policy.default) ||
    (typeof policy.modelId === "string" && policy.modelId) ||
    platformDefaultModelRef ||
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
  /** 路由解析完整结果（顶层恒为 runtime target）。 */
  routeResolution: RouteResolution;
  /** 路由解析原始 Outcome（含 candidateCount）。 */
  routeOutcome: RouteResolutionOutcome;
  /** 冻结的 RuntimeRevisionId。 */
  runtimeRevisionId: string;
  /** 提取的模型信息。 */
  modelInfo: ModelInfo;
  /** Projection 版本号。 */
  projectionVersionNo: number | undefined;
}

/** 解析未成功的结果。 */
export interface UnresolvedExecutionPlan {
  resolved: false;
  /** 未解析原因。 */
  reason:
    | "no_effective_route"
    | "ambiguous_route_configuration"
    | "invalid_traffic_weight_total"
    | "agent_revision_not_found";
}

export type ExecutionPlan = ResolvedExecutionPlan | UnresolvedExecutionPlan;

// ─── 输入 ──────────────────────────────────────────────────

export interface ResolveExecutionPlanInput {
  tenantId: string;
  routeScopeKey: string;
  businessKey: { threadId?: string; jobId?: string };
  attributes?: Record<string, RouteResolutionAttribute>;
  /**
   * Thread 的真实模型事实：员工本次选择，其次会话默认；两者都没有时为 null。
   * 同时作为路由解析输入进入解析摘要，不得用平台默认预先填充。
   */
  threadDefaultModelRef?: string | null;
  /** 平台默认模型，在 Thread 模型策略之后兜底。 */
  platformDefaultModelRef?: string;
  /** 路由解析器（默认使用 统一入口）。 */
  routeResolver?: RouteResolver;
}

/**
 * 单次解析执行计划（顶层 Harness 语义）。
 *
 * 一次性完成 Runtime Route 解析 + 模型信息提取。
 * Dispatcher 后续步骤直接使用返回结果，不再重复查询控制面。
 *
 * 顶层不加载、不冻结任何 AgentRevision。
 */
export async function resolveExecutionPlan(
  input: ResolveExecutionPlanInput,
  defaultResolver: RouteResolver,
): Promise<ExecutionPlan> {
  // 1. 路由解析（顶层恒为 runtime target，无 Agent 约束）
  const routeOutcome = await (input.routeResolver ?? defaultResolver)({
    tenantId: input.tenantId,
    target: { kind: "runtime" },
    routeScopeKey: input.routeScopeKey,
    businessKey: input.businessKey,
    attributes: input.attributes ?? {},
    threadDefaultModelRef: input.threadDefaultModelRef,
  });

  if (routeOutcome.status === "unresolved") {
    const reason =
      routeOutcome.reason === "ambiguous_route_configuration"
        ? "ambiguous_route_configuration"
        : routeOutcome.reason === "invalid_traffic_weight_total"
          ? "invalid_traffic_weight_total"
          : "no_effective_route";
    return { resolved: false, reason };
  }

  const routeResolution = routeOutcome.resolution;

  // 2. 模型信息：顶层 Harness 执行不依赖任何 AgentRevision 模型策略。
  const modelInfo = extractModelInfo(
    null,
    input.threadDefaultModelRef ?? null,
    input.platformDefaultModelRef,
  );

  return {
    resolved: true,
    routeResolution,
    routeOutcome,
    runtimeRevisionId: routeResolution.runtimeRevisionId,
    modelInfo,
    projectionVersionNo: routeResolution.projectionVersionNo,
  };
}
