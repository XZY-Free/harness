import {
  type ActivateRouteSetCommand,
  type ActivateRouteSetResult,
  RouteSetRequiresAtomicUpdateError,
  createActivateRouteSet,
} from "@/lib/routes/application/activate-route-set";
import {
  AgentCapabilityUnsupportedError,
  ArtifactNotVerifiedForRouteError,
  RevisionNotPublishedError,
  RouteSetVersionConflictError,
} from "@/lib/routes/domain/route-revision";
import type {
  RouteActivationRecord,
  RouteRevisionRecord,
} from "@/lib/routes/persistence/route-revision-record";
import type {
  AgentRevisionSummary,
  DesiredRoute,
  RouteRow,
  RouteSetActivationSession,
  RouteSetActivationStore,
  RouteSetRow,
  RuntimeRevisionSummary,
} from "@/lib/routes/persistence/route-set-activation-store";
import { describe, expect, it, vi } from "vitest";

// ─── 测试 Fixtures ──────────────────────────────────────────

const TENANT_ID = "tenant-1";
const AGENT_ID = "agent-1";
const ROUTE_SET_ID = "rs-1";
const ROUTE_SCOPE_KEY = "prod";
const ACTOR = { tenantId: TENANT_ID, actorType: "user" as const, actorId: "user-1" };

