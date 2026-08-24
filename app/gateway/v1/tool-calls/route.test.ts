/**
 * 02-6 P6 Tool Gateway 集成测试（真实 MySQL 8 · 冻结方案 §14 / §15 / §16 / §18 / §55.5）。
 *
 * 覆盖（§55.5）：
 * - allow → ToolCall running + PermissionDecision(allow)（授权执行，Executor 后置）。
 * - pause(Turn) 不执行 → ToolCall paused + UAR(confirmation/tool_permission_confirmation) + Invocation waiting_user。
 * - block 不执行 → ToolCall cancelled + 403 POLICY_BLOCKED + 不创建 UAR。
 * - pause(Job) → ToolCall cancelled + 403 POLICY_REQUIRES_PREAUTH + 不创建 UAR。
 * - 同 (toolId, operationId) 同 args 幂等重放（不重复决策）。
 * - 同 operation_id 不同 args → 409 OPERATION_PAYLOAD_CONFLICT。
 * - decisionSequence 由 ToolCall 行锁串行分配（并发同 operation_id 不重复决策）。
 * - Policy digest mismatch → 409 POLICY_INTEGRITY_MISMATCH（fail-closed，不建 ToolCall）。
 */
import { randomUUID } from "node:crypto";
import { resolveGenericUserAction } from "@/lib/conversations/user-action-resolve-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { type PolicyRuleInput, createPolicyRevision } from "@/lib/permission/policy-queries";
import { threadTable } from "@/lib/persistence/schema/conversation";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import { permissionDecisionTable } from "@/lib/persistence/schema/permission";
import {
  type ToolProvider,
  toolProviderTable,
  toolSchemaRevisionTable,
  toolTable,
} from "@/lib/persistence/schema/tool";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "./route";

const TENANT = DEFAULT_TENANT_ID;
const REQ = "req-gw-1";
const SIGNING_SECRET = "test-gateway-signing-secret-0123456789abcdef"; // ≥32 字节

/** 固定合法 hash（sha256: + 64 hex）。 */
function hash(hex: string): string {
  return `sha256:${hex.padStart(64, "0")}`;
}

function rule(patch: Partial<PolicyRuleInput>): PolicyRuleInput {
  return {
    ruleKey: "r1",
    toolPattern: "*",
    argMatcher: null,
    decision: "allow",
    scope: { type: "tenant" },
    priority: 0,
    reason: null,
    ...patch,
  };
}

/** 发布的 Policy Revision → { policyRevisionId, policyRulesDigest }。 */
async function seedPolicy(defaultDecision: "allow" | "pause" | "block", rules: PolicyRuleInput[]) {
  const result = await createPolicyRevision({
    tenantId: TENANT,
    defaultDecision,
    rules,
    expectedVersionNo: null,
    actor: { tenantId: TENANT, actorType: "user", actorId: "test-admin" },
    requestId: REQ,
  });
  return { policyRevisionId: result.revision.id, policyRulesDigest: result.rulesHash };
}

