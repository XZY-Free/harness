import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { acquireExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import {
  TEST_EXECUTION_BINDING_EVIDENCE,
  createExecutionBinding,
} from "@/lib/executions/test-support/create-unverified-execution-binding";
import { markAttemptPreparedForTestInTransaction } from "@/lib/executions/test-support/preparation-fixtures";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { issueTestExecutionToken } from "@/lib/identity/test-support/execution-token";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { auditEvent } from "@/lib/persistence/schema/audit";
import { threadItemTable, threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import {
  executionBindingTable,
  executionOwnershipTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import {
  governanceConfigRevisionTable,
  governanceConfigSetTable,
} from "@/lib/persistence/schema/governance-config";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import {
  applyRuntimeSessionDispatchForTest,
  createRuntimeSessionBindingForTest,
  sourceIntentForFixture,
} from "@/lib/runtime/test-support/session-write-fixtures";
import { createNoPlatformWorkspaceBinding } from "@/lib/workspace/workspace-binding-store";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "./route";

const TENANT = DEFAULT_TENANT_ID;

/** 每个 Invocation 的 Current Execution Authority claims（gateway token 必须与之绑定）。 */
interface GatewayAuthorityClaims {
  runtimeRevisionId: string;
  attemptId: string;
  ownershipId: string;
  leaseEpoch: string;
  sessionBindingId: string;
}
const authorityByInvocation = new Map<string, GatewayAuthorityClaims>();

/**
 * 为已有 Invocation + ExecutionBinding 播种 canonical Authority 链：
 * prepared InvocationAttempt → ExecutionOwnership(executing) → active RuntimeSessionBinding。
 */
async function seedRuntimeAuthority(input: {
  tenantId: string;
  invocationId: string;
  runtimeRevisionId: string;
}): Promise<void> {
  const attempt = await createAttempt({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
  });
  const evidence = {
    kind: "test-candidate",
    invocationId: input.invocationId,
    attemptId: attempt.id,
  };
  await db.transaction((tx) =>
    markAttemptPreparedForTestInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
  const acquired = await acquireExecutionOwnership({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: attempt.id,
    runtimeRevisionId: input.runtimeRevisionId,
    acquiredByType: "service",
    acquiredById: "external-runtime-subject-test",
  });
  const session = await createRuntimeSessionBindingForTest({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: attempt.id,
    ownershipId: acquired.ownership.id,
    runtimeRevisionId: input.runtimeRevisionId,
    leaseEpoch: acquired.ownership.leaseEpoch,
    intentType: "start",
    startIntentKey: `start:${acquired.ownership.id}`,
    ...sourceIntentForFixture({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      attemptId: attempt.id,
      intentType: "start",
    }),
  });
  // canonical 约束：bindingState=active 必须冻结语义请求并携带 remote refs + startedEventId。
  await applyRuntimeSessionDispatchForTest(input.tenantId, session.id, {
    bindingState: "active",
    semanticRequestJson: { kind: "external-runtime-subject-test" },
    semanticRequestDigest: `sha256:${"0".repeat(64)}`,
    remoteSessionRef: "external-runtime-subject-test-session",
    remoteExecutionRef: "external-runtime-subject-test-execution",
    startedEventId: randomUUID(),
  });
  await db
    .update(executionOwnershipTable)
    .set({
      executionPhase: "executing",
      activatedAt: new Date(),
      activationDigest: `sha256:${"0".repeat(64)}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.id, acquired.ownership.id),
      ),
    );
  authorityByInvocation.set(input.invocationId, {
    runtimeRevisionId: input.runtimeRevisionId,
    attemptId: attempt.id,
    ownershipId: acquired.ownership.id,
    leaseEpoch: String(acquired.ownership.leaseEpoch),
    sessionBindingId: session.id,
  });
}

describe("External Runtime effective execution subject", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
    authorityByInvocation.clear();
  });

  async function seedRunningInvocation(subjectId = "employee-original") {
    const threadId = randomUUID();
    const turnId = randomUUID();
    const invocationId = randomUUID();
    await db.insert(threadTable).values({
      id: threadId,
      tenantId: TENANT,
      ownerUserId: subjectId,
      lifecycleState: "active",
      lastActivityAt: new Date(),
      lastTurnSequence: 1,
      lastItemSequence: 1,
      lastEventSequence: 0,
      pendingQueueVersionNo: 1,
      versionNo: 1,
    });
    await db.insert(turnTable).values({
      id: turnId,
      threadId,
      turnSequence: 1,
      triggerType: "user_message",
      turnState: "running",
      activeInvocationId: invocationId,
      latestInvocationId: invocationId,
      regenerationNo: 0,
      versionNo: 1,
    });
    // canonical 约束：Invocation.triggerItemId 是真实外键且 subject_shape 要求非空。
    const triggerItemId = randomUUID();
    await db.insert(threadItemTable).values({
      id: triggerItemId,
      threadId,
      turnId,
      itemSequence: 1,
      itemType: "user_message",
      itemState: "completed",
      authorType: "user",
      contentJson: { text: "trigger" },
      contentHash: "test-trigger-item",
    });
    await db.insert(invocationTable).values({
      id: invocationId,
      tenantId: TENANT,
      threadId,
      turnId,
      invocationSequence: 1,
      invocationKind: "initial",
      executionState: "running",
      subjectType: "thread",
      triggerItemId,
      inputDigest: `sha256:${"0".repeat(64)}`,
      versionNo: 1,
    });
    const [governanceSet] = await db
      .select({ revisionId: governanceConfigSetTable.currentRevisionId })
      .from(governanceConfigSetTable)
      .where(eq(governanceConfigSetTable.tenantId, TENANT))
      .limit(1);
    if (!governanceSet?.revisionId) throw new Error("测试 Governance Revision 不存在");
    const [governanceRevision] = await db
      .select({ digest: governanceConfigRevisionTable.configDigest })
      .from(governanceConfigRevisionTable)
      .where(eq(governanceConfigRevisionTable.id, governanceSet.revisionId))
      .limit(1);
    if (!governanceRevision) throw new Error("测试 Governance Revision 不存在");
    const workspace = await createNoPlatformWorkspaceBinding(
      TENANT,
      "external-runtime-subject-test",
    );
    // runtimeRevisionId 在 token authority 与 Binding 中必须一致且为 UUID。
    await createExecutionBinding({
      invocationId,
      tenantId: TENANT,
      runtimeRevisionId: invocationId,
      deploymentRouteId: "external-route",
      modelProvider: "test",
      modelId: "test-model",
      workspaceBindingId: workspace.id,
      governanceConfigRevisionId: governanceSet.revisionId,
      governanceConfigDigest: governanceRevision.digest,
      controlPlaneEvidence: TEST_EXECUTION_BINDING_EVIDENCE,
      projectionVersionNo: 1,
      executionSubject: { tenantId: TENANT, subjectType: "user", subjectId },
    });
    await seedRuntimeAuthority({
      tenantId: TENANT,
      invocationId,
      runtimeRevisionId: invocationId,
    });
    return { threadId, turnId, invocationId };
  }

  function gatewayToken(invocationId: string, tenantId = TENANT) {
    const authority = authorityByInvocation.get(invocationId);
    if (!authority) throw new Error(`Invocation ${invocationId} 缺少 Execution Authority 播种`);
    return issueTestExecutionToken({
      tenantId,
      invocationId,
      ...authority,
      audience: "gateway",
    });
  }

  function request(
    tokenInvocationId: string,
    bodyInvocationId: string,
    extraBody: Record<string, unknown> = {},
    tokenTenantId = TENANT,
  ) {
    const action = {
      actionId: "knowledge-1",
      stepNo: 1,
      actionType: "knowledge.search",
      purposeCode: "policy_lookup",
      shortPurpose: "查询制度",
      payload: { query: "年假制度" },
    };
    return new Request("http://localhost/gateway/capability-actions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayToken(tokenInvocationId, tokenTenantId)}`,
        "content-type": "application/json",
        "idempotency-key": `${bodyInvocationId}:${action.actionId}`,
      },
      body: JSON.stringify({
        invocation_id: bodyInvocationId,
        producer_sequence_start: 1,
        action,
        ...extraBody,
      }),
    });
  }

  it("uses Binding subject and audits caller workload plus effective subject", async () => {
    const seeded = await seedRunningInvocation();
    const response = await POST(request(seeded.invocationId, seeded.invocationId));
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);

    const [audit] = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.actionType, "capability.action.execute"))
      .limit(1);
    expect(audit).toMatchObject({
      tenantId: TENANT,
      actorType: "workload",
      actorId: `gateway:${seeded.invocationId}`,
      outcome: "succeeded",
      metadataRedacted: {
        parent_invocation_id: seeded.invocationId,
        caller_workload: { type: "execution", audience: "gateway" },
        effective_subject: { type: "user", id: "employee-original" },
      },
    });
    expect(JSON.stringify(audit?.metadataRedacted)).not.toContain('"id":"gateway"');
  });

  it("audits a denied capability with the same two identities", async () => {
    const seeded = await seedRunningInvocation();
    const response = await POST(
      request(seeded.invocationId, seeded.invocationId, {
        action: {
          actionId: "knowledge-1",
          stepNo: 1,
          actionType: "tool.call",
          purposeCode: "forbidden_tool",
          shortPurpose: "调用未授权工具",
          payload: { toolId: "tool-denied", operationId: "run", arguments: {} },
        },
      }),
    );
    expect(response.status).toBe(404);
    const [audit] = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.actionType, "capability.action.execute"))
      .limit(1);
    expect(audit).toMatchObject({
      outcome: "failed",
      metadataRedacted: {
        caller_workload: { type: "execution" },
        effective_subject: { type: "user", id: "employee-original" },
      },
    });
  });

  it("ignores no runtime-asserted user: strict body rejects it before execution", async () => {
    const seeded = await seedRunningInvocation();
    const response = await POST(
      request(seeded.invocationId, seeded.invocationId, {
        execution_subject: { subject_type: "user", subject_id: "forged-user" },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_SCHEMA_INVALID" } });
  });

  it("token bound to Invocation A cannot execute Invocation B", async () => {
    const a = await seedRunningInvocation("employee-a");
    const b = await seedRunningInvocation("employee-b");
    const response = await POST(request(a.invocationId, b.invocationId));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_SCHEMA_INVALID" } });
  });

  it("token bound to another Runtime Target cannot execute the invocation", async () => {
    const seeded = await seedRunningInvocation();
    const forged = issueWorkloadToken({
      contractVersion: 3,
      type: "execution",
      tenantId: TENANT,
      invocationId: seeded.invocationId,
      runtimeRevisionId: "other-runtime-revision",
      attemptId: seeded.invocationId,
      ownershipId: seeded.invocationId,
      leaseEpoch: "1",
      sessionBindingId: seeded.invocationId,
      audience: "gateway",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway,
    });
    const action = {
      actionId: "knowledge-1",
      stepNo: 1,
      actionType: "knowledge.search",
      purposeCode: "policy_lookup",
      shortPurpose: "查询制度",
      payload: { query: "年假制度" },
    };
    const response = await POST(
      new Request("http://localhost/gateway/capability-actions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${forged}`,
          "content-type": "application/json",
          "idempotency-key": `${seeded.invocationId}:knowledge-1`,
        },
        body: JSON.stringify({
          invocation_id: seeded.invocationId,
          producer_sequence_start: 1,
          action,
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("token bound to tenant B cannot access tenant A invocation", async () => {
    const seeded = await seedRunningInvocation();
    const response = await POST(
      request(seeded.invocationId, seeded.invocationId, {}, "11111111-1111-4111-8111-111111111111"),
    );
    expect(response.status).toBe(409);
    expect(await db.select().from(auditEvent)).toHaveLength(0);
  });

  it("fails closed when the frozen subject facts conflict", async () => {
    const seeded = await seedRunningInvocation();
    await db
      .update(executionBindingTable)
      .set({ principalSource: "trusted_service" })
      .where(eq(executionBindingTable.invocationId, seeded.invocationId));

    const response = await POST(request(seeded.invocationId, seeded.invocationId));
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "HARNESS_LOOP_STATE_RECOVERY_FAILED" },
    });
  });
});
