/**
 * S03-C05：Admin API route handlers 集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖 4 个 Admin API 路由：
 * - POST /admin/api/v1/agents/{agent_id}/revisions — 创建 AgentRevision。
 * - POST /admin/api/v1/agent-revisions/{revision_id}/publish — 发布 AgentRevision（attestation 门禁）。
 * - POST /admin/api/v1/artifact-attestations/verify — 验证制品证明。
 * - POST /admin/api/v1/deployment-routes/{route_id}/disable — 禁用 DeploymentRoute。
 *
 * 测试环境：APP_ENV=test，auth mode=dev（resolvePrincipal 使用 DEFAULT_USER_ID）。
 * 真实 ed25519 签名 + 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { POST as publishPOST } from "@/app/admin/api/v1/agent-revisions/[revision_id]/publish/route";
import { GET as getAgentRevisionGET } from "@/app/admin/api/v1/agent-revisions/[revision_id]/route";
import { POST as withdrawAgentRevisionPOST } from "@/app/admin/api/v1/agent-revisions/[revision_id]/withdraw/route";
import { POST as createRevisionPOST } from "@/app/admin/api/v1/agents/[agent_id]/revisions/route";
import { GET as getAgentGET } from "@/app/admin/api/v1/agents/[agent_id]/route";
import { POST as verifyPOST } from "@/app/admin/api/v1/artifact-attestations/verify/route";
import { PUT as activateRouteSetPUT } from "@/app/admin/api/v1/deployment-route-sets/[route_set_id]/activation/route";
import { POST as disableRoutePOST } from "@/app/admin/api/v1/deployment-routes/[route_id]/disable/route";
import { createAgent, getAgentById } from "@/lib/agents/persistence/agent-queries";
import {
  createDraftRevision,
  getRevisionById,
} from "@/lib/agents/persistence/agent-revision-queries";
import { createDraftRevisionWithContractSnapshot } from "@/lib/agents/test-support/create-draft-revision-with-contract";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import {
  resetArtifactStoreOverrides,
  setArtifactStoreOverride,
  setBuilderKeyRegistryOverride,
} from "@/lib/artifacts/infrastructure/artifact-store-provider";
import { listAttestationsByRevision } from "@/lib/artifacts/persistence/artifact-attestation-reader";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-writer";
import {
  type PredicateSupplyChain,
  type TestBuilderKey,
  buildDsseArtifactAttestationEnvelope,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import type { ActivateRouteSetResponse } from "@/lib/control-plane-client/contracts/route";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { db } from "@/lib/db/client";
import { assertCrossTenantHidden, buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { findIdempotencyRecord } from "@/lib/identity/idempotency-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { auditEvent, idempotencyRecord } from "@/lib/persistence/schema/control-plane";
import { deploymentRouteTable } from "@/lib/persistence/schema/routes";
import { getPublicationRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import { createActivateRouteSet } from "@/lib/routes/application/activate-route-set";
import { createRouteSet, getRouteSetById } from "@/lib/routes/application/deployment-route-service";
import { RouteIdempotencyCompletionError } from "@/lib/routes/domain/route-revision";
import { mysqlRouteSetActivationStore } from "@/lib/routes/persistence/mysql-route-set-activation-store";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { ensureAgentContractSnapshotBoundForRevision } from "@/lib/test-support/ensure-agent-contract-snapshot";
import { publishTrustedAgentRevisionForTest } from "@/lib/test-support/publish-trusted-agent-revision";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 identity.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  resetArtifactStoreOverrides();
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：InMemoryManagedArtifactStore ────────────────────

class InMemoryManagedArtifactStore implements ManagedArtifactStore {
  private envelopes = new Map<string, Buffer>();
  private sboms = new Map<string, unknown>();
  private provenances = new Map<string, ProvenanceDocument>();

  writeDsseEnvelope(ref: string, envelope: Buffer): void {
    this.envelopes.set(ref, envelope);
  }
  writeSbom(ref: string, doc: unknown): void {
    this.sboms.set(ref, doc);
  }
  writeProvenance(ref: string, doc: ProvenanceDocument): void {
    this.provenances.set(ref, doc);
  }

  async readDsseEnvelope(ref: string): Promise<Buffer> {
    const envelope = this.envelopes.get(ref);
    if (!envelope) throw new Error(`DSSE envelope not found: ${ref}`);
    return envelope;
  }
  async readSbom(ref: string): Promise<unknown> {
    const doc = this.sboms.get(ref);
    if (!doc) throw new Error(`sbom not found: ${ref}`);
    return doc;
  }
  async readProvenance(ref: string): Promise<ProvenanceDocument> {
    const doc = this.provenances.get(ref);
    if (!doc) throw new Error(`provenance not found: ${ref}`);
    return doc;
  }
}

// ─── 辅助：ed25519 密钥对 + DSSE Envelope（来自 test-support） ──

function buildCleanSbom(): unknown {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { type: "application", name: "test-app", version: "1.0.0" } },
    components: [
      {
        type: "library",
        name: "lodash",
        version: "4.17.21",
        licenses: [{ license: { id: "MIT" } }],
      },
    ],
  };
}

function buildValidProvenance(): ProvenanceDocument {
  return {
    sourceRevision: "git_commit_1",
    buildPipeline: "ci-cd-pipeline-1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  };
}

// ─── 辅助：seed admin 用户 + action bindings ────────────────

async function seedAdminWithActionBindings() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "agent.revision.create",
    resourceScope: { type: "agent", wildcard: true },
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "agent.retract",
    resourceScope: { type: "agent", wildcard: true },
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "agent.publish",
    resourceScope: { type: "agent", wildcard: true },
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "artifact.attestation.verify",
    resourceScope: { type: "artifact_type", wildcard: true },
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "route.update",
    resourceScope: { type: "agent", wildcard: true },
  });
  return { tenantId: tenant.id, userIdentityId: identity.id };
}

// ─── 辅助：seed Agent + published AgentRevision + attestation ─

async function seedPublishedAgentRevision(
  tenantId: string,
  ownerId: string,
  agentKey: string,
  contentSuffix: string,
  lifecycleState: "draft" | "enabled" = "draft",
) {
  const agent = await createAgent({
    tenantId,
    agentKey,
    displayName: `Agent ${agentKey}`,
    ownerUserId: ownerId,
    lifecycleState,
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

  // Agent 是源码不可见黑盒：发布权威 = AgentContractSnapshot，无 Attestation。
  await publishTrustedAgentRevisionForTest({
    tenantId,
    revisionId: revision.id,
    agentExpectedVersionNo: 1,
    actorId: ownerId,
  });

  return { agent, revision };
}

describe("PUT /admin/api/v1/deployment-route-sets/{route_set_id}/activation", () => {
  it("连续激活同一 Route 时返回完整 previous Activation 历史", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const agentResult = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "route-set-api-agent",
      "route-set-api-agent-v1",
      "enabled",
    );
    const routeSet = await createRouteSet({
      tenantId,
      target: { kind: "agent", agentId: agentResult.agent.id },
      routeScopeKey: "prod",
      routeScopeJson: { networkZone: "internal" },
    });

    const buildActivationRequest = (
      expectedVersionNo: number,
      idempotencyKey: string,
      routeId?: string,
    ) =>
      buildApiRequest({
        audience: "admin",
        method: "PUT",
        path: `/deployment-route-sets/${routeSet.id}/activation`,
        idempotencyKey,
        ifMatch: `route-set-${expectedVersionNo}`,
        body: {
          expected_version_no: expectedVersionNo,
          reason: "验证 RouteSet Activation 历史字段",
          routes: [
            {
              ...(routeId ? { route_id: routeId } : {}),
              route_group_id: "primary",
              // 判别 target：agent RouteRevision 只携带 Agent 事实，绝不携带 runtime_revision_id。
              target: {
                kind: "agent",
                agent_revision_id: agentResult.revision.id,
                endpoint_ref: "https://agent.example.com/a2a",
                identity_mode: "bearer",
                credential_ref_id: "cred-1",
                network_zone: "private",
              },
              traffic_weight: 10000,
              priority_no: 1,
              activation_state: "active",
            },
          ],
        },
      });

    const firstResponse = await activateRouteSetPUT(
      buildActivationRequest(1, "idem-route-set-api-001"),
      { params: Promise.resolve({ route_set_id: routeSet.id }) },
    );
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as ActivateRouteSetResponse;
    const firstActivation = firstBody.activations[0]!;
    expect(firstActivation).toHaveProperty("previous_route_revision_id", null);
    expect(firstActivation).toHaveProperty("previous_route_activation_id", null);

    // 落库 RouteRevision：agent target → runtimeRevisionId=null，Agent endpoint facts 精确。
    const [persistedRevision] = await db
      .select()
      .from(routeRevision)
      .where(eq(routeRevision.routeSetId, routeSet.id));
    expect(persistedRevision).toBeDefined();
    expect(persistedRevision?.runtimeRevisionId).toBeNull();
    expect(persistedRevision?.agentRevisionId).toBe(agentResult.revision.id);
    expect(persistedRevision?.agentEndpointRef).toBe("https://agent.example.com/a2a");
    expect(persistedRevision?.agentIdentityMode).toBe("bearer");
    expect(persistedRevision?.agentCredentialRefId).toBe("cred-1");
    expect(persistedRevision?.agentNetworkZone).toBe("private");

    const replayResponse = await activateRouteSetPUT(
      buildActivationRequest(1, "idem-route-set-api-001"),
      { params: Promise.resolve({ route_set_id: routeSet.id }) },
    );
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toEqual(firstBody);

    const idempotency = await findIdempotencyRecord({
      tenantId,
      audience: "admin",
      callerType: "user",
      callerId: userIdentityId,
      commandScope: `route_set.activate:${routeSet.id}`,
      idempotencyKey: "idem-route-set-api-001",
    });
    expect(idempotency?.processingState).toBe("completed");
    expect(idempotency?.responseRedactedJson).toBe(JSON.stringify(firstBody));
    expect(
      await db.select().from(routeActivation).where(eq(routeActivation.routeSetId, routeSet.id)),
    ).toHaveLength(1);

    if (!idempotency) throw new Error("RouteSet IdempotencyRecord 未创建");
    await db
      .update(idempotencyRecord)
      .set({ responseRedactedJson: '{"foo":"bar"}' })
      .where(eq(idempotencyRecord.id, idempotency.id));
    await expect(
      activateRouteSetPUT(buildActivationRequest(1, "idem-route-set-api-001"), {
        params: Promise.resolve({ route_set_id: routeSet.id }),
      }),
    ).rejects.toThrow("completed 记录响应结构非法");
    await db
      .update(idempotencyRecord)
      .set({ responseRedactedJson: JSON.stringify(firstBody) })
      .where(eq(idempotencyRecord.id, idempotency.id));

    const secondResponse = await activateRouteSetPUT(
      buildActivationRequest(2, "idem-route-set-api-002", firstActivation.route_id),
      { params: Promise.resolve({ route_set_id: routeSet.id }) },
    );
    expect(secondResponse.status).toBe(200);
    const secondBody = (await secondResponse.json()) as ActivateRouteSetResponse;
    const secondActivation = secondBody.activations[0]!;
    expect(secondActivation.previous_route_revision_id).toBe(firstActivation.route_revision_id);
    expect(secondActivation.previous_route_activation_id).toBe(firstActivation.route_activation_id);
  });

  it("IdempotencyRecord authority 缺失时事务不留下任何 RouteSet 激活事实", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const agentResult = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "route-set-missing-authority-agent",
      "route-set-missing-authority-agent-v1",
      "enabled",
    );
    const routeSet = await createRouteSet({
      tenantId,
      target: { kind: "agent", agentId: agentResult.agent.id },
      routeScopeKey: "missing-authority",
      routeScopeJson: {},
    });
    const activateRouteSet = createActivateRouteSet({ store: mysqlRouteSetActivationStore });

    await expect(
      activateRouteSet({
        tenantId,
        routeSetId: routeSet.id,
        expectedVersionNo: 1,
        desiredRoutes: [
          {
            routeKey: "primary",
            routeGroupId: "primary",
            // 判别 target — agent RouteRevision 只携带 Agent 事实，不携带 runtimeRevisionId。
            target: {
              kind: "agent",
              agentRevisionId: agentResult.revision.id,
              agentEndpointRef: "https://agent.example.com/a2a",
              agentIdentityMode: "bearer",
              agentCredentialRefId: "cred-1",
              agentNetworkZone: "private",
            },
            trafficWeight: 10000,
            priorityNo: 1,
            activationState: "active",
          },
        ],
        actor: { tenantId, actorType: "user", actorId: userIdentityId },
        reason: "验证 authority 缺失回滚",
        requestId: "req-route-set-missing-authority",
        idempotencyKey: "idem-route-set-missing-authority",
        idempotencyCompletion: {
          recordId: "missing-idempotency-record",
          httpStatus: 200,
          serializeResponse: JSON.stringify,
        },
      }),
    ).rejects.toThrow(RouteIdempotencyCompletionError);

    expect(
      await db.select().from(routeRevision).where(eq(routeRevision.routeSetId, routeSet.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(routeActivation).where(eq(routeActivation.routeSetId, routeSet.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(deploymentRouteTable)
        .where(eq(deploymentRouteTable.routeSetId, routeSet.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(auditEvent).where(eq(auditEvent.targetId, routeSet.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(eq(controlPlaneOutboxEvent.aggregateId, routeSet.id)),
    ).toHaveLength(0);
    expect((await getRouteSetById(tenantId, routeSet.id))?.versionNo).toBe(1);
  });

  it("旧 flat payload（agent_revision_id/runtime_revision_id/agent_endpoint_ref）→ 400 且零落库", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const agentResult = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "route-set-flat-reject-agent",
      "flat-v1",
      "enabled",
    );
    const routeSet = await createRouteSet({
      tenantId,
      target: { kind: "agent", agentId: agentResult.agent.id },
      routeScopeKey: "flat-reject",
      routeScopeJson: {},
    });

    // 冻结架构拒绝 flat/nullable 双轨：agent target 不得携带 runtime 事实，也不得用扁平字段猜测。
    const flatBodies = [
      // 旧混合双轨形状：同时携带 agent 与 runtime 事实。
      {
        expected_version_no: 1,
        reason: "legacy mixed flat payload",
        routes: [
          {
            route_group_id: "primary",
            agent_revision_id: agentResult.revision.id,
            runtime_revision_id: "rtrv-legacy",
            agent_endpoint_ref: "https://agent.example.com/a2a",
            agent_identity_mode: "bearer",
            agent_credential_ref_id: "cred-1",
            agent_network_zone: "private",
            traffic_weight: 10000,
            priority_no: 1,
          },
        ],
      },
      // 旧 flat agent-only（无 target 包装）。
      {
        expected_version_no: 1,
        reason: "legacy flat agent payload",
        routes: [
          {
            route_group_id: "primary",
            agent_revision_id: agentResult.revision.id,
            agent_endpoint_ref: "https://agent.example.com/a2a",
            agent_identity_mode: "bearer",
            agent_credential_ref_id: "cred-1",
            agent_network_zone: "private",
            traffic_weight: 10000,
            priority_no: 1,
          },
        ],
      },
    ];

    for (let i = 0; i < flatBodies.length; i++) {
      const response = await activateRouteSetPUT(
        buildApiRequest({
          audience: "admin",
          method: "PUT",
          path: `/deployment-route-sets/${routeSet.id}/activation`,
          idempotencyKey: `idem-route-set-flat-reject-${i}`,
          ifMatch: "route-set-1",
          body: flatBodies[i],
        }),
        { params: Promise.resolve({ route_set_id: routeSet.id }) },
      );
      expect(response.status).toBe(400);
    }

    expect(
      await db.select().from(routeRevision).where(eq(routeRevision.routeSetId, routeSet.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(routeActivation).where(eq(routeActivation.routeSetId, routeSet.id)),
    ).toHaveLength(0);
  });

  it("nested target omitted/null/extra key/cross-group → fail-closed 400 且零落库", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const agentResult = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "route-set-nested-reject-agent",
      "nested-v1",
      "enabled",
    );
    const routeSet = await createRouteSet({
      tenantId,
      target: { kind: "agent", agentId: agentResult.agent.id },
      routeScopeKey: "nested-reject",
      routeScopeJson: {},
    });
    const validTarget = {
      kind: "agent",
      agent_revision_id: agentResult.revision.id,
      endpoint_ref: "https://agent.example.com/a2a",
      identity_mode: "bearer",
      credential_ref_id: "cred-1",
      network_zone: "private",
    };

    const badBodies = [
      // target 整体缺失。
      {
        expected_version_no: 1,
        reason: "missing target",
        routes: [{ route_group_id: "primary", traffic_weight: 10000, priority_no: 1 }],
      },
      // target = null。
      {
        expected_version_no: 1,
        reason: "null target",
        routes: [
          { route_group_id: "primary", target: null, traffic_weight: 10000, priority_no: 1 },
        ],
      },
      // cross-group：agent target 不得携带对侧 runtime 字段。
      {
        expected_version_no: 1,
        reason: "cross-group target",
        routes: [
          {
            route_group_id: "primary",
            target: { ...validTarget, runtime_revision_id: "rtrv-x" },
            traffic_weight: 10000,
            priority_no: 1,
          },
        ],
      },
      // target 额外 key。
      {
        expected_version_no: 1,
        reason: "extra key",
        routes: [
          {
            route_group_id: "primary",
            target: { ...validTarget, agent_extra: "x" },
            traffic_weight: 10000,
            priority_no: 1,
          },
        ],
      },
      // route_id 类型非法：不得在映射阶段抛异常或生成空串身份。
      {
        expected_version_no: 1,
        reason: "invalid route id",
        routes: [
          {
            route_id: 42,
            route_group_id: "primary",
            target: validTarget,
            traffic_weight: 10000,
            priority_no: 1,
          },
        ],
      },
      // 顶层 extra key。
      {
        expected_version_no: 1,
        reason: "top-level extra key",
        routes: [
          {
            route_group_id: "primary",
            target: validTarget,
            traffic_weight: 10000,
            priority_no: 1,
          },
        ],
        compatibility_mode: true,
      },
    ];

    for (let i = 0; i < badBodies.length; i++) {
      const response = await activateRouteSetPUT(
        buildApiRequest({
          audience: "admin",
          method: "PUT",
          path: `/deployment-route-sets/${routeSet.id}/activation`,
          idempotencyKey: `idem-route-set-nested-reject-${i}`,
          ifMatch: "route-set-1",
          body: badBodies[i],
        }),
        { params: Promise.resolve({ route_set_id: routeSet.id }) },
      );
      expect(response.status).toBe(400);
    }

    expect(
      await db.select().from(routeRevision).where(eq(routeRevision.routeSetId, routeSet.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(routeActivation).where(eq(routeActivation.routeSetId, routeSet.id)),
    ).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 1. POST /admin/api/v1/artifact-attestations/verify
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/artifact-attestations/verify", () => {
  let tenantId: string;
  let userIdentityId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithActionBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
  });

  it("成功验证 → 200 + verification_state=verified", async () => {
    // 先创建一个 draft AgentRevision 作为 artifact_revision_id 目标
    const agent = await createAgent({
      tenantId,
      agentKey: "verify-agent",
      displayName: "Verify Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevisionWithContractSnapshot({
      tenantId,
      agentId: agent.id,
      modelPolicyJson: { model: "gpt-4" },
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });

    // 准备 store override + builder keys override
    const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("verify-artifact-content");
    const sigRef = `attestation:signature:${digest.slice(7, 15)}`;
    const sbomRef = `attestation:sbom:${digest.slice(7, 15)}`;
    const provRef = `attestation:provenance:${digest.slice(7, 15)}`;
    const sbomDoc = buildCleanSbom();
    const provDoc = buildValidProvenance();
    const supplyChain: PredicateSupplyChain = {
      sbomRef,
      sbomContent: sbomDoc,
      provenanceRef: provRef,
      provenanceContent: provDoc,
    };
    const store = new InMemoryManagedArtifactStore();
    store.writeDsseEnvelope(
      sigRef,
      buildDsseArtifactAttestationEnvelope(keyPair, digest, supplyChain),
    );
    store.writeSbom(sbomRef, sbomDoc);
    store.writeProvenance(provRef, provDoc);
    setArtifactStoreOverride(store);
    setBuilderKeyRegistryOverride(builderKeys);

    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/artifact-attestations/verify",
      idempotencyKey: "idem-verify-001",
      body: {
        artifact_type: "runtime_revision",
        artifact_revision_id: draftRevision.id,
        artifact_digest: digest,
        dsse_envelope_ref: sigRef,
        sbom_ref: sbomRef,
        provenance_ref: provRef,
        builder_identity: "builder:company-agent-runtime",
      },
    });

    const response = await verifyPOST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.verification_state).toBe("verified");
    expect(body.attestation_id).toEqual(expect.any(String));
    expect(typeof body.attestation_id).toBe("string");
    // UUID 格式校验
    const attestationId = body.attestation_id as string;
    expect(attestationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const digest = computeArtifactDigest("no-idem-content");
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/artifact-attestations/verify",
      body: {
        artifact_type: "runtime_revision",
        artifact_revision_id: "rev-1",
        artifact_digest: digest,
        dsse_envelope_ref: "attestation:signature:x",
        sbom_ref: "attestation:sbom:x",
        provenance_ref: "attestation:provenance:x",
        builder_identity: "builder:company-agent-runtime",
      },
    });

    const response = await verifyPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("验证失败 → 422 ARTIFACT_ATTESTATION_FAILED", async () => {
    // 用错误的密钥签名 → 验签失败
    const goodKeyPair = generateTestBuilderKey("builder:company-agent-runtime");
    const badKeyPair = generateTestBuilderKey("builder:attacker");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": goodKeyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("bad-sig-content");
    const sigRef = "attestation:signature:bad";
    const sbomRef = "attestation:sbom:bad";
    const provRef = "attestation:provenance:bad";
    const sbomDoc = buildCleanSbom();
    const provDoc = buildValidProvenance();
    const supplyChain: PredicateSupplyChain = {
      sbomRef,
      sbomContent: sbomDoc,
      provenanceRef: provRef,
      provenanceContent: provDoc,
    };
    const store = new InMemoryManagedArtifactStore();
    // 用 badKeyPair 签名（公钥与白名单不一致）
    store.writeDsseEnvelope(
      sigRef,
      buildDsseArtifactAttestationEnvelope(badKeyPair, digest, supplyChain),
    );
    store.writeSbom(sbomRef, sbomDoc);
    store.writeProvenance(provRef, provDoc);
    setArtifactStoreOverride(store);
    setBuilderKeyRegistryOverride(builderKeys);

    const requestBody = {
      artifact_type: "runtime_revision",
      artifact_revision_id: "rev-bad-sig",
      artifact_digest: digest,
      dsse_envelope_ref: sigRef,
      sbom_ref: sbomRef,
      provenance_ref: provRef,
      builder_identity: "builder:company-agent-runtime",
    };
    const buildRequest = () =>
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: "/artifact-attestations/verify",
        idempotencyKey: "idem-verify-fail",
        body: requestBody,
      });

    const response = await verifyPOST(buildRequest());
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ARTIFACT_ATTESTATION_FAILED");

    const replay = await verifyPOST(buildRequest());
    expect(replay.status).toBe(422);
    expect(await replay.json()).toEqual(body);
    expect(
      await listAttestationsByRevision(tenantId, "runtime_revision", "rev-bad-sig"),
    ).toHaveLength(1);
    const idempotency = await findIdempotencyRecord({
      tenantId,
      audience: "admin",
      callerType: "user",
      callerId: userIdentityId,
      commandScope: "artifact.attestation.verify:rev-bad-sig",
      idempotencyKey: "idem-verify-fail",
    });
    expect(idempotency?.processingState).toBe("completed");
    expect(idempotency?.httpStatus).toBe(422);
  });

  it("幂等重放 → 200 (same response)", async () => {
    const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("replay-content");
    const sigRef = "attestation:signature:replay";
    const sbomRef = "attestation:sbom:replay";
    const provRef = "attestation:provenance:replay";
    const sbomDoc = buildCleanSbom();
    const provDoc = buildValidProvenance();
    const supplyChain: PredicateSupplyChain = {
      sbomRef,
      sbomContent: sbomDoc,
      provenanceRef: provRef,
      provenanceContent: provDoc,
    };
    const store = new InMemoryManagedArtifactStore();
    store.writeDsseEnvelope(
      sigRef,
      buildDsseArtifactAttestationEnvelope(keyPair, digest, supplyChain),
    );
    store.writeSbom(sbomRef, sbomDoc);
    store.writeProvenance(provRef, provDoc);
    setArtifactStoreOverride(store);
    setBuilderKeyRegistryOverride(builderKeys);

    const body = {
      artifact_type: "runtime_revision",
      artifact_revision_id: "rev-replay",
      artifact_digest: digest,
      dsse_envelope_ref: sigRef,
      sbom_ref: sbomRef,
      provenance_ref: provRef,
      builder_identity: "builder:company-agent-runtime",
    };

    const request1 = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/artifact-attestations/verify",
      idempotencyKey: "idem-replay-001",
      body,
    });
    const response1 = await verifyPOST(request1);
    expect(response1.status).toBe(200);
    const body1 = (await response1.json()) as Record<string, unknown>;

    const request2 = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/artifact-attestations/verify",
      idempotencyKey: "idem-replay-001",
      body,
    });
    const response2 = await verifyPOST(request2);
    expect(response2.status).toBe(200);
    const body2 = (await response2.json()) as Record<string, unknown>;

    expect(body2.attestation_id).toBe(body1.attestation_id);
    expect(body2.verification_state).toBe(body1.verification_state);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. POST /admin/api/v1/agents/{agent_id}/revisions
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/agents/{agent_id}/revisions", () => {
  let tenantId: string;
  let userIdentityId: string;
  let agentId: string;
  let contractSnapshot: { id: string };

  beforeEach(async () => {
    const seeded = await seedAdminWithActionBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
    const agent = await createAgent({
      tenantId,
      agentKey: "rev-agent",
      displayName: "Revision Agent",
      ownerUserId: userIdentityId,
    });
    agentId = agent.id;
    contractSnapshot = await seedAgentContractSnapshot({
      tenantId,
      agentId,
      createdBy: userIdentityId,
    });
  });

  it("成功创建 → 201 + ETag", async () => {
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/agents/test-agent-id/revisions",
      idempotencyKey: "idem-create-rev-001",
      body: {
        agent_contract_snapshot_id: contractSnapshot.id,
        model_policy: { model: "gpt-4" },
        permission_requirements: {},
        delegation_policy: { max_depth: 0 },
        agent_interface_requirements: { required: [], optional: [] },
      },
    });

    const response = await createRevisionPOST(request, {
      params: Promise.resolve({ agent_id: agentId }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toEqual(expect.any(String));
    expect(body.revision_no).toBe(1);
    expect(body.revision_state).toBe("draft");
    expect(body.agent_contract_snapshot_id).toBe(contractSnapshot.id);
    const etag = response.headers.get("etag");
    expect(etag).toBeDefined();
    expect(etag).toContain("agent-revision-1");
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/agents/test-agent-id/revisions",
      body: {
        source: { source_type: "agent_yaml", source_revision: "git:no-idem" },
        artifact_ref: `oci://registry/agent@${computeArtifactDigest("no-idem")}`,
        instruction_hash: computeArtifactDigest("no-idem-instr"),
        agent_contract_snapshot_id: contractSnapshot.id,
        model_policy: { model: "gpt-4" },
        permission_requirements: {},
        delegation_policy: { max_depth: 0 },
        agent_interface_requirements: { required: [], optional: [] },
      },
    });

    const response = await createRevisionPOST(request, {
      params: Promise.resolve({ agent_id: agentId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("跨租户 Agent → 404 RESOURCE_NOT_FOUND", async () => {
    const crossTenantRequestId = "req-cross-tenant-rev";
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/agents/random-uuid/revisions",
      requestId: crossTenantRequestId,
      idempotencyKey: "idem-cross-tenant-001",
      body: {
        source: { source_type: "agent_yaml", source_revision: "git:cross-tenant" },
        artifact_ref: `oci://registry/agent@${computeArtifactDigest("cross-tenant")}`,
        instruction_hash: computeArtifactDigest("cross-tenant-instr"),
        agent_contract_snapshot_id: contractSnapshot.id,
        model_policy: { model: "gpt-4" },
        permission_requirements: {},
        delegation_policy: { max_depth: 0 },
        agent_interface_requirements: { required: [], optional: [] },
      },
    });

    const randomAgentId = "99999999-9999-4999-8999-999999999999";
    const response = await createRevisionPOST(request, {
      params: Promise.resolve({ agent_id: randomAgentId }),
    });
    await assertCrossTenantHidden(response, crossTenantRequestId);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Agent / AgentRevision 权威查询与撤回
// ═══════════════════════════════════════════════════════════

describe("Agent control-plane detail and withdrawal", () => {
  it("详情由服务端投影执行资格，撤回后同一详情立即不可执行", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const { agent, revision } = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "agent-detail",
      "detail-v1",
      "enabled",
    );

    const agentResponse = await getAgentGET(
      buildApiRequest({ audience: "admin", method: "GET", path: `/agents/${agent.id}` }),
      { params: Promise.resolve({ agent_id: agent.id }) },
    );
    expect(agentResponse.status).toBe(200);
    expect(await agentResponse.json()).toMatchObject({
      id: agent.id,
      current_revision_id: revision.id,
      lifecycle_state: "enabled",
      version_no: 2,
    });

    const getRevision = () =>
      getAgentRevisionGET(
        buildApiRequest({
          audience: "admin",
          method: "GET",
          path: `/agent-revisions/${revision.id}`,
        }),
        { params: Promise.resolve({ revision_id: revision.id }) },
      );
    const before = await getRevision();
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as Record<string, unknown>;
    expect(beforeBody.execution_eligible).toBe(true);
    expect(beforeBody.publication_record_id).toEqual(expect.any(String));
    // Agent 黑盒：发布权威 = Contract Snapshot，无 Attestation 列表。

    const requestBody = { reason_code: "security_response", reason: "发现风险" };
    const buildWithdrawRequest = () =>
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: `/agent-revisions/${revision.id}/withdraw`,
        idempotencyKey: "idem-agent-withdraw-detail",
        ifMatch: `agent-revision-${revision.revisionNo}`,
        body: requestBody,
      });
    const withdrawn = await withdrawAgentRevisionPOST(buildWithdrawRequest(), {
      params: Promise.resolve({ revision_id: `${revision.id}` }),
    });
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toMatchObject({
      id: revision.id,
      revision_state: "withdrawn",
      withdrawal_record_id: expect.any(String),
    });

    const replay = await withdrawAgentRevisionPOST(buildWithdrawRequest(), {
      params: Promise.resolve({ revision_id: `${revision.id}` }),
    });
    expect(replay.status).toBe(200);

    const after = await getRevision();
    const afterBody = (await after.json()) as Record<string, unknown>;
    expect(afterBody.execution_eligible).toBe(false);
    expect(afterBody.ineligibility_reasons).toContain("publication_withdrawn");
    expect(afterBody.withdrawal_record_id).toEqual(expect.any(String));
  });
});

// ═══════════════════════════════════════════════════════════
// 4. POST /admin/api/v1/agent-revisions/{revision_id}/publish
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/agent-revisions/{revision_id}/publish", () => {
  let tenantId: string;
  let userIdentityId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithActionBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
  });

  it("成功发布 → 200", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "publish-agent",
      displayName: "Publish Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevisionWithContractSnapshot({
      tenantId,
      agentId: agent.id,
      modelPolicyJson: { model: "gpt-4" },
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });
    // 发布路由强制 Revision 绑定 AgentContractSnapshot（helper 已绑定）。

    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/agent-revisions/rev/publish",
      idempotencyKey: "idem-publish-001",
      ifMatch: "agent-revision-1",
      body: {
        release_notes: "Initial release",
      },
    });

    const response = await publishPOST(request, {
      params: Promise.resolve({ revision_id: draftRevision.id }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.revision_state).toBe("published");
    expect(body.published_at).toBeTruthy();

    const publishedAgent = await getAgentById(tenantId, agent.id);
    expect(publishedAgent?.currentRevisionId).toBe(draftRevision.id);

    const outbox = await db
      .select()
      .from(controlPlaneOutboxEvent)
      .where(eq(controlPlaneOutboxEvent.aggregateId, draftRevision.id));
    expect(outbox).toHaveLength(1);

    const idempotency = await findIdempotencyRecord({
      tenantId,
      audience: "admin",
      callerType: "user",
      callerId: userIdentityId,
      commandScope: `agent.publish:${draftRevision.id}`,
      idempotencyKey: "idem-publish-001",
    });
    expect(idempotency?.processingState).toBe("completed");
    expect(idempotency?.responseRedactedJson).toBe(JSON.stringify(body));
    expect(
      await getPublicationRecordBySubject({
        tenantId,
        subjectType: "agent_revision",
        subjectRevisionId: draftRevision.id,
      }),
    ).toMatchObject({
      attestationIds: [],
      idempotencyKey: "idem-publish-001",
      idempotencyRecordId: idempotency?.id,
      publishedByType: "user",
      publishedBy: userIdentityId,
    });

    const replayRequest = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/agent-revisions/rev/publish",
      idempotencyKey: "idem-publish-001",
      ifMatch: "agent-revision-1",
      body: {
        release_notes: "Initial release",
      },
    });
    const replayResponse = await publishPOST(replayRequest, {
      params: Promise.resolve({ revision_id: draftRevision.id }),
    });
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toEqual(body);
    expect(
      await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(eq(controlPlaneOutboxEvent.aggregateId, draftRevision.id)),
    ).toHaveLength(1);
  });

  it("两个不同幂等键并发发布时只返回一个成功结果", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "concurrent-publish-agent",
      displayName: "Concurrent Publish Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevisionWithContractSnapshot({
      tenantId,
      agentId: agent.id,
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });
    await ensureAgentContractSnapshotBoundForRevision(draftRevision.id, tenantId);
    const buildRequest = (idempotencyKey: string) =>
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: "/agent-revisions/rev/publish",
        idempotencyKey,
        ifMatch: "agent-revision-1",
        body: {
          release_notes: "Concurrent release",
        },
      });

    const responses = await Promise.all([
      publishPOST(buildRequest("idem-concurrent-publish-1"), {
        params: Promise.resolve({ revision_id: draftRevision.id }),
      }),
      publishPOST(buildRequest("idem-concurrent-publish-2"), {
        params: Promise.resolve({ revision_id: draftRevision.id }),
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    expect((await getRevisionById(draftRevision.id))?.revisionState).toBe("published");
    expect((await getAgentById(tenantId, agent.id))?.currentRevisionId).toBe(draftRevision.id);
    expect(
      await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(eq(controlPlaneOutboxEvent.aggregateId, draftRevision.id)),
    ).toHaveLength(1);
  });

  it("缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "no-ifmatch-agent",
      displayName: "No IfMatch Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevisionWithContractSnapshot({
      tenantId,
      agentId: agent.id,
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });

    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/agent-revisions/rev/publish",
      idempotencyKey: "idem-no-ifmatch-001",
      body: {
        release_notes: "Initial release",
      },
    });

    const response = await publishPOST(request, {
      params: Promise.resolve({ revision_id: draftRevision.id }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("ETag 不匹配 → 412 ETAG_MISMATCH", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "etag-mismatch-agent",
      displayName: "ETag Mismatch Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevisionWithContractSnapshot({
      tenantId,
      agentId: agent.id,
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });

    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/agent-revisions/rev/publish",
      idempotencyKey: "idem-etag-mismatch-001",
      ifMatch: "agent-revision-999",
      body: {
        release_notes: "Initial release",
      },
    });

    const response = await publishPOST(request, {
      params: Promise.resolve({ revision_id: draftRevision.id }),
    });
    expect(response.status).toBe(412);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ETAG_MISMATCH");
  });

  it("携带 legacy artifact_attestation_id → 400 REQUEST_SCHEMA_INVALID（黑盒权威）", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "no-attest-agent",
      displayName: "No Attestation Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevisionWithContractSnapshot({
      tenantId,
      agentId: agent.id,
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });

    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/agent-revisions/rev/publish",
      idempotencyKey: "idem-no-attest-001",
      ifMatch: "agent-revision-1",
      body: {
        release_notes: "Initial release",
        artifact_attestation_id: "99999999-9999-4999-8999-999999999999",
      },
    });

    const response = await publishPOST(request, {
      params: Promise.resolve({ revision_id: draftRevision.id }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. POST /admin/api/v1/deployment-routes/{route_id}/disable
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/deployment-routes/{route_id}/disable", () => {
  let tenantId: string;
  let userIdentityId: string;
  let agentId: string;
  let agentRevisionId: string;
  let routeSetId: string;
  let routeId: string;
  let currentVersionNo: number;

  beforeEach(async () => {
    const seeded = await seedAdminWithActionBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;

    const agentResult = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "route-disable-agent",
      "agent-v1",
      "enabled",
    );
    agentId = agentResult.agent.id;
    agentRevisionId = agentResult.revision.id;

    const routeSet = await createRouteSet({
      tenantId,
      target: { kind: "agent", agentId },
      routeScopeKey: "prod",
      routeScopeJson: { networkZone: "internal" },
    });
    routeSetId = routeSet.id;

    const activated = await activateSingleRouteForTest({
      tenantId,
      routeSetId,
      routeSetExpectedVersionNo: 1,
      target: {
        kind: "agent",
        agentRevisionId,
        agentEndpointRef: "https://agent.example.com/a2a",
        agentIdentityMode: "bearer",
        agentCredentialRefId: "cred-1",
        agentNetworkZone: "private",
      },
      trafficWeight: 10_000,
      priorityNo: 1,
      actor: { tenantId, actorType: "service", actorId: "test-deploy-bot" },
    });
    routeId = activated.route.id;
    currentVersionNo = activated.routeSet.versionNo;
  });

  it("禁用只追加 Activation，复用当前 Revision，并推进 RouteSet ETag", async () => {
    const [currentActivation] = await db
      .select()
      .from(routeActivation)
      .where(eq(routeActivation.routeId, routeId));
    expect(currentActivation).toBeDefined();

    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: `/deployment-routes/${routeId}/disable`,
      idempotencyKey: "idem-disable-route-001",
      ifMatch: `route-set-${currentVersionNo}`,
      body: { reason: "人工停用" },
    });

    const response = await disableRoutePOST(request, {
      params: Promise.resolve({ route_id: `${routeId}` }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.route_set_version_no).toBe(currentVersionNo + 1);
    expect(body.route_revision_id).toBe(currentActivation?.routeRevisionId);
    expect(body.previous_route_activation_id).toBe(currentActivation?.id);
    expect(body.route_activation_id).not.toBe(currentActivation?.id);
    expect(body.activation_state).toBe("disabled");
    expect(response.headers.get("etag")).toContain(`route-set-${currentVersionNo + 1}`);

    const revisions = await db
      .select({ id: routeRevision.id })
      .from(routeRevision)
      .where(eq(routeRevision.routeId, routeId));
    const activations = await db
      .select({ id: routeActivation.id })
      .from(routeActivation)
      .where(eq(routeActivation.routeId, routeId));
    expect(revisions).toHaveLength(1);
    expect(activations).toHaveLength(2);
  });

  it("相同 Idempotency-Key 重试返回原结果，不创建第三条 Activation", async () => {
    const requestBody = { reason: "人工停用" };
    const buildRequest = () =>
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: `/deployment-routes/${routeId}/disable`,
        idempotencyKey: "idem-disable-route-retry-001",
        ifMatch: `route-set-${currentVersionNo}`,
        body: requestBody,
      });

    const first = await disableRoutePOST(buildRequest(), {
      params: Promise.resolve({ route_id: `${routeId}` }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.route_revision_id).toBeTruthy();
    expect(firstBody.route_activation_id).toBeTruthy();

    const replay = await disableRoutePOST(buildRequest(), {
      params: Promise.resolve({ route_id: `${routeId}` }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const idempotency = await findIdempotencyRecord({
      tenantId,
      audience: "admin",
      callerType: "user",
      callerId: userIdentityId,
      commandScope: `route.disable:${routeId}`,
      idempotencyKey: "idem-disable-route-retry-001",
    });
    expect(idempotency?.processingState).toBe("completed");
    expect(idempotency?.responseRedactedJson).toBe(JSON.stringify(firstBody));
    const activations = await db
      .select({ id: routeActivation.id })
      .from(routeActivation)
      .where(eq(routeActivation.routeId, routeId));
    expect(activations).toHaveLength(2);
  });

  it("缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: `/deployment-routes/${routeId}/disable`,
      idempotencyKey: "idem-disable-no-ifmatch-001",
      body: { reason: "人工停用" },
    });

    const response = await disableRoutePOST(request, {
      params: Promise.resolve({ route_id: `${routeId}` }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("ETag 不匹配 → 412 ETAG_MISMATCH", async () => {
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: `/deployment-routes/${routeId}/disable`,
      idempotencyKey: "idem-disable-etag-mismatch-001",
      ifMatch: "route-set-999",
      body: { reason: "人工停用" },
    });

    const response = await disableRoutePOST(request, {
      params: Promise.resolve({ route_id: `${routeId}` }),
    });
    expect(response.status).toBe(412);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ETAG_MISMATCH");
  });

  it("跨租户 Route → 404 RESOURCE_NOT_FOUND", async () => {
    const crossTenantRequestId = "req-cross-tenant-route";
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/deployment-routes/random-uuid/disable",
      requestId: crossTenantRequestId,
      idempotencyKey: "idem-disable-cross-tenant-001",
      ifMatch: `route-set-${currentVersionNo}`,
      body: { reason: "人工停用" },
    });

    const randomRouteId = "99999999-9999-4999-8999-999999999999";
    const response = await disableRoutePOST(request, {
      params: Promise.resolve({ route_id: `${randomRouteId}` }),
    });
    await assertCrossTenantHidden(response, crossTenantRequestId);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. POST /admin/api/v1/agent-registrations + GET /agents/{id}/contracts
// （Public Agent Contract 登记流；目标路由尚未实现 → 本组用例为先行冻结，预期 RED）
// ═══════════════════════════════════════════════════════════

/**
 * 目标路由模块（尚未存在）。用动态 import 加载，使"路由缺失"的 RED 只落在
 * 本组用例上，不影响本文件既有绿色用例。
 */
