/**
 * 可复用的"可解析 Route 权威"装配。
 *
 * 从 `lib/executions/test-support/seed-runtime-authority.ts` 与 Job 集成测试抽出：
 * Thread 与 Job 的默认调度入口都要求 Tenant 下存在一条 runtime target 的 enabled Route
 * （Projection 是唯一数据源），测试夹具必须建出**真实**权威而不是伪造 Projection。
 */
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { buildActor } from "@/lib/test-support/create-verified-attestation";

export const DEFAULT_ROUTE_SCOPE_KEY = "default";

export interface RuntimeRouteAuthority {
  routeSetId: string;
  routeId: string;
  runtimeRevisionId: string;
}

/**
 * 为给定 RuntimeRevision 建出 runtime target 的 RouteSet + 单条启用 Route
 * （含 RouteActivation 与 RouteEligibilityProjection）。
 */
export async function seedRuntimeRouteAuthority(input: {
  tenantId: string;
  runtimeRevisionId: string;
  routeScopeKey?: string;
  routeScopeJson?: Record<string, unknown>;
  actorId?: string;
}): Promise<RuntimeRouteAuthority> {
  const routeScopeKey = input.routeScopeKey ?? DEFAULT_ROUTE_SCOPE_KEY;
  const routeSet = await createRouteSet({
    tenantId: input.tenantId,
    target: { kind: "runtime" },
    routeScopeKey,
    routeScopeJson: input.routeScopeJson ?? { networkZone: "internal" },
  });
  const activated = await activateSingleRouteForTest({
    tenantId: input.tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    target: { kind: "runtime", runtimeRevisionId: input.runtimeRevisionId },
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(input.tenantId, input.actorId ?? "fixture-deploy-bot"),
  });
  return {
    routeSetId: routeSet.id,
    routeId: activated.route.id,
    runtimeRevisionId: input.runtimeRevisionId,
  };
}
