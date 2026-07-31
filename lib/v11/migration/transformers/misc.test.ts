/**
 * S13-C03 misc 域迁移转换器集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - ChatExample 转换器：无 V11 目标，返回 skip
 * - AuditFailureLog 转换器：正常迁移（V11RuntimeEventIngress + AuditEvent）、无 V11Invocation 时仅写 AuditEvent
 * - DesktopDevice 转换器：正常迁移、status→deviceState 映射、userIdentityId 不存在异常
 * - AdminAuditLog 转换器：正常迁移（action→actionType 映射）、action 不在目录异常
 * - 端到端 misc 域迁移：ChatExample/AuditFailureLog/DesktopDevice/AdminAuditLog 顺序执行
 * - 幂等性：二次运行跳过已迁移记录
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import {
  adminAuditLog as AdminAuditLog,
  auditFailureLog as AuditFailureLog,
  chatExample as ChatExample,
  desktopDevice as DesktopDevice,
  thread as Thread,
  threadRun as ThreadRun,
  user as User,
} from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { createExecutionRunner } from "@/lib/v11/migration/migration-runner";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { InMemoryMigrationStateStore } from "@/lib/v11/migration/migration-state";
import { createConversationTransformers } from "@/lib/v11/migration/transformers/conversation";
import { createIdentityTransformers } from "@/lib/v11/migration/transformers/identity";
import { createMiscTransformers } from "@/lib/v11/migration/transformers/misc";
import { getV11TableRegistry } from "@/lib/v11/migration/v11-table-registry";
import { auditEvent } from "@/lib/v11/schema/audit";
import { device } from "@/lib/v11/schema/device";
import { v11RuntimeEventIngress } from "@/lib/v11/schema/runtime";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/** 合并 identity + conversation + misc 转换器（misc 域依赖 identity 域 User 和 conversation 域 ThreadRun）。 */
function createMergedTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ...createIdentityTransformers(),
    ...createConversationTransformers(),
    ...createMiscTransformers(),
  ]);
}

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

/** 插入 User 并迁移 identity 域，返回 userId。 */
async function setupUser(userId: string, externalId: string): Promise<void> {
  await db.insert(User).values({
    id: userId,
    externalId,
    email: `${externalId}@example.com`,
    name: externalId,
  });
  const store = new InMemoryMigrationStateStore();
  const runner = createExecutionRunner(
    store,
    createIdentityTransformers(),
    100,
    false,
    getV11TableRegistry(),
  );
  await runner.runDomain("identity");
}

/** 插入 User + Thread + ThreadRun 并迁移 identity + conversation 域，返回 runId。 */
async function setupUserThreadRun(
  userId: string,
  externalId: string,
  threadId: string,
  runId: string,
): Promise<void> {
  await setupUser(userId, externalId);

  await db.insert(Thread).values({
    id: threadId,
    title: "misc 测试会话",
    userId,
    status: "idle",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-02T00:00:00Z"),
  });

  await db.insert(ThreadRun).values({
    id: runId,
    threadId,
    status: "completed",
    triggerType: "user_message",
    model: "test-model",
    startedAt: new Date("2024-05-01T00:00:00Z"),
    finishedAt: new Date("2024-05-01T00:01:00Z"),
    createdAt: new Date("2024-05-01T00:00:00Z"),
    updatedAt: new Date("2024-05-01T00:01:00Z"),
  });

  // 迁移 conversation 域，使 ThreadRun → V11Invocation 存在
  const store = new InMemoryMigrationStateStore();
  const runner = createExecutionRunner(
    store,
    new Map<string, MigrationTransformer>([
      ...createIdentityTransformers(),
      ...createConversationTransformers(),
    ]),
    100,
    false,
    getV11TableRegistry(),
  );
  await runner.runDomain("identity");
  await runner.runDomain("conversation");
}

