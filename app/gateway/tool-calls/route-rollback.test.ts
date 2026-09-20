/**
 * 02-6 P7 §55.7 事务原子性（故障注入）。
 *
 * 验证 §16.3 单事务：PermissionDecision 写入成功后，同事务建 UAR 失败（createUserActionRequest
 * 抛错）→ 整笔回滚：不残留 PermissionDecision / ToolCall / UAR，Invocation 维持 running
 * （不误写 waiting_user）。
 */
import { randomUUID } from "node:crypto";
import { computeToolExecutionContractDigest } from "@/lib/capability/tool-execution-contract";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { acquireExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { issueTestExecutionToken } from "@/lib/identity/test-support/execution-token";
import { type PolicyRuleInput, createPolicyRevision } from "@/lib/permission/policy-queries";
import { threadItemTable, threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import {
  executionBindingTable,
  executionOwnershipTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { permissionDecisionTable } from "@/lib/persistence/schema/permission";
import {
  type ToolProvider,
  connectionTable,
  toolProviderTable,
  toolSchemaRevisionTable,
  toolTable,
} from "@/lib/persistence/schema/tool";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { buildCapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import {
  applyRuntimeSessionDispatchForTest,
  createRuntimeSessionBindingForTest,
  sourceIntentForFixture,
} from "@/lib/runtime/test-support/session-write-fixtures";
import { createNoPlatformWorkspaceBinding } from "@/lib/workspace/workspace-binding-store";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// §55.7：UAR 创建失败 → §16.3 事务整体回滚。仅覆盖 createUserActionRequest，其余保持真实。
vi.mock("@/lib/permission/user-action-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permission/user-action-queries")>();
  return {
    ...actual,
    createUserActionRequest: vi.fn().mockRejectedValue(new Error("injected UAR failure")),
  };
});

const TENANT = DEFAULT_TENANT_ID;
const REQ = "req-rollback-1";
const SIGNING_SECRET = "test-gateway-signing-secret-0123456789abcdef"; // ≥32 字节

let catalogTool: Parameters<typeof buildCapabilityCatalogSnapshot>[0]["tools"][number] | null =
  null;

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

async function seedToolchain(): Promise<{ toolId: string; schemaHash: string }> {
  const connectionId = randomUUID();
  await db.insert(connectionTable).values({
    id: connectionId,
    tenantId: TENANT,
    connectionKey: "test-webhook",
    connectionType: "webhook",
    endpointRef: "https://example.invalid/webhook",
    authMethod: "none",
    ownerUserId: "test-admin",
    lifecycleState: "enabled",
    versionNo: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const providerId = randomUUID();
  const provider: ToolProvider = {
    id: providerId,
    tenantId: TENANT,
    providerKey: "test-provider",
    providerType: "webhook",
    trustLevel: "standard",
    displayName: "Test Provider",
    description: null,
    connectionId,
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
  const executionContractJson = {
    timeoutMs: 1_000,
    idempotencySupport: "header" as const,
    sideEffectMode: "write" as const,
    verificationMode: "provider_response" as const,
    responseLimits: { maxBytes: 8_192 },
    providerOperationMetadata: { effectType: "update" },
  };
  const executionContractDigest = computeToolExecutionContractDigest(executionContractJson);
  await db.insert(toolSchemaRevisionTable).values({
    id: schemaRevisionId,
    toolId,
    revisionNo: 1,
    description: "v1",
    inputSchemaJson: { type: "object" },
    outputSchemaJson: null,
    schemaHash,
    riskMetadataJson: { risk_class: "medium" },
    executionContractJson,
    executionContractDigest,
    revisionState: "published",
    createdBy: "test-admin",
    createdAt: new Date(),
    publishedAt: new Date(),
  });
  await db
    .update(toolTable)
    .set({ currentSchemaRevisionId: schemaRevisionId })
    .where(eq(toolTable.id, toolId));

  catalogTool = {
    toolId,
    operationId: "writeFile",
    schemaRevisionId,
    schemaHash,
    executionContractDigest,
    displayName: "Write File",
    description: "v1",
    inputSchema: { type: "object" },
    sideEffect: "write",
    idempotent: true,
  };

  return { toolId, schemaHash };
}

async function seedInvocation(): Promise<string> {
  const invocationId = randomUUID();
  // canonical 约束：Invocation.threadId/turnId/triggerItemId 是真实外键，
  // 且 Invocation_subject_shape 要求 thread 主体 triggerItemId 非空。
  const threadId = "t-1";
  const turnId = "turn-1";
  await db.insert(threadTable).values({
    id: threadId,
    tenantId: TENANT,
    ownerUserId: "user-1",
    defaultWorkspaceId: null,
    activeGoalId: null,
    title: null,
    defaultModelRef: null,
    defaultEnvironmentDefinitionId: null,
    lastActivityAt: new Date(),
    lastTurnSequence: 1,
    lastItemSequence: 1,
    lastEventSequence: 0,
    pendingQueueVersionNo: 1,
    versionNo: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
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
    subjectType: "thread",
    threadId,
    turnId,
    jobId: null,
    invocationSequence: 1,
    invocationKind: "initial",
    executionState: "running",
    inputDigest: `sha256:${"0".repeat(64)}`,
    triggerItemId,
    replacesInvocationId: null,
    outputItemId: null,
    resultRef: null,
    startedAt: new Date(),
    finishedAt: null,
    errorCode: null,
    errorSummary: null,
    versionNo: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return invocationId;
}

async function seedBinding(
  invocationId: string,
  frozen: { policyRevisionId: string; policyRulesDigest: string },
): Promise<{
  runtimeRevisionId: string;
  attemptId: string;
  ownershipId: string;
  leaseEpoch: string;
  sessionBindingId: string;
}> {
  if (!catalogTool) throw new Error("seedToolchain must run first");
  const catalog = buildCapabilityCatalogSnapshot({
    invocationId,
    preferredAgentId: null,
    agentCandidate: null,
    tools: [catalogTool],
    knowledgeSources: [],
    sourceRefs: ["test-fixture:tool-capability-catalog"],
  });
  // canonical：Binding.workspaceBindingId 必须指向真实 WorkspaceBinding 行
  //（authority guard 按 id 加载，缺失 = WorkspaceNotReady fail-closed）。
  const workspace = await createNoPlatformWorkspaceBinding(TENANT, "test-service");
  await db.insert(executionBindingTable).values({
    capabilityCatalogJson: catalog.snapshot,
    capabilityCatalogDigest: catalog.digest,
    capabilityCatalogVersion: catalog.version,
    capabilityCatalogSourceRefs: catalog.sourceRefs,
    capabilityCatalogCreatedAt: catalog.createdAt,
    principalType: "user",
    principalId: "test-user",
    principalSource: "authenticated_user",
    principalFrozenAt: new Date(),
    invocationId,
    tenantId: TENANT,
    runtimeRevisionId: "runtime-rev-fake",
    deploymentRouteId: "route-fake",
    modelProvider: "provider",
    modelId: "model",
    modelRevisionRef: null,
    workspaceBindingId: workspace.id,
    policyRevisionId: frozen.policyRevisionId,
    policyRulesDigest: frozen.policyRulesDigest,
    governanceConfigRevisionId: "governance-rev-fake",
    governanceConfigDigest: hash("9"),
    routeRevisionId: "route-rev-fake",
    routeActivationId: "route-act-fake",
    routeContentDigest: hash("1"),
    runtimeArtifactId: "runtime-art-fake",
    runtimeArtifactDigest: hash("3"),
    runtimeConfigDigest: hash("4"),
    runtimeTargetDigest: hash("5"),
    runtimeEvidenceKind: "hosted_artifact" as const,
    capabilityManifestDigest: hash("5"),
    runtimeAttestationIds: ["runtime-att-1"],
    runtimePublicationRecordId: "runtime-pub-fake",
    conformanceRunId: "conformance-fake",
    resolutionInputDigest: hash("6"),
    projectionVersionNo: 0,
    environmentMode: "NO_PLATFORM_ENVIRONMENT",
    environmentDefinitionRevisionId: null,
    configHash: hash("7"),
  });
  // canonical 权威链：Attempt(prepared) → ExecutionOwnership → SessionBinding(active)，
  // gateway route 的 Current Execution Authority guard 依赖该链（缺失 = NotCurrentExecutor）。
  const attempt = await createAttempt({ tenantId: TENANT, invocationId });
  const evidence = { kind: "rollback-test-candidate", invocationId, attemptId: attempt.id };
  await db.transaction((tx) =>
    markAttemptPreparedInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
  const acquired = await acquireExecutionOwnership({
    tenantId: TENANT,
    invocationId,
    attemptId: attempt.id,
    runtimeRevisionId: "runtime-rev-fake",
    acquiredByType: "service",
    acquiredById: "tool-gateway-rollback-test",
  });
  const session = await createRuntimeSessionBindingForTest({
    tenantId: TENANT,
    invocationId,
    attemptId: attempt.id,
    ownershipId: acquired.ownership.id,
    runtimeRevisionId: "runtime-rev-fake",
    leaseEpoch: acquired.ownership.leaseEpoch,
    intentType: "start",
    startIntentKey: `start:${acquired.ownership.id}`,
    ...sourceIntentForFixture({
      tenantId: TENANT,
      invocationId,
      attemptId: attempt.id,
      intentType: "start",
    }),
  });
  // bindingState=active 必须冻结语义请求并携带 remote refs + startedEventId。
  await applyRuntimeSessionDispatchForTest(TENANT, session.id, {
    bindingState: "active",
    semanticRequestJson: { kind: "tool-gateway-rollback-test" },
    semanticRequestDigest: `sha256:${"0".repeat(64)}`,
    remoteSessionRef: "rollback-test-session",
    remoteExecutionRef: "rollback-test-execution",
    startedEventId: randomUUID(),
  });
  // canonical ExecutionOwnership_executing_activation_shape：executing 阶段必须携带
  // activatedAt + activationDigest，authority guard 才承认 executing 请求。
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
        eq(executionOwnershipTable.tenantId, TENANT),
        eq(executionOwnershipTable.id, acquired.ownership.id),
      ),
    );
  return {
    runtimeRevisionId: "runtime-rev-fake",
    attemptId: attempt.id,
    ownershipId: acquired.ownership.id,
    leaseEpoch: String(acquired.ownership.leaseEpoch),
    sessionBindingId: session.id,
  };
}

function gatewayToken(
  invocationId: string,
  authority: {
    runtimeRevisionId: string;
    attemptId: string;
    ownershipId: string;
    leaseEpoch: string;
    sessionBindingId: string;
  },
): string {
  return issueTestExecutionToken({
    tenantId: TENANT,
    invocationId,
    audience: "gateway",
    ...authority,
  });
}

function gatewayRequest(token: string, body: unknown): Request {
  return new Request("http://localhost/gateway/tool-calls", {
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
    invocation_id: "unused",
    tool_id: "unused",
    schema_hash: "unused",
    operation_id: "op-1",
    arguments: { path: "/tmp/foo.txt" },
    ...patch,
  };
}

beforeEach(async () => {
  await resetDatabase(db);
  catalogTool = null;
  process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
  process.env.SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET = SIGNING_SECRET;
  await ensureDefaultTenant();
});

afterEach(() => {
  process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
  process.env.SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET = SIGNING_SECRET;
});

describe("POST /gateway/tool-calls 事务原子性（02-6 P7 §55.7 故障注入）", () => {
  it("PermissionDecision 成功但 UAR 创建失败 → 整笔回滚，无残留决策/ToolCall/UAR，Invocation 保持 running", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("pause", []);
    const invocationId = await seedInvocation();
    const authority = await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
    // 注入失败：§16.3 事务回滚；route 对未知错误 fail-closed 向上抛（Next 渲染 500），POST reject。
    await expect(
      POST(
        gatewayRequest(
          gatewayToken(invocationId, authority),
          toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
        ),
      ),
    ).rejects.toThrow("injected UAR failure");

    // §55.7：整笔回滚，不残留任何半成品。
    const decisions = await db.select().from(permissionDecisionTable);
    expect(decisions).toHaveLength(0);
    const toolCalls = await db.select().from(toolCallTable);
    expect(toolCalls).toHaveLength(0);
    const uars = await db.select().from(userActionRequestTable);
    expect(uars).toHaveLength(0);

    const inv = await db.select().from(invocationTable).where(eq(invocationTable.id, invocationId));
    expect(inv[0]!.executionState).toBe("running");
  });
});
