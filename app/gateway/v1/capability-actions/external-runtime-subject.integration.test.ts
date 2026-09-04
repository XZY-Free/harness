import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  TEST_EXECUTION_BINDING_EVIDENCE,
  createExecutionBinding,
} from "@/lib/executions/test-support/create-unverified-execution-binding";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { auditEvent } from "@/lib/persistence/schema/audit";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import {
  governanceConfigRevisionTable,
  governanceConfigSetTable,
} from "@/lib/persistence/schema/governance-config";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "./route";

const TENANT = DEFAULT_TENANT_ID;

describe("External Runtime effective execution subject", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
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
      lastItemSequence: 0,
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
    await db.insert(invocationTable).values({
      id: invocationId,
      tenantId: TENANT,
      threadId,
      turnId,
      invocationSequence: 1,
      invocationKind: "initial",
      executionState: "running",
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
    await createExecutionBinding({
      invocationId,
      tenantId: TENANT,
      runtimeRevisionId: "external-runtime-revision",
      deploymentRouteId: "external-route",
      modelProvider: "test",
      modelId: "test-model",
      governanceConfigRevisionId: governanceSet.revisionId,
      governanceConfigDigest: governanceRevision.digest,
      controlPlaneEvidence: TEST_EXECUTION_BINDING_EVIDENCE,
      projectionVersionNo: 1,
      executionSubject: { tenantId: TENANT, subjectType: "user", subjectId },
    });
    return { threadId, turnId, invocationId };
  }

  function gatewayToken(invocationId: string, tenantId = TENANT) {
    return issueWorkloadToken({
      type: "gateway",
      tenantId,
      invocationId,
      runtimeRevisionId: "external-runtime-revision",
      audience: "gateway",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway,
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
    return new Request("http://localhost/gateway/v1/capability-actions", {
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
        caller_workload: { type: "gateway", audience: "gateway" },
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
        caller_workload: { type: "gateway" },
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
      type: "gateway",
      tenantId: TENANT,
      invocationId: seeded.invocationId,
      runtimeRevisionId: "other-runtime-revision",
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
      new Request("http://localhost/gateway/v1/capability-actions", {
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
      .set({ executionSubjectSource: "trusted_service" })
      .where(eq(executionBindingTable.invocationId, seeded.invocationId));

    const response = await POST(request(seeded.invocationId, seeded.invocationId));
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "HARNESS_LOOP_STATE_RECOVERY_FAILED" },
    });
  });
});