/** ToolProvider + Tool + published SchemaRevision。 */
async function seedToolchain(): Promise<{ toolId: string; schemaHash: string }> {
  const providerId = randomUUID();
  const provider: ToolProvider = {
    id: providerId,
    tenantId: TENANT,
    providerKey: "test-provider",
    providerType: "builtin",
    trustLevel: "standard",
    displayName: "Test Provider",
    description: null,
    connectionId: null,
    ownerUserId: "test-admin",
    lifecycleState: "enabled",
    versionNo: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
  await db.insert(toolProviderTable).values(provider);

  const toolId = randomUUID();
  await db.insert(toolTable).values({
    id: toolId,
    tenantId: TENANT,
    providerId,
    toolKey: "writeFile",
    displayName: "Write File",
    description: null,
    riskClass: "medium",
    currentSchemaRevisionId: null,
    lifecycleState: "enabled",
    versionNo: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });

  const schemaRevisionId = randomUUID();
  const schemaHash = hash("a");
  await db.insert(toolSchemaRevisionTable).values({
    id: schemaRevisionId,
    toolId,
    revisionNo: 1,
    description: "v1",
    inputSchemaJson: { type: "object" },
    outputSchemaJson: null,
    schemaHash,
    riskMetadataJson: { risk_class: "medium" },
    revisionState: "published",
    createdBy: "test-admin",
    createdAt: new Date(),
    publishedAt: new Date(),
  });
  await db
    .update(toolTable)
    .set({ currentSchemaRevisionId: schemaRevisionId })
    .where(eq(toolTable.id, toolId));

  return { toolId, schemaHash };
}

/** 直接插入 Invocation（turn 或 job 模式）。返回 invocationId。 */
async function seedInvocation(opts: {
  threadId?: string | null;
  turnId?: string | null;
  jobId?: string | null;
}): Promise<string> {
  const invocationId = randomUUID();
  await db.insert(invocationTable).values({
    id: invocationId,
    tenantId: TENANT,
    threadId: opts.threadId ?? null,
    turnId: opts.turnId ?? null,
    jobId: opts.jobId ?? null,
    invocationSequence: 1,
    invocationKind: opts.jobId ? "job" : "initial",
    executionState: "running",
    triggerItemId: null,
    replacesInvocationId: null,
    outputItemId: null,
    resultRef: null,
    runtimeSessionBindingId: null,
    runtimeExecutionRef: null,
    startedAt: new Date(),
    finishedAt: null,
    lastHeartbeatAt: new Date(),
    errorCode: null,
    errorSummary: null,
    versionNo: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return invocationId;
}

/** 直接插入不可变 ExecutionBinding（其余 digest 用占位值）。 */
async function seedBinding(
  invocationId: string,
  frozen: { policyRevisionId: string; policyRulesDigest: string },
): Promise<void> {
  await db.insert(executionBindingTable).values({
    invocationId,
    tenantId: TENANT,
    agentRevisionId: "agent-rev-fake",
    runtimeRevisionId: "runtime-rev-fake",
    deploymentRouteId: "route-fake",
    modelProvider: "provider",
    modelId: "model",
    modelRevisionRef: null,
    initialEnvironmentLeaseId: null,
    workspaceBindingId: null,
    policyRevisionId: frozen.policyRevisionId,
    policyRulesDigest: frozen.policyRulesDigest,
    governanceConfigRevisionId: "governance-rev-fake",
    governanceConfigDigest: hash("9"),
    contextCheckpointId: null,
    routeRevisionId: "route-rev-fake",
    routeActivationId: "route-act-fake",
    routeContentDigest: hash("1"),
    agentArtifactId: "agent-art-fake",
    runtimeArtifactId: "runtime-art-fake",
    agentArtifactDigest: hash("2"),
    runtimeArtifactDigest: hash("3"),
    runtimeConfigDigest: hash("4"),
    capabilityManifestDigest: hash("5"),
    agentAttestationIds: ["agent-att-1"],
    runtimeAttestationIds: ["runtime-att-1"],
    agentPublicationRecordId: "agent-pub-fake",
    runtimePublicationRecordId: "runtime-pub-fake",
    conformanceRunId: "conformance-fake",
    resolutionInputDigest: hash("6"),
    projectionVersionNo: 0,
    environmentDefinitionRevisionId: null,
    configHash: hash("7"),
  });
}

/** 最小 Thread 行（resolveGenericUserAction approve/deny 需要事件流 + resume InvocationCommand）。 */
async function seedThread(id: string): Promise<void> {
  await db.insert(threadTable).values({
    id,
    tenantId: TENANT,
    ownerUserId: "user-1",
    defaultWorkspaceId: null,
    activeGoalId: null,
    title: null,
    defaultModelRef: null,
    defaultEnvironmentDefinitionId: null,
    lastActivityAt: new Date(),
    lastTurnSequence: 0,
    lastItemSequence: 0,
    lastEventSequence: 0,
    pendingQueueVersionNo: 1,
    versionNo: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
}

/** 签发 Gateway Access Token。 */
function gatewayToken(invocationId: string): string {
  return issueWorkloadToken({
    type: "gateway",
    tenantId: TENANT,
    invocationId,
    audience: "gateway",
    expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway,
  });
}

function gatewayRequest(token: string, body: unknown): Request {
  return new Request("http://localhost/gateway/v1/tool-calls", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-request-id": REQ,
    },
    body: JSON.stringify(body),
  });
}

function toolCallBody(patch: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    invocation_id: "unused", // route 以 token 的 invocationId 为准校验
    tool_id: "unused",
    schema_hash: "unused",
    operation_id: "op-1",
    arguments: { path: "/tmp/foo.txt" },
    ...patch,
  };
}

/** 断言查询恰好返回一行并取回。 */
async function singleRow<T>(rows: Promise<readonly T[]>): Promise<T> {
  const list = await rows;
  const row = list[0];
  if (!row) throw new Error("expected exactly one row");
  return row;
}

async function getDecisions(toolCallId: string) {
  return db
    .select()
    .from(permissionDecisionTable)
    .where(eq(permissionDecisionTable.toolCallId, toolCallId))
    .orderBy(asc(permissionDecisionTable.decisionSequence));
}

beforeEach(async () => {
  await resetDatabase(db);
  process.env.SNOW_AUTH_MODE = "dev";
  process.env.SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET = SIGNING_SECRET;
  await ensureDefaultTenant();
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = "dev";
  process.env.SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET = SIGNING_SECRET;
});

describe("POST /gateway/v1/tool-calls（02-6 P6 §14/§15/§16/§18/§55.5）", () => {
  it("allow：ToolCall→running + PermissionDecision(allow)；Executor 不在此执行（§18.1）", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });

    const res = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
      ),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.call_state).toBe("running");
    expect(json.decision).toBe("allow");
    expect(json.decision_sequence).toBe(1);
    expect(json.schema_revision_id).toBeTruthy();
    expect(json.tool_call_id).toBeTruthy();

    const tc = await singleRow(
      db.select().from(toolCallTable).where(eq(toolCallTable.id, json.tool_call_id)),
    );
    expect(tc.callState).toBe("running");
    const decisions = await getDecisions(json.tool_call_id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision).toBe("allow");
    expect(decisions[0]!.policyRevisionId).toBe(policyRevisionId);
  });

  it("pause(Turn)：ToolCall→paused + UAR(tool_permission_confirmation) + Invocation waiting_user（§18.3/§19）", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("pause", []);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });

    const res = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
      ),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.call_state).toBe("paused");
    expect(json.decision).toBe("pause");
    expect(json.user_action_request_id).toBeTruthy();

    const uars = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.toolCallId, json.tool_call_id));
    expect(uars).toHaveLength(1);
    expect(uars[0]!.purpose).toBe("tool_permission_confirmation");
    expect(uars[0]!.requestType).toBe("confirmation");
    expect(uars[0]!.permissionDecisionId).toBeTruthy();
    expect(uars[0]!.requestState).toBe("pending");

    const inv = await singleRow(
      db.select().from(invocationTable).where(eq(invocationTable.id, invocationId)),
    );
    expect(inv.executionState).toBe("waiting_user");
  });

  it("block：ToolCall→cancelled + 403 POLICY_BLOCKED + 不创建 UAR（§18.2）", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("block", []);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });

    const res = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
      ),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error?.code).toBe("POLICY_BLOCKED");

    const tc = await singleRow(
      db.select().from(toolCallTable).where(eq(toolCallTable.tenantId, TENANT)),
    );
    expect(tc.callState).toBe("cancelled");
    expect(tc.errorCode).toBe("POLICY_BLOCKED");
    const uars = await db.select().from(userActionRequestTable);
    expect(uars).toHaveLength(0);
  });

  it("pause(Job)：ToolCall→cancelled + 403 POLICY_REQUIRES_PREAUTH + 不创建 UAR（§18.4）", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("pause", []);
    const invocationId = await seedInvocation({ jobId: "job-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });

    const res = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
      ),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error?.code).toBe("POLICY_REQUIRES_PREAUTH");

    const tc = await singleRow(
      db.select().from(toolCallTable).where(eq(toolCallTable.tenantId, TENANT)),
    );
    expect(tc.callState).toBe("cancelled");
    expect(tc.errorCode).toBe("POLICY_REQUIRES_PREAUTH");
    const uars = await db.select().from(userActionRequestTable);
    expect(uars).toHaveLength(0);
  });

  it("幂等：同 (toolId, operationId) 同 args 重放现有状态，不重复决策（§16.2/§47.1）", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });

    const body = toolCallBody({
      invocation_id: invocationId,
      tool_id: toolId,
      schema_hash: schemaHash,
    });
    const res1 = await POST(gatewayRequest(gatewayToken(invocationId), body));
    const json1 = await res1.json();
    const res2 = await POST(gatewayRequest(gatewayToken(invocationId), body));
    const json2 = await res2.json();

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(json1.tool_call_id).toBe(json2.tool_call_id);
    expect(json2.decision).toBe("allow");
    // 同一 ToolCall 只产生一次决策
    const decisions = await getDecisions(json1.tool_call_id);
    expect(decisions).toHaveLength(1);
  });

  it("冲突：同 (toolId, operationId) 不同 args → 409 OPERATION_PAYLOAD_CONFLICT", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });

    const res1 = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
      ),
    );
    expect(res1.status).toBe(200);

    const res2 = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({
          invocation_id: invocationId,
          tool_id: toolId,
          schema_hash: schemaHash,
          arguments: { path: "/tmp/other.txt" },
        }),
      ),
    );
    expect(res2.status).toBe(409);
    const json2 = await res2.json();
    expect(json2.error?.code).toBe("OPERATION_PAYLOAD_CONFLICT");
  });

  it("并发同 operation_id：行锁串行分配，只产生一次决策（§16.3 决策序列锁）", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
    const token = gatewayToken(invocationId);
    const body = toolCallBody({
      invocation_id: invocationId,
      tool_id: toolId,
      schema_hash: schemaHash,
    });

    const [r1, r2] = await Promise.all([
      POST(gatewayRequest(token, body)),
      POST(gatewayRequest(token, body)),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const j1 = await r1.json();
    const j2 = await r2.json();
    expect(j1.tool_call_id).toBe(j2.tool_call_id);
    const decisions = await getDecisions(j1.tool_call_id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decisionSequence).toBe(1);
  });

  it("Policy digest mismatch → 409 POLICY_INTEGRITY_MISMATCH（fail-closed，不建 ToolCall）", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId } = await seedPolicy("allow", [rule({})]);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    // 故意给出错误的 digest → 重算不匹配。
    await seedBinding(invocationId, {
      policyRevisionId,
      policyRulesDigest: hash("f"),
    });

    const res = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
      ),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error?.code).toBe("POLICY_INTEGRITY_MISMATCH");

    const tcs = await db.select().from(toolCallTable).where(eq(toolCallTable.tenantId, TENANT));
    expect(tcs).toHaveLength(0);
  });

  it("schema_hash 不一致 → 409 TOOL_SCHEMA_CHANGED（§16.2）", async () => {
    const { toolId } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });

    const res = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: hash("z") }),
      ),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error?.code).toBe("TOOL_SCHEMA_CHANGED");
  });
});

