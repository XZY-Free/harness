/**
 * S13-C03 policy 域迁移转换器集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - PolicyConfig 转换器：正常迁移（V11PolicySet + V11PolicyRevision）、key 为空异常
 * - PolicyConfigHistory 转换器：正常迁移为 AuditEvent（only changedKeys + hash）
 * - ToolPermissionRule 转换器：正常迁移（V11PermissionDecision + V11Policy）、decision 映射、scope 无法映射异常
 * - ToolApprovalRequest 转换器：正常迁移（V11UserActionRequest + V11PermissionDecision）、threadId/toolRunId 不存在异常、status 映射
 * - 端到端 policy 域迁移：4 张表顺序执行
 * - 幂等性：二次运行跳过已迁移记录
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import {
  policyConfig as PolicyConfig,
  policyConfigHistory as PolicyConfigHistory,
  thread as Thread,
  toolApprovalRequest as ToolApprovalRequest,
  toolPermissionRule as ToolPermissionRule,
  toolRun as ToolRun,
  user as User,
} from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { createExecutionRunner } from "@/lib/v11/migration/migration-runner";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { InMemoryMigrationStateStore } from "@/lib/v11/migration/migration-state";
import { createPolicyTransformers } from "@/lib/v11/migration/transformers/policy";
import { getV11TableRegistry } from "@/lib/v11/migration/v11-table-registry";
import { auditEvent as AuditEvent } from "@/lib/v11/schema/audit";
import {
  v11PermissionDecision,
  v11Policy,
  v11PolicyRevision,
  v11PolicySet,
} from "@/lib/v11/schema/permission";
import { v11UserActionRequest } from "@/lib/v11/schema/user-action-request";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

/** 设置 User + Thread + ToolRun，返回各 id。 */
async function setupThreadAndToolRun(
  userId: string,
  threadId: string,
  toolRunId: string,
  runId?: string,
): Promise<void> {
  await db.insert(User).values({
    id: userId,
    externalId: `ext-${userId}`,
    email: `${userId}@example.com`,
    name: userId,
  });
  await db.insert(Thread).values({
    id: threadId,
    title: `策略测试-${threadId}`,
    userId,
    status: "idle",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-02T00:00:00Z"),
  });
  await db.insert(ToolRun).values({
    id: toolRunId,
    threadId,
    toolName: "writeFile",
    status: "succeeded",
    input: { path: "/tmp/test.txt" },
    output: { ok: true },
    startedAt: new Date("2024-01-01T00:10:00Z"),
    finishedAt: new Date("2024-01-01T00:10:30Z"),
    runId: runId ?? null,
  });
}