const BASE_ROUTE_SET: RouteSetRow = {
  id: ROUTE_SET_ID,
  tenantId: TENANT_ID,
  agentId: AGENT_ID,
  routeScopeKey: ROUTE_SCOPE_KEY,
  routeScopeJson: {},
  versionNo: 1,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const BASE_AGENT_REVISION: AgentRevisionSummary = {
  id: "agent-rev-1",
  agentId: AGENT_ID,
  revisionState: "published",
  requiredCapabilities: [],
};

const BASE_RUNTIME_REVISION: RuntimeRevisionSummary = {
  id: "runtime-rev-1",
  revisionState: "published",
  capabilities: [],
};

function makeRevisionRecord(overrides: Partial<RouteRevisionRecord> = {}): RouteRevisionRecord {
  return {
    id: "rev-1",
    tenantId: TENANT_ID,
    routeId: "route-1",
    routeSetId: ROUTE_SET_ID,
    revisionNo: 1,
    agentRevisionId: BASE_AGENT_REVISION.id,
    runtimeRevisionId: BASE_RUNTIME_REVISION.id,
    policyRevisionId: null,
    modelPolicyRevisionId: null,
    toolsetRevisionId: null,
    trafficAllocationJson: {},
    routeKey: "primary",
    routeGroupId: "primary",
    selectorDigest: "sha256:abc",
    trafficWeight: 10000,
    priorityNo: 0,
    effectiveFrom: null,
    effectiveUntil: null,
    eligibilityConditionsJson: {},
    contentDigest: "sha256:content",
    createdByType: "user",
    createdBy: "user-1",
    validatedAt: new Date("2026-01-01"),
    createdAt: new Date("2026-01-01"),
    ...overrides,
  } as RouteRevisionRecord;
}

function makeActivationRecord(
  overrides: Partial<RouteActivationRecord> = {},
): RouteActivationRecord {
  return {
    id: "act-1",
    tenantId: TENANT_ID,
    routeId: "route-1",
    routeRevisionId: "rev-1",
    routeSetId: ROUTE_SET_ID,
    activationSequence: 1,
    activationState: "active",
    previousRouteRevisionId: null,
    routeSetVersionNo: 2,
    activatedByType: "user",
    activatedBy: "user-1",
    reason: "test",
    requestId: "req-1",
    idempotencyKey: "idem-1",
    activatedAt: new Date("2026-01-01"),
    ...overrides,
  } as RouteActivationRecord;
}

// ─── Mock Store 工厂 ───────────────────────────────────────

function createMockStore(overrides: {
  routeSet?: RouteSetRow;
  existingRoutes?: RouteRow[];
  agentRevisions?: Map<string, AgentRevisionSummary>;
  runtimeRevisions?: Map<string, RuntimeRevisionSummary>;
  attestationResults?: Map<string, boolean>;
  routeSetVersionConflict?: boolean;
}): RouteSetActivationStore {
  const routeSet = overrides.routeSet ?? BASE_ROUTE_SET;
  const existingRoutes = overrides.existingRoutes ?? [];
  const agentRevisions =
    overrides.agentRevisions ?? new Map([[BASE_AGENT_REVISION.id, BASE_AGENT_REVISION]]);
  const runtimeRevisions =
    overrides.runtimeRevisions ?? new Map([[BASE_RUNTIME_REVISION.id, BASE_RUNTIME_REVISION]]);
  const attestationResults =
    overrides.attestationResults ??
    new Map([
      ["agent_revision:agent-rev-1", true],
      ["runtime_revision:runtime-rev-1", true],
    ]);

  let revisionNo = 1;
  let activationSeq = 1;
  let routeCounter = 1;

  return {
    transaction: async <T>(
      operation: (session: RouteSetActivationSession) => Promise<T>,
    ): Promise<T> => {
      const session: RouteSetActivationSession = {
        lockRouteSet: vi.fn(async () => routeSet),
        listRoutesBySet: vi.fn(async () => existingRoutes),
        findActiveRevision: vi.fn(async () => null),
        findLatestActivation: vi.fn(async () => null),
        loadRevisionExecutionEvidence: vi.fn(async () => null),
        findIdempotentRouteSetActivation: vi.fn(async () => null),
        findAgentRevision: vi.fn(async (id: string) => agentRevisions.get(id) ?? null),
        findRuntimeRevision: vi.fn(async (id: string) => runtimeRevisions.get(id) ?? null),
        hasVerifiedAttestation: vi.fn(
          async (params: { tenantId: string; artifactType: string; revisionId: string }) =>
            attestationResults.get(`${params.artifactType}:${params.revisionId}`) ?? false,
        ),
        resolveOrCreateRouteIdentity: vi.fn(
          async (params: { routeSetId: string; routeId?: string; routeKey: string }) => {
            const resolvedId = params.routeId ?? `route-${routeCounter++}`;
            return {
              id: resolvedId,
              routeSetId: params.routeSetId,
              routeKey: params.routeKey,
              agentRevisionId: BASE_AGENT_REVISION.id,
              runtimeRevisionId: BASE_RUNTIME_REVISION.id,
              trafficWeight: 10000,
              priorityNo: 0,
              routeState: "enabled" as const,
              effectiveFrom: null,
              effectiveUntil: null,
              activeRouteRevisionId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          },
        ),
        findRevisionByContent: vi.fn(async () => null),
        nextRevisionNo: vi.fn(async () => revisionNo++),
        appendRevision: vi.fn(async (params: any) =>
          makeRevisionRecord({
            id: params.id,
            routeId: params.routeId,
            routeSetId: params.routeSetId,
            revisionNo: params.revisionNo,
            trafficWeight: params.content?.trafficWeight ?? 10000,
            routeGroupId: params.content?.routeGroupId ?? "primary",
          }),
        ),
        nextActivationSequence: vi.fn(async () => activationSeq++),
        appendActivation: vi.fn(async (params: any) =>
          makeActivationRecord({
            id: params.id,
            routeId: params.routeId,
            routeRevisionId: params.routeRevisionId,
            routeSetId: params.routeSetId,
            activationSequence: params.activationSequence,
            activationState: params.activationState,
            routeSetVersionNo: params.routeSetVersionNo,
          }),
        ),
        updateRouteProjection: vi.fn(async () => ({
          id: "route-1",
          routeSetId: ROUTE_SET_ID,
          routeKey: "primary",
          agentRevisionId: BASE_AGENT_REVISION.id,
          runtimeRevisionId: BASE_RUNTIME_REVISION.id,
          trafficWeight: 10000,
          priorityNo: 0,
          routeState: "enabled" as const,
          effectiveFrom: null,
          effectiveUntil: null,
          activeRouteRevisionId: "rev-1",
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        advanceRouteSetVersion: vi.fn(async () =>
          overrides.routeSetVersionConflict
            ? null
            : { ...routeSet, versionNo: routeSet.versionNo + 1, updatedAt: new Date() },
        ),
        appendAudit: vi.fn(async () => {}),
        appendOutbox: vi.fn(async () => {}),
        completeIdempotency: vi.fn(async () => true),
      };
      return operation(session);
    },
  };
}

const NOW = new Date("2026-06-01T00:00:00Z");

function makeCommand(overrides: Partial<ActivateRouteSetCommand> = {}): ActivateRouteSetCommand {
  return {
    tenantId: TENANT_ID,
    routeSetId: ROUTE_SET_ID,
    expectedVersionNo: 1,
    desiredRoutes: [
      {
        routeKey: "primary",
        routeGroupId: "primary",
        agentRevisionId: BASE_AGENT_REVISION.id,
        runtimeRevisionId: BASE_RUNTIME_REVISION.id,
        trafficWeight: 10000,
        priorityNo: 0,
        eligibilityConditions: {},
        activationState: "active",
      },
    ],
    actor: ACTOR,
    reason: "test activation",
    requestId: "req-1",
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

// ─── 测试 ──────────────────────────────────────────────────

describe("activateRouteSet", () => {
  it("单条 10000 权重激活 — 成功", async () => {
    const store = createMockStore({});
    const activateRouteSet = createActivateRouteSet({ store, now: () => NOW });

    const result = await activateRouteSet(makeCommand());
    expect(result.routeSetId).toBe(ROUTE_SET_ID);
    expect(result.routeSetVersionNo).toBe(2);
    expect(result.activations).toHaveLength(1);
    expect(result.activations[0]?.activationState).toBe("active");
    expect(result.affectsNewInvocationsOnly).toBe(true);
  });

  it("两条 5000/5000 同 Group 原子激活 — 成功", async () => {
    const store = createMockStore({});
    const activateRouteSet = createActivateRouteSet({ store, now: () => NOW });

    const result = await activateRouteSet(
      makeCommand({
        desiredRoutes: [
          {
            routeKey: "primary",
            routeGroupId: "primary",
            agentRevisionId: BASE_AGENT_REVISION.id,
            runtimeRevisionId: BASE_RUNTIME_REVISION.id,
            trafficWeight: 5000,
            priorityNo: 0,
            eligibilityConditions: {},
            activationState: "active",
          },
          {
            routeKey: "secondary",
            routeGroupId: "primary",
            agentRevisionId: BASE_AGENT_REVISION.id,
            runtimeRevisionId: BASE_RUNTIME_REVISION.id,
            trafficWeight: 5000,
            priorityNo: 0,
            eligibilityConditions: {},
            activationState: "active",
          },
        ],
      }),
    );
    expect(result.activations).toHaveLength(2);
    expect(result.routeSetVersionNo).toBe(2);
  });

  it("权重合计不为 10000 → RouteSetRequiresAtomicUpdateError", async () => {
    const store = createMockStore({});
    const activateRouteSet = createActivateRouteSet({ store, now: () => NOW });

    await expect(
      activateRouteSet(
        makeCommand({
          desiredRoutes: [
            {
              routeKey: "primary",
              routeGroupId: "primary",
              agentRevisionId: BASE_AGENT_REVISION.id,
              runtimeRevisionId: BASE_RUNTIME_REVISION.id,
              trafficWeight: 5000,
              priorityNo: 0,
              eligibilityConditions: {},
              activationState: "active",
            },
            {
              routeKey: "primary",
              routeGroupId: "primary",
              agentRevisionId: BASE_AGENT_REVISION.id,
              runtimeRevisionId: BASE_RUNTIME_REVISION.id,
              trafficWeight: 4000,
              priorityNo: 0,
              eligibilityConditions: {},
              activationState: "active",
            },
          ],
        }),
      ),
    ).rejects.toThrow(RouteSetRequiresAtomicUpdateError);
  });

  it("不同 Group 相同 Selector 和 Priority → RouteSetRequiresAtomicUpdateError", async () => {
    const store = createMockStore({});
    const activateRouteSet = createActivateRouteSet({ store, now: () => NOW });

    await expect(
      activateRouteSet(
        makeCommand({
          desiredRoutes: [
            {
              routeKey: "group-a",
              routeGroupId: "group-a",
              agentRevisionId: BASE_AGENT_REVISION.id,
              runtimeRevisionId: BASE_RUNTIME_REVISION.id,
              trafficWeight: 10000,
              priorityNo: 0,
              eligibilityConditions: {},
              activationState: "active",
            },
            {
              routeKey: "group-b",
              routeGroupId: "group-b",
              agentRevisionId: BASE_AGENT_REVISION.id,
              runtimeRevisionId: BASE_RUNTIME_REVISION.id,
              trafficWeight: 10000,
              priorityNo: 0,
              eligibilityConditions: {},
              activationState: "active",
            },
          ],
        }),
      ),
    ).rejects.toThrow(RouteSetRequiresAtomicUpdateError);
  });

  it("RouteSet 版本冲突 → RouteSetVersionConflictError", async () => {
    const store = createMockStore({});
    const activateRouteSet = createActivateRouteSet({ store, now: () => NOW });

    await expect(activateRouteSet(makeCommand({ expectedVersionNo: 999 }))).rejects.toThrow(
      RouteSetVersionConflictError,
    );
  });

  it("AgentRevision 非 published → RevisionNotPublishedError", async () => {
    const store = createMockStore({
      agentRevisions: new Map([
        [
          "agent-rev-draft",
          { ...BASE_AGENT_REVISION, id: "agent-rev-draft", revisionState: "draft" },
        ],
      ]),
    });
    const activateRouteSet = createActivateRouteSet({ store, now: () => NOW });

    await expect(
      activateRouteSet(
        makeCommand({
          desiredRoutes: [
            {
              routeKey: "primary",
              routeGroupId: "primary",
              agentRevisionId: "agent-rev-draft",
              runtimeRevisionId: BASE_RUNTIME_REVISION.id,
              trafficWeight: 10000,
              priorityNo: 0,
              eligibilityConditions: {},
              activationState: "active",
            },
          ],
        }),
      ),
    ).rejects.toThrow(RevisionNotPublishedError);
  });

  it("Attestation 缺失 → ArtifactNotVerifiedForRouteError", async () => {
    const store = createMockStore({
      attestationResults: new Map([
        ["agent_revision:agent-rev-1", false],
        ["runtime_revision:runtime-rev-1", true],
      ]),
    });
    const activateRouteSet = createActivateRouteSet({ store, now: () => NOW });

    await expect(activateRouteSet(makeCommand())).rejects.toThrow(ArtifactNotVerifiedForRouteError);
  });

  it("actor tenantId 与 command tenantId 不一致 → Error", async () => {
    const store = createMockStore({});
    const activateRouteSet = createActivateRouteSet({ store, now: () => NOW });

    await expect(
      activateRouteSet(
        makeCommand({
          actor: { tenantId: "other-tenant", actorType: "user", actorId: "user-1" },
        }),
      ),
    ).rejects.toThrow("actor tenant");
  });

  it("RuntimeRevision capability 不满足 → AgentCapabilityUnsupportedError", async () => {
    const store = createMockStore({
      agentRevisions: new Map([
        ["agent-rev-1", { ...BASE_AGENT_REVISION, requiredCapabilities: ["gpu"] }],
      ]),
      runtimeRevisions: new Map([
        ["runtime-rev-1", { ...BASE_RUNTIME_REVISION, capabilities: [] }],
      ]),
    });
    const activateRouteSet = createActivateRouteSet({ store, now: () => NOW });

    await expect(activateRouteSet(makeCommand())).rejects.toThrow(AgentCapabilityUnsupportedError);
  });
});