// ═══════════════════════════════════════════════════════════
// 1. ChatExample 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 ChatExample 转换器", () => {
  it("ChatExample 无 V11 目标，迁移时 skip", async () => {
    await db.insert(ChatExample).values({
      id: "chat-example-001",
      content: "你好，请帮我写代码",
      sortOrder: 1,
      enabled: true,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMiscTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("misc");

    const table = result.tables.find((t) => t.sourceTable === "ChatExample");
    expect(table?.sourceCount).toBe(1);
    expect(table?.targetCount).toBe(0);
    expect(table?.skipCount).toBe(1);
    expect(table?.anomalyCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. AuditFailureLog 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 AuditFailureLog 转换器", () => {
  it("正常 AuditFailureLog 迁移为 V11RuntimeEventIngress + AuditEvent", async () => {
    const userId = "user-afl-001";
    const threadId = "thread-afl-001";
    const runId = "run-afl-001";
    await setupUserThreadRun(userId, "ext-afl-001", threadId, runId);

    await db.insert(AuditFailureLog).values({
      id: "afl-001",
      threadId,
      toolName: "writeFile",
      runId,
      errorMessage: "审计写入失败：连接超时",
      payload: '{"sensitive":"data"}',
      retryCount: 2,
      createdAt: new Date("2024-06-01T12:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("misc");

    const table = result.tables.find((t) => t.sourceTable === "AuditFailureLog");
    expect(table?.sourceCount).toBe(1);
    expect(table?.targetCount).toBe(2); // V11RuntimeEventIngress + AuditEvent
    expect(table?.anomalyCount).toBe(0);

    // 验证 V11RuntimeEventIngress 写入（reject 通道）
    const [ingress] = await db
      .select()
      .from(v11RuntimeEventIngress)
      .where(eq(v11RuntimeEventIngress.id, "afl-001"))
      .limit(1);
    expect(ingress).toBeDefined();
    expect(ingress?.invocationId).toBe(runId);
    expect(ingress?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(ingress?.ingressState).toBe("rejected");
    expect(ingress?.candidateType).toBe("execution.failed");
    expect(ingress?.producerEventId).toBe("afl-001");
    expect(ingress?.producerSequence).toBe(2);
    expect(ingress?.rejectedReason).toBe("审计写入失败：连接超时");
    expect(ingress?.payloadHash).toMatch(/^sha256:/);

    // 验证 AuditEvent 写入
    const [audit] = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.targetId, "afl-001"))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit?.actionType).toBe("event.quarantine.resolve");
    expect(audit?.actorType).toBe("system");
    expect(audit?.actorId).toBe("system");
    expect(audit?.reason).toBe("审计写入失败：连接超时");
  });

  it("runId 对应的 V11Invocation 不存在时仅写 AuditEvent", async () => {
    await db.insert(AuditFailureLog).values({
      id: "afl-002",
      threadId: "thread-no-run",
      toolName: "readFile",
      runId: "nonexistent-run",
      errorMessage: "审计写入失败",
      retryCount: 0,
      createdAt: new Date("2024-06-01T12:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMiscTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("misc");

    const table = result.tables.find((t) => t.sourceTable === "AuditFailureLog");
    expect(table?.sourceCount).toBe(1);
    expect(table?.targetCount).toBe(1); // 仅 AuditEvent
    expect(table?.anomalyCount).toBe(0);

    // V11RuntimeEventIngress 不应写入
    const ingressRows = await db
      .select()
      .from(v11RuntimeEventIngress)
      .where(eq(v11RuntimeEventIngress.id, "afl-002"));
    expect(ingressRows.length).toBe(0);

    // AuditEvent 应写入
    const [audit] = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.targetId, "afl-002"))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit?.actionType).toBe("event.quarantine.resolve");
  });

  it("runId 为空时仅写 AuditEvent", async () => {
    await db.insert(AuditFailureLog).values({
      id: "afl-003",
      threadId: "thread-no-runid",
      toolName: "executeTool",
      errorMessage: "无 runId 的审计失败",
      retryCount: 1,
      createdAt: new Date("2024-06-01T12:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMiscTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("misc");

    const table = result.tables.find((t) => t.sourceTable === "AuditFailureLog");
    expect(table?.targetCount).toBe(1); // 仅 AuditEvent

    // AuditEvent 应写入
    const [audit] = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.targetId, "afl-003"))
      .limit(1);
    expect(audit).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. DesktopDevice 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 DesktopDevice 转换器", () => {
  it("正常 DesktopDevice 迁移为 V11Device", async () => {
    const userId = "user-dd-001";
    await setupUser(userId, "ext-dd-001");

    await db.insert(DesktopDevice).values({
      id: "dd-001",
      userId,
      deviceId: "device-key-001",
      publicKey: "base64-public-key-data",
      name: "MacBook Pro",
      version: "1.0.0",
      status: "active",
      lastActiveAt: new Date("2024-07-01T10:00:00Z"),
      createdAt: new Date("2024-06-01T00:00:00Z"),
      updatedAt: new Date("2024-07-01T10:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("misc");

    const table = result.tables.find((t) => t.sourceTable === "DesktopDevice");
    expect(table?.sourceCount).toBe(1);
    expect(table?.targetCount).toBe(1);
    expect(table?.anomalyCount).toBe(0);

    // 验证 V11Device 写入
    const [dev] = await db.select().from(device).where(eq(device.id, "dd-001")).limit(1);
    expect(dev).toBeDefined();
    expect(dev?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(dev?.userId).toBe(userId);
    expect(dev?.deviceKey).toBe("device-key-001");
    expect(dev?.deviceName).toBe("MacBook Pro");
    expect(dev?.appVersion).toBe("1.0.0");
    expect(dev?.deviceState).toBe("active");
    expect(dev?.revokedAt).toBeNull();
    // publicKey 为不可迁字段，使用 legacy 占位
    expect(dev?.publicKey).toBe("legacy-public-key:dd-001");
  });

  it("status=revoked 映射为 deviceState=revoked 且保留 revokedAt", async () => {
    const userId = "user-dd-002";
    await setupUser(userId, "ext-dd-002");

    const revokedAt = new Date("2024-07-15T08:00:00Z");
    await db.insert(DesktopDevice).values({
      id: "dd-002",
      userId,
      deviceId: "device-key-002",
      publicKey: "base64-public-key-data",
      name: "MacBook Air",
      version: "2.0.0",
      status: "revoked",
      lastActiveAt: new Date("2024-07-01T10:00:00Z"),
      revokedAt,
      createdAt: new Date("2024-06-01T00:00:00Z"),
      updatedAt: revokedAt,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("misc");

    const [dev] = await db.select().from(device).where(eq(device.id, "dd-002")).limit(1);
    expect(dev?.deviceState).toBe("revoked");
    expect(dev?.revokedAt).toEqual(revokedAt);
  });

  it("userIdentityId 不存在时入异常队列", async () => {
    // 不迁移 identity 域，直接插入 DesktopDevice
    await db.insert(User).values({
      id: "user-dd-noidentity",
      externalId: "ext-dd-noidentity",
      email: "noidentity@example.com",
    });

    await db.insert(DesktopDevice).values({
      id: "dd-no-ui",
      userId: "user-dd-noidentity",
      deviceId: "device-key-no-ui",
      publicKey: "base64-public-key",
      name: "Unknown Device",
      version: "1.0.0",
      status: "active",
      lastActiveAt: new Date("2024-07-01T10:00:00Z"),
      createdAt: new Date("2024-06-01T00:00:00Z"),
      updatedAt: new Date("2024-07-01T10:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("misc");

    const table = result.tables.find((t) => t.sourceTable === "DesktopDevice");
    expect(table?.anomalyCount).toBe(1);
    expect(table?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("DesktopDevice");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain("UserIdentity 不存在");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. AdminAuditLog 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 AdminAuditLog 转换器", () => {
  it("正常 AdminAuditLog 迁移为 AuditEvent（action=policies.updated → actionType=policy.publish）", async () => {
    const userId = "user-aal-001";
    await setupUser(userId, "ext-aal-001");

    await db.insert(AdminAuditLog).values({
      id: "aal-001",
      actorUserId: userId,
      action: "policies.updated",
      targetType: "policy",
      targetId: "policy",
      outcome: "succeeded",
      metadata: { key: "value" },
      createdAt: new Date("2024-08-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("misc");

    const table = result.tables.find((t) => t.sourceTable === "AdminAuditLog");
    expect(table?.sourceCount).toBe(1);
    expect(table?.targetCount).toBe(1);
    expect(table?.anomalyCount).toBe(0);

    // 验证 AuditEvent 写入
    const [audit] = await db.select().from(auditEvent).where(eq(auditEvent.id, "aal-001")).limit(1);
    expect(audit).toBeDefined();
    expect(audit?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(audit?.actorType).toBe("user");
    expect(audit?.actorId).toBe(userId);
    expect(audit?.actionType).toBe("policy.publish");
    expect(audit?.targetType).toBe("policy");
    expect(audit?.targetId).toBe("policy");
    expect(audit?.reason).toContain("policies.updated");
    expect(audit?.reason).toContain("succeeded");
    expect(audit?.requestId).toBe("legacy-admin-audit:aal-001");
  });

  it("action=skills.published 映射为 actionType=agent.publish", async () => {
    const userId = "user-aal-002";
    await setupUser(userId, "ext-aal-002");

    await db.insert(AdminAuditLog).values({
      id: "aal-002",
      actorUserId: userId,
      action: "skills.published",
      targetType: "skill",
      targetId: "skill-001",
      outcome: "succeeded",
      metadata: {},
      createdAt: new Date("2024-08-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("misc");

    const [audit] = await db.select().from(auditEvent).where(eq(auditEvent.id, "aal-002")).limit(1);
    expect(audit?.actionType).toBe("agent.publish");
  });

  it("action=thread.purged 映射为 actionType=deletion.request", async () => {
    const userId = "user-aal-003";
    await setupUser(userId, "ext-aal-003");

    await db.insert(AdminAuditLog).values({
      id: "aal-003",
      actorUserId: userId,
      action: "thread.purged",
      targetType: "thread",
      targetId: "thread:abc",
      outcome: "succeeded",
      metadata: {},
      createdAt: new Date("2024-08-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("misc");

    const [audit] = await db.select().from(auditEvent).where(eq(auditEvent.id, "aal-003")).limit(1);
    expect(audit?.actionType).toBe("deletion.request");
  });

  it("action 不在 AUDIT_ACTION_TYPES 目录时入异常队列", async () => {
    const userId = "user-aal-004";
    await setupUser(userId, "ext-aal-004");

    await db.insert(AdminAuditLog).values({
      id: "aal-004",
      actorUserId: userId,
      action: "skills.matched", // 不在映射目录
      targetType: "skill",
      targetId: "skill-002",
      outcome: "succeeded",
      metadata: {},
      createdAt: new Date("2024-08-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("misc");

    const table = result.tables.find((t) => t.sourceTable === "AdminAuditLog");
    expect(table?.anomalyCount).toBe(1);
    expect(table?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("AdminAuditLog");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain("不在 AUDIT_ACTION_TYPES 目录");
    expect(anomalies[0]?.reason).toContain("skills.matched");
  });

  it("outcome=failed 时 reason 包含 failed", async () => {
    const userId = "user-aal-005";
    await setupUser(userId, "ext-aal-005");

    await db.insert(AdminAuditLog).values({
      id: "aal-005",
      actorUserId: userId,
      action: "skills.created",
      targetType: "skill",
      targetId: "skill-003",
      outcome: "failed",
      metadata: {},
      createdAt: new Date("2024-08-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("misc");

    const [audit] = await db.select().from(auditEvent).where(eq(auditEvent.id, "aal-005")).limit(1);
    expect(audit?.actionType).toBe("agent.revision.create");
    expect(audit?.reason).toContain("failed");
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 端到端 misc 域迁移
// ═══════════════════════════════════════════════════════════

describe("S13-C03 misc 域端到端迁移", () => {
  it("完整 misc 域迁移：ChatExample/AuditFailureLog/DesktopDevice/AdminAuditLog 顺序执行", async () => {
    const userId = "user-e2e-misc-001";
    const threadId = "thread-e2e-misc-001";
    const runId = "run-e2e-misc-001";
    await setupUserThreadRun(userId, "ext-e2e-misc-001", threadId, runId);

    // ChatExample（skip）
    await db.insert(ChatExample).values({
      id: "chat-example-e2e",
      content: "端到端示例",
      sortOrder: 1,
      enabled: true,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    });

    // AuditFailureLog（V11RuntimeEventIngress + AuditEvent）
    await db.insert(AuditFailureLog).values({
      id: "afl-e2e",
      threadId,
      toolName: "writeFile",
      runId,
      errorMessage: "端到端审计失败",
      payload: "{}",
      retryCount: 1,
      createdAt: new Date("2024-06-01T12:00:00Z"),
    });

    // DesktopDevice（V11Device）
    await db.insert(DesktopDevice).values({
      id: "dd-e2e",
      userId,
      deviceId: "device-e2e",
      publicKey: "base64-key",
      name: "E2E Device",
      version: "1.0.0",
      status: "active",
      lastActiveAt: new Date("2024-07-01T10:00:00Z"),
      createdAt: new Date("2024-06-01T00:00:00Z"),
      updatedAt: new Date("2024-07-01T10:00:00Z"),
    });

    // AdminAuditLog（AuditEvent）
    await db.insert(AdminAuditLog).values({
      id: "aal-e2e",
      actorUserId: userId,
      action: "skills.published",
      targetType: "skill",
      targetId: "skill-e2e",
      outcome: "succeeded",
      metadata: {},
      createdAt: new Date("2024-08-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("misc");

    // 汇总验证
    expect(result.totalAnomalyCount).toBe(0);

    // ChatExample: skip（0 目标）
    const chatTable = result.tables.find((t) => t.sourceTable === "ChatExample");
    expect(chatTable?.sourceCount).toBe(1);
    expect(chatTable?.targetCount).toBe(0);
    expect(chatTable?.skipCount).toBe(1);

    // AuditFailureLog: 2 目标（V11RuntimeEventIngress + AuditEvent）
    const aflTable = result.tables.find((t) => t.sourceTable === "AuditFailureLog");
    expect(aflTable?.targetCount).toBe(2);

    // DesktopDevice: 1 目标
    const ddTable = result.tables.find((t) => t.sourceTable === "DesktopDevice");
    expect(ddTable?.targetCount).toBe(1);

    // AdminAuditLog: 1 目标
    const aalTable = result.tables.find((t) => t.sourceTable === "AdminAuditLog");
    expect(aalTable?.targetCount).toBe(1);

    // 验证 V11 表实际写入
    const devices = await db.select().from(device);
    expect(devices.length).toBe(1);
    expect(devices[0]?.id).toBe("dd-e2e");

    const ingressRows = await db
      .select()
      .from(v11RuntimeEventIngress)
      .where(eq(v11RuntimeEventIngress.id, "afl-e2e"));
    expect(ingressRows.length).toBe(1);
    expect(ingressRows[0]?.ingressState).toBe("rejected");

    // AuditEvent 应有 2 条（AuditFailureLog + AdminAuditLog）
    const allAudits = await db.select().from(auditEvent);
    expect(allAudits.length).toBe(2);
    const auditActionTypes = allAudits.map((a) => a.actionType).sort();
    expect(auditActionTypes).toEqual(["agent.publish", "event.quarantine.resolve"]);
  });

  it("幂等性：二次运行跳过所有已迁移记录", async () => {
    const userId = "user-idem-misc-001";
    const threadId = "thread-idem-misc-001";
    const runId = "run-idem-misc-001";
    await setupUserThreadRun(userId, "ext-idem-misc-001", threadId, runId);

    await db.insert(ChatExample).values({
      id: "chat-example-idem",
      content: "幂等示例",
      sortOrder: 1,
      enabled: true,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    });

    await db.insert(AuditFailureLog).values({
      id: "afl-idem",
      threadId,
      toolName: "writeFile",
      runId,
      errorMessage: "幂等审计失败",
      payload: "{}",
      retryCount: 0,
      createdAt: new Date("2024-06-01T12:00:00Z"),
    });

    await db.insert(DesktopDevice).values({
      id: "dd-idem",
      userId,
      deviceId: "device-idem",
      publicKey: "base64-key",
      name: "Idem Device",
      version: "1.0.0",
      status: "active",
      lastActiveAt: new Date("2024-07-01T10:00:00Z"),
      createdAt: new Date("2024-06-01T00:00:00Z"),
      updatedAt: new Date("2024-07-01T10:00:00Z"),
    });

    await db.insert(AdminAuditLog).values({
      id: "aal-idem",
      actorUserId: userId,
      action: "policies.updated",
      targetType: "policy",
      targetId: "policy",
      outcome: "succeeded",
      metadata: {},
      createdAt: new Date("2024-08-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();

    // 第一次运行
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result1 = await runner1.runDomain("misc");
    expect(result1.totalTargetCount).toBeGreaterThan(0);

    // 记录第一次的 V11 表行数
    const deviceCount1 = (await db.select().from(device)).length;
    const ingressCount1 = (await db.select().from(v11RuntimeEventIngress)).length;
    const auditCount1 = (await db.select().from(auditEvent)).length;

    // 第二次运行：应全部跳过，不产生新目标
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runDomain("misc");

    expect(result2.totalTargetCount).toBe(0);
    // ChatExample skip + AuditFailureLog + DesktopDevice + AdminAuditLog = 4 条源记录全部跳过
    expect(result2.totalSkipCount).toBe(4);

    // V11 表行数不变
    const deviceCount2 = (await db.select().from(device)).length;
    const ingressCount2 = (await db.select().from(v11RuntimeEventIngress)).length;
    const auditCount2 = (await db.select().from(auditEvent)).length;
    expect(deviceCount2).toBe(deviceCount1);
    expect(ingressCount2).toBe(ingressCount1);
    expect(auditCount2).toBe(auditCount1);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. createMiscTransformers 工厂
// ═══════════════════════════════════════════════════════════

describe("S13-C03 createMiscTransformers 工厂", () => {
  it("返回 4 个转换器", () => {
    const transformers = createMiscTransformers();
    expect(transformers.size).toBe(4);
    expect(transformers.has("ChatExample")).toBe(true);
    expect(transformers.has("AuditFailureLog")).toBe(true);
    expect(transformers.has("DesktopDevice")).toBe(true);
    expect(transformers.has("AdminAuditLog")).toBe(true);
  });

  it("每个转换器是函数类型", () => {
    const transformers = createMiscTransformers();
    for (const [, transformer] of transformers) {
      expect(typeof transformer).toBe("function");
    }
  });

  it("工厂每次调用返回独立 Map 实例", () => {
    const t1 = createMiscTransformers();
    const t2 = createMiscTransformers();
    expect(t1).not.toBe(t2);
    expect(t1.size).toBe(t2.size);
  });

  it("ChatExample 转换器直接调用返回 skip", async () => {
    const transformers = createMiscTransformers();
    const transformer = transformers.get("ChatExample");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({ id: "test", content: "test" });
    expect(result.targets).toEqual([]);
    expect(result.skip).toBe(true);
  });

  it("AdminAuditLog 转换器直接调用：action 不在目录返回异常", async () => {
    const transformers = createMiscTransformers();
    const transformer = transformers.get("AdminAuditLog");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "test-aal",
      actorUserId: "user-test",
      action: "unknown.action",
      targetType: "unknown",
      targetId: "target",
      outcome: "succeeded",
      metadata: {},
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("不在 AUDIT_ACTION_TYPES 目录");
  });
});
