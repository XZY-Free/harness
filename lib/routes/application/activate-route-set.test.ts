import type { RevisionExecutionEvidenceReader } from "@/lib/control-plane/application/revision-execution-evidence-reader";
import type { RevisionExecutionEvidenceSnapshot } from "@/lib/control-plane/domain/revision-execution-eligibility";
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
  RouteIdempotencyCompletionError,
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
import {
  PUBLICATION_CONFORMANCE_CASES,
  PUBLICATION_CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtime/domain/runtime-conformance-contract";
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

// §04: Mock Evidence Reader — 返回完全资格的快照，供单元测试使用
const MOCK_ELIGIBLE_SNAPSHOT = {
  tenantId: TENANT_ID,
  agentRevisionId: BASE_AGENT_REVISION.id,
  agentArtifactEvidence: {
    tenantId: TENANT_ID,
    artifactType: "agent_revision",
    artifactRevisionId: BASE_AGENT_REVISION.id,
    artifactId: "art-1",
    artifactDigest: "sha256:a",
    attestationId: "att-1",
    verificationState: "verified" as const,
    attestationFormat: "in_toto_dsse" as const,
    verifiedAt: new Date(),
    revokedAt: null,
    revocationRecordId: null,
    verificationPolicyRevisionId: null,
    envelopeDigest: null,
  },
  agentPublication: {
    publicationRecordId: "pub-1",
    subjectType: "agent_revision" as const,
    subjectRevisionId: BASE_AGENT_REVISION.id,
    evidenceSetDigest: "sha256:e",
    attestationIds: ["att-1"],
    conformanceRunId: null,
    withdrawalRecordId: null,
    publishedAt: new Date(),
    agentContractSnapshotId: "snapshot-1",
    agentContractDigest: "sha256:p",
    agentCapabilityDigest: "sha256:m",
    agentContextDigest: "sha256:c",
  },
  agentLifecycleState: "active" as const,
  agentRevisionState: "published" as const,
  runtimeRevisionId: BASE_RUNTIME_REVISION.id,
  runtimeArtifactEvidence: {
    tenantId: TENANT_ID,
    artifactType: "runtime_revision",
    artifactRevisionId: BASE_RUNTIME_REVISION.id,
    artifactId: "art-2",
    artifactDigest: "sha256:b",
    attestationId: "att-2",
    verificationState: "verified" as const,
    attestationFormat: "in_toto_dsse" as const,
    verifiedAt: new Date(),
    revokedAt: null,
    revocationRecordId: null,
    verificationPolicyRevisionId: null,
    envelopeDigest: null,
  },
  runtimePublication: {
    publicationRecordId: "pub-2",
    subjectType: "runtime_revision" as const,
    subjectRevisionId: BASE_RUNTIME_REVISION.id,
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
      runtimeRevisionId: BASE_RUNTIME_REVISION.id,
      overallResult: "passed" as const,
      runtimeTargetDigest: "sha256:b",
      runtimeConfigDigest: "sha256:config",
      protocolContractRevision: "agent-runtime-protocol@1",
      suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
      conformanceFormat: "standard_dsse" as const,
    },
    caseResults: PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({ caseId, passed: true })),
    expected: {
      tenantId: TENANT_ID,
      runtimeRevisionId: BASE_RUNTIME_REVISION.id,
      runtimeTargetDigest: "sha256:b",
      runtimeConfigDigest: "sha256:config",
      protocolContractRevision: "agent-runtime-protocol@1",
      allowedFormats: ["standard_dsse"],
    },
  },
  runtimeLifecycleState: "active" as const,
  runtimeRevisionState: "published" as const,
  runtimeCapabilities: [],
  runtimeEvidenceKind: "hosted_artifact" as const,
  policyRequirement: { kind: "none" as const },
} satisfies RevisionExecutionEvidenceSnapshot;
const mockEvidenceReader: RevisionExecutionEvidenceReader = {
  loadCurrentEvidence: vi.fn(async () => MOCK_ELIGIBLE_SNAPSHOT),
  loadExactEvidence: vi.fn(async () => MOCK_ELIGIBLE_SNAPSHOT),
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
  attestationResults?: Map<string, boolean>;
  routeSetVersionConflict?: boolean;
  latestActivations?: Map<string, RouteActivationRecord>;
  revisionsById?: Map<string, RouteRevisionRecord>;
  appendAudit?: ReturnType<typeof vi.fn>;
  appendOutbox?: ReturnType<typeof vi.fn>;
  completeIdempotency?: ReturnType<typeof vi.fn>;
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
      const mockDbOrTx = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ agentInterfaceRequirementsJson: null }]),
            }),
          }),
        }),
      } as any;
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
            previousRouteRevisionId: params.previousRouteRevisionId,
            previousRouteActivationId: params.previousRouteActivationId,
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
        appendAudit: overrides.appendAudit ?? vi.fn(async () => {}),
        appendOutbox: overrides.appendOutbox ?? vi.fn(async () => {}),
        completeIdempotency: overrides.completeIdempotency ?? vi.fn(async () => true),
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
  it("完整 replacement 把隐式 disabled Route 同时写入结果和 outbox", async () => {
    const appendAudit = vi.fn(async () => {});
    const appendOutbox = vi.fn(async () => {});
    const previousActivation = makeActivationRecord({
      id: "act-previous",
      routeId: "route-removed",
      routeRevisionId: "rev-removed",
    });
    const previousRevision = makeRevisionRecord({
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
          agentRevisionId: BASE_AGENT_REVISION.id,
          runtimeRevisionId: BASE_RUNTIME_REVISION.id,
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
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: mockEvidenceReader,
      now: () => NOW,
    });

    const result = await activateRouteSet(makeCommand());

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
          agentRevisionId: BASE_AGENT_REVISION.id,
          runtimeRevisionId: BASE_RUNTIME_REVISION.id,
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
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: mockEvidenceReader,
      now: () => NOW,
    });

    await expect(activateRouteSet(makeCommand())).rejects.toThrow(
      "隐式禁用 Route route-removed 时找不到历史 Revision rev-missing",
    );
  });

  it("隐式 disabled Route 的历史 Activation 缺失时拒绝部分成功", async () => {
    const store = createMockStore({
      existingRoutes: [
        {
          id: "route-removed",
          routeSetId: ROUTE_SET_ID,
          routeKey: "removed",
          agentRevisionId: BASE_AGENT_REVISION.id,
          runtimeRevisionId: BASE_RUNTIME_REVISION.id,
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
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: mockEvidenceReader,
      now: () => NOW,
    });

    await expect(activateRouteSet(makeCommand())).rejects.toThrow(
      "隐式禁用 Route route-removed 时找不到历史 Activation",
    );
  });

  it("单条 10000 权重激活 — 成功", async () => {
    const store = createMockStore({});
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: mockEvidenceReader,
      now: () => NOW,
    });

    const result = await activateRouteSet(makeCommand());
    expect(result.routeSetId).toBe(ROUTE_SET_ID);
    expect(result.routeSetVersionNo).toBe(2);
    expect(result.activations).toHaveLength(1);
    expect(result.activations[0]?.activationState).toBe("active");
    expect(result.affectsNewInvocationsOnly).toBe(true);
  });

  it("两条 5000/5000 同 Group 原子激活 — 成功", async () => {
    const store = createMockStore({});
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: mockEvidenceReader,
      now: () => NOW,
    });

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
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: mockEvidenceReader,
      now: () => NOW,
    });

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
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: mockEvidenceReader,
      now: () => NOW,
    });

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
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: mockEvidenceReader,
      now: () => NOW,
    });

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
    const draftSnapshot = { ...MOCK_ELIGIBLE_SNAPSHOT, agentRevisionState: "draft" as const };
    const draftReader: RevisionExecutionEvidenceReader = {
      loadCurrentEvidence: vi.fn(async () => draftSnapshot),
      loadExactEvidence: vi.fn(async () => draftSnapshot),
    };
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: draftReader,
      now: () => NOW,
    });

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
    ).rejects.toThrow("执行资格不足");
  });

  it("Attestation 缺失 → ArtifactNotVerifiedForRouteError", async () => {
    const store = createMockStore({
      attestationResults: new Map([
        ["agent_revision:agent-rev-1", false],
        ["runtime_revision:runtime-rev-1", true],
      ]),
    });
    const noAttestationSnapshot = { ...MOCK_ELIGIBLE_SNAPSHOT, agentArtifactEvidence: null };
    const noAttestationReader: RevisionExecutionEvidenceReader = {
      loadCurrentEvidence: vi.fn(async () => noAttestationSnapshot),
      loadExactEvidence: vi.fn(async () => noAttestationSnapshot),
    };
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: noAttestationReader,
      now: () => NOW,
    });

    await expect(activateRouteSet(makeCommand())).rejects.toThrow("执行资格不足");
  });

  it("actor tenantId 与 command tenantId 不一致 → Error", async () => {
    const store = createMockStore({});
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: mockEvidenceReader,
      now: () => NOW,
    });

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
    // Override getDbOrTx to return agentInterfaceRequirementsJson with gpu requirement
    const origStore = store;
    const storeWithCapDb = {
      ...origStore,
      transaction: async <T>(
        operation: (session: RouteSetActivationSession) => Promise<T>,
      ): Promise<T> => {
        return origStore.transaction(async (session) => {
          const origGetDbOrTx = session.getDbOrTx.bind(session);
          return operation({
            ...session,
            getDbOrTx: () =>
              ({
                ...origGetDbOrTx(),
                select: () => ({
                  from: () => ({
                    where: () => ({
                      limit: () =>
                        Promise.resolve([
                          { agentInterfaceRequirementsJson: { required: ["gpu"] } },
                        ]),
                    }),
                  }),
                }),
              }) as any,
          });
        });
      },
    };
    const activateRouteSet = createActivateRouteSet({
      store: storeWithCapDb,
      evidenceReaderForTest: mockEvidenceReader,
      now: () => NOW,
    });

    await expect(activateRouteSet(makeCommand())).rejects.toThrow("执行资格不足");
  });

  it("IdempotencyRecord authority 缺失时拒绝提交", async () => {
    const store = createMockStore({ completeIdempotency: vi.fn(async () => false) });
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: mockEvidenceReader,
      now: () => NOW,
    });

    await expect(
      activateRouteSet(
        makeCommand({
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
    const activateRouteSet = createActivateRouteSet({
      store,
      evidenceReaderForTest: mockEvidenceReader,
      now: () => NOW,
    });

    await expect(activateRouteSet(makeCommand())).rejects.toThrow(
      "历史 Activation 与当前 Route authority 不一致",
    );
  });
});