describe("POST /gateway/v1/tool-calls Pause/Resume（02-6 P7 §20/§45/§55.6/§55.7）", () => {
  /** 暂停一个 Turn ToolCall → 返回网关侧事实（ToolCall/UAR/Invocation/tool/schema）。 */
  async function pauseTurn(): Promise<{
    toolCallId: string;
    userActionRequestId: string;
    invocationId: string;
    toolId: string;
    schemaHash: string;
  }> {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("pause", []);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
    await seedThread("t-1");
    const res = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
      ),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    return {
      toolCallId: json.tool_call_id as string,
      userActionRequestId: json.user_action_request_id as string,
      invocationId,
      toolId,
      schemaHash,
    };
  }

  async function approve(requestId: string) {
    await resolveGenericUserAction({
      tenantId: TENANT,
      requestId,
      resolution: "approve",
      resolvedBy: "user-1",
      actorType: "user",
      actorId: "user-1",
    });
  }

  it("pause Decision#1 + UAR 创建一次；重复请求不重复建 UAR（§19/§47.3/§55.6）", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("pause", []);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
    await seedThread("t-1");
    const body = toolCallBody({
      invocation_id: invocationId,
      tool_id: toolId,
      schema_hash: schemaHash,
    });

    const r1 = await POST(gatewayRequest(gatewayToken(invocationId), body));
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1.decision).toBe("pause");
    expect(j1.decision_sequence).toBe(1);
    const toolCallId = j1.tool_call_id as string;
    const uarId = j1.user_action_request_id as string;
    expect(uarId).toBeTruthy();

    const decisions = await getDecisions(toolCallId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision).toBe("pause");

    let uars = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.toolCallId, toolCallId));
    expect(uars).toHaveLength(1);
    expect(uars[0]!.id).toBe(uarId);

    // 重复请求 → 幂等 pause 重放：同一 ToolCall、同一 UAR，不新增 pause 决策。
    const r2 = await POST(gatewayRequest(gatewayToken(invocationId), body));
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.decision).toBe("pause");
    expect(j2.tool_call_id).toBe(toolCallId);
    expect(j2.user_action_request_id).toBe(uarId);
    uars = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.toolCallId, toolCallId));
    expect(uars).toHaveLength(1);
    const decisions2 = await getDecisions(toolCallId);
    expect(decisions2).toHaveLength(1);
  });

  it("approve：resume same Invocation → 重提交 same ToolCall → Decision#2=allow + running + 执行一次（§20.1/§55.6）", async () => {
    const { toolCallId, userActionRequestId, invocationId, toolId, schemaHash } = await pauseTurn();
    await approve(userActionRequestId);

    // approve 已恢复 Invocation → running + 入队 resume；此处直接重提交验证 gateway 侧。
    const body = toolCallBody({
      invocation_id: invocationId,
      tool_id: toolId,
      schema_hash: schemaHash,
    });

    const res = await POST(gatewayRequest(gatewayToken(invocationId), body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tool_call_id).toBe(toolCallId);
    expect(json.decision).toBe("allow");
    expect(json.decision_sequence).toBe(2);
    expect(json.call_state).toBe("running");

    const decisions = await getDecisions(toolCallId);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.decision).toBe("pause");
    expect(decisions[1]!.decision).toBe("allow");
    expect(decisions[1]!.policyRevisionId).toBe(decisions[0]!.policyRevisionId);

    const tc = await singleRow(
      db.select().from(toolCallTable).where(eq(toolCallTable.id, toolCallId)),
    );
    expect(tc.callState).toBe("running");

    // 执行一次：再提交 → running 重放，不新增决策。
    const res2 = await POST(gatewayRequest(gatewayToken(invocationId), body));
    expect(res2.status).toBe(200);
    const j2 = await res2.json();
    expect(j2.call_state).toBe("running");
    const decisions2 = await getDecisions(toolCallId);
    expect(decisions2).toHaveLength(2);
  });

  it("deny：ToolCall→cancelled + errorCode=USER_DENIED，不生成 Grant（§20.3/§45）", async () => {
    const { toolCallId, userActionRequestId } = await pauseTurn();
    await resolveGenericUserAction({
      tenantId: TENANT,
      requestId: userActionRequestId,
      resolution: "deny",
      resolvedBy: "user-1",
      actorType: "user",
      actorId: "user-1",
    });

    const tc = await singleRow(
      db.select().from(toolCallTable).where(eq(toolCallTable.id, toolCallId)),
    );
    expect(tc.callState).toBe("cancelled");
    expect(tc.errorCode).toBe("USER_DENIED");
  });

  it("approve 后 arguments 变化 → 原确认无效，同 operation 不同 args → 409（§20.1/§55.6）", async () => {
    const { toolCallId, userActionRequestId, invocationId, toolId, schemaHash } = await pauseTurn();
    await approve(userActionRequestId);

    const res = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({
          invocation_id: invocationId,
          tool_id: toolId,
          schema_hash: schemaHash,
          arguments: { path: "/tmp/other.txt" },
        }),
      ),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error?.code).toBe("OPERATION_PAYLOAD_CONFLICT");
  });

  it("block after approval：policy 变 block → approval 失效，追加 Decision#2=block + paused→cancelled（§20.2/§55.6）", async () => {
    const { toolCallId, userActionRequestId, invocationId, toolId, schemaHash } = await pauseTurn();
    await approve(userActionRequestId);

    // 重新绑定 invocation 到新的 blocking policy revision（含新 digest）。
    const blockPol = await seedPolicy("block", [rule({ toolPattern: "*", decision: "block" })]);
    await db
      .update(executionBindingTable)
      .set({
        policyRevisionId: blockPol.policyRevisionId,
        policyRulesDigest: blockPol.policyRulesDigest,
      })
      .where(eq(executionBindingTable.invocationId, invocationId));

    const res = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({
          invocation_id: invocationId,
          tool_id: toolId,
          schema_hash: schemaHash,
        }),
      ),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error?.code).toBe("POLICY_BLOCKED");

    const tc = await singleRow(
      db.select().from(toolCallTable).where(eq(toolCallTable.id, toolCallId)),
    );
    expect(tc.callState).toBe("cancelled");
    expect(tc.errorCode).toBe("POLICY_BLOCKED");

    const decisions = await getDecisions(toolCallId);
    expect(decisions).toHaveLength(2);
    expect(decisions[1]!.decision).toBe("block");
  });
});
