/**
 * 02-6 P7 §55.7 事务原子性（故障注入）。
 *
 * 验证 §16.3 单事务：PermissionDecision 写入成功后，同事务建 UAR 失败（createUserActionRequest
 * 抛错）→ 整笔回滚：不残留 PermissionDecision / ToolCall / UAR，Invocation 维持 running
 * （不误写 waiting_user）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { type PolicyRuleInput, createPolicyRevision } from "@/lib/permission/policy-queries";
import { permissionDecisionTable } from "@/lib/persistence/schema/permission";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/runtime";
import {
  type ToolProvider,
  toolProviderTable,
  toolSchemaRevisionTable,
  toolTable,
} from "@/lib/persistence/schema/tool";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { eq } from "drizzle-orm";
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

async function seedInvocation(): Promise<string> {
  const invocationId = randomUUID();
  await db.insert(invocationTable).values({
    id: invocationId,
    tenantId: TENANT,
    threadId: "t-1",
    turnId: "turn-1",
    jobId: null,
    invocationSequence: 1,
    invocationKind: "initial",
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
  process.env.SNOW_AUTH_MODE = "dev";
  process.env.SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET = SIGNING_SECRET;
  await ensureDefaultTenant();
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = "dev";
  process.env.SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET = SIGNING_SECRET;
});

describe("POST /gateway/v1/tool-calls 事务原子性（02-6 P7 §55.7 故障注入）", () => {
  it("PermissionDecision 成功但 UAR 创建失败 → 整笔回滚，无残留决策/ToolCall/UAR，Invocation 保持 running", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("pause", []);
    const invocationId = await seedInvocation();
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });

    // 注入失败：§16.3 事务回滚；route 对未知错误 fail-closed 向上抛（Next 渲染 500），POST reject。
    await expect(
      POST(
        gatewayRequest(
          gatewayToken(invocationId),
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