async function loadAgentRegistrationRoute() {
  return await import("@/app/admin/api/v1/agent-registrations/route");
}
async function loadAgentContractsRoute() {
  return await import("@/app/admin/api/v1/agents/[agent_id]/contracts/route");
}

/** HR 合同 fixture（真实首个集成的登记事实）。 */
async function loadHrAgentContract() {
  const { hrAgentContract } = await import("@/lib/agents/test-support/hr-agent-contract");
  return JSON.parse(JSON.stringify(hrAgentContract)) as Record<string, unknown>;
}

/** 冻结的新语义 action：agent.contract.register（非 legacy agent.descriptor.create）。 */
const AGENT_CONTRACT_REGISTER_ACTION = "agent.contract.register" as never;

/** seed 管理员并授予 agent.contract.register（依赖生产 action 目录后续补该 code）。 */
async function seedContractRegistrationAdmin() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: AGENT_CONTRACT_REGISTER_ACTION,
    resourceScope: { type: "agent", wildcard: true },
  });
  return { tenantId: tenant.id, userIdentityId: identity.id };
}

async function countTableRows(table: string): Promise<number> {
  const [rows] = (await db.execute(
    sql.raw(`SELECT COUNT(*) AS n FROM \`${table}\``),
  )) as unknown as [{ n: number }[]];
  return Number(rows?.[0]?.n ?? -1);
}

