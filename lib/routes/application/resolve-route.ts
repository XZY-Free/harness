import {
  type RouteResolutionAttribute,
  type RouteResolutionOutcome,
  resolveRouteCandidates,
} from "../domain/route-resolution-policy";
import type { RouteEligibilityResolutionStore } from "../persistence/route-eligibility-resolution-store";

export interface ResolveRouteCommand {
  tenantId: string;
  /**
   * 调用方显式提供的可选 Agent 控制面约束（§8.3）。
   * null = 无 Agent 约束，解析基础 Harness Route；concrete = 带 Agent 约束。
   */
  agentConstraint?: string | null;
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
      agentConstraint: command.agentConstraint ?? null,
      routeScopeKey: command.routeScopeKey,
    });
    return resolveRouteCandidates({
      tenantId: command.tenantId,
      agentConstraint: command.agentConstraint ?? null,
      routeScopeKey: command.routeScopeKey,
      businessKey: command.businessKey,
      attributes: command.attributes ?? {},
      threadDefaultModelRef: command.threadDefaultModelRef,
      candidates,
      now: command.now ?? clock(),
    });
  };
}
