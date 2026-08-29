import { randomUUID } from "node:crypto";
import type { AuditActor } from "@/lib/identity/audit";
import type {
  DeploymentRouteRow,
  DeploymentRouteSetRow,
  RouteState,
} from "@/lib/persistence/schema/routes";
import { createActivateRouteSet } from "@/lib/routes/application/activate-route-set";
import { getRouteById, getRouteSetById } from "@/lib/routes/application/deployment-route-service";
import { createDisableRoute } from "@/lib/routes/application/disable-route";
import { mysqlRouteSetActivationStore } from "@/lib/routes/persistence/mysql-route-set-activation-store";
import { createBuildRouteEligibility } from "@/lib/routes/projection/build-route-eligibility";
import { mysqlRouteEligibilityStore } from "@/lib/routes/projection/mysql-route-eligibility-store";

// : Resolver 只读 RouteEligibilityProjection（投影是运行时唯一解析数据源）。
// 测试夹具在权威事实变更（激活/禁用）后须同步构建投影，解析器才能命中正确候选。
const buildRouteEligibility = createBuildRouteEligibility({ store: mysqlRouteEligibilityStore });
async function buildProjection(tenantId: string, routeId: string): Promise<void> {
  await buildRouteEligibility({ tenantId, routeId });
}

export interface ActivatedSingleRouteForTestResult {
  route: DeploymentRouteRow;
  routeSet: DeploymentRouteSetRow;
  routeRevisionId: string;
  routeActivationId: string;
  routeGroupId: string;
  etag: string;
  auditEventId: string;
  affectsNewInvocationsOnly: true;
}

const activateRouteSet = createActivateRouteSet({ store: mysqlRouteSetActivationStore });
const disableRoute = createDisableRoute({ store: mysqlRouteSetActivationStore });

/** 测试夹具只通过正式 RouteSet Activation / DisableRoute 创建单路由事实。 */
export async function activateSingleRouteForTest(params: {
  tenantId: string;
  routeSetId: string;
  routeId?: string;
  routeSetExpectedVersionNo: number;
  /** : null = 基础 Harness Route（无 Agent 资产约束，§8.3）。 */
  agentRevisionId: string | null;
  runtimeRevisionId: string;
  /**
   * 专题01 Batch4 补漏：Agent Route 生产调用事实。
   * agentRevisionId 非空时必须冻结；默认提供合法 facts（测试夹具构造合法路由）。
   * base route（agentRevisionId=null）必须为 undefined/null。
   */
  agentRouteFacts?: {
    agentEndpointRef: string;
    agentIdentityMode: "none" | "bearer";
    agentCredentialRefId: string | null;
    agentNetworkZone: string;
  };
  trafficWeight: number;
  priorityNo?: number;
  routeState?: RouteState;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  actor: AuditActor;
  requestId?: string;
  idempotencyKey?: string;
}): Promise<ActivatedSingleRouteForTestResult> {
  const requestId = params.requestId ?? randomUUID();
  const idempotencyKey = params.idempotencyKey ?? `test-route:${randomUUID()}`;
  if (params.routeState === "disabled") {
    if (!params.routeId) throw new Error("DisableRoute 测试夹具必须指定 routeId");
    const disabled = await disableRoute({
      tenantId: params.tenantId,
      routeSetId: params.routeSetId,
      routeId: params.routeId,
      expectedVersionNo: params.routeSetExpectedVersionNo,
      actor: params.actor,
      reason: "测试夹具禁用 Route",
      requestId,
      idempotencyKey,
    });
    const routeSet = await getRouteSetById(params.tenantId, params.routeSetId);
    if (!routeSet) throw new Error(`测试 RouteSet 不存在: ${params.routeSetId}`);
    await buildProjection(params.tenantId, params.routeId);
    return {
      route: disabled.route as DeploymentRouteRow,
      routeSet,
      routeRevisionId: disabled.routeRevisionId,
      routeActivationId: disabled.routeActivationId,
      routeGroupId: disabled.routeGroupId,
      etag: `route-set-${disabled.routeSetVersionNo}`,
      auditEventId: disabled.auditEventId,
      affectsNewInvocationsOnly: true,
    };
  }

  const activated = await activateRouteSet({
    tenantId: params.tenantId,
    routeSetId: params.routeSetId,
    expectedVersionNo: params.routeSetExpectedVersionNo,
    desiredRoutes: [
      {
        routeId: params.routeId,
        routeKey: "primary",
        routeGroupId: "primary",
        agentRevisionId: params.agentRevisionId,
        runtimeRevisionId: params.runtimeRevisionId,
        // 专题01 Batch4 补漏：agent route 冻结生产调用事实；base route 禁止携带。
        ...(params.agentRevisionId !== null
          ? {
              agentEndpointRef:
                params.agentRouteFacts?.agentEndpointRef ?? "https://agent.example.com/a2a",
              agentIdentityMode: params.agentRouteFacts?.agentIdentityMode ?? "bearer",
              agentCredentialRefId: params.agentRouteFacts?.agentCredentialRefId ?? "cred-1",
              agentNetworkZone: params.agentRouteFacts?.agentNetworkZone ?? "private",
            }
          : {}),
        policyRevisionId: null,
        modelPolicyRevisionId: null,
        toolsetRevisionId: null,
        trafficWeight: params.trafficWeight,
        priorityNo: params.priorityNo ?? 0,
        effectiveFrom: params.effectiveFrom ?? null,
        effectiveUntil: params.effectiveUntil ?? null,
        eligibilityConditions: {},
        activationState: "active",
      },
    ],
    actor: params.actor,
    reason: "测试夹具激活单 Route",
    requestId,
    idempotencyKey,
  });
  const activation = params.routeId
    ? activated.activations.find((item) => item.routeId === params.routeId)
    : activated.activations[0];
  if (!activation) throw new Error("测试 Route 激活结果缺失");
  const route = await getRouteById(params.tenantId, activation.routeId);
  const routeSet = await getRouteSetById(params.tenantId, params.routeSetId);
  if (!route || !routeSet) throw new Error("测试 Route 激活事实读取失败");
  await buildProjection(params.tenantId, activation.routeId);
  return {
    route,
    routeSet,
    routeRevisionId: activation.routeRevisionId,
    routeActivationId: activation.routeActivationId,
    routeGroupId: activation.routeGroupId,
    etag: `route-set-${activated.routeSetVersionNo}`,
    auditEventId: activated.auditEventId,
    affectsNewInvocationsOnly: true,
  };
}