function registrationBody(contract: Record<string, unknown>) {
  return {
    protocol: { type: "a2a", contract_revision: "0.3.0" },
    contract,
  };
}

describe("POST /admin/api/v1/agent-registrations（Public Agent Contract 登记）", () => {
  it("happy path：201 结构化投影（无原始合同回显），创建一个 draft Agent + 一个快照，写 agent.contract.register 审计", async () => {
    const { POST } = await loadAgentRegistrationRoute();
    const { tenantId, userIdentityId } = await seedContractRegistrationAdmin();
    const contract = await loadHrAgentContract();

    const response = await POST(
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: "/agent-registrations",
        idempotencyKey: "idem-agent-registration-001",
        body: registrationBody(contract),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      agent: Record<string, unknown>;
      contract: Record<string, unknown>;
    };

    // agent 投影：身份由合同 agent.id 决定
    expect(body.agent).toMatchObject({
      id: expect.any(String),
      agent_key: "hr-assistant",
      display_name: "企业人力智能助手",
      lifecycle_state: "draft",
    });

    // contract 投影：仅结构化事实，snake_case wire 字段
    expect(Object.keys(body.contract).sort()).toEqual(
      [
        "capabilities",
        "capability_digest",
        "captured_at",
        "context_digest",
        "contract_digest",
        "contract_version",
        "interaction",
        "invocation_context",
        "protocol_contract_revision",
        "protocol_type",
        "public_agent_version",
        "result_contract",
        "snapshot_id",
      ].sort(),
    );
    expect(body.contract.contract_version).toBe("1.0.0");
    expect(body.contract.public_agent_version).toBe("1.0.0");
    expect(body.contract.protocol_type).toBe("a2a");
    expect(body.contract.protocol_contract_revision).toBe("0.3.0");
    expect(body.contract.contract_digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // interaction：六个布尔事实 + supported_locales（完整结构，非部分匹配）
    expect(body.contract.interaction).toEqual({
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
      supported_locales: ["zh-CN"],
    });

    // capability：每个持久化事实都投影（key/name/description/tags/examples/input_modes/output_modes），
    // 代表性中英文描述必须在结构化位置出现 —— 这是 Web/Desktop 要展示的信息，不是原始文件泄漏。
    const capabilities = body.contract.capabilities as Array<Record<string, unknown>>;
    expect(capabilities.map((c) => c.key)).toEqual([
      "leave-and-attendance-service",
      "employee-self-service",
      "hr-policy-and-benefits-consultation",
      "hr-system-and-document-assistance",
    ]);
    expect(Object.keys(capabilities[0]!).sort()).toEqual(
      ["key", "name", "description", "tags", "examples", "input_modes", "output_modes"].sort(),
    );
    expect(capabilities[0]!.name).toEqual({
      "zh-CN": "假勤与请假服务",
      en: "Leave and Attendance Service",
    });
    expect((capabilities[0]!.description as Record<string, string>)["zh-CN"]).toContain(
      "请假申请、请假修改相关对话",
    );
    expect((capabilities[0]!.description as Record<string, string>).en).toContain("Leave requests");
    // 真实 HR artifact 无 tags/examples/input_modes/output_modes → 空数组，不虚构也不丢弃
    expect(capabilities[0]!.tags).toEqual([]);
    expect(capabilities[0]!.examples).toEqual([]);
    expect(capabilities[0]!.input_modes).toEqual([]);
    expect(capabilities[0]!.output_modes).toEqual([]);

    // invocation context：key/name/description/necessity/applies_to/trust_requirement/declaration_source
    const contexts = body.contract.invocation_context as Array<Record<string, unknown>>;
    expect(contexts.map((c) => c.key)).toEqual([
      "execution_subject",
      "timezone",
      "current_datetime",
      "locale",
      "conversation_summary",
      "attachment_references",
    ]);
    expect(Object.keys(contexts[0]!).sort()).toEqual(
      [
        "key",
        "name",
        "description",
        "necessity",
        "applies_to",
        "trust_requirement",
        "declaration_source",
      ].sort(),
    );
    // 该 artifact 的 name/description 只有 zh-CN → en 为 null（保留缺失事实，不虚构）
    expect(contexts[0]!.name).toEqual({ "zh-CN": "执行主体", en: null });
    expect((contexts[0]!.description as Record<string, string>)["zh-CN"]).toContain(
      "可信调用者身份",
    );
    expect((contexts[0]!.description as Record<string, string | null>).en).toBeNull();
    expect(contexts[0]!.necessity).toBe("preferred");
    expect(contexts[0]!.applies_to).toEqual([
      "leave-and-attendance-service",
      "employee-self-service",
    ]);
    // wire 上无 trust_requirement → null；declaration_source 是登记侧系统 provenance
    expect(contexts[0]!.trust_requirement).toBeNull();
    expect(contexts[0]!.declaration_source).toBe("provider_declared");
    // 无 applies_to 的 context（timezone）→ null 而非省略键
    expect(contexts[1]!.applies_to).toBeNull();

    // result_contract：fields/error_codes/notes 全部投影，zh-CN notes 原文在结构化位置
    const resultContract = body.contract.result_contract as Record<string, unknown>;
    expect(Object.keys(resultContract).sort()).toEqual(["error_codes", "fields", "notes"].sort());
    expect(resultContract.fields).toEqual([
      "request_id",
      "status",
      "answer",
      "result_type",
      "data",
      "actions",
      "error_code",
      "retryable",
      "agent_name",
      "agent_version",
    ]);
    expect(resultContract.error_codes).toEqual([
      "identity_required",
      "identity_unverified",
      "input_required",
      "not_found",
      "rejected",
      "temporarily_unavailable",
      "failed",
      "cancelled",
      "contract_error",
    ]);
    expect(resultContract.notes).toEqual({
      "zh-CN":
        "answer为人类可读主回答；result_type为结果类别；data为可选结构化数据；actions为可选宿主可执行动作（第一版无通用动作协议时为空）；error_code为稳定机器错误；retryable表示是否适合重试。",
      en: null,
    });

    // 「不回显原始整文件」的判据：精确键集合（上文逐层冻结）+ 无 raw/整文件包装键 +
    // 无 URL/secret/内部 id，而非删掉结构化描述/notes
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("raw_contract");
    expect(serialized).not.toContain("contract_json");
    expect(serialized).not.toContain("source_file");
    expect(serialized).not.toContain("source_path");
    expect(serialized).not.toContain("agent_card_url");
    expect(serialized).not.toContain("runtime_endpoint");
    expect(serialized).not.toMatch(/https?:\/\//); // 冻结 wire 不接受也不回显任何 URL
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("employee_id");
    expect(serialized).not.toContain("corp_id");

    // 落库：一个 draft Agent（owner=登记管理员）+ 一个快照 header
    expect(await countTableRows("Agent")).toBe(1);
    expect(await countTableRows("AgentContractSnapshot")).toBe(1);
    expect(await countTableRows("AgentContractCapability")).toBe(4);
    expect(await countTableRows("AgentContractInvocationContext")).toBe(6);

    // 审计：新语义 action，且不得使用 legacy descriptor 术语
    const { auditEvent } = await import("@/lib/persistence/schema/audit");
    const events = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.actionType, "agent.contract.register"));
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe(userIdentityId);
    expect(events[0]!.tenantId).toBe(tenantId);
    const legacyEvents = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.actionType, "agent.descriptor.create"));
    expect(legacyEvents).toHaveLength(0);
  });

  it("幂等：同 key 同 body 重放相同 201；同 key 不同 body 409；不同 key 重复登记 → 同一 Agent 两个快照", async () => {
    const { POST } = await loadAgentRegistrationRoute();
    await seedContractRegistrationAdmin();
    const contract = await loadHrAgentContract();

    const build = (key: string, body: unknown) =>
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: "/agent-registrations",
        idempotencyKey: key,
        body,
      });

    const first = await POST(build("idem-agent-registration-replay", registrationBody(contract)));
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    // 同 key + 同 body → 重放相同 201，不新增行
    const replay = await POST(build("idem-agent-registration-replay", registrationBody(contract)));
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstBody);
    expect(await countTableRows("Agent")).toBe(1);
    expect(await countTableRows("AgentContractSnapshot")).toBe(1);

    // 同 key + 不同 body → 409 IDEMPOTENCY_CONFLICT
    const conflictBody = registrationBody(contract);
    (conflictBody.protocol as Record<string, unknown>).contract_revision = "0.4.0";
    const conflict = await POST(build("idem-agent-registration-replay", conflictBody));
    expect(conflict.status).toBe(409);
    expect(await countTableRows("AgentContractSnapshot")).toBe(1);

    // 不同 key + 相同显式登记 → 新快照，但 Agent 仍唯一
    const second = await POST(build("idem-agent-registration-second", registrationBody(contract)));
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { contract: { snapshot_id: string } };
    expect(secondBody.contract.snapshot_id).not.toBe(
      (firstBody as { contract: { snapshot_id: string } }).contract.snapshot_id,
    );
    expect(await countTableRows("Agent")).toBe(1);
    expect(await countTableRows("AgentContractSnapshot")).toBe(2);
  });

  it("校验 fail-closed：未知字段/URL/secret/缺失 protocol/缺少 Idempotency-Key → 400 且零行落库", async () => {
    const { POST } = await loadAgentRegistrationRoute();
    await seedContractRegistrationAdmin();
    const contract = await loadHrAgentContract();

    const badBodies: Array<unknown> = [
      { ...registrationBody(contract), agent_card_url: "https://hr.example.com/card.json" },
      { ...registrationBody(contract), runtime_endpoint: "https://hr.example.com/a2a" },
      { ...registrationBody(contract), agent_id: "caller-supplied-id" }, // 身份只来自合同 agent.id
      { ...registrationBody(contract), agent_key: "caller-supplied-key" },
      { ...registrationBody(contract), display_name: "caller-supplied-name" },
      { protocol: { type: "a2a", contract_revision: "0.3.0" } }, // 缺 contract
      { contract }, // 缺 protocol
      { protocol: { type: "mcp", contract_revision: "" }, contract }, // 非法 protocol
      registrationBody({ ...contract, authorization: "Bearer secret" }), // secret
      registrationBody({ ...contract, employee_id: "E001" }), // 员工身份类字段
      registrationBody({ ...contract, corp_id: "corp-1" }),
    ];

    for (const body of badBodies) {
      const response = await POST(
        buildApiRequest({
          audience: "admin",
          method: "POST",
          path: "/agent-registrations",
          idempotencyKey: `idem-agent-registration-invalid-${JSON.stringify(body).length}-${Math.random()}`,
          body,
        }),
      );
      expect(response.status).toBe(400);
      const errorBody = (await response.json()) as { error: { code: string } };
      expect(errorBody.error.code).toBe("REQUEST_SCHEMA_INVALID");
    }

    // 缺少 Idempotency-Key → 400
    const noKeyResponse = await POST(
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: "/agent-registrations",
        body: registrationBody(contract),
      }),
    );
    expect(noKeyResponse.status).toBe(400);

    expect(await countTableRows("Agent")).toBe(0);
    expect(await countTableRows("AgentContractSnapshot")).toBe(0);
    expect(await countTableRows("AgentContractCapability")).toBe(0);
    expect(await countTableRows("AgentContractInvocationContext")).toBe(0);
  });

  it("鉴权：无效 Bearer → 401；缺少 agent.contract.register scope → 403 且零行", async () => {
    const { POST } = await loadAgentRegistrationRoute();
    // 只 seed 管理员身份，不授予 agent.contract.register
    const tenant = await ensureDefaultTenant();
    await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: DEFAULT_USER_ID,
      email: DEFAULT_USER_EMAIL,
      displayName: DEFAULT_USER_NAME,
    });
    const contract = await loadHrAgentContract();

    // 无效 Bearer → 401 AUTHENTICATION_REQUIRED
    const unauthorized = await POST(
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: "/agent-registrations",
        idempotencyKey: "idem-agent-registration-unauth",
        token: "not-a-real-workload-token",
        body: registrationBody(contract),
      }),
    );
    expect(unauthorized.status).toBe(401);
    const unauthBody = (await unauthorized.json()) as { error: { code: string } };
    expect(unauthBody.error.code).toBe("AUTHENTICATION_REQUIRED");

    // 无 agent.contract.register 绑定 → 403 ACTION_SCOPE_DENIED
    const forbidden = await POST(
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: "/agent-registrations",
        idempotencyKey: "idem-agent-registration-forbidden",
        body: registrationBody(contract),
      }),
    );
    expect(forbidden.status).toBe(403);
    const forbiddenBody = (await forbidden.json()) as { error: { code: string } };
    expect(forbiddenBody.error.code).toBe("ACTION_SCOPE_DENIED");

    expect(await countTableRows("Agent")).toBe(0);
    expect(await countTableRows("AgentContractSnapshot")).toBe(0);
  });

  it("service-only 主体首次登记被拒绝且零行落库（owner 歧义防护）", async () => {
    const { POST } = await loadAgentRegistrationRoute();
    await seedContractRegistrationAdmin();
    const contract = await loadHrAgentContract();

    const { issueWorkloadToken } = await import("@/lib/identity/workload-token");
    const token = issueWorkloadToken({
      type: "service",
      tenantId: (await ensureDefaultTenant()).id,
      audience: "admin",
      serviceId: "cicd",
      expiresAt: Date.now() + 60_000,
    });

    const response = await POST(
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: "/agent-registrations",
        idempotencyKey: "idem-agent-registration-service",
        token,
        body: registrationBody(contract),
      }),
    );
    // service 主体不得成为首次创建 Agent 的 owner：拒绝（scope 层或 owner 歧义防护层）
    expect([403, 422]).toContain(response.status);
    expect(await countTableRows("Agent")).toBe(0);
    expect(await countTableRows("AgentContractSnapshot")).toBe(0);
  });
});

