import {
 type RouteResolutionAttribute,
 type RouteResolutionOutcome,
 resolveRouteCandidates,
} from "../domain/route-resolution-policy";
import type { RouteEligibilityResolutionStore } from "../persistence/route-eligibility-resolution-store";

export interface ResolveRouteCommand {
 tenantId: string;
 agentId: string;
 routeScopeKey: string;
 businessKey: { threadId?: string; jobId?: string };
 attributes?: Record<string, RouteResolutionAttribute>;
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
 agentId: command.agentId,
 routeScopeKey: command.routeScopeKey,
 });
 return resolveRouteCandidates({
 tenantId: command.tenantId,
 agentId: command.agentId,
 routeScopeKey: command.routeScopeKey,
 businessKey: command.businessKey,
 attributes: command.attributes ?? {},
 candidates,
 now: command.now ?? clock(),
 });
 };
}
