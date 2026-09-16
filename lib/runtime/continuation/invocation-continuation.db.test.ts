import type { AgentCall } from "@/lib/agents/calls/domain/agent-call";
import type { ControlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { acquireExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { TEST_RUNTIME_REVISION_ID } from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { executionOwnershipTable, invocationTable } from "@/lib/persistence/schema/executions";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvocationContinuationPermanentError,
  createInvocationContinuationHandler,
} from "./invocation-continuation";

beforeEach(async () => {
  await resetDatabase(db);
});

function call(state: AgentCall["state"], versionNo = 2): AgentCall {
  return {
    id: "call-1",
    tenantId: "tenant-1",
    parentInvocationId: "invocation-1",
    agentId: "agent-1",
    sourceType: "harness_planned",
    sourceRef: "action-1",
    state,
    agentSessionBindingId: null,
    sessionBinding: null,
    currentAttempt: null,
    resultText: state === "completed" ? "完成" : null,
    resultJson: null,
    resultDigest: null,
    errorCode: state === "failed" ? "REMOTE_FAILED" : null,
    errorSummary: state === "failed" ? "远端失败" : null,
    cancelRequestedAt: null,
    logicalCallKey: "harness-action:action-1:agent:agent-1",
    creationRequestDigest: "sha256:test",
    createdAt: new Date(),
    startedAt: new Date(),
    waitingAt: state === "waiting_user" ? new Date() : null,
    finishedAt: state === "completed" || state === "failed" ? new Date() : null,
    versionNo,
  };
}

function event(kind: string, sourceVersion = 2): ControlPlaneOutboxEvent {
  return {
    id: "event-1",
    tenantId: "tenant-1",
    schemaVersion: "1.0",
    eventKey: `continuation:${kind}`,
    eventType: "agent_call.continuation.requested",
    aggregateType: "AgentCall",
    aggregateId: "call-1",
    aggregateVersion: sourceVersion,
    payloadJson: {
      parent_invocation_id: "invocation-1",
      agent_call_id: "call-1",
      source_version: sourceVersion,
      kind,
    },
    occurredAt: new Date(),
    availableAt: new Date(),
  };
}

describe("Invocation continuation handler", () => {
  it("终态只恢复原父 Invocation，重复旧版本安全 no-op", async () => {
    const resumeParent = vi.fn(async () => undefined);
    let current = call("completed");
    const handler = createInvocationContinuationHandler({
      getAgentCall: async () => current,
      coordinateWaitingUser: vi.fn(),
      resumeParent,
      resumeAfterAgentResponse: vi.fn(),
      resumeAgentFromUserAction: vi.fn(),
    });

    await handler(event("resume_parent"));
    expect(resumeParent).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: "invocation-1", agentCallId: "call-1" }),
    );

    current = call("completed", 3);
    await handler(event("resume_parent", 2));
    expect(resumeParent).toHaveBeenCalledOnce();
  });

  it("waiting_user 只调用幂等协调能力", async () => {
    const coordinateWaitingUser = vi.fn(async () => undefined);
    const handler = createInvocationContinuationHandler({
      getAgentCall: async () => call("waiting_user"),
      coordinateWaitingUser,
      resumeParent: vi.fn(),
      resumeAfterAgentResponse: vi.fn(),
      resumeAgentFromUserAction: vi.fn(),
    });

    await handler(event("coordinate_user_input"));

    expect(coordinateWaitingUser).toHaveBeenCalledWith("tenant-1", "call-1");
  });

  it("tenant 或父 Invocation 不一致时永久失败", async () => {
    const mismatched = call("completed");
    mismatched.parentInvocationId = "other-invocation";
    const handler = createInvocationContinuationHandler({
      getAgentCall: async () => mismatched,
      coordinateWaitingUser: vi.fn(),
      resumeParent: vi.fn(),
      resumeAfterAgentResponse: vi.fn(),
      resumeAgentFromUserAction: vi.fn(),
    });

    await expect(handler(event("resume_parent"))).rejects.toBeInstanceOf(
      InvocationContinuationPermanentError,
    );
  });

  it("已保存用户回答由 durable continuation 恢复同一 AgentCall", async () => {
    const resumeAgentFromUserAction = vi.fn(async () => undefined);
    const handler = createInvocationContinuationHandler({
      getAgentCall: async () => call("waiting_user"),
      coordinateWaitingUser: vi.fn(),
      resumeParent: vi.fn(),
      resumeAfterAgentResponse: vi.fn(),
      resumeAgentFromUserAction,
    });
    const resumeEvent = event("resume_agent_after_user_response");
    resumeEvent.payloadJson = {
      ...(resumeEvent.payloadJson as Record<string, unknown>),
      user_action_request_id: "request-1",
    };

    await handler(resumeEvent);

    expect(resumeAgentFromUserAction).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      requestId: "request-1",
      agentCallId: "call-1",
      sourceVersion: 2,
    });
  });
});

describe("Invocation continuation execution ownership", () => {
  it("同一 Invocation 只有一个新鲜 owner，租约过期后按新 epoch 接管重领", async () => {
    const tenant = await ensureDefaultTenant();
    await db.insert(invocationTable).values({
      id: "invocation-lease",
      tenantId: tenant.id,
      subjectType: "job",
      threadId: null,
      turnId: null,
      jobId: "job-lease",
      invocationSequence: 1,
      invocationKind: "job",
      executionState: "running",
      inputDigest: `sha256:${"0".repeat(64)}`,
    });

    // V12：Invocation 执行租约统一由 ExecutionOwnership 承载（prepared Attempt + active Owner）。
    const attempt = await createAttempt({
      tenantId: tenant.id,
      invocationId: "invocation-lease",
    });
    const attemptEvidence = { kind: "invocation-continuation-lease-test" };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: attempt.id,
        evidence: attemptEvidence,
        digest: protocolDigest(attemptEvidence),
      }),
    );
    const acquire = (acquiredById: string) =>
      acquireExecutionOwnership({
        tenantId: tenant.id,
        invocationId: "invocation-lease",
        attemptId: attempt.id,
        runtimeRevisionId: TEST_RUNTIME_REVISION_ID,
        acquiredByType: "service",
        acquiredById,
      });

    const first = await acquire("worker-a");
    // 新鲜 owner 存活期间，竞争者无法取得执行权。
    await expect(acquire("worker-b")).rejects.toMatchObject({ code: "HealthyOwnerExists" });
    // 租约过期后按新 epoch 接管：旧 owner 置 lost，新 owner epoch+1。
    await db
      .update(executionOwnershipTable)
      .set({ leaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(executionOwnershipTable.id, first.ownership.id));
    const reclaimed = await acquire("worker-b");

    expect(first.ownership.leaseEpoch).toBe(1);
    expect(reclaimed.ownership.leaseEpoch).not.toBe(first.ownership.leaseEpoch);
    const rows = await db
      .select()
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.invocationId, "invocation-lease"))
      .orderBy(executionOwnershipTable.leaseEpoch);
    expect(rows.map((row) => [row.leaseEpoch, row.ownershipState])).toEqual([
      [1, "lost"],
      [2, "active"],
    ]);
  });
});
