import { randomUUID } from "node:crypto";
import type { AgentCallBindingCandidate } from "@/lib/agents/calls/domain/agent-call-binding";
import type { StoreAgentCallInput } from "@/lib/agents/calls/persistence/agent-call-store";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { applyToolCall } from "@/lib/capability/application/apply-tool-call";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import {
  acquireExecutionOwnership,
  getAuthorityDatabaseTime,
} from "@/lib/executions/persistence/execution-ownership-store";
import { markAttemptPreparedForTestInTransaction } from "@/lib/executions/test-support/preparation-fixtures";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
import { effectRecordTable } from "@/lib/persistence/schema/effect";
import {
  executionOwnershipTable,
  invocationTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/** R02 §3：该夹具 Session 冻结的发布能力证据（Hosted Revision 的能力名列表）。 */
const RUNTIME_CAPABILITIES_JSON = ["event_stream"];

function digest(value: unknown): string {
  return protocolDigest(value);
}

function agentBindingCandidate(agentId: string): AgentCallBindingCandidate {
  const hash = digest({ agentId, candidate: "runtime-action-authority" });
  return {
    agentId,
    agentRevisionId: randomUUID(),
    agentContractSnapshotId: randomUUID(),
    agentContractDigest: hash,
    agentCapabilityDigest: hash,
    agentContextDigest: hash,
    agentPublicationRecordId: randomUUID(),
    deploymentRouteId: randomUUID(),
    routeRevisionId: randomUUID(),
    routeActivationId: randomUUID(),
    routeContentDigest: hash,
    resolutionInputDigest: hash,
    projectionVersionNo: 1,
    endpointRef: "https://agent.example.test/a2a",
    identityMode: "none",
    credentialRefId: null,
    networkZone: "external",
    protocolType: "a2a",
    protocolContractDigest: "a2a@1",
    policyRevisionId: randomUUID(),
    policyRulesDigest: hash,
    governanceConfigRevisionId: randomUUID(),
    governanceConfigDigest: hash,
  };
}

async function createActiveRuntime() {
  const fixture = await seedPreparedRuntimeAttempt();
  const acquired = await acquireTestRuntimeAuthority({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
    attemptId: fixture.attempt.id,
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
  });
  const activationEvidence = {
    kind: "runtime-action-authority",
    ownershipId: acquired.ownership.id,
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
  };
  await db
    .update(executionOwnershipTable)
    .set({
      activationEvidence,
      activationDigest: digest(activationEvidence),
      activatedAt: new Date(),
    })
    .where(eq(executionOwnershipTable.id, acquired.ownership.id));
  const semanticRequest = { invocationId: fixture.invocation.id, action: "authority" };
  const semanticRequestDigest = digest(semanticRequest);
  // R02 §3：Hosted 接纳回执的摘要来自冻结发布证据（Session 与事件必须同源）。
  const capabilitiesDigest = expectedCapabilityManifestDigest({
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
  });
  const remoteSessionRef = `action-session:${acquired.session.id}`;
  const remoteExecutionRef = `action-execution:${acquired.ownership.id}`;
  await applyRuntimeSessionDispatchForTest(fixture.tenantId, acquired.session.id, {
    bindingState: "dispatching",
    semanticRequestJson: semanticRequest,
    semanticRequestDigest,
    remoteSessionRef,
    remoteExecutionRef,
    transportAcknowledgement: { capabilitiesDigest },
  });
  await ingressRuntimeEvents({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
    batch: {
      protocolVersion: 3,
      authority: acquired.authority,
      events: [
        {
          eventId: randomUUID(),
          producerSequence: "1",
          type: "execution.started",
          schemaVersion: 1,
          payload: {
            intentKey: acquired.session.startIntentKey,
            semanticRequestDigest,
            remoteSessionRef,
            remoteExecutionRef,
            capabilitiesDigest,
          },
        },
      ],
    },
  });
  return { fixture, acquired };
}

async function takeOver(runtime: Awaited<ReturnType<typeof createActiveRuntime>>) {
  // 过期必须对齐**生产判定所用的权威时钟**（DB `CURRENT_TIMESTAMP(6)`）：客户端
  // `Date.now()` 与 DB 时钟存在毫秒级偏差，只留 1ms 余量并不足以表达「已过期」，
  // 并发下 VM 时钟滞后加剧，会误报 HealthyOwnerExists。
  await db
    .update(executionOwnershipTable)
    .set({ leaseExpiresAt: await getAuthorityDatabaseTime(db) })
    .where(eq(executionOwnershipTable.id, runtime.acquired.ownership.id));
  const attempt = await createAttempt({
    tenantId: runtime.fixture.tenantId,
    invocationId: runtime.fixture.invocation.id,
    retryReasonCode: "action-authority-takeover",
  });
  const evidence = { kind: "action-authority-takeover", attemptId: attempt.id };
  await db.transaction((tx) =>
    markAttemptPreparedForTestInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: digest(evidence),
    }),
  );
  return acquireExecutionOwnership({
    tenantId: runtime.fixture.tenantId,
    invocationId: runtime.fixture.invocation.id,
    attemptId: attempt.id,
    runtimeRevisionId: runtime.fixture.binding.runtimeRevisionId,
    acquiredByType: "service",
    acquiredById: "action-authority-takeover",
  });
}

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

