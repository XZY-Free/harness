/**
 * §4.6: Configured Route Resolver — 统一解析入口。
 *
 * 所有执行路径（Employee Turn、Dispatcher、Binding）必须共用此入口，
 * 不得在各自模块内单独组装 Resolver。
 *
 * Shadow 阶段：
 * - Authority = 实际执行结果
 * - Projection = 对比结果
 * - 差异记录到日志（不记录敏感数据）
 *
 * 切换后（useProjectionForExecution=true）：
 * - Projection 用于选择
 * - Binding 做最终权威校验（Fail-closed）
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §4.6
 */

import { createShadowRouteResolver, type ShadowResolutionResult, type ShadowResolverConfig } from "@/lib/routes/application/shadow-route-resolver";
import type { RouteResolutionStore } from "@/lib/routes/persistence/route-resolution-store";
import type { RouteEligibilityResolutionStore } from "@/lib/routes/persistence/route-eligibility-resolution-store";
import type { RouteResolutionAttribute, RouteResolutionOutcome, ResolveRouteCandidatesInput } from "@/lib/routes/domain/route-resolution-policy";

// ─── 类型导出 ──────────────────────────────────────────────

export type { ShadowResolutionResult, ShadowDiff } from "@/lib/routes/application/shadow-route-resolver";

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
  /** Shadow 差异（仅 Shadow 阶段有值）。 */
  shadow?: ShadowResolutionResult["shadow"];
  /** 解析耗时（ms）。 */
  resolveMs: number;
}

// ─── 配置 ────────────────────────────────────────────────

export interface ConfiguredResolverConfig extends Partial<ShadowResolverConfig> {
  /** Shadow 是否启用（默认 true）。 */
  shadowEnabled?: boolean;
}

// ─── 依赖 ────────────────────────────────────────────────

export interface ConfiguredResolverDependencies {
  authorityStore: RouteResolutionStore;
  projectionStore: RouteEligibilityResolutionStore;
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
    enabled: deps.config?.shadowEnabled ?? true,
    useProjectionForExecution: deps.config?.useProjectionForExecution ?? false,
  };

  const shadowResolve = createShadowRouteResolver({
    authorityStore: deps.authorityStore,
    projectionStore: deps.projectionStore,
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
