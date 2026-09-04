import { randomUUID } from "node:crypto";
import { createCreateAgentCall } from "@/lib/agents/calls/application/create-agent-call";
import { resolveAgentActionBinding } from "@/lib/agents/calls/application/resolve-agent-call-binding";
import { computeAgentCallBindingHash } from "@/lib/agents/calls/domain/agent-call-binding";
import {
  AgentCallStateConcurrencyError,
  createMysqlAgentCallStore,
  mysqlAgentCallStore,
} from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallTable,
} from "@/lib/persistence/schema/agent-calls";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { capabilityUseTable } from "@/lib/persistence/schema/capability-use";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { governanceConfigRevisionTable } from "@/lib/persistence/schema/governance-config";
import { policyRevisionTable } from "@/lib/persistence/schema/permission";
import { computePublicationEvidenceSetDigest } from "@/lib/publications/domain/publication-record";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { buildActor } from "@/lib/test-support/create-verified-attestation";
import { and, count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-29T00:00:00.000Z");
type Scenario = Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>;
let scenarios: Scenario[] = [];
let extraCredentialEnvVars: string[] = [];

beforeEach(async () => {
  await resetDatabase(db);
  scenarios = [];
  extraCredentialEnvVars = [];
});

afterEach(async () => {
  for (const scenario of scenarios) {
    delete process.env[scenario.credentialEnvVar];
    await scenario.provider.server.close();
  }
  for (const envVar of extraCredentialEnvVars) delete process.env[envVar];
});

async function seed(options?: Parameters<typeof seedAgentCallExecutionScenario>[0]) {
  const scenario = await seedAgentCallExecutionScenario(options);
  scenarios.push(scenario);
  return scenario;
}

function commandFor(
  scenario: Scenario,
  overrides: Partial<Parameters<ReturnType<typeof createCreateAgentCall>>[0]> = {},
) {
  return {
    tenantId: scenario.tenantId,
    parentInvocationId: scenario.parentInvocationId,
    agentId: scenario.agentId,
    actionId: scenario.actionId,
    transportChannel: "hosted" as const,
    bindingCandidate: scenario.binding,
    now: NOW,
    ...overrides,
  };
}

describe("mysqlAgentCallStore.finalizeAgentCall", () => {
  it("单事务创建 Call + Binding + Attempt(1) + CapabilityUse", async () => {
    const scenario = await seed();
    const [call] = await db
      .select()
      .from(agentCallTable)
      .where(eq(agentCallTable.id, scenario.callId));
    const [binding] = await db
      .select()
      .from(agentCallBindingTable)
      .where(eq(agentCallBindingTable.callId, scenario.callId));
    const [attempt] = await db
      .select()
      .from(agentCallAttemptTable)
      .where(eq(agentCallAttemptTable.callId, scenario.callId));
    const [use] = await db
      .select()
      .from(capabilityUseTable)
      .where(
        and(
          eq(capabilityUseTable.invocationId, scenario.parentInvocationId),
          eq(capabilityUseTable.capabilityType, "agent"),
        ),
      );
    expect(call?.creationRequestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(binding?.bindingHash).toBe(scenario.bindingHash);
    expect(attempt?.attemptNo).toBe(1);
    expect(use?.revisionId).toBe(scenario.agentRevisionId);
  });

  it("同 key 同 canonical request 重放，返回原 Call 且不重复 Attempt/CapabilityUse", async () => {
    const scenario = await seed();
    const create = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => NOW });
    const replay = await create(commandFor(scenario));
    expect(replay.status).toBe("replayed");
    expect(replay.call.id).toBe(scenario.callId);
    expect(
      await db
        .select()
        .from(agentCallAttemptTable)
        .where(eq(agentCallAttemptTable.callId, scenario.callId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(capabilityUseTable)
        .where(eq(capabilityUseTable.invocationId, scenario.parentInvocationId)),
    ).toHaveLength(1);
  });

  it("同 key 切到另一个有效 AgentRevision 也必须幂等冲突", async () => {
    const scenario = await seed();
    const latest = await scenario.createNewLatestEvidence();
    extraCredentialEnvVars.push(latest.newCredentialEnvVar);
    await activateSingleRouteForTest({
      tenantId: scenario.tenantId,
      routeSetId: scenario.resolution.routeSetId,
      routeId: scenario.resolution.deploymentRouteId,
      routeSetExpectedVersionNo: scenario.resolution.routeSetVersionNo,
      target: {
        kind: "agent",
        agentRevisionId: latest.newAgentRevisionId,
        agentEndpointRef: scenario.endpoint,
        agentIdentityMode: "bearer",
        agentCredentialRefId: latest.newCredentialRefId,
        agentNetworkZone: "private",
      },
      trafficWeight: 10_000,
      actor: buildActor(scenario.tenantId, "idempotency-revision-switch"),
    });
    const resolved = await resolveAgentActionBinding({
      tenantId: scenario.tenantId,
      agentId: scenario.agentId,
      resolveRoute: createResolveRoute({ store: mysqlRouteEligibilityResolutionStore }),
      routeScopeKey: "default",
      businessKey: { threadId: scenario.threadId },
    });
    const binding = resolved.bindingCandidate;
    await expect(
      mysqlAgentCallStore.finalizeAgentCall({
        id: randomUUID(),
        tenantId: scenario.tenantId,
        parentInvocationId: scenario.parentInvocationId,
        agentId: scenario.agentId,
        sourceType: "harness_planned",
        sourceRef: scenario.actionId,
        logicalCallKey: scenario.logicalCallKey,
        transportChannel: "hosted",
        bindingCandidate: binding,
        bindingHash: computeAgentCallBindingHash(binding),
        createdAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "AGENT_CALL_IDEMPOTENCY_CONFLICT" });
  });

  it("candidate 的 Agent 身份必须与创建命令精确一致", async () => {
    const scenario = await seed();
    const binding = { ...scenario.binding, agentId: randomUUID() };
    await expect(
      mysqlAgentCallStore.finalizeAgentCall({
        id: randomUUID(),
        tenantId: scenario.tenantId,
        parentInvocationId: scenario.parentInvocationId,
        agentId: scenario.agentId,
        sourceType: "harness_planned",
        sourceRef: scenario.actionId,
        logicalCallKey: scenario.logicalCallKey,
        transportChannel: "hosted",
        bindingCandidate: binding,
        bindingHash: computeAgentCallBindingHash(binding),
        createdAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "AGENT_CALL_BINDING_STALE" });
  });

  it("Agent.currentRevisionId 摘要被篡改时仍按 Route exact Revision 冻结 Call", async () => {
    const scenario = await seed();
    await db
      .update(agentTable)
      .set({ currentRevisionId: randomUUID() })
      .where(eq(agentTable.id, scenario.agentId));
    const create = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => NOW });

    const result = await create(
      commandFor(scenario, { actionId: `current-summary-drift:${randomUUID()}` }),
    );

    expect(result.call).not.toHaveProperty("agentRevisionId");
    const [binding] = await db
      .select()
      .from(agentCallBindingTable)
      .where(eq(agentCallBindingTable.callId, result.call.id));
    expect(binding?.agentRevisionId).toBe(scenario.agentRevisionId);
  });

  it("Parent Invocation 非 running 时不得新建 AgentCall", async () => {
    const scenario = await seed();
    await db
      .update(invocationTable)
      .set({ executionState: "queued" })
      .where(eq(invocationTable.id, scenario.parentInvocationId));
    const create = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => NOW });
    await expect(
      create(commandFor(scenario, { actionId: `parent-not-running:${randomUUID()}` })),
    ).rejects.toMatchObject({
      code: "AGENT_CALL_BINDING_STALE",
    });
  });

  it("同请求并发最终化只创建一个 Call", async () => {
    const scenario = await seed();
    const actionId = `concurrent:${randomUUID()}`;
    const logicalCallKey = `${scenario.parentInvocationId}:${actionId}:${scenario.agentId}`;
    const create = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => NOW });
    const [left, right] = await Promise.all([
      create(commandFor(scenario, { actionId })),
      create(commandFor(scenario, { actionId })),
    ]);
    expect([left.status, right.status].sort()).toEqual(["created", "replayed"]);
    expect(left.call.id).toBe(right.call.id);
    expect(
      await db
        .select()
        .from(agentCallTable)
        .where(
          and(
            eq(agentCallTable.parentInvocationId, scenario.parentInvocationId),
            eq(agentCallTable.logicalCallKey, logicalCallKey),
          ),
        ),
    ).toHaveLength(1);
  });

  it("Resolve 后 Publication withdraw，最终事务 fail closed 且不写 Call", async () => {
    const scenario = await seed();
    const [publication] = await db
      .select()
      .from(publicationRecord)
      .where(eq(publicationRecord.id, scenario.agentPublicationRecordId));
    if (!publication) throw new Error("测试 publication 缺失");
    await db.insert(withdrawalRecord).values({
      id: randomUUID(),
      tenantId: scenario.tenantId,
      publicationRecordId: publication.id,
      subjectType: "agent_revision",
      subjectRevisionId: scenario.agentRevisionId,
      reasonCode: "test",
      reason: "stale candidate",
      withdrawnByType: "service",
      withdrawnBy: "test",
      withdrawnAt: NOW,
    });
    const actionId = `withdrawn:${randomUUID()}`;
    const logicalCallKey = `harness-action:${actionId}:agent:${scenario.agentId}`;
    const create = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => NOW });
    await expect(create(commandFor(scenario, { actionId }))).rejects.toMatchObject({
      code: "AGENT_CALL_BINDING_STALE",
    });
    expect(
      await db
        .select()
        .from(agentCallTable)
        .where(eq(agentCallTable.logicalCallKey, logicalCallKey)),
    ).toHaveLength(0);
  });

  it("Resolve 后 RouteActivation 切版，旧 candidate 最终化失败", async () => {
    const scenario = await seed();
    await activateSingleRouteForTest({
      tenantId: scenario.tenantId,
      routeSetId: scenario.resolution.routeSetId,
      routeId: scenario.resolution.deploymentRouteId,
      routeSetExpectedVersionNo: scenario.resolution.routeSetVersionNo,
      target: scenario.resolution.target,
      trafficWeight: 10_000,
      actor: buildActor(scenario.tenantId, "route-switch-test"),
    });
    const create = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => NOW });
    await expect(
      create(commandFor(scenario, { actionId: `route-switch:${randomUUID()}` })),
    ).rejects.toMatchObject({ code: "AGENT_CALL_BINDING_STALE" });
  });

  it("Resolve 后 Projection version bump，旧 candidate 最终化失败", async () => {
    const scenario = await seed();
    await db
      .update(routeEligibilityProjection)
      .set({ projectionVersionNo: scenario.binding.projectionVersionNo + 1 })
      .where(eq(routeEligibilityProjection.routeId, scenario.binding.deploymentRouteId));
    const create = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => NOW });
    await expect(
      create(commandFor(scenario, { actionId: `projection-bump:${randomUUID()}` })),
    ).rejects.toMatchObject({ code: "AGENT_CALL_BINDING_STALE" });
  });

  it("candidate 的 resolutionInputDigest 必须与 source provenance 精确一致", async () => {
    const scenario = await seed();
    const binding = {
      ...scenario.binding,
      resolutionInputDigest: `sha256:${"f".repeat(64)}`,
    };
    await expect(
      mysqlAgentCallStore.finalizeAgentCall({
        id: randomUUID(),
        tenantId: scenario.tenantId,
        parentInvocationId: scenario.parentInvocationId,
        agentId: scenario.agentId,
        sourceType: "harness_planned",
        sourceRef: scenario.actionId,
        logicalCallKey: scenario.logicalCallKey,
        transportChannel: "hosted",
        bindingCandidate: binding,
        bindingHash: computeAgentCallBindingHash(binding),
        createdAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "AGENT_CALL_BINDING_STALE" });
  });

  it("黑盒 Agent Publication 被注入 Attestation 后必须 fail closed", async () => {
    const scenario = await seed();
    const injectedAttestationId = randomUUID();
    await db
      .update(publicationRecord)
      .set({
        attestationIds: [injectedAttestationId],
        evidenceSetDigest: computePublicationEvidenceSetDigest({
          attestationIds: [injectedAttestationId],
          conformanceRunId: null,
          approvals: [],
          additionalEvidence: {
            agent_contract_snapshot: {
              id: scenario.agentContractSnapshotId,
              contract_digest: scenario.agentContractDigest,
              capability_digest: scenario.agentCapabilityDigest,
              context_digest: scenario.agentContextDigest,
            },
          },
        }),
      })
      .where(eq(publicationRecord.id, scenario.agentPublicationRecordId));
    const create = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => NOW });
    await expect(
      create(commandFor(scenario, { actionId: `agent-attestation:${randomUUID()}` })),
    ).rejects.toMatchObject({ code: "AGENT_CALL_BINDING_STALE" });
  });

  it("Policy 或 Governance 内容在 Resolve 后漂移时必须 fail closed", async () => {
    const scenario = await seed();
    await db
      .update(policyRevisionTable)
      .set({ defaultDecision: "allow" })
      .where(eq(policyRevisionTable.id, scenario.binding.policyRevisionId));
    const create = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => NOW });
    await expect(
      create(commandFor(scenario, { actionId: `policy-drift:${randomUUID()}` })),
    ).rejects.toMatchObject({ code: "AGENT_CALL_BINDING_STALE" });

    await db
      .update(policyRevisionTable)
      .set({ defaultDecision: "pause" })
      .where(eq(policyRevisionTable.id, scenario.binding.policyRevisionId));
    const [governance] = await db
      .select()
      .from(governanceConfigRevisionTable)
      .where(eq(governanceConfigRevisionTable.id, scenario.binding.governanceConfigRevisionId));
    if (!governance) throw new Error("测试 GovernanceConfigRevision 缺失");
    await db
      .update(governanceConfigRevisionTable)
      .set({
        configJson: {
          ...governance.configJson,
          formatOnWrite: !governance.configJson.formatOnWrite,
        },
      })
      .where(eq(governanceConfigRevisionTable.id, governance.id));
    await expect(
      create(commandFor(scenario, { actionId: `governance-drift:${randomUUID()}` })),
    ).rejects.toMatchObject({ code: "AGENT_CALL_BINDING_STALE" });
  });

  it("AgentRevision 的 ContractSnapshot commitment 漂移时失败", async () => {
    const scenario = await seed();
    await db
      .update(agentRevisionTable)
      .set({ agentContractSnapshotId: randomUUID() })
      .where(eq(agentRevisionTable.id, scenario.agentRevisionId));
    const create = createCreateAgentCall({ store: mysqlAgentCallStore, now: () => NOW });
    await expect(
      create(commandFor(scenario, { actionId: `contract-drift:${randomUUID()}` })),
    ).rejects.toMatchObject({ code: "AGENT_CALL_BINDING_STALE" });
  });

  it("CapabilityUse 写失败时 Call/Binding/Attempt 一并回滚，无孤儿", async () => {
    const scenario = await seed();
    const before = await Promise.all([
      db
        .select({ value: count() })
        .from(agentCallTable)
        .where(eq(agentCallTable.tenantId, scenario.tenantId)),
      db
        .select({ value: count() })
        .from(agentCallBindingTable)
        .where(eq(agentCallBindingTable.tenantId, scenario.tenantId)),
      db
        .select({ value: count() })
        .from(agentCallAttemptTable)
        .where(eq(agentCallAttemptTable.tenantId, scenario.tenantId)),
      db
        .select({ value: count() })
        .from(capabilityUseTable)
        .where(eq(capabilityUseTable.tenantId, scenario.tenantId)),
    ]);
    const failingStore = createMysqlAgentCallStore({
      recordCapabilityUse: async () => {
        throw new Error("simulated capability ledger failure");
      },
    });
    const create = createCreateAgentCall({ store: failingStore, now: () => NOW });
    const actionId = `rollback:${randomUUID()}`;
    const logicalCallKey = `harness-action:${actionId}:agent:${scenario.agentId}`;
    await expect(create(commandFor(scenario, { actionId }))).rejects.toThrow(
      "simulated capability ledger failure",
    );
    expect(
      await db
        .select()
        .from(agentCallTable)
        .where(eq(agentCallTable.logicalCallKey, logicalCallKey)),
    ).toHaveLength(0);
    const after = await Promise.all([
      db
        .select({ value: count() })
        .from(agentCallTable)
        .where(eq(agentCallTable.tenantId, scenario.tenantId)),
      db
        .select({ value: count() })
        .from(agentCallBindingTable)
        .where(eq(agentCallBindingTable.tenantId, scenario.tenantId)),
      db
        .select({ value: count() })
        .from(agentCallAttemptTable)
        .where(eq(agentCallAttemptTable.tenantId, scenario.tenantId)),
      db
        .select({ value: count() })
        .from(capabilityUseTable)
        .where(eq(capabilityUseTable.tenantId, scenario.tenantId)),
    ]);
    expect(after).toEqual(before);
  });
});

describe("AgentCall 后续状态与 Attempt", () => {
  it("状态 CAS、Attempt 幂等与 parent 隔离保持不变", async () => {
    const scenario = await seed();
    const running = await mysqlAgentCallStore.updateState({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
      from: "queued",
      to: "running",
      now: NOW,
    });
    expect(running.state).toBe("running");
    await expect(
      mysqlAgentCallStore.updateState({
        callId: scenario.callId,
        tenantId: scenario.tenantId,
        from: "queued",
        to: "running",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(AgentCallStateConcurrencyError);
    await mysqlAgentCallStore.finishAttempt({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
      attemptNo: 1,
      to: "failed",
      errorCode: "RETRYABLE",
      now: NOW,
    });
    const attempt2 = await mysqlAgentCallStore.createAttempt({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
      retryReasonCode: "transport_retry",
      transportChannel: "hosted",
      now: NOW,
    });
    expect(attempt2.attemptNo).toBe(2);
    const [parent] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, scenario.parentInvocationId));
    expect(parent?.executionState).toBe("running");
  });
});
