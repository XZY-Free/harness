import { execFileSync } from "node:child_process";
/**
 * 02-6 P6 Tool Gateway 集成测试（真实 MySQL 8 · 冻结方案 §14 / §15 / §16 / §18 / §55.5）。
 *
 * 覆盖（§55.5）：
 * - allow → ToolCall queued + immutable ToolExecutionBinding；worker claim 后才进入 running。
 * - pause(Turn) 不执行 → ToolCall paused + UAR(confirmation/tool_permission_confirmation) + Invocation waiting_user。
 * - block 不执行 → ToolCall cancelled + 403 POLICY_BLOCKED + 不创建 UAR。
 * - pause(Job) → ToolCall cancelled + 403 POLICY_REQUIRES_PREAUTH + 不创建 UAR。
 * - 同 (toolId, operationId) 同 args 幂等重放（不重复决策）。
 * - 同 operation_id 不同 args → 409 OPERATION_PAYLOAD_CONFLICT。
 * - decisionSequence 由 ToolCall 行锁串行分配（并发同 operation_id 不重复决策）。
 * - Policy digest mismatch → 409 POLICY_INTEGRITY_MISMATCH（fail-closed，不建 ToolCall）。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeClient } from "@/desktop/bridge/bridge-client";
import type { BrowserActionTarget, BrowserCommandTarget } from "@/desktop/bridge/command-executor";
import { createDeviceIdentity } from "@/desktop/bridge/device-identity";
import { AiLockManager } from "@/desktop/browser/ai-lock";
import { openDesktopDatabase } from "@/desktop/storage/database";
import { registerBuiltinTools } from "@/lib/capability/builtin-tools";
import {
  computeEffectRequestDigest,
  createEffectRecord,
  createEffectTargets,
  reconcileEffect,
} from "@/lib/capability/effect-queries";
import { computeToolExecutionContractDigest } from "@/lib/capability/tool-execution-contract";
import {
  claimNextQueuedToolCall,
  updateToolExecutionAttempt,
} from "@/lib/capability/tool-execution-queries";
import { createToolExecutionWorker } from "@/lib/capability/tool-execution-worker";
import { getCurrentToolSchemaRevision, listTools } from "@/lib/capability/tool-queries";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { resolveGenericUserAction } from "@/lib/conversations/user-action-resolve-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { BridgeServer, setBridgeServer } from "@/lib/desktop-bridge/bridge-server";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { acquireExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { registerDevice } from "@/lib/identity/device-queries";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { issueTestExecutionToken } from "@/lib/identity/test-support/execution-token";
import { type PolicyRuleInput, createPolicyRevision } from "@/lib/permission/policy-queries";
import {
  threadEventTable,
  threadItemTable,
  threadTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import { effectRecordTable } from "@/lib/persistence/schema/effect";
import {
  executionBindingTable,
  executionOwnershipTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { userIdentity } from "@/lib/persistence/schema/identity";
import { permissionDecisionTable } from "@/lib/persistence/schema/permission";
import {
  type ToolProvider,
  connectionTable,
  toolProviderTable,
  toolSchemaRevisionTable,
  toolTable,
} from "@/lib/persistence/schema/tool";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import {
  toolExecutionAttemptTable,
  toolExecutionBindingTable,
} from "@/lib/persistence/schema/tool-execution";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { createInvocationContinuationHandler } from "@/lib/runtime/continuation/invocation-continuation";
import { buildCapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import {
  createRuntimeSessionBinding,
  updateRuntimeSessionDispatch,
} from "@/lib/runtime/persistence/runtime-session-store";
import { resolveToolExecutionTarget } from "@/lib/runtime/resolve-tool-execution-target";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { ensureDesktopWorkspace } from "@/lib/workspace/desktop-workspace-queries";
import { createNoPlatformWorkspaceBinding } from "@/lib/workspace/workspace-binding-store";
import {
  activateWorkspaceWriter,
  reserveWorkspaceWriter,
} from "@/lib/workspace/workspace-write-lock-queries";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import { POST as dispatchDesktopPost } from "../desktop-tool-executions/route";
import { POST } from "./route";

const TENANT = DEFAULT_TENANT_ID;
const REQ = "req-gw-1";
const SIGNING_SECRET = "test-gateway-signing-secret-0123456789abcdef"; // ≥32 字节

/** 探测 sandbox-exec 是否真的可用（嵌套沙箱等环境下 sandbox_apply 会 EPERM）。 */
function sandboxExecAvailable(): boolean {
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/bin/true"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** seedBinding 播种的 Current Execution Authority claims（gateway token 必须与之绑定）。 */
let currentAuthority: {
  runtimeRevisionId: string;
  attemptId: string;
  ownershipId: string;
  leaseEpoch: string;
  sessionBindingId: string;
} | null = null;

let catalogTool: Parameters<typeof buildCapabilityCatalogSnapshot>[0]["tools"][number] | null =
  null;

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
async function seedToolchain(
  options: {
    endpointRef?: string;
    idempotencySupport?: "none" | "header";
    timeoutMs?: number;
  } = {},
): Promise<{ toolId: string; schemaHash: string }> {
  const connectionId = randomUUID();
  await db.insert(connectionTable).values({
    id: connectionId,
    tenantId: TENANT,
    connectionKey: "test-webhook",
    connectionType: "webhook",
    endpointRef: options.endpointRef ?? "https://example.invalid/webhook",
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
    timeoutMs: options.timeoutMs ?? 1_000,
    idempotencySupport: options.idempotencySupport ?? ("header" as const),
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

/**
 * 建立 tool_call owner 的 EffectRecord（owner 多态后的测试助手）。
 * operationKey 固定为 ToolCall 唯一外部操作身份，调用方不可自定义。
 */
async function seedToolCallEffect(input: {
  toolCallId: string;
  invocationId: string;
  targetSummaryJson?: unknown;
}): Promise<Awaited<ReturnType<typeof createEffectRecord>>> {
  return createEffectRecord({
    tenantId: TENANT,
    ownerKind: "tool_call",
    ownerRef: input.toolCallId,
    invocationId: input.invocationId,
    requestDigest: computeEffectRequestDigest({ toolCall: input.toolCallId, fixture: "gateway" }),
    effectType: "update",
    targetSummaryJson: input.targetSummaryJson ?? { total: 1 },
    externalIdempotencyKey: `snow-tool:${input.toolCallId}`,
  });
}

/** 直接插入 Invocation（turn 或 job 模式）。返回 invocationId。 */
async function seedInvocation(opts: {
  threadId?: string | null;
  turnId?: string | null;
  jobId?: string | null;
}): Promise<string> {
  const invocationId = randomUUID();
  if (opts.jobId) {
    await db.insert(invocationTable).values({
      id: invocationId,
      tenantId: TENANT,
      subjectType: "job",
      jobId: opts.jobId,
      invocationSequence: 1,
      invocationKind: "job",
      executionState: "running",
      inputDigest: `sha256:${"0".repeat(64)}`,
      startedAt: new Date(),
      versionNo: 1,
    });
    return invocationId;
  }
  const threadId = opts.threadId!;
  const turnId = opts.turnId!;
  // canonical 约束：Invocation.threadId/turnId/triggerItemId 是真实外键，
  // 且 Invocation_subject_shape 要求 thread 主体 triggerItemId 非空。
  await seedThread(threadId);
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

/**
 * 直接插入不可变 ExecutionBinding（其余 digest 用占位值），
 * 并按 canonical Authority 链播种：WorkspaceBinding（NO_PLATFORM 或桌面 HOST_AFFINE）
 * → prepared InvocationAttempt → ExecutionOwnership(executing) → active RuntimeSessionBinding
 * （HOST_AFFINE 还需 active WorkspaceWriteLock + workspaceWriterGeneration）。
 * 之后 gatewayToken 必须携带同一条 authority 链的 claims。
 */
async function seedBinding(
  invocationId: string,
  frozen: {
    policyRevisionId: string;
    policyRulesDigest: string;
    toolPermissionMode?: "auto" | "ask" | "full_access";
    /** 桌面 HOST_AFFINE 场景：使用已登记的桌面 WorkspaceBinding。 */
    desktopWorkspace?: { bindingId: string; storageScopeDigest: string };
  },
): Promise<void> {
  if (!catalogTool) throw new Error("seedToolchain must run first");
  const catalog = buildCapabilityCatalogSnapshot({
    toolPermissionMode: frozen.toolPermissionMode,
    invocationId,
    preferredAgentId: null,
    agentCandidate: null,
    tools: [catalogTool],
    knowledgeSources: [],
    sourceRefs: ["test-fixture:tool-capability-catalog"],
  });
  const workspaceBindingId =
    frozen.desktopWorkspace?.bindingId ??
    (await createNoPlatformWorkspaceBinding(TENANT, "tool-gateway-test")).id;
  const runtimeRevisionId = randomUUID();
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
    runtimeRevisionId,
    deploymentRouteId: "route-fake",
    modelProvider: "provider",
    modelId: "model",
    modelRevisionRef: null,
    workspaceBindingId,
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
  const attempt = await createAttempt({ tenantId: TENANT, invocationId });
  const evidence = { kind: "test-candidate", invocationId, attemptId: attempt.id };
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
    runtimeRevisionId,
    acquiredByType: "service",
    acquiredById: "tool-gateway-test",
  });
  const session = await createRuntimeSessionBinding({
    tenantId: TENANT,
    invocationId,
    attemptId: attempt.id,
    ownershipId: acquired.ownership.id,
    runtimeRevisionId,
    leaseEpoch: acquired.ownership.leaseEpoch,
    intentType: "start",
    startIntentKey: `start:${acquired.ownership.id}`,
  });
  // canonical 约束：bindingState=active 必须冻结语义请求并携带 remote refs + startedEventId。
  await updateRuntimeSessionDispatch(TENANT, session.id, {
    bindingState: "active",
    semanticRequestJson: { kind: "tool-gateway-test" },
    semanticRequestDigest: `sha256:${"0".repeat(64)}`,
    remoteSessionRef: "tool-gateway-test-session",
    remoteExecutionRef: "tool-gateway-test-execution",
    startedEventId: randomUUID(),
  });
  // HOST_AFFINE 桌面工作区：执行前必须持有 active WorkspaceWriteLock 并回填 writer generation。
  let workspaceWriterGeneration: number | null = null;
  if (frozen.desktopWorkspace) {
    const reserved = await reserveWorkspaceWriter({
      tenantId: TENANT,
      storageScopeDigest: frozen.desktopWorkspace.storageScopeDigest,
      invocationId,
      attemptId: attempt.id,
      ownershipId: acquired.ownership.id,
      workspaceBindingId: frozen.desktopWorkspace.bindingId,
      leaseExpiresAt: new Date(Date.now() + 3600_000),
    });
    await activateWorkspaceWriter({
      tenantId: TENANT,
      lockId: reserved.lock.id,
      ownershipId: acquired.ownership.id,
      writerGeneration: reserved.writerGeneration,
      backendGrantRef: "test-desktop-grant",
      backendEvidence: {
        scopeDigest: frozen.desktopWorkspace.storageScopeDigest,
        writerGeneration: reserved.writerGeneration,
      },
    });
    workspaceWriterGeneration = reserved.writerGeneration;
  }
  await db
    .update(executionOwnershipTable)
    .set({
      executionPhase: "executing",
      activatedAt: new Date(),
      activationDigest: `sha256:${"0".repeat(64)}`,
      workspaceWriterGeneration,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(executionOwnershipTable.tenantId, TENANT),
        eq(executionOwnershipTable.id, acquired.ownership.id),
      ),
    );
  currentAuthority = {
    runtimeRevisionId,
    attemptId: attempt.id,
    ownershipId: acquired.ownership.id,
    leaseEpoch: String(acquired.ownership.leaseEpoch),
    sessionBindingId: session.id,
  };
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
    lastTurnSequence: 1,
    lastItemSequence: 1,
    lastEventSequence: 0,
    pendingQueueVersionNo: 1,
    versionNo: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
}

/** 签发 Gateway Access Token（必须绑定 seedBinding 播种的 authority claims）。 */
function gatewayToken(invocationId: string): string {
  if (!currentAuthority) throw new Error("seedBinding must run before gatewayToken");
  return issueTestExecutionToken({
    tenantId: TENANT,
    invocationId,
    audience: "gateway",
    ...currentAuthority,
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
  catalogTool = null;
  currentAuthority = null;
  process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
  process.env.SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET = SIGNING_SECRET;
  await ensureDefaultTenant();
});

afterEach(() => {
  process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
  process.env.SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET = SIGNING_SECRET;
});

describe("POST /gateway/tool-calls（02-6 P6 §14/§15/§16/§18/§55.5）", () => {
  it.runIf(process.platform === "darwin")(
    "真实桌面签名桥只执行已授权命令，持久 Attempt 防止并发重复发送",
    async (ctx) => {
      // 命令经真实 seatbelt 沙箱执行；sandbox_apply EPERM 的环境（嵌套沙箱等）
      // 无法满足"真实执行成功"断言，产品按设计 fail-closed，此处条件跳过。
      if (!sandboxExecAvailable()) {
        console.warn("[skip] sandbox-exec 在当前运行环境不可用（sandbox_apply EPERM）");
        ctx.skip();
      }
      const identity = createDeviceIdentity();
      identity.tenantId = TENANT;
      await db.insert(userIdentity).values({
        id: "test-user",
        tenantId: TENANT,
        externalSubject: "desktop-owner",
        email: "desktop-owner@example.com",
      });
      await registerDevice({
        tenantId: TENANT,
        userId: "test-user",
        deviceKey: identity.deviceId,
        publicKey: identity.keyPair.publicKeyBase64,
        deviceName: "test",
        appVersion: "1",
      });
      const workspace = await ensureDesktopWorkspace({
        tenantId: TENANT,
        userId: "test-user",
        deviceKey: identity.deviceId,
        displayName: "test",
        storageScopeDigest: `sha256:${"a".repeat(64)}`,
      });
      await registerBuiltinTools({ tenantId: TENANT, ownerUserId: "test-user" });
      const tool = (await listTools({ tenantId: TENANT })).items.find(
        (item) => item.toolKey === "shell",
      )!;
      const revision = (await getCurrentToolSchemaRevision({ tenantId: TENANT, toolId: tool.id }))!;
      const executionTarget = (await resolveToolExecutionTarget({
        tenantId: TENANT,
        threadId: "desktop-thread",
        ownerUserId: "test-user",
        workspaceBindingId: workspace.bindingId,
      }))!;
      catalogTool = {
        toolId: tool.id,
        operationId: tool.toolKey,
        schemaRevisionId: revision.id,
        schemaHash: revision.schemaHash,
        executionContractDigest: revision.executionContractDigest,
        displayName: tool.displayName,
        description: "运行命令",
        inputSchema: revision.inputSchemaJson as Record<string, unknown>,
        sideEffect: "write",
        idempotent: false,
        executionTarget,
      };
      const policy = await seedPolicy("allow", [rule({ toolPattern: "tool.shell" })]);
      const invocationId = await seedInvocation({
        threadId: "desktop-thread",
        turnId: "desktop-turn",
      });
      await seedBinding(invocationId, {
        ...policy,
        desktopWorkspace: {
          bindingId: workspace.bindingId,
          storageScopeDigest: `sha256:${"a".repeat(64)}`,
        },
      });
      const response = await POST(
        gatewayRequest(
          gatewayToken(invocationId),
          toolCallBody({
            invocation_id: invocationId,
            tool_id: tool.id,
            schema_hash: revision.schemaHash,
            arguments: { command: "date" },
          }),
        ),
      );
      expect(response.status).toBe(200);
      const claimed = (await claimNextQueuedToolCall({
        workerId: "desktop-test",
        leaseMs: 60000,
      }))!;
      await updateToolExecutionAttempt({
        tenantId: TENANT,
        attemptId: claimed.attempt.id,
        fromState: "claimed",
        toState: "dispatched",
        retryClass: "undetermined",
      });
      const nativeRoot = await realpath(await mkdtemp(join(tmpdir(), "snow-desktop-bridge-")));
      const workspaceRoot = join(nativeRoot, "project");
      await mkdir(workspaceRoot);
      const nativeDb = await openDesktopDatabase(
        join(nativeRoot, "desktop.sqlite"),
        resolve("desktop/storage/migrations"),
      );
      nativeDb.workspaceRoots.upsert({
        bindingId: workspace.bindingId,
        workspaceId: workspace.workspaceId,
        absolutePath: workspaceRoot,
        displayName: "test",
      });
      const bridge = new BridgeServer({ port: 0 });
      await bridge.start();
      setBridgeServer(bridge);
      const address = (bridge as unknown as { wss: WebSocketServer }).wss.address();
      if (!address || typeof address === "string") throw new Error("bridge port missing");
      const client = new BridgeClient({
        serverUrl: `ws://127.0.0.1:${address.port}`,
        deviceIdentity: identity,
        tenantId: TENANT,
        deviceName: "test",
        deviceVersion: "1",
        commandTarget: {} as BrowserCommandTarget,
        actionTarget: {} as BrowserActionTarget,
        workspaceRoots: nativeDb.workspaceRoots,
        aiLockManager: new AiLockManager(),
      });
      const send = vi.spyOn(bridge, "sendRpcToBoundThread");
      client.connect();
      try {
        await vi.waitFor(() => expect(client.isReady()).toBe(true), { timeout: 5000 });
        const request = {
          toolCallId: claimed.binding.toolCallId,
          attemptId: claimed.attempt.id,
        };
        const forged = await dispatchDesktopPost(
          gatewayRequest(gatewayToken(invocationId), { ...request, command: "other-command" }),
        );
        expect(forged.status).toBe(400);
        expect(send).not.toHaveBeenCalled();
        const responses = await Promise.all([
          dispatchDesktopPost(gatewayRequest(gatewayToken(invocationId), request)),
          dispatchDesktopPost(gatewayRequest(gatewayToken(invocationId), request)),
        ]);
        expect(responses.map((item) => item.status).sort()).toEqual([200, 409]);
        const success = responses.find((item) => item.status === 200)!;
        expect(await success.json()).toMatchObject({
          ok: true,
          result: {
            ok: true,
            exitCode: 0,
            workingDirectory: workspaceRoot,
            stdout: expect.stringMatching(/\S/),
          },
        });
        expect(send).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: "test-user",
            threadId: "desktop-thread",
            payload: expect.objectContaining({ command: "date", bindingId: workspace.bindingId }),
          }),
        );
      } finally {
        client.disconnect();
        await bridge.stop();
        nativeDb.close();
        await rm(nativeRoot, { recursive: true, force: true });
        setBridgeServer(null);
      }
    },
  );
  it("命令经过真实 Gateway、权限、Worker 和 Effect 链返回系统时间，重放不重复执行", async () => {
    const root = await mkdtemp(join(tmpdir(), "snow-shell-gateway-"));
    vi.stubEnv("RUNTIME_DEFAULT", "host");
    vi.stubEnv("SNOW_WORKSPACES_DIR", root);
    try {
      await registerBuiltinTools({ tenantId: TENANT, ownerUserId: "test-admin" });
      const tool = (await listTools({ tenantId: TENANT })).items.find(
        (item) => item.toolKey === "shell",
      )!;
      const revision = (await getCurrentToolSchemaRevision({ tenantId: TENANT, toolId: tool.id }))!;
      const executionTarget = (await resolveToolExecutionTarget({
        tenantId: TENANT,
        threadId: "shell-thread",
        workspaceBindingId: null,
        ownerUserId: "test-user",
      }))!;
      catalogTool = {
        toolId: tool.id,
        operationId: tool.toolKey,
        schemaRevisionId: revision.id,
        schemaHash: revision.schemaHash,
        executionContractDigest: revision.executionContractDigest,
        displayName: tool.displayName,
        description: "运行命令",
        inputSchema: revision.inputSchemaJson as Record<string, unknown>,
        sideEffect: "write",
        idempotent: false,
        executionTarget,
      };
      const policy = await seedPolicy("allow", [rule({ toolPattern: "tool.shell" })]);
      const invocationId = await seedInvocation({ threadId: "shell-thread", turnId: "shell-turn" });
      await seedBinding(invocationId, policy);
      const body = toolCallBody({
        invocation_id: invocationId,
        tool_id: tool.id,
        schema_hash: revision.schemaHash,
        arguments: { command: 'node -p "new Date().toISOString()"' },
      });
      const response = await POST(gatewayRequest(gatewayToken(invocationId), body));
      expect(response.status, JSON.stringify(await response.json())).toBe(200);
      await expect(createToolExecutionWorker().runOnce()).resolves.toBe("executed");
      const call = await singleRow(db.select().from(toolCallTable));
      expect(call).toMatchObject({
        callState: "succeeded",
        resultSummaryJson: {
          exitCode: 0,
          stdout: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          executionEnvironment: "host",
        },
      });
      expect((await POST(gatewayRequest(gatewayToken(invocationId), body))).status).toBe(200);
      await expect(createToolExecutionWorker().runOnce()).resolves.toBe("idle");
      expect(await db.select().from(toolExecutionAttemptTable)).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("无 Connection 的内置网页工具通过正式授权入队，网络未配置时确定失败并写入续跑事件", async () => {
    await registerBuiltinTools({ tenantId: TENANT, ownerUserId: "test-admin" });
    const tools = await listTools({ tenantId: TENANT });
    const tool = tools.items.find((item) => item.toolKey === "web-fetch")!;
    const revision = (await getCurrentToolSchemaRevision({ tenantId: TENANT, toolId: tool.id }))!;
    catalogTool = {
      toolId: tool.id,
      operationId: tool.toolKey,
      schemaRevisionId: revision.id,
      schemaHash: revision.schemaHash,
      executionContractDigest: revision.executionContractDigest,
      displayName: tool.displayName,
      description: "读取网页",
      inputSchema: revision.inputSchemaJson as Record<string, unknown>,
      sideEffect: "read",
      idempotent: false,
    };
    const policy = await seedPolicy("allow", []);
    const invocationId = await seedInvocation({
      threadId: "builtin-thread",
      turnId: "builtin-turn",
    });
    await seedBinding(invocationId, policy);
    const response = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({
          invocation_id: invocationId,
          tool_id: tool.id,
          schema_hash: revision.schemaHash,
          arguments: { url: "https://example.com" },
        }),
      ),
    );
    expect(response.status, JSON.stringify(await response.json())).toBe(200);
    const binding = await singleRow(db.select().from(toolExecutionBindingTable));
    expect(binding).toMatchObject({
      providerType: "builtin",
      executorKind: "builtin.web_fetch",
      authMethod: "none",
      connectionId: null,
    });
    const previous = process.env.WEB_FETCH_DOMAIN_ALLOWLIST;
    process.env.WEB_FETCH_DOMAIN_ALLOWLIST = "";
    try {
      await expect(createToolExecutionWorker().runOnce()).resolves.toBe("executed");
      const call = await singleRow(db.select().from(toolCallTable));
      expect(call).toMatchObject({ callState: "failed", errorCode: "WEB_ACCESS_NOT_CONFIGURED" });
      await expect(createToolExecutionWorker().runOnce()).resolves.toBe("idle");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "WEB_FETCH_DOMAIN_ALLOWLIST");
      else process.env.WEB_FETCH_DOMAIN_ALLOWLIST = previous;
    }
  });
  it("同一 Tool 的 actual arguments 在 canonical service 分别产生 allow/block/pause", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [
      rule({
        ruleKey: "block-secret",
        argMatcher: { pathRegex: "^secret" },
        decision: "block",
        priority: 20,
      }),
      rule({
        ruleKey: "pause-sensitive",
        argMatcher: { pathRegex: "^sensitive" },
        decision: "pause",
        priority: 10,
      }),
    ]);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
    const call = (operation_id: string, path: string) =>
      POST(
        gatewayRequest(
          gatewayToken(invocationId),
          toolCallBody({
            invocation_id: invocationId,
            tool_id: toolId,
            schema_hash: schemaHash,
            operation_id,
            arguments: { path },
          }),
        ),
      );
    const allowed = await call("op-allow", "/safe/file.txt");
    const blocked = await call("op-block", "/secret/file.txt");
    const paused = await call("op-pause", "/sensitive/file.txt");
    expect((await allowed.json()).call_state).toBe("queued");
    expect((await blocked.json()).error.code).toBe("POLICY_BLOCKED");
    expect((await paused.json()).call_state).toBe("paused");
  });

  it("allow：ToolCall→queued + immutable ToolExecutionBinding，Provider 尚未开始", async () => {
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
    expect(json.call_state).toBe("queued");
    expect(json.decision).toBe("allow");
    expect(json.decision_sequence).toBe(1);
    expect(json.schema_revision_id).toBeTruthy();
    expect(json.tool_call_id).toBeTruthy();

    const tc = await singleRow(
      db.select().from(toolCallTable).where(eq(toolCallTable.id, json.tool_call_id)),
    );
    expect(tc.callState).toBe("queued");
    expect(tc.startedAt).toBeNull();
    const [executionBinding] = await db
      .select()
      .from(toolExecutionBindingTable)
      .where(eq(toolExecutionBindingTable.toolCallId, tc.id));
    expect(executionBinding).toMatchObject({
      providerType: "webhook",
      executorKind: "webhook.post_json",
      credentialRefId: null,
    });
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
    expect(uars[0]!.itemId).toBeTruthy();
    const projected = await singleRow(
      db.select().from(threadItemTable).where(eq(threadItemTable.id, uars[0]!.itemId!)),
    );
    expect(projected.itemType).toBe("user_action");
    expect(projected.contentJson).toMatchObject({
      request_id: uars[0]!.id,
      request_type: "confirmation",
      state: "pending",
    });
    const events = await db
      .select()
      .from(threadEventTable)
      .where(eq(threadEventTable.itemId, projected.id))
      .orderBy(asc(threadEventTable.eventSequence));
    expect(events.map((e) => e.eventType)).toEqual(["item.created", "user_action.requested"]);

    const inv = await singleRow(
      db.select().from(invocationTable).where(eq(invocationTable.id, invocationId)),
    );
    expect(inv.executionState).toBe("waiting_user");
    const turn = await singleRow(db.select().from(turnTable).where(eq(turnTable.id, "turn-1")));
    expect(turn.turnState).toBe("waiting_user");
    expect(turn.activeInvocationId).toBe(invocationId);
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

  it("幂等摘要使用规范 JSON：对象键顺序不同仍重放同一 ToolCall", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });

    const base = {
      invocation_id: invocationId,
      tool_id: toolId,
      schema_hash: schemaHash,
    };
    const first = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({ ...base, arguments: { path: "/tmp/foo.txt", mode: "append" } }),
      ),
    );
    const second = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({ ...base, arguments: { mode: "append", path: "/tmp/foo.txt" } }),
      ),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json()).tool_call_id).toBe((await second.json()).tool_call_id);
    expect(await db.select().from(toolCallTable)).toHaveLength(1);
  });

  it("模型 arguments 夹带 credential 字段时 fail-closed，且不创建 ToolCall", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });

    const response = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({
          invocation_id: invocationId,
          tool_id: toolId,
          schema_hash: schemaHash,
          arguments: { path: "/tmp/foo.txt", token: "must-not-be-forwarded" },
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error?.code).toBe("REQUEST_SCHEMA_INVALID");
    expect(await db.select().from(toolCallTable)).toHaveLength(0);
  });

  it("queued → worker → real webhook → Effect confirmed → terminal → durable continuation", async () => {
    let sideEffects = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        sideEffects += 1;
        response.writeHead(200, {
          "content-type": "application/json",
          "x-request-id": "provider-1",
        });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address missing");
      const { toolId, schemaHash } = await seedToolchain({
        endpointRef: `http://127.0.0.1:${address.port}/effect`,
      });
      const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
      const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
      await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
      const response = await POST(
        gatewayRequest(
          gatewayToken(invocationId),
          toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
        ),
      );
      const body = await response.json();
      expect(body.call_state).toBe("queued");
      const worker = createToolExecutionWorker({
        workerId: "tool-worker-test",
        allowLoopbackHttp: true,
      });
      await expect(worker.runOnce()).resolves.toBe("executed");
      await expect(worker.runOnce()).resolves.toBe("idle");
      expect(sideEffects).toBe(1);
      const [toolCall] = await db
        .select()
        .from(toolCallTable)
        .where(eq(toolCallTable.id, body.tool_call_id));
      expect(toolCall?.callState).toBe("succeeded");
      expect(toolCall?.startedAt).not.toBeNull();
      const [attempt] = await db
        .select()
        .from(toolExecutionAttemptTable)
        .where(eq(toolExecutionAttemptTable.toolCallId, body.tool_call_id));
      expect(attempt).toMatchObject({ attemptNo: 1, attemptState: "succeeded" });
      const [effect] = await db
        .select()
        .from(effectRecordTable)
        .where(eq(effectRecordTable.ownerRef, body.tool_call_id));
      expect(effect?.effectState).toBe("confirmed_success");
      const continuations = await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(eq(controlPlaneOutboxEvent.aggregateId, body.tool_call_id));
      expect(continuations).toHaveLength(1);
      expect(continuations[0]?.eventType).toBe("tool_call.continuation.requested");
      const terminalReplay = await POST(
        gatewayRequest(
          gatewayToken(invocationId),
          toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
        ),
      );
      expect(await terminalReplay.json()).toMatchObject({
        call_state: "succeeded",
        result: { ok: true },
        effect: { effect_state: "confirmed_success" },
      });
      let resumedInvocationId: string | null = null;
      const continuationHandler = createInvocationContinuationHandler({
        getAgentCall: async () => null,
        coordinateWaitingUser: async () => undefined,
        resumeParent: async () => undefined,
        resumeAfterAgentResponse: async () => undefined,
        resumeAgentFromUserAction: async () => undefined,
        getToolCall: async ({ tenantId, toolCallId }) => {
          const [row] = await db
            .select()
            .from(toolCallTable)
            .where(and(eq(toolCallTable.tenantId, tenantId), eq(toolCallTable.id, toolCallId)))
            .limit(1);
          return row ?? null;
        },
        resumeToolParent: async ({ invocationId: resumed }) => {
          resumedInvocationId = resumed;
        },
      });
      await continuationHandler(continuations[0]!);
      expect(resumedInvocationId).toBe(invocationId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("webhook 4xx → Attempt/Effect/ToolCall 确定失败并创建 continuation", async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => response.writeHead(422).end("invalid"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address missing");
      const { toolId, schemaHash } = await seedToolchain({
        endpointRef: `http://127.0.0.1:${address.port}/effect`,
      });
      const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
      const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
      await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
      const response = await POST(
        gatewayRequest(
          gatewayToken(invocationId),
          toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
        ),
      );
      const body = await response.json();
      const worker = createToolExecutionWorker({
        workerId: "permanent-failure-worker",
        allowLoopbackHttp: true,
      });
      await expect(worker.runOnce()).resolves.toBe("executed");
      const [toolCall] = await db
        .select()
        .from(toolCallTable)
        .where(eq(toolCallTable.id, body.tool_call_id));
      const [attempt] = await db
        .select()
        .from(toolExecutionAttemptTable)
        .where(eq(toolExecutionAttemptTable.toolCallId, body.tool_call_id));
      const [effect] = await db
        .select()
        .from(effectRecordTable)
        .where(eq(effectRecordTable.ownerRef, body.tool_call_id));
      expect(toolCall).toMatchObject({ callState: "failed", errorCode: "PROVIDER_HTTP_422" });
      expect(attempt).toMatchObject({ attemptState: "failed", retryClass: "permanent" });
      expect(effect?.effectState).toBe("confirmed_failure");
      expect(
        await db
          .select()
          .from(controlPlaneOutboxEvent)
          .where(eq(controlPlaneOutboxEvent.aggregateId, body.tool_call_id)),
      ).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("Provider 已产生外部副作用后 worker 崩溃：恢复为 unknown_effect，绝不二次发送", async () => {
    let sideEffects = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        sideEffects += 1;
        response.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address missing");
      const endpoint = `http://127.0.0.1:${address.port}/effect`;
      const { toolId, schemaHash } = await seedToolchain({ endpointRef: endpoint });
      const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
      const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
      await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
      const response = await POST(
        gatewayRequest(
          gatewayToken(invocationId),
          toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
        ),
      );
      const body = await response.json();
      const claimed = await claimNextQueuedToolCall({
        workerId: "crashing-worker",
        leaseMs: 60_000,
      });
      if (!claimed) throw new Error("claim missing");
      const effect = await seedToolCallEffect({
        toolCallId: body.tool_call_id,
        invocationId,
      });
      await createEffectTargets({
        tenantId: TENANT,
        effectRecordId: effect.id,
        targets: [{ targetRef: `tool-call:${body.tool_call_id}` }],
      });
      await updateToolExecutionAttempt({
        tenantId: TENANT,
        attemptId: claimed.attempt.id,
        fromState: "claimed",
        toState: "dispatched",
        externalIdempotencyKey: `snow-tool:${body.tool_call_id}`,
        retryClass: "undetermined",
      });
      await fetch(endpoint, { method: "POST", body: "{}" });
      await db
        .update(toolExecutionAttemptTable)
        .set({ claimExpiresAt: new Date(0) })
        .where(eq(toolExecutionAttemptTable.id, claimed.attempt.id));
      const worker = createToolExecutionWorker({
        workerId: "recovery-worker",
        allowLoopbackHttp: true,
      });
      await expect(worker.runOnce()).resolves.toBe("recovered");
      await expect(worker.runOnce()).resolves.toBe("idle");
      expect(sideEffects).toBe(1);
      const [toolCall] = await db
        .select()
        .from(toolCallTable)
        .where(eq(toolCallTable.id, body.tool_call_id));
      expect(toolCall?.callState).toBe("unknown_effect");
      const [recoveredEffect] = await db
        .select()
        .from(effectRecordTable)
        .where(eq(effectRecordTable.id, effect.id));
      expect(recoveredEffect?.effectState).toBe("unknown_effect");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("Effect/ToolCall/Attempt 已提交但 worker 崩溃：补发 continuation 且不重放 Provider", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
    const response = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
      ),
    );
    const body = await response.json();
    const claimed = await claimNextQueuedToolCall({ workerId: "terminal-crash", leaseMs: 60_000 });
    if (!claimed) throw new Error("claim missing");
    const effect = await seedToolCallEffect({
      toolCallId: body.tool_call_id,
      invocationId,
    });
    const [target] = await createEffectTargets({
      tenantId: TENANT,
      effectRecordId: effect.id,
      targets: [{ targetRef: `tool-call:${body.tool_call_id}` }],
    });
    await updateToolExecutionAttempt({
      tenantId: TENANT,
      attemptId: claimed.attempt.id,
      fromState: "claimed",
      toState: "dispatched",
      externalIdempotencyKey: `snow-tool:${body.tool_call_id}`,
      retryClass: "undetermined",
    });
    await reconcileEffect({
      tenantId: TENANT,
      effectRecordId: effect.id,
      path: "gateway",
      verificationMethod: "provider_query",
      expectedOperationId: "op-1",
      targetUpdates: [{ targetHash: target!.targetHash, targetState: "confirmed_success" }],
      externalResultRef: "provider-success-before-crash",
      resultSummaryJson: { ok: true },
    });
    await updateToolExecutionAttempt({
      tenantId: TENANT,
      attemptId: claimed.attempt.id,
      fromState: "dispatched",
      toState: "succeeded",
      externalIdempotencyKey: `snow-tool:${body.tool_call_id}`,
      providerRequestRef: "provider-success-before-crash",
      retryClass: "none",
      finished: true,
    });

    const worker = createToolExecutionWorker({ workerId: "terminal-recovery" });
    await expect(worker.runOnce()).resolves.toBe("recovered");
    await expect(worker.runOnce()).resolves.toBe("idle");
    const [attempt] = await db
      .select()
      .from(toolExecutionAttemptTable)
      .where(eq(toolExecutionAttemptTable.id, claimed.attempt.id));
    expect(attempt?.attemptState).toBe("succeeded");
    const continuations = await db
      .select()
      .from(controlPlaneOutboxEvent)
      .where(eq(controlPlaneOutboxEvent.aggregateId, body.tool_call_id));
    expect(continuations).toHaveLength(1);
  });

  it("worker 在 dispatch 前崩溃：过期 claim 安全回队并只执行一次", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address missing");
      const { toolId, schemaHash } = await seedToolchain({
        endpointRef: `http://127.0.0.1:${address.port}/effect`,
      });
      const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
      const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
      await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
      const response = await POST(
        gatewayRequest(
          gatewayToken(invocationId),
          toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
        ),
      );
      expect((await response.json()).call_state).toBe("queued");
      expect(
        await claimNextQueuedToolCall({
          workerId: "lost-before-dispatch",
          leaseMs: 1,
          now: new Date(0),
        }),
      ).not.toBeNull();
      const worker = createToolExecutionWorker({
        workerId: "replacement-worker",
        allowLoopbackHttp: true,
      });
      await expect(worker.runOnce()).resolves.toBe("recovered");
      await expect(worker.runOnce()).resolves.toBe("executed");
      await expect(worker.runOnce()).resolves.toBe("idle");
      expect(requests).toBe(1);
      const attempts = await db
        .select()
        .from(toolExecutionAttemptTable)
        .orderBy(asc(toolExecutionAttemptTable.attemptNo));
      expect(attempts.map((attempt) => attempt.attemptState)).toEqual(["failed", "succeeded"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("无外部幂等保障的 write webhook 超时后进入 unknown_effect 且不自动重放", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        setTimeout(() => response.writeHead(200).end("{}"), 250);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address missing");
      const { toolId, schemaHash } = await seedToolchain({
        endpointRef: `http://127.0.0.1:${address.port}/effect`,
        idempotencySupport: "none",
        timeoutMs: 100,
      });
      const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
      const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
      await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
      const response = await POST(
        gatewayRequest(
          gatewayToken(invocationId),
          toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
        ),
      );
      const body = await response.json();
      const worker = createToolExecutionWorker({
        workerId: "timeout-worker",
        allowLoopbackHttp: true,
      });
      await expect(worker.runOnce()).resolves.toBe("executed");
      await expect(worker.runOnce()).resolves.toBe("idle");
      expect(requests).toBe(1);
      const [toolCall] = await db
        .select()
        .from(toolCallTable)
        .where(eq(toolCallTable.id, body.tool_call_id));
      expect(toolCall?.callState).toBe("unknown_effect");
      const [effect] = await db
        .select()
        .from(effectRecordTable)
        .where(eq(effectRecordTable.ownerRef, body.tool_call_id));
      expect(effect?.effectState).toBe("unknown_effect");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("有外部幂等键的 5xx 可安全重试并沿用同一 key", async () => {
    const keys: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      keys.push(request.headers["idempotency-key"] as string | undefined);
      request.resume();
      request.on("end", () => {
        if (keys.length === 1) response.writeHead(503).end("retry");
        else response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address missing");
      const { toolId, schemaHash } = await seedToolchain({
        endpointRef: `http://127.0.0.1:${address.port}/effect`,
      });
      const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
      const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
      await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
      const response = await POST(
        gatewayRequest(
          gatewayToken(invocationId),
          toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
        ),
      );
      const body = await response.json();
      const worker = createToolExecutionWorker({
        workerId: "retry-worker",
        allowLoopbackHttp: true,
      });
      await expect(worker.runOnce()).resolves.toBe("executed");
      await expect(worker.runOnce()).resolves.toBe("executed");
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
      const attempts = await db
        .select()
        .from(toolExecutionAttemptTable)
        .where(eq(toolExecutionAttemptTable.toolCallId, body.tool_call_id))
        .orderBy(asc(toolExecutionAttemptTable.attemptNo));
      expect(attempts.map((attempt) => attempt.attemptState)).toEqual(["failed", "succeeded"]);
      expect(attempts[0]?.externalIdempotencyKey).toBe(attempts[1]?.externalIdempotencyKey);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("Effect confirmed_partial 不得把 ToolCall 伪装为 succeeded", async () => {
    const { toolId, schemaHash } = await seedToolchain();
    const { policyRevisionId, policyRulesDigest } = await seedPolicy("allow", [rule({})]);
    const invocationId = await seedInvocation({ threadId: "t-1", turnId: "turn-1" });
    await seedBinding(invocationId, { policyRevisionId, policyRulesDigest });
    const response = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({ invocation_id: invocationId, tool_id: toolId, schema_hash: schemaHash }),
      ),
    );
    const body = await response.json();
    await claimNextQueuedToolCall({ workerId: "partial-test", leaseMs: 60_000 });
    const effect = await seedToolCallEffect({
      toolCallId: body.tool_call_id,
      invocationId,
      targetSummaryJson: { total: 2 },
    });
    const targets = await createEffectTargets({
      tenantId: TENANT,
      effectRecordId: effect.id,
      targets: [{ targetRef: "target:one" }, { targetRef: "target:two" }],
    });
    const reconciled = await reconcileEffect({
      tenantId: TENANT,
      effectRecordId: effect.id,
      path: "gateway",
      verificationMethod: "provider_query",
      expectedOperationId: "op-1",
      targetUpdates: [
        { targetHash: targets[0]!.targetHash, targetState: "confirmed_success" },
        { targetHash: targets[1]!.targetHash, targetState: "confirmed_failure" },
      ],
    });
    expect(reconciled.effectRecord.effectState).toBe("confirmed_partial");
    expect(reconciled.toolCall?.callState).toBe("unknown_effect");
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

describe("POST /gateway/tool-calls Pause/Resume（02-6 P7 §20/§45/§55.6/§55.7）", () => {
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
    return resolveGenericUserAction({
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

  it("approve：同一 ToolCall 追加 allow 后进入 queued，等待 durable worker", async () => {
    const { toolCallId, userActionRequestId, invocationId, toolId, schemaHash } = await pauseTurn();
    const resolved = await approve(userActionRequestId);
    expect(resolved.resumeCommand.payloadJson).toMatchObject({
      resume_source: "user_action_resolution",
      resume_payload: { request_id: userActionRequestId, resolution: "approve" },
    });

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
    expect(json.call_state).toBe("queued");

    const decisions = await getDecisions(toolCallId);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.decision).toBe("pause");
    expect(decisions[1]!.decision).toBe("allow");
    expect(decisions[1]!.policyRevisionId).toBe(decisions[0]!.policyRevisionId);
    expect(decisions[1]!.decidedBy).toBe("user_action");
    expect(decisions[1]!.reasonCodesJson).toContain("USER_APPROVED");

    const tc = await singleRow(
      db.select().from(toolCallTable).where(eq(toolCallTable.id, toolCallId)),
    );
    expect(tc.callState).toBe("queued");

    // worker 尚未领取时再提交 → queued 重放，不新增决策或执行绑定。
    const res2 = await POST(gatewayRequest(gatewayToken(invocationId), body));
    expect(res2.status).toBe(200);
    const j2 = await res2.json();
    expect(j2.call_state).toBe("queued");
    const decisions2 = await getDecisions(toolCallId);
    expect(decisions2).toHaveLength(2);
    expect(
      await db
        .select()
        .from(toolExecutionBindingTable)
        .where(eq(toolExecutionBindingTable.toolCallId, toolCallId)),
    ).toHaveLength(1);
  });

  it("deny：ToolCall→cancelled + errorCode=USER_DENIED，不生成 Grant（§20.3/§45）", async () => {
    const { toolCallId, userActionRequestId } = await pauseTurn();
    await resolveGenericUserAction({
      tenantId: TENANT,
      requestId: userActionRequestId,
      resolution: "deny",
      userNote: "不要写入文件，先解释方案",
      resolvedBy: "user-1",
      actorType: "user",
      actorId: "user-1",
    });

    const tc = await singleRow(
      db.select().from(toolCallTable).where(eq(toolCallTable.id, toolCallId)),
    );
    expect(tc.callState).toBe("cancelled");
    expect(tc.errorCode).toBe("USER_DENIED");
    expect(await createToolExecutionWorker().runOnce()).toBe("idle");
    const [guidance] = await db
      .select()
      .from(threadItemTable)
      .where(eq(threadItemTable.itemType, "user_guidance"));
    expect(guidance?.contentJson).toMatchObject({ text: "不要写入文件，先解释方案" });
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

it.each(["auto", "ask", "full_access"] as const)(
  "冻结 %s 模式决定网页工具是否询问，模型参数不能覆盖",
  async (mode) => {
    await registerBuiltinTools({ tenantId: TENANT, ownerUserId: "test-admin" });
    const tools = await listTools({ tenantId: TENANT });
    const tool = tools.items.find((item) => item.toolKey === "web-fetch")!;
    const revision = (await getCurrentToolSchemaRevision({ tenantId: TENANT, toolId: tool.id }))!;
    catalogTool = {
      toolId: tool.id,
      operationId: tool.toolKey,
      schemaRevisionId: revision.id,
      schemaHash: revision.schemaHash,
      executionContractDigest: revision.executionContractDigest,
      displayName: tool.displayName,
      description: "读取网页",
      inputSchema: revision.inputSchemaJson as Record<string, unknown>,
      sideEffect: "read",
      idempotent: false,
    };
    const policy = await seedPolicy("pause", []);
    const invocationId = await seedInvocation({ threadId: "mode-thread", turnId: "mode-turn" });
    await seedBinding(invocationId, { ...policy, toolPermissionMode: mode });
    // 当前 Thread 偏好与冻结模式相反，执行仍遵从冻结值。
    await db
      .update(threadTable)
      .set({ toolPermissionMode: mode === "ask" ? "full_access" : "ask" })
      .where(eq(threadTable.id, "mode-thread"));
    const response = await POST(
      gatewayRequest(
        gatewayToken(invocationId),
        toolCallBody({
          invocation_id: invocationId,
          tool_id: tool.id,
          tool_schema_revision_id: revision.id,
          schema_hash: revision.schemaHash,
          arguments: { url: "https://example.com" },
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).call_state).toBe(mode === "ask" ? "paused" : "queued");
    expect(await db.select().from(userActionRequestTable)).toHaveLength(mode === "ask" ? 1 : 0);
  },
);
