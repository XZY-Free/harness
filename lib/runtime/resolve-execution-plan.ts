/**
 * : ResolveExecutionPlan — 单次解析执行计划。
 *
 * Dispatcher 和 Employee-turn-dispatcher 必须调用此函数一次性完成：
 * 1. Route 解析（使用统一 ConfiguredRouteResolver）
 * 2. AgentRevision 读取 + 模型信息提取
 *
 * 后续步骤（Invocation + Binding + Attempt + Turn 状态转换）直接使用返回结果，
 * 不再重复查询控制面。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案
 */

import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import type { AgentRevision } from "@/lib/persistence/schema/agent";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type {
  RouteResolution,
  RouteResolutionAttribute,
  RouteResolutionOutcome,
} from "@/lib/routes/domain/route-resolution-policy";

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
 * 优先级：员工为本次 Invocation 选择的模型 / 会话默认模型 > AgentRevision 默认模型
 * > 平台默认模型 > "default" 占位。
 *
 * `threadDefaultModelRef` 只接受真实会话事实（员工本次选择或会话默认），调用方不得
 * 提前用平台默认填充：一旦填充，AgentRevision 的模型策略将永远不被采纳。平台默认
 * 由 `platformDefaultModelRef` 在 Agent 策略之后兜底。
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
  /** 路由解析完整结果。 */
  routeResolution: RouteResolution;
  /** 路由解析原始 Outcome（含 candidateCount）。 */
  routeOutcome: RouteResolutionOutcome;
  /** 冻结的 AgentRevision。null = 基础 Harness Route（无 Agent 资产约束）。 */
  agentRevisionId: string | null;
  /** 冻结的 AgentRevision 完整对象（供 Runtime dispatch 使用）。null = 无 Agent 约束。 */
  agentRevision: AgentRevision | null;
  /** 冻结的 RuntimeRevisionId。 */
  runtimeRevisionId: string;
  /** 提取的模型信息。 */
  modelInfo: ModelInfo;
  /** : Projection 版本号。 */
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
  /**
   * 调用方显式提供的可选 Agent 控制面约束（§8.3）。
   * null = 无 Agent 约束，解析基础 Harness Route；concrete = 带 Agent 约束。
   */
  agentConstraint?: string | null;
  routeScopeKey: string;
  businessKey: { threadId?: string; jobId?: string };
  attributes?: Record<string, RouteResolutionAttribute>;
  /**
   * Thread 的真实模型事实：员工本次选择，其次会话默认；两者都没有时为 null。
   * 同时作为路由解析输入进入解析摘要，不得用平台默认预先填充。
   */
  threadDefaultModelRef?: string | null;
  /** 平台默认模型，在 AgentRevision 模型策略之后兜底。 */
  platformDefaultModelRef?: string;
  /** 路由解析器（默认使用 统一入口）。 */
  routeResolver?: RouteResolver;
}

/**
 * : 单次解析执行计划。
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
    agentConstraint: input.agentConstraint ?? null,
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

  // 2. 读取 AgentRevision（提取模型信息）。
  // 基础 Harness Route（agentRevisionId === null）→ 不加载 AgentRevision，模型由
  // 本次 / Thread 显式模型 → 平台默认模型决定（§9.2）。AgentRevision 模型策略仅在
  // 存在 Agent 约束时进入优先级（§9.2）。
  const agentRevisionId = routeResolution.agentRevisionId;
  const agentRevision = agentRevisionId !== null ? await getRevisionById(agentRevisionId) : null;
  if (agentRevisionId !== null && !agentRevision) {
    return { resolved: false, reason: "agent_revision_not_found" };
  }

  const modelInfo = extractModelInfo(
    agentRevision?.modelPolicyJson ?? null,
    input.threadDefaultModelRef ?? null,
    input.platformDefaultModelRef,
  );

  return {
    resolved: true,
    routeResolution,
    routeOutcome,
    agentRevisionId,
    agentRevision,
    runtimeRevisionId: routeResolution.runtimeRevisionId,
    modelInfo,
    projectionVersionNo: routeResolution.projectionVersionNo,
  };
}
