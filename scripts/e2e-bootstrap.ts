/**
 * e2e 正式链引导（在 dev server 启动前执行）。
 *
 * 建出可执行的**基础 Harness Route** 正式链（§8.3 base route，agentRevisionId=null），
 * 使 Web / Desktop 客户端发送的首条消息能真正走通 §9.3 Employee Turn 热路径
 * Route Resolver → ExecutionBinding → Runtime，而不是在
 * `POST /api/v1/threads/{id}/turns` 因 `dispatched=false` 抛错。
 *
 * 专题01 §15：不再创建默认 Agent（Agent 空表是合法平台状态，§6.2/§33.1）；
 * 基础 Harness Runtime 初始化走正式 Runtime 控制面（§15.3/§11.4），不伪装成 Agent seed。
 * 故本脚本只装配 hosted Runtime → published RuntimeRevision → base RouteSet →
 * RouteActivation（agentRevisionId=null）→ RouteEligibilityProjection，全程走正式服务
 * 与正式验签器（复用 `lib/test-support/seed-published-runtime-revision.ts` 的 §11.2 合规说明）。
 *
 * 【关口 07 真实链】RouteActivation 后**不再直连 buildRouteEligibility**：
 * Projection 必须由真实 Outbox Delivery 链驱动——
 *   ActivateRouteSet（事务内 appendOutbox + seedEventDeliveries）
 *   → control-plane-outbox-worker 的 pollOnce()（claim delivery → projection event handler）
 *   → Projection Consumer → RouteEligibilityProjection。
 * pollOnce 复用 `scripts/workers/control-plane-outbox-worker.ts` 的真实装配，
 * 只是在一个进程内同步驱动单次投递（投递逻辑与 Worker 完全一致，见 07.3/07.4）。
 *
 * 由 `scripts/e2e-start.mts` 以子进程方式调用，DATABASE_URL 由父进程注入。
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { createOutboxRelayWorker } from "@/lib/control-plane/events/outbox-relay-worker";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { createActivateRouteSet } from "@/lib/routes/application/activate-route-set";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { mysqlRouteSetActivationStore } from "@/lib/routes/persistence/mysql-route-set-activation-store";
import { createBuildRouteEligibility } from "@/lib/routes/projection/build-route-eligibility";
import { mysqlRouteEligibilitySourceReader } from "@/lib/routes/projection/mysql-route-eligibility-source-reader";
import { mysqlRouteEligibilityStore } from "@/lib/routes/projection/mysql-route-eligibility-store";
import { createProjectionEventHandler } from "@/lib/routes/projection/projection-event-handlers";
import { buildActor } from "@/lib/test-support/create-verified-attestation";
import { seedPublishedRuntimeRevision } from "@/lib/test-support/seed-published-runtime-revision";

const ROUTE_SCOPE_KEY = "default";

// ─── 真实 Outbox Delivery → Projection Consumer 装配（与 control-plane-outbox-worker 一致）──
const buildRouteEligibility = createBuildRouteEligibility({ store: mysqlRouteEligibilityStore });
const projectionHandler = createProjectionEventHandler({
  store: mysqlRouteEligibilityStore,
  sourceReader: mysqlRouteEligibilitySourceReader,
  buildRouteEligibility,
});
// 只在本进程内同步消费：claim delivery → handler → complete（真实 Worker 投递逻辑，07.4）。
const outboxWorker = createOutboxRelayWorker(projectionHandler, { pollIntervalMs: 0 });

const activateRouteSet = createActivateRouteSet({ store: mysqlRouteSetActivationStore });

/** 驱动真实 Outbox Delivery Worker 消费一次，直到 RouteEligibilityProjection 落库。 */
async function drainOutboxForRoute(routeId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await outboxWorker.pollOnce();
    const projection = await mysqlRouteEligibilityStore.getProjectionByRoute(routeId);
    if (projection) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `真实 Outbox Delivery Worker 未驱动 RouteEligibilityProjection 落库（routeId=${routeId}）`,
  );
}

async function main(): Promise<void> {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });

  const suffix = randomUUID().slice(0, 8);
  const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
    tenant.id,
    identity.id,
    `hosted-${suffix}`,
    ["event_stream"],
    suffix,
  );

  const routeSet = await createRouteSet({
    tenantId: tenant.id,
    agentId: null, // 基础 Harness Route（§8.3）
    routeScopeKey: ROUTE_SCOPE_KEY,
    routeScopeJson: { networkZone: "internal" },
  });

  const requestId = randomUUID();
  // 正式 ActivateRouteSet：单事务写 RouteRevision + RouteActivation + Audit + Outbox + Delivery（07.4）。
  const activated = await activateRouteSet({
    tenantId: tenant.id,
    routeSetId: routeSet.id,
    expectedVersionNo: routeSet.versionNo,
    desiredRoutes: [
      {
        routeId: undefined,
        routeKey: "primary",
        routeGroupId: "primary",
        agentRevisionId: null, // 基础 Harness Route（§8.3，无 Agent 资产约束）
        runtimeRevisionId: runtimeRevision.id,
        policyRevisionId: null,
        modelPolicyRevisionId: null,
        toolsetRevisionId: null,
        trafficWeight: MAX_TRAFFIC_WEIGHT,
        priorityNo: 1,
        effectiveFrom: null,
        effectiveUntil: null,
        eligibilityConditions: {},
        activationState: "active",
      },
    ],
    actor: buildActor(tenant.id, "deploy-bot-e2e"),
    reason: "e2e 正式链引导（真实 Outbox 驱动 Projection）",
    requestId,
    idempotencyKey: `e2e-route-bootstrap:${randomUUID()}`,
  });
  const activation = activated.activations[0];
  if (!activation) throw new Error("e2e Route 激活结果缺失");

  // 真实 Outbox Delivery Worker 消费 route_set.activated → Projection Consumer 构建投影（07.3/07.4）。
  await drainOutboxForRoute(activation.routeId);

  console.log(
    `[e2e-bootstrap] 基础 Harness Route 正式链就绪：runtimeRevision=${runtimeRevision.id} route=${activation.routeId} routeActivation=${activation.routeActivationId}（无默认 Agent，§15；Projection 由真实 Outbox Worker 驱动，关口07）`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("[e2e-bootstrap] 失败：", error);
  process.exit(1);
});
