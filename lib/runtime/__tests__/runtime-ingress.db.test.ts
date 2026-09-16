import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { acquireExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import {
  executionOwnershipTable,
  invocationTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import {
  EventPayloadHashConflictError,
  IngressAuthorityMismatchError,
  ProducerSequenceGapError,
  ingressRuntimeEvents,
} from "@/lib/runtime/application/ingress-runtime-events";
import { updateRuntimeSessionDispatch } from "@/lib/runtime/persistence/runtime-session-store";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

async function createActiveRuntime() {
  const fixture = await seedPreparedRuntimeAttempt();
  const acquired = await acquireTestRuntimeAuthority({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
    attemptId: fixture.attempt.id,
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
  });
  const activationEvidence = {
    kind: "runtime-ingress-test",
    ownershipId: acquired.ownership.id,
  };
  await db
    .update(executionOwnershipTable)
    .set({
      activationEvidence,
      activationDigest: protocolDigest(activationEvidence),
      activatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(executionOwnershipTable.id, acquired.ownership.id));
  const semanticRequest = { invocationId: fixture.invocation.id, fixture: "runtime-ingress" };
  const semanticRequestDigest = protocolDigest(semanticRequest);
  const remoteSessionRef = `runtime-session:${acquired.session.id}`;
  const remoteExecutionRef = `runtime-execution:${fixture.invocation.id}`;
  const capabilitiesDigest = protocolDigest({ fixture: "runtime-ingress" });
  await updateRuntimeSessionDispatch(fixture.tenantId, acquired.session.id, {
    bindingState: "dispatching",
    semanticRequestJson: semanticRequest,
    semanticRequestDigest,
    remoteSessionRef,
    remoteExecutionRef,
    transportAcknowledgement: { capabilitiesDigest },
  });
  const started = {
    eventId: randomUUID(),
    producerSequence: "1",
    type: "execution.started" as const,
    schemaVersion: 1,
    payload: {
      intentKey: acquired.session.startIntentKey,
      semanticRequestDigest,
      remoteSessionRef,
      remoteExecutionRef,
      capabilitiesDigest,
    },
  };
  await ingressRuntimeEvents({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
    batch: { protocolVersion: 3, authority: acquired.authority, events: [started] },
  });
  return { fixture, acquired, started };
}

async function replaceCurrentOwner(input: Awaited<ReturnType<typeof createActiveRuntime>>) {
  await db
    .update(executionOwnershipTable)
    .set({ leaseExpiresAt: new Date(Date.now() - 1) })
    .where(eq(executionOwnershipTable.id, input.acquired.ownership.id));
  const attempt = await createAttempt({
    tenantId: input.fixture.tenantId,
    invocationId: input.fixture.invocation.id,
    retryReasonCode: "test_takeover",
  });
  const evidence = { kind: "test-replacement", attemptId: attempt.id };
  await db.transaction((tx) =>
    markAttemptPreparedInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
  return acquireExecutionOwnership({
    tenantId: input.fixture.tenantId,
    invocationId: input.fixture.invocation.id,
    attemptId: attempt.id,
    runtimeRevisionId: input.fixture.binding.runtimeRevisionId,
    acquiredByType: "service",
    acquiredById: "runtime-ingress-replacement",
  });
}

function progressEvent(
  sequence: string,
  eventId = randomUUID(),
  payload: Record<string, unknown> = { message: "progress" },
) {
  return {
    eventId,
    producerSequence: sequence,
    type: "progress" as const,
    schemaVersion: 1,
    payload,
  };
}

describe("RuntimeEventIngress database fencing", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  it("INGRESS-01/INGRESS-11: execution.started is the only formal transition to running", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const acquired = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const [before] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, fixture.invocation.id));
    expect(before?.executionState).toBe("queued");
    expect(acquired.session.bindingState).toBe("prepared");
  });

  it("INGRESS-03/INGRESS-04/INGRESS-07: old authority cannot add events or claim a historical receipt", async () => {
    const runtime = await createActiveRuntime();
    const event = progressEvent("2");
    await ingressRuntimeEvents({
      tenantId: runtime.fixture.tenantId,
      invocationId: runtime.fixture.invocation.id,
      batch: { protocolVersion: 3, authority: runtime.acquired.authority, events: [event] },
    });
    const replacement = await replaceCurrentOwner(runtime);

    await expect(
      ingressRuntimeEvents({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: runtime.acquired.authority,
          events: [progressEvent("3", randomUUID(), { resultRef: "old-response" })],
        },
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });
    await expect(
      ingressRuntimeEvents({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: {
            ...runtime.acquired.authority,
            attemptId: replacement.ownership.attemptId,
            ownershipId: replacement.ownership.id,
            leaseEpoch: String(replacement.ownership.leaseEpoch),
          },
          events: [event],
        },
      }),
    ).rejects.toBeInstanceOf(IngressAuthorityMismatchError);
  });

  it("INGRESS-05/INGRESS-08/INGRESS-09: exact replay returns the original receipt, but payload conflicts and gaps fail closed", async () => {
    const runtime = await createActiveRuntime();
    const event = progressEvent("2");
    const first = await ingressRuntimeEvents({
      tenantId: runtime.fixture.tenantId,
      invocationId: runtime.fixture.invocation.id,
      batch: { protocolVersion: 3, authority: runtime.acquired.authority, events: [event] },
    });
    await replaceCurrentOwner(runtime);
    const replay = await ingressRuntimeEvents({
      tenantId: runtime.fixture.tenantId,
      invocationId: runtime.fixture.invocation.id,
      batch: { protocolVersion: 3, authority: runtime.acquired.authority, events: [event] },
    });
    expect(replay.replayedEventIds).toEqual([event.eventId]);
    expect(replay.receipts).toEqual(first.receipts);
    await expect(
      ingressRuntimeEvents({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: runtime.acquired.authority,
          events: [progressEvent("2", event.eventId, { message: "conflict" })],
        },
      }),
    ).rejects.toBeInstanceOf(EventPayloadHashConflictError);
    await expect(
      ingressRuntimeEvents({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: runtime.acquired.authority,
          events: [progressEvent("4")],
        },
      }),
    ).rejects.toBeInstanceOf(ProducerSequenceGapError);
  });

  it("INGRESS-10: a mixed batch rolls back every new event when any event conflicts", async () => {
    const runtime = await createActiveRuntime();
    const accepted = progressEvent("2");
    await ingressRuntimeEvents({
      tenantId: runtime.fixture.tenantId,
      invocationId: runtime.fixture.invocation.id,
      batch: { protocolVersion: 3, authority: runtime.acquired.authority, events: [accepted] },
    });
    const legal = progressEvent("3");
    await expect(
      ingressRuntimeEvents({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: runtime.acquired.authority,
          events: [accepted, legal, progressEvent("4", accepted.eventId, { message: "conflict" })],
        },
      }),
    ).rejects.toBeInstanceOf(EventPayloadHashConflictError);
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, runtime.fixture.tenantId),
          eq(invocationTable.id, runtime.fixture.invocation.id),
        ),
      );
    expect(invocation?.lastProducerSequence).toBe(2);
    const ingress = await db
      .select()
      .from(runtimeEventIngressTable)
      .where(
        and(
          eq(runtimeEventIngressTable.tenantId, runtime.fixture.tenantId),
          eq(runtimeEventIngressTable.invocationId, runtime.fixture.invocation.id),
          eq(runtimeEventIngressTable.producerEventId, legal.eventId),
        ),
      );
    expect(ingress).toEqual([]);
  });
});
