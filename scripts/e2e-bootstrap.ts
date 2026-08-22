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
 * 由 `scripts/e2e-start.mts` 以子进程方式调用，DATABASE_URL 由父进程注入。
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { buildActor } from "@/lib/test-support/create-verified-attestation";
import { seedPublishedRuntimeRevision } from "@/lib/test-support/seed-published-runtime-revision";

const ROUTE_SCOPE_KEY = "default";

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

  const routeResult = await activateSingleRouteForTest({
    tenantId: tenant.id,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    agentRevisionId: null, // 基础 Harness Route（§8.3）
    runtimeRevisionId: runtimeRevision.id,
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(tenant.id, "deploy-bot-e2e"),
  });

  console.log(
    `[e2e-bootstrap] 基础 Harness Route 正式链就绪：runtimeRevision=${runtimeRevision.id} ` +
      `route=${routeResult.route.id} routeActivation=${routeResult.routeActivationId}（无默认 Agent，§15）`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("[e2e-bootstrap] 失败：", error);
  process.exit(1);
});
