import { randomUUID } from "node:crypto";
/**
 * 员工端真实 Agent Catalog 集成测试（RED，tests-only）。
 *
 * 业务切片：员工 Web/Desktop 的真实 Agent 选择器（components/hooks/use-catalog.ts）
 * 调用 GET /api/v1/catalog/options?resource_type=agent&lifecycle_state=enabled，
 * 必须只展示「当前可通过 default 路由执行的 Agent」。
 *
 * 事实链（全部走生产实现，不 mock、不直接插投影、不手调 buildRouteEligibility）：
 * 1. 合同登记/Agent 仍 draft → API 空。
 * 2. 正式 createPublishAgentRevision 发布 + 真实 Outbox Delivery Worker
 *    （consumerName=route_projection）消费 agent.revision.published →
 *    权威 Agent 行刷新出 enabled CatalogEntry；但无 default eligible route 时 API 仍空。
 * 3. 正式 createRouteSet(routeScopeKey=default) + createActivateRouteSet →
 *    worker 消费 route_set.activated 建出 eligible projection → API 恰好返回该 Agent。
 * 4. 非 default 路由 / disabled route 不可见；多 eligible route 不重复。
 * 5. 正式撤回（createWithdrawAgentRevision）或禁用 route 后，worker 处理后 Agent 消失。
 * 6. 路由资格失效后旧 ETag 不得 304，必须 200 + 更高 CatalogRevision + 新 ETag。
 * 7. 跨租户 Agent/route 永不泄漏。
 * 8. 无 CatalogEntry 或无 eligible default route 均 fail-closed。
 * 9. Delivery 确实由 route_projection consumer 完成（state=completed）。
 *
 * 环境：APP_ENV=test + SNOW_AUTH_MODE=dev（员工身份 = DEFAULT_USER，默认租户）。
 */
import { GET as catalogOptionsGET } from "@/app/api/v1/catalog/options/route";
import { parseCatalogRevisionEtag } from "@/lib/admin/route-helpers";
import { createPublishAgentRevision } from "@/lib/agents/application/publish-agent-revision";
import { createWithdrawAgentRevision } from "@/lib/agents/application/withdraw-agent-revision";
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import { mysqlAgentPublicationStore } from "@/lib/agents/persistence/mysql-agent-publication-store";
import { mysqlAgentWithdrawalStore } from "@/lib/agents/persistence/mysql-agent-withdrawal-store";
import { createDraftRevisionWithContractSnapshot } from "@/lib/agents/test-support/create-draft-revision-with-contract";
import { getCatalogEntryByResource } from "@/lib/catalog/catalog-queries";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { controlPlaneEventDelivery } from "@/lib/control-plane/events/control-plane-event-delivery";
import { createOutboxRelayWorker } from "@/lib/control-plane/events/outbox-relay-worker";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { tenant } from "@/lib/persistence/schema/identity";
import { createActivateRouteSet } from "@/lib/routes/application/activate-route-set";
import { createRouteSet } from "@/lib/routes/application/deployment-route-service";
import { createDisableRoute } from "@/lib/routes/application/disable-route";
import { mysqlRouteSetActivationStore } from "@/lib/routes/persistence/mysql-route-set-activation-store";
import { createBuildRouteEligibility } from "@/lib/routes/projection/build-route-eligibility";
import { mysqlRouteEligibilitySourceReader } from "@/lib/routes/projection/mysql-route-eligibility-source-reader";
import { mysqlRouteEligibilityStore } from "@/lib/routes/projection/mysql-route-eligibility-store";
import { createProjectionEventHandler } from "@/lib/routes/projection/projection-event-handlers";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { ensureAgentContractSnapshotBoundForRevision } from "@/lib/test-support/ensure-agent-contract-snapshot";
import { seedPublishedRuntimeRevision } from "@/lib/test-support/seed-published-runtime-revision";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 装配：真实 Outbox Delivery Worker（route_projection consumer）─────────

