/**
 * §4.6: Configured Route Resolver — 统一解析入口。
 *
 * 所有执行路径（Employee Turn、Dispatcher、Binding）必须共用此入口，
 * 不得在各自模块内单独组装 Resolver。
 *
 * §4.6 切换完成后：
 * - Projection 是唯一运行时解析数据源
 * - Authority Store 仅用于诊断对比（可选，默认不启用）
 * - Binding 对权威事实做 FOR UPDATE 最终校验（Fail-closed）
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §4.6
 */

import {
  type ShadowResolutionResult,
  type ShadowResolverConfig,
  createShadowRouteResolver,
} from "@/lib/routes/application/shadow-route-resolver";
import type {
  ResolveRouteCandidatesInput,
  RouteResolutionAttribute,
  RouteResolutionOutcome,
} from "@/lib/routes/domain/route-resolution-policy";
import type { RouteEligibilityResolutionStore } from "@/lib/routes/persistence/route-eligibility-resolution-store";
import type { RouteResolutionStore } from "@/lib/routes/persistence/route-resolution-store";

// ─── 类型导出 ──────────────────────────────────────────────

export type {
  ShadowResolutionResult,
  ShadowDiff,
} from "@/lib/routes/application/shadow-route-resolver";

// ─── 输入/输出 ──────────────────────────────────────────────

export interface ConfiguredResolveRouteCommand {
  tenantId: string;
  agentId: string;
  routeScopeKey: string;
  businessKey: { threadId?: string; jobId?: string };
  attributes?: Record<string, RouteResolutionAttribute>;
  now?: Date;
}

export interface ConfiguredResolveRouteResult {
  /** 解析结果。 */
  outcome: RouteResolutionOutcome;
  /** Shadow 差异（仅诊断模式启用时）。 */
  shadow?: ShadowResolutionResult["shadow"];
  /** 解析耗时（ms）。 */
  resolveMs: number;
}

// ─── 配置 ────────────────────────────────────────────────

export interface ConfiguredResolverConfig extends Partial<ShadowResolverConfig> {
  /** Shadow 是否启用（默认 false — Projection 唯一）。 */
  shadowEnabled?: boolean;
}

// ─── 依赖 ────────────────────────────────────────────────

export interface ConfiguredResolverDependencies {
  /** Projection Store — 运行时解析的唯一数据源。 */
  projectionStore: RouteEligibilityResolutionStore;
  /** Authority Store — 仅诊断模式启用时使用。 */
  authorityStore?: RouteResolutionStore;
  config?: ConfiguredResolverConfig;
}

// ─── Resolver 类型 ──────────────────────────────────────────

export type ConfiguredRouteResolver = (
  command: ConfiguredResolveRouteCommand,
) => Promise<ConfiguredResolveRouteResult>;

// ─── 工厂 ────────────────────────────────────────────────

/**
 * §4.6: 创建统一 Route Resolver 入口。
 *
 * 此函数是唯一的 Resolver 组装点。
 * Employee Turn 和 Dispatcher 必须调用此函数获取 Resolver，
 * 不得自行 new 或 import Shadow Resolver。
 */
export function createConfiguredRouteResolver(
  deps: ConfiguredResolverDependencies,
): ConfiguredRouteResolver {
  const shadowConfig: ShadowResolverConfig = {
    enabled: deps.config?.shadowEnabled ?? false,
  };

  const shadowResolve = createShadowRouteResolver({
    projectionStore: deps.projectionStore,
    authorityStore: deps.authorityStore,
    config: shadowConfig,
  });

  return async function configuredResolveRoute(
    command: ConfiguredResolveRouteCommand,
  ): Promise<ConfiguredResolveRouteResult> {
    const start = Date.now();

    const shadowResult = await shadowResolve({
      tenantId: command.tenantId,
      agentId: command.agentId,
      routeScopeKey: command.routeScopeKey,
      businessKey: command.businessKey,
      attributes: command.attributes ?? {},
      now: command.now ?? new Date(),
    });

    const resolveMs = Date.now() - start;

    return {
      outcome: shadowResult.outcome,
      shadow: shadowResult.shadow,
      resolveMs,
    };
  };
}

// ─── 兼容：保持 ResolveRouteCandidatesInput 类型导出 ─────────────────────────
export type { ResolveRouteCandidatesInput };
