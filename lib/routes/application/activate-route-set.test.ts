import type { RevisionExecutionEvidenceReader } from "@/lib/control-plane/application/revision-execution-evidence-reader";
import type {
  AgentTargetEvidenceSnapshot,
  RevisionExecutionEvidenceSnapshot,
  RuntimeTargetEvidenceSnapshot,
} from "@/lib/control-plane/domain/revision-execution-eligibility";
import {
  type ActivateRouteSetCommand,
  type ActivateRouteSetResult,
  RouteSetRequiresAtomicUpdateError,
  createActivateRouteSet,
} from "@/lib/routes/application/activate-route-set";
import {
  RevisionNotPublishedError,
  RouteIdempotencyCompletionError,
  type RouteRevisionTarget,
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
  RouteSetTarget,
  RuntimeRevisionSummary,
} from "@/lib/routes/persistence/route-set-activation-store";
import {
  PUBLICATION_CONFORMANCE_CASES,
  PUBLICATION_CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import { describe, expect, it, vi } from "vitest";

// ─── 专题01 冻结架构：target 判别联合 ──────────────────────
// 正式 target 类型来自领域定义（route-revision / route-set-activation-store /
// revision-execution-eligibility）。测试直接使用正式类型，不得再定义重复本地形状或窄型 cast。
type AgentTarget = Extract<RouteRevisionTarget, { kind: "agent" }>;
type RuntimeTarget = Extract<RouteRevisionTarget, { kind: "runtime" }>;
/** Agent 目标 DesiredRoute — target 收敛到 agent 分支，只携带 Agent 事实。 */
type AgentDesiredRoute = DesiredRoute & { target: AgentTarget };
/** Runtime 目标 DesiredRoute — target 收敛到 runtime 分支，只携带 Runtime 事实。 */
type RuntimeDesiredRoute = DesiredRoute & { target: RuntimeTarget };

// ─── 测试 Fixtures ──────────────────────────────────────────

const TENANT_ID = "tenant-1";
const AGENT_ID = "agent-1";
const AGENT_REVISION_ID = "agent-rev-1";
const RUNTIME_REVISION_ID = "runtime-rev-1";
const ROUTE_SET_ID = "rs-1";
const ROUTE_SCOPE_KEY = "prod";
const ACTOR = { tenantId: TENANT_ID, actorType: "user" as const, actorId: "user-1" };

/** Agent RouteSet — target:{kind:"agent", agentId}。 */
const BASE_AGENT_ROUTE_SET: RouteSetRow = {
  id: ROUTE_SET_ID,
  tenantId: TENANT_ID,
  target: { kind: "agent", agentId: AGENT_ID } satisfies RouteSetTarget,
  routeScopeKey: ROUTE_SCOPE_KEY,
  routeScopeJson: {},
  versionNo: 1,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

/** Runtime RouteSet — target:{kind:"runtime"}，不携带 agentId。 */
const BASE_RUNTIME_ROUTE_SET: RouteSetRow = {
  id: ROUTE_SET_ID,
  tenantId: TENANT_ID,
  target: { kind: "runtime" } satisfies RouteSetTarget,
  routeScopeKey: ROUTE_SCOPE_KEY,
  routeScopeJson: {},
  versionNo: 1,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const BASE_AGENT_REVISION: AgentRevisionSummary = {
  id: AGENT_REVISION_ID,
  agentId: AGENT_ID,
  revisionState: "published",
};

/** 另一 Agent 的 Revision — 用于 D（跨 Agent 拒绝）。 */
const OTHER_AGENT_REVISION: AgentRevisionSummary = {
  id: "agent-rev-other",
  agentId: "agent-other",
  revisionState: "published",
};

const BASE_RUNTIME_REVISION: RuntimeRevisionSummary = {
  id: RUNTIME_REVISION_ID,
  revisionState: "published",
};

// §04: Agent target Evidence Snapshot — 只含 Agent publication / lifecycle /
// revision state + public policy。不得携带任何 runtime 字段（专题01 冻结架构）。
const AGENT_ELIGIBLE_SNAPSHOT = {
  kind: "agent",
  tenantId: TENANT_ID,
  agentRevisionId: AGENT_REVISION_ID,
  // Agent 是源码不可见黑盒：无 Agent Artifact Evidence（发布权威 = AgentContractSnapshot）。
  agentPublication: {
    publicationRecordId: "pub-1",
    subjectType: "agent_revision",
    subjectRevisionId: AGENT_REVISION_ID,
    evidenceSetDigest: "sha256:e",
    attestationIds: [],
    conformanceRunId: null,
    withdrawalRecordId: null,
    publishedAt: new Date(),
    agentContractSnapshotId: "snapshot-1",
    agentContractDigest: "sha256:p",
    agentCapabilityDigest: "sha256:m",
    agentContextDigest: "sha256:c",
  },
  agentLifecycleState: "active",
  agentRevisionState: "published",
  policyRequirement: { kind: "none" },
} satisfies AgentTargetEvidenceSnapshot;

// §04: Runtime target Evidence Snapshot — 只含 Runtime evidence（不含任何 Agent 字段）。
const RUNTIME_ELIGIBLE_SNAPSHOT = {
  kind: "runtime",
  tenantId: TENANT_ID,
  runtimeRevisionId: RUNTIME_REVISION_ID,
  runtimeArtifactEvidence: {
    tenantId: TENANT_ID,
    artifactType: "runtime_revision",
    artifactRevisionId: RUNTIME_REVISION_ID,
    artifactId: "art-2",
    artifactDigest: "sha256:b",
    attestationId: "att-2",
    verificationState: "verified",
    attestationFormat: "in_toto_dsse",
    verifiedAt: new Date(),
    revokedAt: null,
    revocationRecordId: null,
    verificationPolicyRevisionId: null,
    envelopeDigest: null,
  },
  runtimePublication: {
    publicationRecordId: "pub-2",
    subjectType: "runtime_revision",
    subjectRevisionId: RUNTIME_REVISION_ID,
    evidenceSetDigest: "sha256:f",
    attestationIds: ["att-2"],
    conformanceRunId: "conf-1",
    withdrawalRecordId: null,
    publishedAt: new Date(),
    agentContractSnapshotId: null,
    agentContractDigest: null,
    agentCapabilityDigest: null,
    agentContextDigest: null,
  },
  runtimeConformance: {
    run: {
      runId: "conf-1",
      tenantId: TENANT_ID,
      runtimeRevisionId: RUNTIME_REVISION_ID,
      overallResult: "passed",
      runtimeTargetDigest: "sha256:b",
      runtimeConfigDigest: "sha256:config",
      protocolContractRevision: "agent-runtime-protocol@1",
      suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
      conformanceFormat: "standard_dsse",
    },
    caseResults: PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({ caseId, passed: true })),
    expected: {
      tenantId: TENANT_ID,
      runtimeRevisionId: RUNTIME_REVISION_ID,
      runtimeTargetDigest: "sha256:b",
      runtimeConfigDigest: "sha256:config",
      protocolContractRevision: "agent-runtime-protocol@1",
      allowedFormats: ["standard_dsse"],
    },
  },
  runtimeLifecycleState: "active",
  runtimeRevisionState: "published",
  runtimeEvidenceKind: "hosted_artifact",
  policyRequirement: { kind: "none" },
} satisfies RuntimeTargetEvidenceSnapshot;

// RouteRevisionRecord fixture — 构造单一合法 DB target row。
// Agent 组：agent 事实非空 + runtime 组字段为 null（不混合，CHECK 约束）。
function makeAgentRevisionRecord(
  overrides: Partial<RouteRevisionRecord> = {},
): RouteRevisionRecord {
  return {
    id: "rev-1",
    tenantId: TENANT_ID,
    routeId: "route-1",
    routeSetId: ROUTE_SET_ID,
    revisionNo: 1,
    agentRevisionId: AGENT_REVISION_ID,
    runtimeRevisionId: null,
    agentEndpointRef: "https://agent.example.com/a2a",
    agentIdentityMode: "bearer",
    agentCredentialRefId: "cred-1",
    agentNetworkZone: "private",
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
  };
}

// Runtime 组：runtimeRevisionId 非空 + agent 组字段为 null（不混合，CHECK 约束）。
function makeRuntimeRevisionRecord(
  overrides: Partial<RouteRevisionRecord> = {},
): RouteRevisionRecord {
  return {
    id: "rev-1",
    tenantId: TENANT_ID,
    routeId: "route-1",
    routeSetId: ROUTE_SET_ID,
    revisionNo: 1,
    agentRevisionId: null,
    runtimeRevisionId: RUNTIME_REVISION_ID,
    agentEndpointRef: null,
    agentIdentityMode: null,
    agentCredentialRefId: null,
    agentNetworkZone: null,
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
  };
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
    previousRouteActivationId: null,
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
  routeSetVersionConflict?: boolean;
  latestActivations?: Map<string, RouteActivationRecord>;
  revisionsById?: Map<string, RouteRevisionRecord>;
  appendAudit?: ReturnType<typeof vi.fn>;
  appendOutbox?: ReturnType<typeof vi.fn>;
  completeIdempotency?: ReturnType<typeof vi.fn>;
}): RouteSetActivationStore {
  const routeSet = overrides.routeSet ?? BASE_AGENT_ROUTE_SET;
  const existingRoutes = overrides.existingRoutes ?? [];
  const agentRevisions =
    overrides.agentRevisions ?? new Map([[AGENT_REVISION_ID, BASE_AGENT_REVISION]]);
  const runtimeRevisions =
    overrides.runtimeRevisions ?? new Map([[RUNTIME_REVISION_ID, BASE_RUNTIME_REVISION]]);

  let revisionNo = 1;
  let activationSeq = 1;
  let routeCounter = 1;

  const mockDbOrTx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ agentInterfaceRequirementsJson: null }]),
        }),
      }),
    }),
  } as any;

  // 单一 session 在工厂闭包内共享，事务多次调用复用同一 session 的 vi.fn，
  // 使测试可从 store 上捕获到激活实际使用的 session。
  const session: RouteSetActivationSession = {
    getDbOrTx: vi.fn(() => mockDbOrTx),
    lockRouteSet: vi.fn(async () => routeSet),
    listRoutesBySet: vi.fn(async () => existingRoutes),
    findLatestActivation: vi.fn(
      async (routeId: string) => overrides.latestActivations?.get(routeId) ?? null,
    ),
    findRevisionById: vi.fn(async (id: string) => overrides.revisionsById?.get(id) ?? null),
    findAgentRevision: vi.fn(async (id: string) => agentRevisions.get(id) ?? null),
    findRuntimeRevision: vi.fn(async (id: string) => runtimeRevisions.get(id) ?? null),
    resolveOrCreateRouteIdentity: vi.fn(
      async (params: { routeSetId: string; routeId?: string; routeKey: string }) => {
        const resolvedId = params.routeId ?? `route-${routeCounter++}`;
        return {
          id: resolvedId,
          routeSetId: params.routeSetId,
          routeKey: params.routeKey,
          agentRevisionId: AGENT_REVISION_ID,
          runtimeRevisionId: RUNTIME_REVISION_ID,
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
      (params.content?.target?.kind === "runtime"
        ? makeRuntimeRevisionRecord
        : makeAgentRevisionRecord)({
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
        previousRouteRevisionId: params.previousRouteRevisionId,
        previousRouteActivationId: params.previousRouteActivationId,
        routeSetVersionNo: params.routeSetVersionNo,
      }),
    ),
    updateRouteProjection: vi.fn(async () => ({
      id: "route-1",
      routeSetId: ROUTE_SET_ID,
      routeKey: "primary",
      agentRevisionId: AGENT_REVISION_ID,
      runtimeRevisionId: RUNTIME_REVISION_ID,
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
    appendAudit: overrides.appendAudit ?? vi.fn(async () => {}),
    appendOutbox: overrides.appendOutbox ?? vi.fn(async () => {}),
    completeIdempotency: overrides.completeIdempotency ?? vi.fn(async () => true),
  };

  const store: RouteSetActivationStore = {
    transaction: async <T>(operation: (s: RouteSetActivationSession) => Promise<T>): Promise<T> =>
      operation(session),
  };
  // 暴露共享 session，供测试捕获激活实际使用的 session。
  (store as any).__session = session;
  return store;
}

const NOW = new Date("2026-06-01T00:00:00Z");

// ─── target 形状的 DesiredRoute 构造器 ─────────────────────

function agentDesired(overrides: Partial<AgentDesiredRoute> = {}): AgentDesiredRoute {
  return {
    routeKey: "primary",
    routeGroupId: "primary",
    target: {
      kind: "agent",
      agentRevisionId: AGENT_REVISION_ID,
      agentEndpointRef: "https://agent.example.com/a2a",
      agentIdentityMode: "bearer",
      agentCredentialRefId: "cred-1",
      agentNetworkZone: "private",
    },
    trafficWeight: 10000,
    priorityNo: 0,
    eligibilityConditions: {},
    activationState: "active",
    ...overrides,
  };
}

function runtimeDesired(overrides: Partial<RuntimeDesiredRoute> = {}): RuntimeDesiredRoute {
  return {
    routeKey: "primary",
    routeGroupId: "primary",
    target: { kind: "runtime", runtimeRevisionId: RUNTIME_REVISION_ID },
    trafficWeight: 10000,
    priorityNo: 0,
    eligibilityConditions: {},
    activationState: "active",
    ...overrides,
  };
}

function makeCommand(
  desiredRoutes: DesiredRoute[],
  overrides: Partial<ActivateRouteSetCommand> = {},
): ActivateRouteSetCommand {
  return {
    tenantId: TENANT_ID,
    routeSetId: ROUTE_SET_ID,
    expectedVersionNo: 1,
    desiredRoutes,
    actor: ACTOR,
    reason: "test activation",
    requestId: "req-1",
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

function makeReader(snapshot: RevisionExecutionEvidenceSnapshot): RevisionExecutionEvidenceReader {
  return {
    loadCurrentEvidence: vi.fn(async () => snapshot),
    loadExactEvidence: vi.fn(async () => snapshot),
  };
}

function activate(store: RouteSetActivationStore, reader: RevisionExecutionEvidenceReader) {
  return createActivateRouteSet({
    store,
    evidenceReaderForTest: reader,
    now: () => NOW,
  });
}

// ─── 原有行为（迁移到 target 形状，保留语义）───────────────

describe("activateRouteSet — 原有行为（target 形状）", () => {
  it("完整 replacement 把隐式 disabled Route 同时写入结果和 outbox", async () => {
    const appendAudit = vi.fn(async () => {});
    const appendOutbox = vi.fn(async () => {});
    const previousActivation = makeActivationRecord({
      id: "act-previous",
      routeId: "route-removed",
      routeRevisionId: "rev-removed",
    });
    const previousRevision = makeAgentRevisionRecord({
      id: "rev-removed",
      routeId: "route-removed",
      routeGroupId: "removed-group",
    });
    const store = createMockStore({
      existingRoutes: [
        {
          id: "route-removed",
          routeSetId: ROUTE_SET_ID,
          routeKey: "removed",
          agentRevisionId: AGENT_REVISION_ID,
          runtimeRevisionId: RUNTIME_REVISION_ID,
          trafficWeight: 10000,
          priorityNo: 0,
          routeState: "enabled",
          effectiveFrom: null,
          effectiveUntil: null,
          activeRouteRevisionId: "rev-removed",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      latestActivations: new Map([["route-removed", previousActivation]]),
      revisionsById: new Map([["rev-removed", previousRevision]]),
      appendAudit,
      appendOutbox,
    });

    const result = await activate(
      store,
      makeReader(AGENT_ELIGIBLE_SNAPSHOT),
    )(makeCommand([agentDesired()]));

    expect(result.activations).toEqual([
      {
        routeId: "route-1",
        routeRevisionId: expect.any(String),
        routeActivationId: expect.any(String),
        activationState: "active",
        routeGroupId: "primary",
        previousRouteRevisionId: null,
        previousRouteActivationId: null,
      },
      {
        routeId: "route-removed",
        routeRevisionId: "rev-removed",
        routeActivationId: expect.any(String),
        activationState: "disabled",
        routeGroupId: "removed-group",
        previousRouteRevisionId: "rev-removed",
        previousRouteActivationId: "act-previous",
      },
    ]);
    expect(appendOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          tenant_id: TENANT_ID,
          route_ids: result.activations.map((activation) => activation.routeId),
          activation_ids: result.activations.map((activation) => activation.routeActivationId),
        }),
      }),
    );
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({
          route_ids: result.activations.map((activation) => activation.routeId),
          activation_ids: result.activations.map((activation) => activation.routeActivationId),
        }),
      }),
    );
  });

  it("隐式 disabled Route 的历史 Revision 缺失时拒绝部分成功", async () => {
    const store = createMockStore({
      existingRoutes: [
        {
          id: "route-removed",
          routeSetId: ROUTE_SET_ID,
          routeKey: "removed",
          agentRevisionId: AGENT_REVISION_ID,
          runtimeRevisionId: RUNTIME_REVISION_ID,
          trafficWeight: 10000,
          priorityNo: 0,
          routeState: "enabled",
          effectiveFrom: null,
          effectiveUntil: null,
          activeRouteRevisionId: "rev-missing",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      latestActivations: new Map([
        [
          "route-removed",
          makeActivationRecord({
            id: "act-previous",
            routeId: "route-removed",
            routeRevisionId: "rev-missing",
          }),
        ],
      ]),
    });

    await expect(
      activate(store, makeReader(AGENT_ELIGIBLE_SNAPSHOT))(makeCommand([agentDesired()])),
    ).rejects.toThrow("隐式禁用 Route route-removed 时找不到历史 Revision rev-missing");
  });

  it("隐式 disabled Route 的历史 Activation 缺失时拒绝部分成功", async () => {
    const store = createMockStore({
      existingRoutes: [
        {
          id: "route-removed",
          routeSetId: ROUTE_SET_ID,
          routeKey: "removed",
          agentRevisionId: AGENT_REVISION_ID,
          runtimeRevisionId: RUNTIME_REVISION_ID,
          trafficWeight: 10000,
          priorityNo: 0,
          routeState: "enabled",
          effectiveFrom: null,
          effectiveUntil: null,
          activeRouteRevisionId: "rev-missing",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });

    await expect(
      activate(store, makeReader(AGENT_ELIGIBLE_SNAPSHOT))(makeCommand([agentDesired()])),
    ).rejects.toThrow("隐式禁用 Route route-removed 时找不到历史 Activation");
  });

  it("单条 10000 权重激活 — 成功", async () => {
    const store = createMockStore({});
    const result = await activate(
      store,
      makeReader(AGENT_ELIGIBLE_SNAPSHOT),
    )(makeCommand([agentDesired()]));
    expect(result.routeSetId).toBe(ROUTE_SET_ID);
    expect(result.routeSetVersionNo).toBe(2);
    expect(result.activations).toHaveLength(1);
    expect(result.activations[0]?.activationState).toBe("active");
    expect(result.affectsNewInvocationsOnly).toBe(true);
  });

  it("两条 5000/5000 同 Group 原子激活 — 成功", async () => {
    const store = createMockStore({});
    const result = await activate(
      store,
      makeReader(AGENT_ELIGIBLE_SNAPSHOT),
    )(
      makeCommand([
        agentDesired({ routeKey: "primary", trafficWeight: 5000 }),
        agentDesired({ routeKey: "secondary", trafficWeight: 5000 }),
      ]),
    );
    expect(result.activations).toHaveLength(2);
    expect(result.routeSetVersionNo).toBe(2);
  });

  it("权重合计不为 10000 → RouteSetRequiresAtomicUpdateError", async () => {
    const store = createMockStore({});
    await expect(
      activate(
        store,
        makeReader(AGENT_ELIGIBLE_SNAPSHOT),
      )(
        makeCommand([
          agentDesired({ routeKey: "primary", trafficWeight: 5000 }),
          agentDesired({ routeKey: "primary", trafficWeight: 4000 }),
        ]),
      ),
    ).rejects.toThrow(RouteSetRequiresAtomicUpdateError);
  });

  it("不同 Group 相同 Selector 和 Priority → RouteSetRequiresAtomicUpdateError", async () => {
    const store = createMockStore({});
    await expect(
      activate(
        store,
        makeReader(AGENT_ELIGIBLE_SNAPSHOT),
      )(
        makeCommand([
          agentDesired({ routeKey: "group-a", routeGroupId: "group-a" }),
          agentDesired({ routeKey: "group-b", routeGroupId: "group-b" }),
        ]),
      ),
    ).rejects.toThrow(RouteSetRequiresAtomicUpdateError);
  });

  it("RouteSet 版本冲突 → RouteSetVersionConflictError", async () => {
    const store = createMockStore({});
    await expect(
      activate(
        store,
        makeReader(AGENT_ELIGIBLE_SNAPSHOT),
      )(makeCommand([agentDesired()], { expectedVersionNo: 999 })),
    ).rejects.toThrow(RouteSetVersionConflictError);
  });

  it("actor tenantId 与 command tenantId 不一致 → Error", async () => {
    const store = createMockStore({});
    await expect(
      activate(
        store,
        makeReader(AGENT_ELIGIBLE_SNAPSHOT),
      )(
        makeCommand([agentDesired()], {
          actor: { tenantId: "other-tenant", actorType: "user", actorId: "user-1" },
        }),
      ),
    ).rejects.toThrow("actor tenant");
  });

  it("IdempotencyRecord authority 缺失时拒绝提交", async () => {
    const store = createMockStore({ completeIdempotency: vi.fn(async () => false) });
    await expect(
      activate(
        store,
        makeReader(AGENT_ELIGIBLE_SNAPSHOT),
      )(
        makeCommand([agentDesired()], {
          idempotencyCompletion: {
            recordId: "missing-record",
            httpStatus: 200,
            serializeResponse: JSON.stringify,
          },
        }),
      ),
    ).rejects.toThrow(RouteIdempotencyCompletionError);
  });

  it("历史 Activation 不属于当前 tenant/Route/RouteSet 时 fail-closed", async () => {
    const store = createMockStore({
      latestActivations: new Map([
        ["route-1", makeActivationRecord({ tenantId: "other-tenant", routeId: "route-1" })],
      ]),
    });
    await expect(
      activate(store, makeReader(AGENT_ELIGIBLE_SNAPSHOT))(makeCommand([agentDesired()])),
    ).rejects.toThrow("历史 Activation 与当前 Route authority 不一致");
  });
});

// ─── 专题01 target 判别断言 A–F ────────────────────────────

describe("activateRouteSet — target 判别（专题01 冻结架构）", () => {
  it("A. agent Route activation 成功，不读 runtimeRevisionId / runtime evidence", async () => {
    const store = createMockStore({});
    const reader = makeReader(AGENT_ELIGIBLE_SNAPSHOT);
    const activateRouteSet = activate(store, reader);

    const result = await activateRouteSet(makeCommand([agentDesired()]));

    // 成功 + 生成 agent target content
    expect(result.routeSetVersionNo).toBe(2);
    expect(result.activations).toHaveLength(1);
    const session = captureSession(store);
    const appendRevisionMock = (session.appendRevision as unknown as { mock: { calls: any[][] } })
      .mock;
    expect(appendRevisionMock.calls).toHaveLength(1);
    const appendedContent = appendRevisionMock.calls[0]?.[0]?.content;
    expect(appendedContent?.target?.kind).toBe("agent");
    expect(appendedContent?.target?.agentRevisionId).toBe(AGENT_REVISION_ID);
    // target 必须不携带 runtimeRevisionId own property（不得构造 placeholder）
    expect(Object.prototype.hasOwnProperty.call(appendedContent?.target, "runtimeRevisionId")).toBe(
      false,
    );

    // 依赖隔离：agent target 不得调用 findRuntimeRevision，也不得要求 runtime evidence
    expect(session.findRuntimeRevision).not.toHaveBeenCalled();
    const loadCurrent = reader.loadCurrentEvidence as ReturnType<typeof vi.fn>;
    expect(loadCurrent).toHaveBeenCalledTimes(1);
    const input = loadCurrent.mock.calls[0]?.[0];
    expect(Object.prototype.hasOwnProperty.call(input, "runtimeRevisionId")).toBe(false);
  });

  it("B. runtime Route activation 成功，target 不含 agent fields，不读 findAgentRevision", async () => {
    const store = createMockStore({ routeSet: BASE_RUNTIME_ROUTE_SET });
    const reader = makeReader(RUNTIME_ELIGIBLE_SNAPSHOT);
    const activateRouteSet = activate(store, reader);

    const result = await activateRouteSet(makeCommand([runtimeDesired()]));

    expect(result.routeSetVersionNo).toBe(2);
    expect(result.activations).toHaveLength(1);
    const session = captureSession(store);
    const appendRevisionMock = (session.appendRevision as unknown as { mock: { calls: any[][] } })
      .mock;
    const appendedContent = appendRevisionMock.calls[0]?.[0]?.content;
    expect(appendedContent?.target?.kind).toBe("runtime");
    expect(appendedContent?.target?.runtimeRevisionId).toBe(RUNTIME_REVISION_ID);
    // runtime target 不得携带任何 agent target 事实 own property
    for (const key of [
      "agentRevisionId",
      "agentEndpointRef",
      "agentIdentityMode",
      "agentCredentialRefId",
      "agentNetworkZone",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(appendedContent?.target, key)).toBe(false);
    }

    // 依赖隔离：runtime target 不得调用 findAgentRevision
    expect(session.findAgentRevision).not.toHaveBeenCalled();
    const loadCurrent = reader.loadCurrentEvidence as ReturnType<typeof vi.fn>;
    const input = loadCurrent.mock.calls[0]?.[0];
    expect(input?.agentRevisionId ?? null).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(input, "agentRevisionId")).toBe(false);
  });

  it("C. Agent RouteSet 拒绝 runtime desired；Runtime RouteSet 拒绝 agent desired", async () => {
    const agentStore = createMockStore({ routeSet: BASE_AGENT_ROUTE_SET });
    await expect(
      activate(agentStore, makeReader(RUNTIME_ELIGIBLE_SNAPSHOT))(makeCommand([runtimeDesired()])),
    ).rejects.toThrow();

    const runtimeStore = createMockStore({ routeSet: BASE_RUNTIME_ROUTE_SET });
    await expect(
      activate(runtimeStore, makeReader(AGENT_ELIGIBLE_SNAPSHOT))(makeCommand([agentDesired()])),
    ).rejects.toThrow();
  });

  it("D. agent Route 的 AgentRevision 属于另一 Agent 时拒绝", async () => {
    const store = createMockStore({
      routeSet: BASE_AGENT_ROUTE_SET,
      agentRevisions: new Map([
        [OTHER_AGENT_REVISION.id, OTHER_AGENT_REVISION],
        [AGENT_REVISION_ID, BASE_AGENT_REVISION],
      ]),
    });
    const reader = makeReader({
      ...AGENT_ELIGIBLE_SNAPSHOT,
      agentRevisionId: OTHER_AGENT_REVISION.id,
    });
    await expect(
      activate(
        store,
        reader,
      )(
        makeCommand([
          agentDesired({
            target: {
              kind: "agent",
              agentRevisionId: OTHER_AGENT_REVISION.id,
              agentEndpointRef: "https://agent.example.com/a2a",
              agentIdentityMode: "bearer",
              agentCredentialRefId: "cred-1",
              agentNetworkZone: "private",
            },
          }),
        ]),
      ),
    ).rejects.toThrow();
  });

  it("E. 撤回/不合格 Agent publication 拒绝 agent active，但 unrelated Runtime 状态不影响 Agent Route", async () => {
    const store = createMockStore({ routeSet: BASE_AGENT_ROUTE_SET });
    // Agent publication 撤回（无 Active Publication）+ AgentRevision 撤回；
    // runtime 状态/证据完全不相关，Agent Route 不得受其影响。
    const reader = makeReader({
      ...AGENT_ELIGIBLE_SNAPSHOT,
      agentPublication: null,
      agentRevisionState: "withdrawn",
    });
    await expect(activate(store, reader)(makeCommand([agentDesired()]))).rejects.toThrow(
      "执行资格不足",
    );

    // 即便 runtime 状态完全不同（quarantined/无 publication），Agent Route 判定的
    // 失败维度仍必须来自 Agent publication/revision，而非 runtime。reader input 不得含 runtime。
    const loadCurrent = reader.loadCurrentEvidence as ReturnType<typeof vi.fn>;
    const input = loadCurrent.mock.calls[0]?.[0];
    expect(Object.prototype.hasOwnProperty.call(input, "runtimeRevisionId")).toBe(false);
  });

  it("F. policy 在 agent 与 runtime 两种 target 上都 fail-closed", async () => {
    // agent target + 引用了已撤回 policy → 拒绝
    const agentStore = createMockStore({ routeSet: BASE_AGENT_ROUTE_SET });
    const agentPolicyReader = makeReader({
      ...AGENT_ELIGIBLE_SNAPSHOT,
      policyRequirement: {
        kind: "referenced",
        policyRevisionId: "policy-1",
        policyRevision: { id: "policy-1", revisionState: "withdrawn", publishedAt: null },
      },
    });
    await expect(
      activate(
        agentStore,
        agentPolicyReader,
      )(
        makeCommand([
          agentDesired({
            policyRevisionId: "policy-1",
            target: {
              kind: "agent",
              agentRevisionId: AGENT_REVISION_ID,
              agentEndpointRef: "https://agent.example.com/a2a",
              agentIdentityMode: "bearer",
              agentCredentialRefId: "cred-1",
              agentNetworkZone: "private",
            },
          }),
        ]),
      ),
    ).rejects.toThrow("执行资格不足");

    // runtime target + 引用了未 published policy → 拒绝
    const runtimeStore = createMockStore({ routeSet: BASE_RUNTIME_ROUTE_SET });
    const runtimePolicyReader = makeReader({
      ...RUNTIME_ELIGIBLE_SNAPSHOT,
      policyRequirement: {
        kind: "referenced",
        policyRevisionId: "policy-2",
        policyRevision: { id: "policy-2", revisionState: "draft", publishedAt: null },
      },
    });
    await expect(
      activate(
        runtimeStore,
        runtimePolicyReader,
      )(
        makeCommand([
          runtimeDesired({
            policyRevisionId: "policy-2",
            target: { kind: "runtime", runtimeRevisionId: RUNTIME_REVISION_ID },
          }),
        ]),
      ),
    ).rejects.toThrow("执行资格不足");
  });
});

// ─── 辅助：从 store 捕获激活实际使用的共享 session ─────────
function captureSession(store: RouteSetActivationStore): RouteSetActivationSession {
  const captured = (store as any).__session as RouteSetActivationSession | undefined;
  if (!captured) throw new Error("captureSession: no session captured");
  return captured;
}