describe("Runtime action authority", () => {
  it("ACTION-01/ACTION-02: an authenticated old generation cannot create ToolCall, EffectRecord, or AgentCall", async () => {
    const runtime = await createActiveRuntime();
    await takeOver(runtime);
    const authority = runtime.acquired.authority;

    await expect(
      applyToolCall({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        authority,
        executionSubject: {
          tenantId: runtime.fixture.tenantId,
          subjectType: "user",
          subjectId: "test-user",
        },
        toolId: randomUUID(),
        toolSchemaRevisionId: randomUUID(),
        schemaHash: digest({ schema: "blocked" }),
        operationId: `blocked-tool:${randomUUID()}`,
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });

    const candidate = agentBindingCandidate(randomUUID());
    const agentInput: StoreAgentCallInput = {
      id: randomUUID(),
      tenantId: runtime.fixture.tenantId,
      parentInvocationId: runtime.fixture.invocation.id,
      authority,
      agentId: candidate.agentId,
      sourceType: "harness_planned",
      sourceRef: `blocked-agent:${randomUUID()}`,
      logicalCallKey: `blocked-agent:${randomUUID()}`,
      transportChannel: "gateway",
      bindingCandidate: candidate,
      bindingHash: digest({ binding: "blocked" }),
      createdAt: new Date(),
    };
    await expect(mysqlAgentCallStore.finalizeAgentCall(agentInput)).rejects.toMatchObject({
      code: "NotCurrentExecutor",
    });

    expect(await db.select().from(toolCallTable)).toEqual([]);
    expect(await db.select().from(effectRecordTable)).toEqual([]);
    expect(await db.select().from(agentCallTable)).toEqual([]);
  });

  it("ACTION-05: a frozen checkpoint gate rejects both direct actions and Runtime action ingress without changing receipts", async () => {
    const runtime = await createActiveRuntime();
    const checkpointIntentId = randomUUID();
    await db
      .update(invocationTable)
      .set({
        checkpointGate: "frozen",
        checkpointIntentId,
        checkpointOwnerId: runtime.acquired.ownership.id,
        checkpointDeadline: new Date(Date.now() + 60_000),
        checkpointProducerSequence: 1n,
        checkpointRecoveryVersion: 0,
        checkpointAnchor: { kind: "action-gate" },
        checkpointPreparedEvidence: { checkpointIntentId },
      })
      .where(eq(invocationTable.id, runtime.fixture.invocation.id));
    const [beforeRejectedActions] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, runtime.fixture.invocation.id));

    await expect(
      applyToolCall({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        authority: runtime.acquired.authority,
        executionSubject: {
          tenantId: runtime.fixture.tenantId,
          subjectType: "user",
          subjectId: "test-user",
        },
        toolId: randomUUID(),
        toolSchemaRevisionId: randomUUID(),
        schemaHash: digest({ schema: "checkpoint-gate" }),
        operationId: `checkpoint-gate:${randomUUID()}`,
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: "CheckpointStale" });
    const agentCandidate = agentBindingCandidate(randomUUID());
    await expect(
      mysqlAgentCallStore.finalizeAgentCall({
        id: randomUUID(),
        tenantId: runtime.fixture.tenantId,
        parentInvocationId: runtime.fixture.invocation.id,
        authority: runtime.acquired.authority,
        agentId: agentCandidate.agentId,
        sourceType: "harness_planned",
        sourceRef: `checkpoint-gate-agent:${randomUUID()}`,
        logicalCallKey: `checkpoint-gate-agent:${randomUUID()}`,
        transportChannel: "gateway",
        bindingCandidate: agentCandidate,
        bindingHash: digest({ binding: "checkpoint-gate" }),
        createdAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "CheckpointStale" });
    await expect(
      ingressRuntimeEvents({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: runtime.acquired.authority,
          events: [
            {
              eventId: randomUUID(),
              producerSequence: "2",
              type: "action",
              schemaVersion: 1,
              payload: { actionState: "proposed", action_id: randomUUID() },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "CheckpointStale" });

    const receipts = await db
      .select()
      .from(runtimeEventIngressTable)
      .where(
        and(
          eq(runtimeEventIngressTable.tenantId, runtime.fixture.tenantId),
          eq(runtimeEventIngressTable.invocationId, runtime.fixture.invocation.id),
        ),
      );
    expect(receipts).toHaveLength(1);
    expect(await db.select().from(toolCallTable)).toEqual([]);
    expect(await db.select().from(agentCallTable)).toEqual([]);
    const [afterRejectedActions] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, runtime.fixture.invocation.id));
    expect(afterRejectedActions).toEqual(beforeRejectedActions);
  });
});
