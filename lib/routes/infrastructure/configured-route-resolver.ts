/**
 * Configured Route Resolver — 唯一解析入口。
 *
 * 所有执行路径（Employee Turn、Dispatcher、Binding）必须共用此入口，
 * 不得在各自模块内单独组装 Resolver。
 *
 * Projection 是唯一运行时解析数据源。
 * Binding 对权威事实做 FOR UPDATE 最终校验（Fail-closed）。
 */

import type {
  ResolveRouteCandidatesInput,
  RouteResolutionAttribute,
  RouteResolutionOutcome,
  RouteTarget,
} from "@/lib/routes/domain/route-resolution-policy";
import { resolveRouteCandidates } from "@/lib/routes/domain/route-resolution-policy";
import type { RouteEligibilityResolutionStore } from "@/lib/routes/persistence/route-eligibility-resolution-store";

// ─── 输入/输出 ──────────────────────────────────────────────

export interface ConfiguredResolveRouteCommand {
  tenantId: string;
  /** 显式解析目标 — {kind:"runtime"} 或 {kind:"agent", agentId}（专题01 冻结架构）。 */
  target: RouteTarget;
  routeScopeKey: string;
  businessKey: { threadId?: string; jobId?: string };
  attributes?: Record<string, RouteResolutionAttribute>;
  threadDefaultModelRef?: string | null;
  now?: Date;
}

export interface ConfiguredResolveRouteResult {
  /** 解析结果。 */
  outcome: RouteResolutionOutcome;
  /** 解析耗时（ms）。 */
  resolveMs: number;
}

// ─── 依赖 ────────────────────────────────────────────────

export interface ConfiguredResolverDependencies {
  /** Projection Store — 运行时解析的唯一数据源。 */
  projectionStore: RouteEligibilityResolutionStore;
}

// ─── Resolver 类型 ──────────────────────────────────────────

export type ConfiguredRouteResolver = (
  command: ConfiguredResolveRouteCommand,
) => Promise<ConfiguredResolveRouteResult>;

// ─── 工厂 ────────────────────────────────────────────────

/**
 * 创建唯一 Route Resolver 入口。
 *
 * 此函数是唯一的 Resolver 组装点。
 * Employee Turn 和 Dispatcher 必须调用此函数获取 Resolver。
 */
export function createConfiguredRouteResolver(
  deps: ConfiguredResolverDependencies,
): ConfiguredRouteResolver {
  return async function configuredResolveRoute(
    command: ConfiguredResolveRouteCommand,
  ): Promise<ConfiguredResolveRouteResult> {
    const start = Date.now();

    // Projection 是唯一数据源 — 单次 SQL 查询 eligible 候选
    const candidates = await deps.projectionStore.loadCandidates({
      tenantId: command.tenantId,
      target: command.target,
      routeScopeKey: command.routeScopeKey,
    });

    // 纯内存选择算法
    const outcome = resolveRouteCandidates({
      tenantId: command.tenantId,
      target: command.target,
      routeScopeKey: command.routeScopeKey,
      businessKey: command.businessKey,
      attributes: command.attributes ?? {},
      threadDefaultModelRef: command.threadDefaultModelRef,
      candidates,
      now: command.now ?? new Date(),
    });

    const resolveMs = Date.now() - start;

    return {
      outcome,
      resolveMs,
    };
  };
}

// ─── 保持 ResolveRouteCandidatesInput 类型导出 ─────────────────────────
export type { ResolveRouteCandidatesInput };