function buildRealOutboxWorker() {
  const handler = createProjectionEventHandler({
    store: mysqlRouteEligibilityStore,
    sourceReader: mysqlRouteEligibilitySourceReader,
    buildRouteEligibility: createBuildRouteEligibility({ store: mysqlRouteEligibilityStore }),
  });
  return createOutboxRelayWorker(handler, {
    workerId: `catalog-test-worker-${randomUUID()}`,
    consumerName: "route_projection",
    batchSize: 100,
    pollIntervalMs: 0,
  });
}

/** 排空 Outbox：反复 pollOnce 直到没有可领取的 Delivery。 */
async function drainOutbox(worker: ReturnType<typeof buildRealOutboxWorker>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const claimed = await worker.pollOnce();
    if (claimed === 0) return;
  }
  throw new Error("Outbox 排空超时：50 轮 pollOnce 后仍有 Delivery 可领取");
}

/** 排空 Outbox 直到投影达到目标状态（真实 Worker 驱动，不手调 buildRouteEligibility）。 */
async function drainUntilProjectionState(
  worker: ReturnType<typeof buildRealOutboxWorker>,
  routeId: string,
  target: "eligible" | "ineligible",
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await drainOutbox(worker);
    const projection = await mysqlRouteEligibilityStore.getProjectionByRoute(routeId);
    if (projection?.eligibilityState === target) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`真实 Outbox Worker 未把投影驱动到 ${target}（routeId=${routeId}）`);
}

// ─── 装配：员工身份 + 正式控制面命令 ────────────────────────

async function seedEmployeeTenant() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  return { tenantId: tenant.id, ownerId: identity.id };
}

