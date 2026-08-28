import {
  type RouteResolutionAttribute,
  type RouteResolutionOutcome,
  type RouteTarget,
  resolveRouteCandidates,
} from "../domain/route-resolution-policy";
import type { RouteEligibilityResolutionStore } from "../persistence/route-eligibility-resolution-store";

export interface ResolveRouteCommand {
  tenantId: string;
  /** 显式解析目标 — {kind:"runtime"} 或 {kind:"agent", agentId}（专题01 冻结架构）。 */
  target: RouteTarget;
  routeScopeKey: string;
  businessKey: { threadId?: string; jobId?: string };
  attributes?: Record<string, RouteResolutionAttribute>;
  threadDefaultModelRef?: string | null;
  now?: Date;
}

export type RouteResolver = (command: ResolveRouteCommand) => Promise<RouteResolutionOutcome>;

/**
 * : 唯一 Resolver — 使用 Projection 作为唯一数据源。
 */
export function createResolveRoute(dependencies: {
  store: RouteEligibilityResolutionStore;
  now?: () => Date;
}): RouteResolver {
  const clock = dependencies.now ?? (() => new Date());
  return async (command) => {
    const candidates = await dependencies.store.loadCandidates({
      tenantId: command.tenantId,
      target: command.target,
      routeScopeKey: command.routeScopeKey,
    });
    return resolveRouteCandidates({
      tenantId: command.tenantId,
      target: command.target,
      routeScopeKey: command.routeScopeKey,
      businessKey: command.businessKey,
      attributes: command.attributes ?? {},
      threadDefaultModelRef: command.threadDefaultModelRef,
      candidates,
      now: command.now ?? clock(),
    });
  };
}