// ═══════════════════════════════════════════════════════════
// 1. PolicyConfig 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 PolicyConfig 转换器", () => {
  it("正常 PolicyConfig 迁移为 V11PolicySet + V11PolicyRevision", async () => {
    const policyValue = { protectedPaths: ["/tmp/protected"] };
    await db.insert(PolicyConfig).values({
      key: "protectedPaths",
      value: policyValue,
      updatedAt: new Date("2024-02-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("policy");

    const configTable = result.tables.find((t) => t.sourceTable === "PolicyConfig");
    expect(configTable?.sourceCount).toBe(1);
    expect(configTable?.targetCount).toBe(2); // V11PolicySet + V11PolicyRevision
    expect(configTable?.anomalyCount).toBe(0);

    // 验证 V11PolicySet 写入
    const [policySet] = await db
      .select()
      .from(v11PolicySet)
      .where(eq(v11PolicySet.policySetKey, "protectedPaths"))
      .limit(1);
    expect(policySet).toBeDefined();
    expect(policySet?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(policySet?.lifecycleState).toBe("enabled");
    expect(policySet?.versionNo).toBe(1);
    expect(policySet?.currentRevisionId).not.toBeNull();

    // 验证 V11PolicyRevision 写入
    expect(policySet).toBeDefined();
    const policySetId = policySet?.id;
    expect(policySetId).toBeDefined();
    const [revision] = await db
      .select()
      .from(v11PolicyRevision)
      .where(eq(v11PolicyRevision.policySetId, policySetId as string))
      .limit(1);
    expect(revision).toBeDefined();
    expect(revision?.revisionNo).toBe(1);
    expect(revision?.revisionJson).toEqual(policyValue);
    expect(revision?.rulesHash).toMatch(/^sha256:/);
    expect(revision?.revisionState).toBe("published");
    expect(revision?.createdBy).toBe("legacy-migration");

    // currentRevisionId 应指向刚创建的 revision
    expect(policySet?.currentRevisionId).toBe(revision?.id);
  });

  it("key 为空时入异常队列", async () => {
    // 直接调用转换器验证防御逻辑（DB 主键约束阻止插入空 key）
    const transformers = createPolicyTransformers();
    const transformer = transformers.get("PolicyConfig");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      key: "",
      value: { foo: "bar" },
      updatedAt: "2024-01-01 00:00:00",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("PolicyConfig.key 为空");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. PolicyConfigHistory 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 PolicyConfigHistory 转换器", () => {
  it("正常 PolicyConfigHistory 迁移为 AuditEvent（只保留 changedKeys + hash）", async () => {
    const beforeSnapshot = JSON.stringify({ protectedPaths: ["/old"] });
    const afterSnapshot = JSON.stringify({ protectedPaths: ["/new", "/tmp"] });
    const changedKeys = JSON.stringify(["protectedPaths"]);

    await db.insert(PolicyConfigHistory).values({
      changedBy: "user-history-001",
      beforeSnapshot,
      afterSnapshot,
      changedKeys,
      changedAt: new Date("2024-03-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("policy");

    const historyTable = result.tables.find((t) => t.sourceTable === "PolicyConfigHistory");
    expect(historyTable?.sourceCount).toBe(1);
    expect(historyTable?.targetCount).toBe(1); // AuditEvent
    expect(historyTable?.anomalyCount).toBe(0);

    // 验证 AuditEvent 写入
    const [audit] = await db
      .select()
      .from(AuditEvent)
      .where(eq(AuditEvent.actorId, "user-history-001"))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(audit?.actorType).toBe("user");
    expect(audit?.actionType).toBe("policy.publish");
    expect(audit?.targetType).toBe("policy");
    // AuditEvent.beforeHash/afterHash 为 varchar(64)，仅存 sha256 hex（无前缀）
    expect(audit?.beforeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(audit?.afterHash).toMatch(/^[a-f0-9]{64}$/);
    // beforeHash 和 afterHash 不同（快照内容不同）
    expect(audit?.beforeHash).not.toBe(audit?.afterHash);
    // reason 保存 changedKeys
    expect(audit?.reason).toBe(changedKeys);
    expect(audit?.requestId).toBe("legacy-migration");
  });
});

// ═══════════════════════════════════════════════════════════
// 3. ToolPermissionRule 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 ToolPermissionRule 转换器", () => {
  it("正常 ToolPermissionRule 迁移为 V11PermissionDecision + V11Policy（首条规则创建占位策略集）", async () => {
    await db.insert(ToolPermissionRule).values({
      id: "rule-001",
      scope: "global",
      scopeRef: null,
      toolPattern: "tool.writeFile",
      argMatcher: { pathRegex: "^/tmp/.*" },
      decision: "allow",
      reason: "允许写临时目录",
      priority: 10,
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("policy");

    const ruleTable = result.tables.find((t) => t.sourceTable === "ToolPermissionRule");
    expect(ruleTable?.sourceCount).toBe(1);
    // 首条规则：V11PolicySet + V11PolicyRevision + V11Policy + V11PermissionDecision = 4
    expect(ruleTable?.targetCount).toBe(4);
    expect(ruleTable?.anomalyCount).toBe(0);

    // 验证占位 V11PolicySet 创建
    const [legacySet] = await db
      .select()
      .from(v11PolicySet)
      .where(eq(v11PolicySet.policySetKey, "legacy-tool-permission-rules"))
      .limit(1);
    expect(legacySet).toBeDefined();
    expect(legacySet?.lifecycleState).toBe("enabled");

    // 验证 V11Policy 写入
    const [policy] = await db.select().from(v11Policy).where(eq(v11Policy.id, "rule-001")).limit(1);
    expect(policy).toBeDefined();
    expect(policy?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(policy?.policySetId).toBe(legacySet?.id);
    expect(policy?.toolPattern).toBe("tool.writeFile");
    expect(policy?.decision).toBe("allow");
    expect(policy?.scopeJson).toEqual({ type: "tenant" });
    expect(policy?.reason).toBe("允许写临时目录");
    expect(policy?.priority).toBe(10);

    // 验证 V11PermissionDecision 写入
    const [decision] = await db
      .select()
      .from(v11PermissionDecision)
      .where(eq(v11PermissionDecision.toolCallId, "legacy-policy-rule-rule-001"))
      .limit(1);
    expect(decision).toBeDefined();
    expect(decision?.decision).toBe("allow");
    expect(decision?.decidedBy).toBe("policy_engine");
  });

  it("decision=deny 映射为 block", async () => {
    await db.insert(ToolPermissionRule).values({
      id: "rule-deny-001",
      scope: "global",
      toolPattern: "tool.deleteFile",
      decision: "deny",
      reason: "禁止删除",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("policy");

    const [policy] = await db
      .select()
      .from(v11Policy)
      .where(eq(v11Policy.id, "rule-deny-001"))
      .limit(1);
    expect(policy?.decision).toBe("block");
  });

  it("decision=ask 映射为 pause", async () => {
    await db.insert(ToolPermissionRule).values({
      id: "rule-ask-001",
      scope: "global",
      toolPattern: "tool.applyPatch",
      decision: "ask",
      reason: "需要确认",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("policy");

    const [policy] = await db
      .select()
      .from(v11Policy)
      .where(eq(v11Policy.id, "rule-ask-001"))
      .limit(1);
    expect(policy?.decision).toBe("pause");
  });

  it("scope=project 无法映射时入异常队列", async () => {
    await db.insert(ToolPermissionRule).values({
      id: "rule-project-001",
      scope: "project",
      scopeRef: "proj-001",
      toolPattern: "tool.writeFile",
      decision: "allow",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("policy");

    const ruleTable = result.tables.find((t) => t.sourceTable === "ToolPermissionRule");
    expect(ruleTable?.anomalyCount).toBe(1);
    expect(ruleTable?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("ToolPermissionRule");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain('scope "project" 无法映射');
  });

  it("scope=thread 且 scopeRef 为空时入异常队列", async () => {
    await db.insert(ToolPermissionRule).values({
      id: "rule-thread-noref-001",
      scope: "thread",
      scopeRef: null,
      toolPattern: "tool.writeFile",
      decision: "allow",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("policy");

    const ruleTable = result.tables.find((t) => t.sourceTable === "ToolPermissionRule");
    expect(ruleTable?.anomalyCount).toBe(1);

    const anomalies = store.getAnomalies("ToolPermissionRule");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain('scope "thread" 无法映射');
  });

  it("scope=thread 且 scopeRef 非空时正确映射 scopeJson", async () => {
    await db.insert(ToolPermissionRule).values({
      id: "rule-thread-001",
      scope: "thread",
      scopeRef: "thread-target-001",
      toolPattern: "tool.readFile",
      decision: "allow",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("policy");

    const [policy] = await db
      .select()
      .from(v11Policy)
      .where(eq(v11Policy.id, "rule-thread-001"))
      .limit(1);
    expect(policy?.scopeJson).toEqual({ type: "thread", ref: "thread-target-001" });
  });

  it("多条规则共用占位策略集（第二条不重复创建）", async () => {
    await db.insert(ToolPermissionRule).values({
      id: "rule-multi-001",
      scope: "global",
      toolPattern: "tool.writeFile",
      decision: "allow",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });
    await db.insert(ToolPermissionRule).values({
      id: "rule-multi-002",
      scope: "global",
      toolPattern: "tool.deleteFile",
      decision: "deny",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("policy");

    // 只有一个占位策略集
    const legacySets = await db
      .select()
      .from(v11PolicySet)
      .where(eq(v11PolicySet.policySetKey, "legacy-tool-permission-rules"));
    expect(legacySets.length).toBe(1);

    // 两条 V11Policy
    const policies = await db.select().from(v11Policy);
    expect(policies.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. ToolApprovalRequest 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 ToolApprovalRequest 转换器", () => {
  it("正常 ToolApprovalRequest 迁移为 V11UserActionRequest + V11PermissionDecision", async () => {
    const userId = "user-approval-001";
    const threadId = "thread-approval-001";
    const toolRunId = "toolrun-approval-001";
    const runId = "run-approval-001";
    await setupThreadAndToolRun(userId, threadId, toolRunId, runId);

    await db.insert(ToolApprovalRequest).values({
      id: "approval-001",
      threadId,
      toolRunId,
      toolName: "writeFile",
      permissionKey: "tool.writeFile:/tmp/secret",
      argFingerprint: "fp-001",
      argSummary: "writeFile /tmp/secret",
      status: "approved",
      approvedScope: "once",
      resolvedBy: userId,
      resolvedAt: new Date("2024-05-01T00:05:00Z"),
      createdAt: new Date("2024-05-01T00:00:00Z"),
      expiresAt: new Date("2024-05-01T01:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("policy");

    const approvalTable = result.tables.find((t) => t.sourceTable === "ToolApprovalRequest");
    expect(approvalTable?.sourceCount).toBe(1);
    expect(approvalTable?.targetCount).toBe(2); // V11UserActionRequest + V11PermissionDecision
    expect(approvalTable?.anomalyCount).toBe(0);

    // 验证 V11UserActionRequest 写入
    const [request] = await db
      .select()
      .from(v11UserActionRequest)
      .where(eq(v11UserActionRequest.id, "approval-001"))
      .limit(1);
    expect(request).toBeDefined();
    expect(request?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(request?.threadId).toBe(threadId);
    expect(request?.toolCallId).toBe(toolRunId);
    expect(request?.invocationId).toBe(runId);
    expect(request?.requestType).toBe("confirmation");
    expect(request?.purpose).toBe("tool_confirm");
    expect(request?.requestState).toBe("resolved");
    expect(request?.resolution).toBe("approve");
    expect(request?.resolvedBy).toBe(userId);
    expect(request?.versionNo).toBe(1);

    // 验证 V11PermissionDecision 写入
    const [decision] = await db
      .select()
      .from(v11PermissionDecision)
      .where(eq(v11PermissionDecision.toolCallId, toolRunId))
      .limit(1);
    expect(decision).toBeDefined();
    expect(decision?.decision).toBe("allow");
    expect(decision?.decidedBy).toBe(userId);
    // approvedScope → decisionScope 存入 riskSummaryJson
    expect(decision?.riskSummaryJson).toEqual({ decisionScope: "once" });
  });

  it("threadId 不存在时入异常队列", async () => {
    // FK 约束阻止直接插入孤儿 ToolApprovalRequest，直接调用转换器验证防御逻辑
    const transformers = createPolicyTransformers();
    const transformer = transformers.get("ToolApprovalRequest");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    // 先插入一个 ToolRun（FK 允许 threadId 存在的情况），但这里测试 threadId 不存在
    // 直接调用转换器：不经过 DB FK 约束
    const result = await transformer({
      id: "approval-orphan-thread",
      threadId: "nonexistent-thread",
      toolRunId: "nonexistent-toolrun",
      toolName: "writeFile",
      permissionKey: "tool.writeFile",
      argFingerprint: "fp",
      argSummary: "summary",
      status: "pending",
      createdAt: "2024-01-01 00:00:00",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("Thread nonexistent-thread 不存在");
  });

  it("toolRunId 不存在时入异常队列", async () => {
    const userId = "user-approval-notoolrun";
    const threadId = "thread-approval-notoolrun";
    await db.insert(User).values({
      id: userId,
      externalId: `ext-${userId}`,
      email: `${userId}@example.com`,
    });
    await db.insert(Thread).values({
      id: threadId,
      title: "无 ToolRun 测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 直接调用转换器：Thread 存在但 ToolRun 不存在
    const transformers = createPolicyTransformers();
    const transformer = transformers.get("ToolApprovalRequest");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "approval-no-toolrun",
      threadId,
      toolRunId: "nonexistent-toolrun",
      toolName: "writeFile",
      permissionKey: "tool.writeFile",
      argFingerprint: "fp",
      argSummary: "summary",
      status: "pending",
      createdAt: "2024-01-01 00:00:00",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("ToolRun nonexistent-toolrun 不存在");
  });

  it("status=pending 映射为 requestState=pending / decision=pause", async () => {
    const userId = "user-approval-pending";
    const threadId = "thread-approval-pending";
    const toolRunId = "toolrun-approval-pending";
    await setupThreadAndToolRun(userId, threadId, toolRunId);

    await db.insert(ToolApprovalRequest).values({
      id: "approval-pending",
      threadId,
      toolRunId,
      toolName: "writeFile",
      permissionKey: "tool.writeFile",
      argFingerprint: "fp-pending",
      argSummary: "writeFile pending",
      status: "pending",
      createdAt: new Date("2024-05-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("policy");

    const [request] = await db
      .select()
      .from(v11UserActionRequest)
      .where(eq(v11UserActionRequest.id, "approval-pending"))
      .limit(1);
    expect(request?.requestState).toBe("pending");
    expect(request?.resolution).toBeNull();

    const [decision] = await db
      .select()
      .from(v11PermissionDecision)
      .where(eq(v11PermissionDecision.toolCallId, toolRunId))
      .limit(1);
    expect(decision?.decision).toBe("pause");
  });

  it("status=denied 映射为 requestState=resolved / resolution=deny / decision=block", async () => {
    const userId = "user-approval-denied";
    const threadId = "thread-approval-denied";
    const toolRunId = "toolrun-approval-denied";
    await setupThreadAndToolRun(userId, threadId, toolRunId);

    await db.insert(ToolApprovalRequest).values({
      id: "approval-denied",
      threadId,
      toolRunId,
      toolName: "deleteFile",
      permissionKey: "tool.deleteFile",
      argFingerprint: "fp-denied",
      argSummary: "deleteFile denied",
      status: "denied",
      resolvedBy: userId,
      resolvedAt: new Date("2024-05-01T00:05:00Z"),
      createdAt: new Date("2024-05-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("policy");

    const [request] = await db
      .select()
      .from(v11UserActionRequest)
      .where(eq(v11UserActionRequest.id, "approval-denied"))
      .limit(1);
    expect(request?.requestState).toBe("resolved");
    expect(request?.resolution).toBe("deny");

    const [decision] = await db
      .select()
      .from(v11PermissionDecision)
      .where(eq(v11PermissionDecision.toolCallId, toolRunId))
      .limit(1);
    expect(decision?.decision).toBe("block");
  });

  it("status=expired 映射为 requestState=expired", async () => {
    const userId = "user-approval-expired";
    const threadId = "thread-approval-expired";
    const toolRunId = "toolrun-approval-expired";
    await setupThreadAndToolRun(userId, threadId, toolRunId);

    await db.insert(ToolApprovalRequest).values({
      id: "approval-expired",
      threadId,
      toolRunId,
      toolName: "writeFile",
      permissionKey: "tool.writeFile",
      argFingerprint: "fp-expired",
      argSummary: "writeFile expired",
      status: "expired",
      createdAt: new Date("2024-05-01T00:00:00Z"),
      expiresAt: new Date("2024-05-01T01:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("policy");

    const [request] = await db
      .select()
      .from(v11UserActionRequest)
      .where(eq(v11UserActionRequest.id, "approval-expired"))
      .limit(1);
    expect(request?.requestState).toBe("expired");
    expect(request?.resolution).toBeNull();
  });

  it("ToolRun 无 runId 时使用占位 invocationId", async () => {
    const userId = "user-approval-norunid";
    const threadId = "thread-approval-norunid";
    const toolRunId = "toolrun-approval-norunid";
    // 不传 runId，ToolRun.runId 为 null
    await setupThreadAndToolRun(userId, threadId, toolRunId);

    await db.insert(ToolApprovalRequest).values({
      id: "approval-norunid",
      threadId,
      toolRunId,
      toolName: "writeFile",
      permissionKey: "tool.writeFile",
      argFingerprint: "fp-norunid",
      argSummary: "writeFile no runId",
      status: "approved",
      resolvedBy: userId,
      resolvedAt: new Date("2024-05-01T00:05:00Z"),
      createdAt: new Date("2024-05-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("policy");

    const [request] = await db
      .select()
      .from(v11UserActionRequest)
      .where(eq(v11UserActionRequest.id, "approval-norunid"))
      .limit(1);
    // runId 为空时使用 LEGACY_INVOCATION_ID
    expect(request?.invocationId).toBe("00000000-0000-4000-8000-000000000004");
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 端到端 policy 域迁移
// ═══════════════════════════════════════════════════════════

describe("S13-C03 policy 域端到端迁移", () => {
  it("完整 policy 域迁移：PolicyConfig/PolicyConfigHistory/ToolPermissionRule/ToolApprovalRequest 顺序执行", async () => {
    const userId = "user-e2e-policy";
    const threadId = "thread-e2e-policy";
    const toolRunId = "toolrun-e2e-policy";
    const runId = "run-e2e-policy";
    await setupThreadAndToolRun(userId, threadId, toolRunId, runId);

    // PolicyConfig
    await db.insert(PolicyConfig).values({
      key: "commandDenyList",
      value: { commands: ["rm -rf"] },
      updatedAt: new Date("2024-06-01T00:00:00Z"),
    });

    // PolicyConfigHistory
    await db.insert(PolicyConfigHistory).values({
      changedBy: "user-e2e-policy",
      beforeSnapshot: JSON.stringify({ commands: [] }),
      afterSnapshot: JSON.stringify({ commands: ["rm -rf"] }),
      changedKeys: JSON.stringify(["commands"]),
      changedAt: new Date("2024-06-01T00:00:00Z"),
    });

    // ToolPermissionRule
    await db.insert(ToolPermissionRule).values({
      id: "rule-e2e-001",
      scope: "global",
      toolPattern: "tool.runCommand",
      decision: "deny",
      reason: "禁止危险命令",
      priority: 100,
      createdAt: new Date("2024-06-01T00:00:00Z"),
      updatedAt: new Date("2024-06-01T00:00:00Z"),
    });

    // ToolApprovalRequest
    await db.insert(ToolApprovalRequest).values({
      id: "approval-e2e-001",
      threadId,
      toolRunId,
      toolName: "writeFile",
      permissionKey: "tool.writeFile:/etc",
      argFingerprint: "fp-e2e",
      argSummary: "writeFile /etc",
      status: "approved",
      approvedScope: "thread",
      resolvedBy: userId,
      resolvedAt: new Date("2024-06-01T00:10:00Z"),
      createdAt: new Date("2024-06-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createPolicyTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("policy");

    // 汇总验证
    expect(result.totalAnomalyCount).toBe(0);

    // PolicyConfig: 2 目标（V11PolicySet + V11PolicyRevision）
    const configTable = result.tables.find((t) => t.sourceTable === "PolicyConfig");
    expect(configTable?.targetCount).toBe(2);

    // PolicyConfigHistory: 1 目标（AuditEvent）
    const historyTable = result.tables.find((t) => t.sourceTable === "PolicyConfigHistory");
    expect(historyTable?.targetCount).toBe(1);

    // ToolPermissionRule: 4 目标（首条创建占位策略集 + 修订 + V11Policy + V11PermissionDecision）
    const ruleTable = result.tables.find((t) => t.sourceTable === "ToolPermissionRule");
    expect(ruleTable?.targetCount).toBe(4);

    // ToolApprovalRequest: 2 目标（V11UserActionRequest + V11PermissionDecision）
    const approvalTable = result.tables.find((t) => t.sourceTable === "ToolApprovalRequest");
    expect(approvalTable?.targetCount).toBe(2);

    // 验证 V11 表实际写入
    const policySets = await db.select().from(v11PolicySet);
    // 1 个 PolicyConfig 创建的 + 1 个 ToolPermissionRule 占位 = 2
    expect(policySets.length).toBe(2);

    const revisions = await db.select().from(v11PolicyRevision);
    expect(revisions.length).toBe(2);

    const policies = await db.select().from(v11Policy);
    expect(policies.length).toBe(1);

    const audits = await db.select().from(AuditEvent);
    expect(audits.length).toBe(1);

    const requests = await db.select().from(v11UserActionRequest);
    expect(requests.length).toBe(1);

    // V11PermissionDecision：1 个 ToolPermissionRule + 1 个 ToolApprovalRequest = 2
    const decisions = await db.select().from(v11PermissionDecision);
    expect(decisions.length).toBe(2);
  });

  it("幂等性：二次运行跳过所有已迁移记录", async () => {
    // PolicyConfig
    await db.insert(PolicyConfig).values({
      key: "formatOnWrite",
      value: { enabled: true },
      updatedAt: new Date("2024-07-01T00:00:00Z"),
    });

    // ToolPermissionRule
    await db.insert(ToolPermissionRule).values({
      id: "rule-idem-001",
      scope: "global",
      toolPattern: "tool.readFile",
      decision: "allow",
      createdAt: new Date("2024-07-01T00:00:00Z"),
      updatedAt: new Date("2024-07-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createPolicyTransformers();

    // 第一次运行
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result1 = await runner1.runDomain("policy");
    expect(result1.totalTargetCount).toBeGreaterThan(0);

    // 记录第一次的 V11 表行数
    const policySetCount1 = (await db.select().from(v11PolicySet)).length;
    const policyCount1 = (await db.select().from(v11Policy)).length;
    const revisionCount1 = (await db.select().from(v11PolicyRevision)).length;

    // 第二次运行：应全部跳过，不产生新目标
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runDomain("policy");

    expect(result2.totalTargetCount).toBe(0);
    // 2 条源记录全部跳过（PolicyConfig + ToolPermissionRule）
    expect(result2.totalSkipCount).toBe(2);

    // V11 表行数不变
    const policySetCount2 = (await db.select().from(v11PolicySet)).length;
    const policyCount2 = (await db.select().from(v11Policy)).length;
    const revisionCount2 = (await db.select().from(v11PolicyRevision)).length;
    expect(policySetCount2).toBe(policySetCount1);
    expect(policyCount2).toBe(policyCount1);
    expect(revisionCount2).toBe(revisionCount1);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. createPolicyTransformers 工厂
// ═══════════════════════════════════════════════════════════

describe("S13-C03 createPolicyTransformers 工厂", () => {
  it("返回 4 个转换器", () => {
    const transformers = createPolicyTransformers();
    expect(transformers.size).toBe(4);
    expect(transformers.has("PolicyConfig")).toBe(true);
    expect(transformers.has("PolicyConfigHistory")).toBe(true);
    expect(transformers.has("ToolPermissionRule")).toBe(true);
    expect(transformers.has("ToolApprovalRequest")).toBe(true);
  });

  it("每个转换器是函数类型", () => {
    const transformers = createPolicyTransformers();
    for (const [, transformer] of transformers) {
      expect(typeof transformer).toBe("function");
    }
  });

  it("工厂每次调用返回独立 Map 实例", () => {
    const t1 = createPolicyTransformers();
    const t2 = createPolicyTransformers();
    expect(t1).not.toBe(t2);
    expect(t1.size).toBe(t2.size);
  });
});