describe("GET /admin/api/v1/agents/{agent_id}/contracts（登记快照列表）", () => {
  it("列表最新优先，且与 POST 投影结构一致（含 capability/context 顺序）", async () => {
    const { POST } = await loadAgentRegistrationRoute();
    const { GET } = await loadAgentContractsRoute();
    await seedContractRegistrationAdmin();
    const contract = await loadHrAgentContract();

    const post = async (key: string) => {
      const response = await POST(
        buildApiRequest({
          audience: "admin",
          method: "POST",
          path: "/agent-registrations",
          idempotencyKey: key,
          body: registrationBody(contract),
        }),
      );
      expect(response.status).toBe(201);
      return (await response.json()) as {
        agent: { id: string };
        contract: Record<string, unknown>;
      };
    };
    const first = await post("idem-agent-contracts-list-001");
    const second = await post("idem-agent-contracts-list-002");

    const response = await GET(
      buildApiRequest({
        audience: "admin",
        method: "GET",
        path: `/agents/${first.agent.id}/contracts`,
      }),
      { params: Promise.resolve({ agent_id: first.agent.id }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    // 最新优先：第一项等于第二次 POST 的投影
    expect(body.items[0]).toEqual(second.contract);
    expect(body.items[1]).toEqual(first.contract);
    // capability / invocation_context 顺序与 POST 一致
    const newest = body.items[0] as {
      capabilities: Array<Record<string, unknown>>;
      invocation_context: Array<Record<string, unknown>>;
      result_contract: { notes: Record<string, string | null> };
    };
    expect(newest.capabilities.map((c) => c.key)[0]).toBe("leave-and-attendance-service");
    expect(newest.invocation_context.map((c) => c.key)[0]).toBe("execution_subject");
    // 结构化描述/notes 必须出现在 GET 投影中（与 POST 深相等 + 代表性原文抽查）
    expect((newest.capabilities[0]!.description as Record<string, string>)["zh-CN"]).toContain(
      "请假申请、请假修改相关对话",
    );
    expect(
      (newest.invocation_context[0]!.description as Record<string, string>)["zh-CN"],
    ).toContain("可信调用者身份");
    expect(newest.result_contract.notes["zh-CN"]).toContain("answer为人类可读主回答");
    // 「不回显原始整文件」判据：无 raw/整文件包装键、无 URL/secret，而非删除结构化事实
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("raw_contract");
    expect(serialized).not.toContain("contract_json");
    expect(serialized).not.toContain("source_file");
    expect(serialized).not.toContain("source_path");
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  it("未知/跨租户 Agent → 404 RESOURCE_NOT_FOUND（隐藏式）", async () => {
    const { GET } = await loadAgentContractsRoute();
    await seedContractRegistrationAdmin();

    const requestId = "req-agent-contracts-cross-tenant";
    const randomAgentId = "99999999-9999-4999-8999-999999999999";
    const response = await GET(
      buildApiRequest({
        audience: "admin",
        method: "GET",
        path: `/agents/${randomAgentId}/contracts`,
        requestId,
      }),
      { params: Promise.resolve({ agent_id: randomAgentId }) },
    );
    await assertCrossTenantHidden(response, requestId);
  });
});