/** 创建 draft Agent + 已绑定合同快照的 draft AgentRevision（不发布）。 */
async function seedDraftAgent(tenantId: string, ownerId: string, agentKey: string) {
  const agent = await createAgent({
    tenantId,
    agentKey,
    displayName: `Agent ${agentKey}`,
    ownerUserId: ownerId,
    lifecycleState: "draft",
  });
  const revision = await createDraftRevisionWithContractSnapshot({
    tenantId,
    agentId: agent.id,
    modelPolicyJson: { default: "doubao-pro" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: { allowed_agent_ids: [] },
    agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
    createdBy: ownerId,
  });
  await ensureAgentContractSnapshotBoundForRevision(revision.id, tenantId);
  return { agent, revision };
}

/** 正式发布命令（同事务产生 agent.revision.published Outbox 事件）。 */
async function publishAgentRevisionFormal(tenantId: string, revisionId: string) {
  await createPublishAgentRevision({ store: mysqlAgentPublicationStore })({
    tenantId,
    revisionId,
    agentExpectedVersionNo: 1,
    actor: { tenantId, actorType: "system", actorId: "catalog-test-publisher" },
    requestId: `catalog-test-publish:${revisionId}`,
    idempotencyKey: `catalog-test-publish:${revisionId}`,
  });
}

/** 正式 RouteSet 激活（同事务产生 route_set.activated Outbox 事件）。 */
async function activateDefaultRouteFormal(params: {
  tenantId: string;
  routeSetId: string;
  expectedVersionNo: number;
  agentRevisionId: string;
  runtimeRevisionId: string;
  routeKeys?: string[];
}) {
  const routeKeys = params.routeKeys ?? ["primary"];
  return createActivateRouteSet({ store: mysqlRouteSetActivationStore })({
    tenantId: params.tenantId,
    routeSetId: params.routeSetId,
    expectedVersionNo: params.expectedVersionNo,
    desiredRoutes: routeKeys.map((routeKey, index) => ({
      routeKey,
      routeGroupId: routeKey,
      agentRevisionId: params.agentRevisionId,
      runtimeRevisionId: params.runtimeRevisionId,
      // 专题01 Batch4 补漏：agent route 必须冻结生产调用事实。
      agentEndpointRef: "https://agent.example.com/a2a",
      agentIdentityMode: "bearer" as const,
      agentCredentialRefId: "cred-1",
      agentNetworkZone: "private",
      trafficWeight: 10000,
      priorityNo: index + 1,
      eligibilityConditions: {},
      activationState: "active" as const,
    })),
    actor: { tenantId: params.tenantId, actorType: "service", actorId: "catalog-test-activator" },
    reason: "员工 Catalog 集成测试激活 default 路由",
    requestId: `catalog-test-activate:${params.routeSetId}:${params.expectedVersionNo}`,
    idempotencyKey: `catalog-test-activate:${params.routeSetId}:${params.expectedVersionNo}`,
  });
}

// ─── 装配：真实 Employee Catalog API 调用 ──────────────────

interface CatalogApiResponse {
  items: Array<{
    resource_type: string;
    resource_id: string;
    display_name: string;
    lifecycle_state: string;
  }>;
  next_cursor: string | null;
  catalog_revision: number;
}

/** 与 use-catalog.ts 完全一致的员工请求：resource_type=agent&lifecycle_state=enabled。 */
async function callEmployeeAgentCatalog(headers: Record<string, string> = {}): Promise<Response> {
  const request = buildApiRequest({
    audience: "employee",
    method: "GET",
    path: "/catalog/options?resource_type=agent&lifecycle_state=enabled",
    headers,
  });
  return catalogOptionsGET(request);
}

async function readCatalogItems(response: Response): Promise<CatalogApiResponse> {
  expect(response.status).toBe(200);
  return (await response.json()) as CatalogApiResponse;
}

/** 从响应头取裸 ETag（去引号），与 use-catalog.ts 的解析方式一致。 */
function rawEtagFrom(response: Response): string {
  const header = response.headers.get("etag") ?? response.headers.get("ETag");
  if (!header) throw new Error("Catalog API 响应缺少 ETag 头");
  return header.replace(/^W\//, "").replace(/^"|"$/g, "");
}

// ═══════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════

describe("员工端真实 Agent Catalog（default 路由资格过滤）", () => {
  it("1. Agent 仍 draft / 合同已登记但未发布 → 实际 API 返回空", async () => {
    const { tenantId, ownerId } = await seedEmployeeTenant();
    const { agent, revision } = await seedDraftAgent(tenantId, ownerId, "draft-only-agent");
    expect(revision.revisionState).toBe("draft");

    const worker = buildRealOutboxWorker();
    await drainOutbox(worker);

    const response = await callEmployeeAgentCatalog();
    const body = await readCatalogItems(response);
    expect(body.items).toHaveLength(0);
    expect(body.items.map((item) => item.resource_id)).not.toContain(agent.id);
  });

  it("2. 正式发布 + 真实 Worker 消费 agent.revision.published → CatalogEntry 刷新为 enabled，但无 default eligible route 时 API 仍空", async () => {
    const { tenantId, ownerId } = await seedEmployeeTenant();
    const { agent, revision } = await seedDraftAgent(tenantId, ownerId, "published-no-route");
    await publishAgentRevisionFormal(tenantId, revision.id);
    expect((await getRevisionById(revision.id))?.revisionState).toBe("published");

    const worker = buildRealOutboxWorker();
    await drainOutbox(worker);

    // 权威 Agent 行应被刷新为 enabled 的 CatalogEntry（由 Catalog 事件投影完成）。
    const entry = await getCatalogEntryByResource({
      tenantId,
      resourceType: "agent",
      resourceId: agent.id,
    });
    expect(entry, "agent.revision.published 消费后应存在 agent CatalogEntry").not.toBeNull();
    expect(entry?.lifecycleState).toBe("enabled");

    // 但没有 default eligible route → 员工实际 API 仍必须返回空。
    const body = await readCatalogItems(await callEmployeeAgentCatalog());
    expect(body.items.map((item) => item.resource_id)).not.toContain(agent.id);
  });

  it("3. default RouteSet 激活 + 真实 Worker 建出 eligible projection → API 恰好返回该 Agent，wire 字段正确", async () => {
    const { tenantId, ownerId } = await seedEmployeeTenant();
    const { agent, revision } = await seedDraftAgent(tenantId, ownerId, "default-visible-agent");
    await publishAgentRevisionFormal(tenantId, revision.id);
    const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
      tenantId,
      ownerId,
      "catalog-default-runtime",
      ["event_stream"],
      "catalog-default-rt",
    );

    const routeSet = await createRouteSet({
      tenantId,
      agentId: agent.id,
      routeScopeKey: "default",
      routeScopeJson: { networkZone: "internal" },
    });
    const activated = await activateDefaultRouteFormal({
      tenantId,
      routeSetId: routeSet.id,
      expectedVersionNo: routeSet.versionNo,
      agentRevisionId: revision.id,
      runtimeRevisionId: runtimeRevision.id,
    });
    const activation = activated.activations[0];
    if (!activation) throw new Error("default RouteSet 激活缺少 RouteActivation");

    const worker = buildRealOutboxWorker();
    await drainUntilProjectionState(worker, activation.routeId, "eligible");

    // Delivery 确实由 route_projection consumer 完成，不是手工调用冒充。
    const deliveries = await db.select().from(controlPlaneEventDelivery);
    expect(deliveries.length).toBeGreaterThanOrEqual(2);
    for (const delivery of deliveries) {
      expect(delivery.consumerName).toBe("route_projection");
      expect(delivery.state).toBe("completed");
    }

    const body = await readCatalogItems(await callEmployeeAgentCatalog());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      resource_type: "agent",
      resource_id: agent.id,
      display_name: agent.displayName,
      lifecycle_state: "enabled",
    });
  });

  it("4a. 只有非 default 路由（prod）且投影 eligible → API 仍不可见", async () => {
    const { tenantId, ownerId } = await seedEmployeeTenant();
    const { agent, revision } = await seedDraftAgent(tenantId, ownerId, "prod-only-agent");
    await publishAgentRevisionFormal(tenantId, revision.id);
    const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
      tenantId,
      ownerId,
      "catalog-prod-runtime",
      ["event_stream"],
      "catalog-prod-rt",
    );

    const routeSet = await createRouteSet({
      tenantId,
      agentId: agent.id,
      routeScopeKey: "prod",
      routeScopeJson: { networkZone: "internal" },
    });
    const activated = await activateDefaultRouteFormal({
      tenantId,
      routeSetId: routeSet.id,
      expectedVersionNo: routeSet.versionNo,
      agentRevisionId: revision.id,
      runtimeRevisionId: runtimeRevision.id,
    });
    const activation = activated.activations[0];
    if (!activation) throw new Error("prod RouteSet 激活缺少 RouteActivation");

    const worker = buildRealOutboxWorker();
    await drainUntilProjectionState(worker, activation.routeId, "eligible");

    // 投影确实是 eligible（default 之外的 scope），但员工 default 请求不可见。
    const [projection] = await db
      .select()
      .from(routeEligibilityProjection)
      .where(eq(routeEligibilityProjection.routeId, activation.routeId))
      .limit(1);
    expect(projection?.eligibilityState).toBe("eligible");

    const body = await readCatalogItems(await callEmployeeAgentCatalog());
    expect(body.items.map((item) => item.resource_id)).not.toContain(agent.id);
  });

  it("4b. 同一 Agent 多条 eligible default route → 不得重复返回", async () => {
    const { tenantId, ownerId } = await seedEmployeeTenant();
    const { agent, revision } = await seedDraftAgent(tenantId, ownerId, "multi-route-agent");
    await publishAgentRevisionFormal(tenantId, revision.id);
    const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
      tenantId,
      ownerId,
      "catalog-multi-runtime",
      ["event_stream"],
      "catalog-multi-rt",
    );

    const routeSet = await createRouteSet({
      tenantId,
      agentId: agent.id,
      routeScopeKey: "default",
      routeScopeJson: { networkZone: "internal" },
    });
    const activated = await activateDefaultRouteFormal({
      tenantId,
      routeSetId: routeSet.id,
      expectedVersionNo: routeSet.versionNo,
      agentRevisionId: revision.id,
      runtimeRevisionId: runtimeRevision.id,
      routeKeys: ["primary", "secondary"],
    });
    expect(activated.activations).toHaveLength(2);

    const worker = buildRealOutboxWorker();
    for (const activation of activated.activations) {
      await drainUntilProjectionState(worker, activation.routeId, "eligible");
    }

    const body = await readCatalogItems(await callEmployeeAgentCatalog());
    const ids = body.items.map((item) => item.resource_id);
    expect(ids.filter((id) => id === agent.id)).toHaveLength(1);
  });

  it("5a. 禁用 default route（正式 DisableRoute + 真实 Worker 消费 route.disabled）→ Agent 从 API 消失", async () => {
    const { tenantId, ownerId } = await seedEmployeeTenant();
    const { agent, revision } = await seedDraftAgent(tenantId, ownerId, "disable-route-agent");
    await publishAgentRevisionFormal(tenantId, revision.id);
    const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
      tenantId,
      ownerId,
      "catalog-disable-runtime",
      ["event_stream"],
      "catalog-disable-rt",
    );

    const routeSet = await createRouteSet({
      tenantId,
      agentId: agent.id,
      routeScopeKey: "default",
      routeScopeJson: { networkZone: "internal" },
    });
    const activated = await activateDefaultRouteFormal({
      tenantId,
      routeSetId: routeSet.id,
      expectedVersionNo: routeSet.versionNo,
      agentRevisionId: revision.id,
      runtimeRevisionId: runtimeRevision.id,
    });
    const activation = activated.activations[0];
    if (!activation) throw new Error("disable 用例缺少 RouteActivation");

    const worker = buildRealOutboxWorker();
    await drainUntilProjectionState(worker, activation.routeId, "eligible");
    const visible = await readCatalogItems(await callEmployeeAgentCatalog());
    expect(visible.items.map((item) => item.resource_id)).toContain(agent.id);

    await createDisableRoute({ store: mysqlRouteSetActivationStore })({
      tenantId,
      routeSetId: routeSet.id,
      routeId: activation.routeId,
      expectedVersionNo: activated.routeSetVersionNo,
      actor: { tenantId, actorType: "service", actorId: "catalog-test-disabler" },
      reason: "员工 Catalog 集成测试禁用 default 路由",
      requestId: `catalog-test-disable:${activation.routeId}`,
      idempotencyKey: `catalog-test-disable:${activation.routeId}`,
    });
    await drainUntilProjectionState(worker, activation.routeId, "ineligible");

    const after = await readCatalogItems(await callEmployeeAgentCatalog());
    expect(after.items.map((item) => item.resource_id)).not.toContain(agent.id);
  });

  it("5b. 正式撤回 AgentRevision（产生 agent.revision.withdrawn）+ 真实 Worker 处理 → Agent 从 API 消失", async () => {
    const { tenantId, ownerId } = await seedEmployeeTenant();
    const { agent, revision } = await seedDraftAgent(tenantId, ownerId, "withdraw-agent");
    await publishAgentRevisionFormal(tenantId, revision.id);
    const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
      tenantId,
      ownerId,
      "catalog-withdraw-runtime",
      ["event_stream"],
      "catalog-withdraw-rt",
    );

    const routeSet = await createRouteSet({
      tenantId,
      agentId: agent.id,
      routeScopeKey: "default",
      routeScopeJson: { networkZone: "internal" },
    });
    const activated = await activateDefaultRouteFormal({
      tenantId,
      routeSetId: routeSet.id,
      expectedVersionNo: routeSet.versionNo,
      agentRevisionId: revision.id,
      runtimeRevisionId: runtimeRevision.id,
    });
    const activation = activated.activations[0];
    if (!activation) throw new Error("withdraw 用例缺少 RouteActivation");

    const worker = buildRealOutboxWorker();
    await drainUntilProjectionState(worker, activation.routeId, "eligible");
    const visible = await readCatalogItems(await callEmployeeAgentCatalog());
    expect(visible.items.map((item) => item.resource_id)).toContain(agent.id);

    const currentAgent = await getAgentById(tenantId, agent.id);
    if (!currentAgent) throw new Error("withdraw 用例 Agent 不存在");
    await createWithdrawAgentRevision({ store: mysqlAgentWithdrawalStore })({
      tenantId,
      revisionId: revision.id,
      agentExpectedVersionNo: currentAgent.versionNo,
      actor: { tenantId, actorType: "service", actorId: "catalog-test-withdrawer" },
      reasonCode: "agent_lifecycle_withdraw",
      reason: "员工 Catalog 集成测试撤回",
      requestId: `catalog-test-withdraw:${revision.id}`,
    });
    expect((await getRevisionById(revision.id))?.revisionState).toBe("withdrawn");
    await drainUntilProjectionState(worker, activation.routeId, "ineligible");

    const after = await readCatalogItems(await callEmployeeAgentCatalog());
    expect(after.items.map((item) => item.resource_id)).not.toContain(agent.id);
  });

  it("6. 路由资格失效后旧 ETag 不得 304：必须 200 + 空列表 + 更高 CatalogRevision + 新 ETag", async () => {
    const { tenantId, ownerId } = await seedEmployeeTenant();
    const { agent, revision } = await seedDraftAgent(tenantId, ownerId, "etag-agent");
    await publishAgentRevisionFormal(tenantId, revision.id);
    const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
      tenantId,
      ownerId,
      "catalog-etag-runtime",
      ["event_stream"],
      "catalog-etag-rt",
    );

    const routeSet = await createRouteSet({
      tenantId,
      agentId: agent.id,
      routeScopeKey: "default",
      routeScopeJson: { networkZone: "internal" },
    });
    const activated = await activateDefaultRouteFormal({
      tenantId,
      routeSetId: routeSet.id,
      expectedVersionNo: routeSet.versionNo,
      agentRevisionId: revision.id,
      runtimeRevisionId: runtimeRevision.id,
    });
    const activation = activated.activations[0];
    if (!activation) throw new Error("ETag 用例缺少 RouteActivation");

    const worker = buildRealOutboxWorker();
    await drainUntilProjectionState(worker, activation.routeId, "eligible");

    const first = await callEmployeeAgentCatalog();
    const firstBody = await readCatalogItems(first);
    expect(firstBody.items.map((item) => item.resource_id)).toContain(agent.id);
    const firstEtag = rawEtagFrom(first);
    const firstRevision = parseCatalogRevisionEtag(firstEtag);

    await createDisableRoute({ store: mysqlRouteSetActivationStore })({
      tenantId,
      routeSetId: routeSet.id,
      routeId: activation.routeId,
      expectedVersionNo: activated.routeSetVersionNo,
      actor: { tenantId, actorType: "service", actorId: "catalog-test-disabler" },
      reason: "员工 Catalog ETag 失效测试禁用 default 路由",
      requestId: `catalog-test-etag-disable:${activation.routeId}`,
      idempotencyKey: `catalog-test-etag-disable:${activation.routeId}`,
    });
    await drainUntilProjectionState(worker, activation.routeId, "ineligible");

    const second = await callEmployeeAgentCatalog({ "if-none-match": `"${firstEtag}"` });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as CatalogApiResponse;
    expect(secondBody.items).toHaveLength(0);
    const secondEtag = rawEtagFrom(second);
    const secondRevision = parseCatalogRevisionEtag(secondEtag);
    expect(secondRevision).toBeGreaterThan(firstRevision);
    expect(secondBody.catalog_revision).toBe(secondRevision);
    expect(secondBody.catalog_revision).toBeGreaterThan(firstBody.catalog_revision);
    expect(secondEtag).not.toBe(firstEtag);
  });

  it("7. 跨租户 Agent/route（完整正式链 + eligible projection）→ 员工 API 永不泄漏", async () => {
    const { tenantId, ownerId } = await seedEmployeeTenant();

    // 另一租户：插入真实 Tenant 根行（多租户阶段尚无 createTenant 命令），
    // 再完整走正式发布 + default 路由激活链。
    const foreignTenantId = randomUUID();
    await db.insert(tenant).values({
      id: foreignTenantId,
      key: `foreign-${foreignTenantId.slice(0, 8)}`,
      name: "Foreign Tenant",
      status: "active",
    });
    const foreignOwner = await upsertUserIdentity({
      tenantId: foreignTenantId,
      externalSubject: "foreign-catalog-owner",
      email: "foreign-catalog-owner@example.com",
      displayName: "Foreign Catalog Owner",
    });
    const { agent, revision } = await seedDraftAgent(
      foreignTenantId,
      foreignOwner.id,
      "foreign-agent",
    );
    await publishAgentRevisionFormal(foreignTenantId, revision.id);
    const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
      foreignTenantId,
      foreignOwner.id,
      "foreign-runtime",
      ["event_stream"],
      "foreign-rt",
    );
    const routeSet = await createRouteSet({
      tenantId: foreignTenantId,
      agentId: agent.id,
      routeScopeKey: "default",
      routeScopeJson: { networkZone: "internal" },
    });
    const activated = await activateDefaultRouteFormal({
      tenantId: foreignTenantId,
      routeSetId: routeSet.id,
      expectedVersionNo: routeSet.versionNo,
      agentRevisionId: revision.id,
      runtimeRevisionId: runtimeRevision.id,
    });
    const activation = activated.activations[0];
    if (!activation) throw new Error("跨租户用例缺少 RouteActivation");

    const worker = buildRealOutboxWorker();
    await drainUntilProjectionState(worker, activation.routeId, "eligible");

    // 员工身份固定解析到默认租户：跨租户 Agent 不得出现。
    const body = await readCatalogItems(await callEmployeeAgentCatalog());
    expect(body.items.map((item) => item.resource_id)).not.toContain(agent.id);
    expect(tenantId).not.toBe(foreignTenantId);
  });

  it("8. fail-closed：无 CatalogEntry（draft）或无 default eligible route（仅 pending RouteSet）→ API 均为空", async () => {
    const { tenantId, ownerId } = await seedEmployeeTenant();

    // 无 CatalogEntry：Agent 仍 draft，从未发布。
    const { agent: draftAgent } = await seedDraftAgent(tenantId, ownerId, "failclosed-draft");
    const entry = await getCatalogEntryByResource({
      tenantId,
      resourceType: "agent",
      resourceId: draftAgent.id,
    });
    expect(entry).toBeNull();

    // 无 eligible default route：Agent 已发布，但 RouteSet 从未激活（pending）。
    const { agent: pendingAgent, revision: pendingRevision } = await seedDraftAgent(
      tenantId,
      ownerId,
      "failclosed-pending",
    );
    await publishAgentRevisionFormal(tenantId, pendingRevision.id);
    await createRouteSet({
      tenantId,
      agentId: pendingAgent.id,
      routeScopeKey: "default",
      routeScopeJson: { networkZone: "internal" },
    });

    const worker = buildRealOutboxWorker();
    await drainOutbox(worker);
    const projections = await db.select().from(routeEligibilityProjection);
    expect(projections).toHaveLength(0);

    const body = await readCatalogItems(await callEmployeeAgentCatalog());
    expect(body.items).toHaveLength(0);
  });
});
