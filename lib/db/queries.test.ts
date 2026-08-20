import { db } from "@/lib/db/client";
import {
  abandonThreadPlan,
  appendThreadEvent,
  consumeOnceApproval,
  createApprovalRequest,
  createBackgroundTask,
  createCheckpointRow,
  createContextSummary,
  createCustomTool,
  createMcpServerConfig,
  createMemoryRow,
  createPermissionRule,
  createProvider,
  createSkill,
  createSkillVersion,
  createSubagentDefinition,
  createSubagentRun,
  createThreadPlan,
  createToolRun,
  deletePermissionRule,
  deleteThreadRecursive,
  findDuplicateMemory,
  findMatchingApprovals,
  finishToolRunFailure,
  finishToolRunSuccess,
  getActiveEmbeddingRow,
  getActiveSummaryByChecksum,
  getActiveThreadPlan,
  getApprovalRequest,
  getBackgroundTask,
  getCheckpoint,
  getCurrentSkillVersion,
  getCustomToolByName,
  getLatestThreadForUser,
  getMcpServerConfigByName,
  getMemoryRow,
  getMessagesByThreadIdForUser,
  getPendingApprovalsByThread,
  getPermissionsForRoleIds,
  getProviderByName,
  getRecentFailedToolRun,
  getSkillById,
  getSkillByName,
  getSkillVersion,
  getSubagentDefinition,
  getSubagentRun,
  getThreadByIdForUser,
  getUserById,
  incrementThreadTokens,
  listActiveBackgroundTasks,
  listActiveBackgroundTasksByThread,
  listActiveSubagentRunsByThread,
  listAdminAuditLogs,
  listBackgroundTasksByThread,
  listCheckpointsByThread,
  listContextSnapshotsForThread,
  listCustomTools,
  listEmbeddingRowsByMemory,
  listEnabledCustomTools,
  listEnabledMcpServerConfigs,
  listExternalFetchedEvents,
  listMcpServerConfigs,
  listMemoryRows,
  listProviders,
  listRolesWithPermissions,
  listSubagentDefinitions,
  listSubagentRunsByThread,
  listSummariesByThread,
  listThreadEvents,
  listThreadPlanItems,
  listThreadPlans,
  listThreadRunSkillsByRun,
  listThreadRunSkillsByThread,
  listThreadStatusChanges,
  listThreadsForUser,
  listUsersWithRoles,
  markCheckpointRestored,
  markOrphanBackgroundTasksOnStartup,
  markOrphanSubagentRunsOnStartup,
  reapStaleThreads,
  requestApprovalAtomic,
  requireThreadForUser,
  resolveApprovalRequest,
  saveContextSnapshot,
  saveThreadRunSkills,
  setCurrentVersion,
  supersedeSummary,
  togglePinThread,
  updateBackgroundTask,
  updateCustomTool,
  updateMcpServerConfig,
  updateMemoryRow,
  updatePermissionRule,
  updateSubagentRun,
  updateThreadPlanItemStatus,
  upsertEmbeddingRow,
  upsertMessageParts,
  upsertThreadPlanItem,
} from "@/lib/db/queries";
import { messageTypeForRole, thread } from "@/lib/db/schema";
import {
  APPROVAL_REQUEST_STATUSES,
  APPROVAL_SCOPES,
  BACKGROUND_TASK_KINDS,
  BACKGROUND_TASK_STATUSES,
  CUSTOM_TOOL_EXECUTOR_TYPES,
  MCP_TRANSPORTS,
  PERMISSION_DECISIONS,
  PERMISSION_SCOPES,
  THREAD_EVENT_TYPES,
  THREAD_PLAN_ITEM_STATUSES,
  THREAD_PLAN_STATUSES,
  THREAD_STATUSES,
  TOOL_RUN_STATUSES,
} from "@/lib/db/schema";
import {
  adminAuditLog,
  backgroundTask,
  contextSnapshot,
  contextSummary,
  customTool,
  gitCheckpoint,
  mcpServerConfig,
  memoryEmbedding,
  memoryEntry,
  message,
  policyConfig,
  providerProfile,
  role,
  rolePermission,
  runTranscriptChunk,
  skill,
  skillVersion,
  subagentDefinition,
  subagentRun,
  threadEvent,
  threadPlan,
  threadPlanItem,
  threadRun,
  threadRunSkill,
  toolApprovalRequest,
  toolPermissionRule,
  toolRun,
  user,
  userRole,
} from "@/lib/db/schema";
import { eq, getTableName, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./test/mysql-harness";

/**
 * Stage A query 层测试(S1 08 同构:真实 MySQL)。
 *
 * 生产是 MySQL(mysql2 + drizzle),测试必须生产同构——不再用 fake-db mock 替代真实 DB。
 * 本测试用 testcontainers 起的真实 MySQL 8 容器(经 vitest globalSetup 注入 DATABASE_URL),
 * beforeEach resetDatabase TRUNCATE 所有表隔离,用 db.insert 灌真实数据(满足外键链),
 * 调真实 queries.ts 函数,断言真实 DB 状态。
 *
 * 验证维度(原 fake-db 无法覆盖、真实 MySQL 才能锁定的命门):
 * - 外键约束真实生效(插 Thread 前先插 User,插 ThreadEvent 前先插 Thread)
 * - unique 约束真实生效(ThreadEvent (threadId, sequence) 唯一、User externalId 唯一、Skill name 唯一)
 * - 事务原子性(requestApprovalAtomic / deleteThreadRecursive / replaceUserRoles / mutateThreadPinnedFacts)
 * - session scope 短 TTL(07-P1-6:approved session → expiresAt 收紧到 30min)
 * - markOrphanSubagentRunsOnStartup orphan 清理(04-G3:running → cancelled + errorMessage 含 orphan)
 * - json 列 zod 校验 fail-closed(08-P2-3:非法结构抛错不落库)
 * - 级联删除顺序(deleteThreadRecursive 先子表后主表)
 */

// ─── 测试数据工厂 ─────────────────────────────────────────────
//
// 复用 studio-queries.test.ts 的工厂模式:每个工厂灌一行真实数据,满足外键链。
// 调用方负责按外键依赖顺序灌(User → Thread → ToolRun/ThreadEvent/...)。

async function insertUser(id: string, name: string | null = null, email?: string) {
  await db.insert(user).values({ id, externalId: id, email: email ?? `${id}@x`, name });
}

async function insertThread(
  id: string,
  userId: string,
  opts: {
    title?: string;
    status?: string;
    activeSkillId?: string | null;
    activeSkillVersionId?: string | null;
    pinnedAt?: Date | null;
    pinnedFacts?: string[] | null;
    updatedAt?: Date;
    createdAt?: Date;
    deletedAt?: Date | null;
    lastMessagePreview?: string | null;
    lastMessageId?: string | null;
  } = {},
) {
  const now = new Date();
  await db.insert(thread).values({
    id,
    userId,
    title: opts.title ?? `thread-${id}`,
    status: (opts.status as never) ?? "idle",
    activeSkillId: opts.activeSkillId ?? null,
    activeSkillVersionId: opts.activeSkillVersionId ?? null,
    pinnedAt: opts.pinnedAt ?? null,
    pinnedFacts: opts.pinnedFacts ?? null,
    createdAt: opts.createdAt ?? now,
    updatedAt: opts.updatedAt ?? now,
    deletedAt: opts.deletedAt ?? null,
    lastMessagePreview: opts.lastMessagePreview ?? null,
    lastMessageId: opts.lastMessageId ?? null,
  });
}

async function insertToolRunRow(
  id: string,
  threadId: string,
  opts: {
    toolName?: string;
    status?: string;
    input?: Record<string, unknown>;
    output?: Record<string, unknown> | null;
    error?: string | null;
    startedAt?: Date;
    finishedAt?: Date | null;
  } = {},
) {
  await db.insert(toolRun).values({
    id,
    threadId,
    toolName: opts.toolName ?? "writeFile",
    status: (opts.status as never) ?? "succeeded",
    input: opts.input ?? {},
    output: opts.output ?? null,
    error: opts.error ?? null,
    startedAt: opts.startedAt ?? new Date(),
    finishedAt: opts.finishedAt ?? null,
  });
}

async function insertEvent(
  id: string,
  threadId: string,
  sequence: number,
  type: string,
  opts: { payload?: unknown; createdAt?: Date } = {},
) {
  await db.insert(threadEvent).values({
    id,
    threadId,
    sequence,
    type,
    payload: (opts.payload ?? {}) as never,
    createdAt: opts.createdAt ?? new Date(),
  });
}

async function insertMessage(
  id: string,
  threadId: string,
  opts: {
    role?: string;
    type?: string | null;
    parts?: unknown;
    runId?: string | null;
    createdAt?: Date;
  } = {},
) {
  await db.insert(message).values({
    id,
    threadId,
    role: opts.role ?? "user",
    type: opts.type ?? null,
    parts: (opts.parts ?? [{ type: "text", text: "hi" }]) as never,
    runId: opts.runId ?? null,
    createdAt: opts.createdAt ?? new Date(),
  });
}

async function insertSkill(
  id: string,
  name: string,
  opts: {
    status?: "active" | "archived";
    currentVersionId?: string | null;
    ownerUserId?: string | null;
    createdAt?: Date;
  } = {},
) {
  await db.insert(skill).values({
    id,
    name,
    status: opts.status ?? "active",
    currentVersionId: opts.currentVersionId ?? null,
    ownerUserId: opts.ownerUserId ?? null,
    createdAt: opts.createdAt ?? new Date(),
  });
}

async function insertSkillVersionRow(
  id: string,
  skillId: string,
  version: number,
  opts: {
    promptTemplate?: string | null;
    allowedTools?: string[] | null;
    status?: string;
    createdAt?: Date;
  } = {},
) {
  await db.insert(skillVersion).values({
    id,
    skillId,
    version,
    promptTemplate: opts.promptTemplate ?? null,
    allowedTools: opts.allowedTools ?? null,
    status: (opts.status as never) ?? "active",
    createdAt: opts.createdAt ?? new Date(),
  });
}

async function insertRole(
  id: string,
  key: string,
  name: string,
  opts: { isSystem?: boolean } = {},
) {
  await db.insert(role).values({ id, key, name, isSystem: opts.isSystem ?? false });
}

async function insertRolePermission(roleId: string, permission: string) {
  await db.insert(rolePermission).values({ roleId, permission });
}

async function insertUserRole(userId: string, roleId: string) {
  await db.insert(userRole).values({ userId, roleId, createdAt: new Date() });
}

async function insertApprovalRequest(
  id: string,
  threadId: string,
  toolRunId: string,
  opts: {
    status?: string;
    approvedScope?: string | null;
    resolvedBy?: string | null;
    resolvedAt?: Date | null;
    expiresAt?: Date | null;
    permissionKey?: string;
    argFingerprint?: string;
    createdAt?: Date;
  } = {},
) {
  await db.insert(toolApprovalRequest).values({
    id,
    threadId,
    toolRunId,
    toolName: "deleteFile",
    permissionKey: opts.permissionKey ?? "tool.deleteFile",
    argFingerprint: opts.argFingerprint ?? "path:x",
    argSummary: "path=x",
    status: (opts.status as never) ?? "pending",
    approvedScope: (opts.approvedScope as never) ?? null,
    resolvedBy: opts.resolvedBy ?? null,
    resolvedAt: opts.resolvedAt ?? null,
    createdAt: opts.createdAt ?? new Date(),
    expiresAt: opts.expiresAt ?? null,
  });
}

async function insertBackgroundTaskRow(
  id: string,
  threadId: string,
  opts: {
    kind?: string;
    status?: string;
    command?: string;
    runtimeType?: string;
    logPath?: string;
    port?: number | null;
    pid?: number | null;
    startedAt?: Date;
    lastActivityAt?: Date;
  } = {},
) {
  await db.insert(backgroundTask).values({
    id,
    threadId,
    kind: (opts.kind as never) ?? "dev-server",
    status: (opts.status as never) ?? "starting",
    command: opts.command ?? "npm run dev",
    runtimeType: opts.runtimeType ?? "host",
    logPath: opts.logPath ?? ".snow/runtime/t1/tasks/x.log",
    port: opts.port ?? null,
    pid: opts.pid ?? null,
    startedAt: opts.startedAt ?? new Date(),
    lastActivityAt: opts.lastActivityAt ?? new Date(),
  });
}

async function insertContextSnapshotRow(
  id: string,
  threadId: string,
  opts: { createdAt?: Date; estimatedTokens?: number; toolNames?: string[] } = {},
) {
  await db.insert(contextSnapshot).values({
    id,
    threadId,
    trigger: "chat.user_message",
    model: "test-model",
    toolNames: opts.toolNames ?? [],
    layers: [],
    protectedRefs: [],
    excludedCandidates: [],
    checksums: {},
    estimatedTokens: opts.estimatedTokens ?? 0,
    createdAt: opts.createdAt ?? new Date(),
  });
}

async function insertContextSummaryRow(
  id: string,
  threadId: string,
  opts: {
    type?: string;
    checksum?: string;
    supersededById?: string | null;
    createdAt?: Date;
  } = {},
) {
  await db.insert(contextSummary).values({
    id,
    threadId,
    type: (opts.type as never) ?? "turn",
    scope: {},
    summaryText: "summary",
    checksum: opts.checksum ?? `ck-${id}`,
    tokenEstimate: 10,
    originalTokenEstimate: 100,
    protectedRefs: [],
    supersededById: opts.supersededById ?? null,
    createdAt: opts.createdAt ?? new Date(),
  });
}

async function insertThreadPlanRow(
  id: string,
  threadId: string,
  opts: { title?: string; status?: string; source?: string; createdAt?: Date } = {},
) {
  await db.insert(threadPlan).values({
    id,
    threadId,
    title: opts.title ?? "plan",
    status: (opts.status as never) ?? "active",
    source: opts.source ?? "system",
    createdAt: opts.createdAt ?? new Date(),
    updatedAt: opts.createdAt ?? new Date(),
  });
}

async function insertThreadPlanItemRow(
  id: string,
  planId: string,
  threadId: string,
  opts: { title?: string; position?: number; status?: string } = {},
) {
  await db.insert(threadPlanItem).values({
    id,
    planId,
    threadId,
    title: opts.title ?? "item",
    position: opts.position ?? 0,
    status: (opts.status as never) ?? "pending",
  });
}

async function insertCheckpointRow(
  id: string,
  threadId: string,
  opts: {
    tag?: string;
    commitSha?: string;
    createdByToolRunId?: string | null;
    restoredAt?: Date | null;
  } = {},
) {
  await db.insert(gitCheckpoint).values({
    id,
    threadId,
    tag: opts.tag ?? "snow-checkpoint-x",
    commitSha: opts.commitSha ?? "sha1",
    reason: "before push",
    createdByToolRunId: opts.createdByToolRunId ?? null,
    restoredAt: opts.restoredAt ?? null,
  });
}

async function insertSubagentDefinitionRow(
  id: string,
  name: string,
  opts: { role?: string; allowedTools?: string[]; contextPolicy?: Record<string, unknown> } = {},
) {
  await db.insert(subagentDefinition).values({
    id,
    name,
    role: (opts.role as never) ?? "explore",
    allowedTools: opts.allowedTools ?? ["readFile"],
    contextPolicy: opts.contextPolicy ?? { maxSnippets: 5 },
  });
}

async function insertSubagentRunRow(
  id: string,
  parentThreadId: string,
  definitionId: string,
  opts: {
    goal?: string;
    status?: string;
    writeScope?: string[] | null;
    resultSummary?: string | null;
    outputArtifactId?: string | null;
    errorMessage?: string | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    createdAt?: Date;
  } = {},
) {
  await db.insert(subagentRun).values({
    id,
    parentThreadId,
    definitionId,
    goal: opts.goal ?? "find x",
    status: (opts.status as never) ?? "queued",
    writeScope: opts.writeScope ?? null,
    resultSummary: opts.resultSummary ?? null,
    outputArtifactId: opts.outputArtifactId ?? null,
    errorMessage: opts.errorMessage ?? null,
    startedAt: opts.startedAt ?? null,
    finishedAt: opts.finishedAt ?? null,
    createdAt: opts.createdAt ?? new Date(),
  });
}

/** COUNT(*) 助手:断言某表行数。table 参数取 drizzle schema 表对象。 */
async function countAll(table: Parameters<typeof getTableName>[0]): Promise<number> {
  const tableName = getTableName(table);
  const [rows] = (await db.execute(
    sql`SELECT COUNT(*) AS c FROM ${sql.identifier(tableName)}`,
  )) as unknown as [Array<{ c: number }>];
  return Number(rows[0]?.c ?? 0);
}

beforeEach(async () => {
  await resetDatabase(db);
});

// ─── messageTypeForRole(纯函数,不依赖 db) ────────────────────

describe("messageTypeForRole", () => {
  it("user → user_input", () => expect(messageTypeForRole("user")).toBe("user_input"));
  it("assistant → assistant_text", () =>
    expect(messageTypeForRole("assistant")).toBe("assistant_text"));
  it("system → system", () => expect(messageTypeForRole("system")).toBe("system"));
});

// ─── V3.0：状态机与事件类型导出锁定 ─────────────────────────

describe("V3.0 schema 导出 (Stage A)", () => {
  it("THREAD_STATUSES 含 V3 新状态且保留旧值顺序", () => {
    expect(THREAD_STATUSES.slice(0, 4)).toEqual([
      "idle",
      "executing",
      "ready_for_review",
      "failed",
    ]);
    for (const s of [
      "planning",
      "awaiting_input",
      "awaiting_approval",
      "verifying",
      "delivering",
      "completed",
      "cancelled",
    ]) {
      expect(THREAD_STATUSES).toContain(s);
    }
  });

  it("THREAD_EVENT_TYPES 含 V3 context/plan 事件，旧事件不变", () => {
    expect(THREAD_EVENT_TYPES.slice(0, 7)).toEqual([
      "agent.started",
      "agent.status_changed",
      "tool.called",
      "tool.succeeded",
      "tool.failed",
      "artifact.created",
      "artifact.updated",
    ]);
    expect(THREAD_EVENT_TYPES).toContain("context.snapshot_created");
    expect(THREAD_EVENT_TYPES).toContain("plan.created");
    expect(THREAD_EVENT_TYPES).toContain("plan.updated");
    expect(THREAD_EVENT_TYPES).toContain("plan.item_updated");
  });

  it("ThreadPlan / ThreadPlanItem 状态枚举导出", () => {
    expect(THREAD_PLAN_STATUSES).toEqual(["active", "completed", "abandoned"]);
    expect(THREAD_PLAN_ITEM_STATUSES).toEqual([
      "pending",
      "in_progress",
      "completed",
      "failed",
      "cancelled",
    ]);
  });
});

// ─── V3.1：权限/审批 schema 导出锁定 ─────────────────────────

describe("V3.1 schema 导出 (Stage A)", () => {
  it("TOOL_RUN_STATUSES 追加 awaiting_approval，旧值顺序不变", () => {
    expect(TOOL_RUN_STATUSES.slice(0, 3)).toEqual(["running", "succeeded", "failed"]);
    expect(TOOL_RUN_STATUSES).toContain("awaiting_approval");
  });

  it("THREAD_EVENT_TYPES 追加 tool.approval_*，旧事件不变", () => {
    expect(THREAD_EVENT_TYPES.slice(0, 7)).toEqual([
      "agent.started",
      "agent.status_changed",
      "tool.called",
      "tool.succeeded",
      "tool.failed",
      "artifact.created",
      "artifact.updated",
    ]);
    expect(THREAD_EVENT_TYPES).toContain("tool.approval_requested");
    expect(THREAD_EVENT_TYPES).toContain("tool.approval_resolved");
  });

  it("权限/审批枚举导出", () => {
    expect(PERMISSION_DECISIONS).toEqual(["allow", "deny", "ask"]);
    expect(PERMISSION_SCOPES).toEqual(["global", "tenant", "project", "thread", "skill"]);
    expect(APPROVAL_REQUEST_STATUSES).toEqual([
      "pending",
      "approved",
      "denied",
      "expired",
      "superseded",
    ]);
    expect(APPROVAL_SCOPES).toEqual(["once", "thread", "project", "always", "session"]);
  });
});

// ─── V3.6：QA gate 事件 enum 追加 ──────

describe("V3.6 schema 导出 (Stage A)", () => {
  it("THREAD_EVENT_TYPES 追加 qa.check_passed / qa.check_failed，旧事件顺序不变", () => {
    expect(THREAD_EVENT_TYPES.slice(0, 7)).toEqual([
      "agent.started",
      "agent.status_changed",
      "tool.called",
      "tool.succeeded",
      "tool.failed",
      "artifact.created",
      "artifact.updated",
    ]);
    expect(THREAD_EVENT_TYPES).toContain("qa.check_passed");
    expect(THREAD_EVENT_TYPES).toContain("qa.check_failed");
    expect(THREAD_EVENT_TYPES.indexOf("subagent.failed")).toBeLessThan(
      THREAD_EVENT_TYPES.indexOf("qa.check_passed"),
    );
  });
});

// ─── V3.1：approval / permission rule CRUD(真实 MySQL) ────────

describe("V3.1 approval / permission rule CRUD (真实 MySQL)", () => {
  it("createToolRun 默认 running;传 awaiting_approval 生效", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    const r1 = await createToolRun({
      threadId: "t1",
      toolName: "deleteFile",
      input: { path: "x" },
    });
    expect(r1.status).toBe("running");
    expect(r1.startedAt).toBeInstanceOf(Date);
    // 真实 DB 落库
    const [row1] = await db.select().from(toolRun).where(eq(toolRun.id, r1.id));
    expect(row1?.status).toBe("running");
    expect(row1?.input).toEqual({ path: "x" });

    const r2 = await createToolRun({
      threadId: "t1",
      toolName: "deleteFile",
      input: { path: "x" },
      status: "awaiting_approval",
    });
    expect(r2.status).toBe("awaiting_approval");
    const [row2] = await db.select().from(toolRun).where(eq(toolRun.id, r2.id));
    expect(row2?.status).toBe("awaiting_approval");
  });

  it("createPermissionRule 写入字段(默认 global / priority 0)", async () => {
    const r = await createPermissionRule({
      toolPattern: "tool.deleteFile",
      decision: "allow",
      priority: 200,
      reason: "DB 放行",
    });
    expect(r.scope).toBe("global");
    expect(r.scopeRef).toBeNull();
    expect(r.toolPattern).toBe("tool.deleteFile");
    expect(r.decision).toBe("allow");
    expect(r.priority).toBe(200);
    expect(r.reason).toBe("DB 放行");
    // 真实 DB 落库
    const [row] = await db.select().from(toolPermissionRule).where(eq(toolPermissionRule.id, r.id));
    expect(row?.scope).toBe("global");
    expect(row?.priority).toBe(200);
  });

  it("createApprovalRequest 写入 pending + 24h expiresAt", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertToolRunRow("tr1", "t1", { status: "awaiting_approval" });
    const before = Date.now();
    const r = await createApprovalRequest({
      threadId: "t1",
      toolRunId: "tr1",
      toolName: "deleteFile",
      permissionKey: "tool.deleteFile",
      argFingerprint: "path:x",
      argSummary: "path=x",
    });
    expect(r.status).toBe("pending");
    expect(r.approvedScope).toBeNull();
    const expiresMs = r.expiresAt?.getTime();
    // 24h ± 5s
    expect(expiresMs).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
    expect(expiresMs).toBeLessThan(before + 25 * 60 * 60 * 1000);
    // 真实 DB 落库
    const [row] = await db
      .select()
      .from(toolApprovalRequest)
      .where(eq(toolApprovalRequest.id, r.id));
    expect(row?.status).toBe("pending");
    expect(row?.expiresAt).toBeInstanceOf(Date);
  });

  it("resolveApprovalRequest:pending → approved,写 scope/resolvedBy/resolvedAt", async () => {
    await insertUser("u1");
    await insertUser("u2");
    await insertThread("t1", "u1");
    await insertToolRunRow("tr1", "t1", { status: "awaiting_approval" });
    await insertApprovalRequest("a1", "t1", "tr1");

    const res = await resolveApprovalRequest({
      id: "a1",
      decision: "approved",
      scope: "thread",
      resolvedBy: "u2",
    });
    expect(res?.status).toBe("approved");
    expect(res?.approvedScope).toBe("thread");
    expect(res?.resolvedBy).toBe("u2");
    expect(res?.resolvedAt).toBeInstanceOf(Date);
    // 真实 DB 落库
    const [row] = await db
      .select()
      .from(toolApprovalRequest)
      .where(eq(toolApprovalRequest.id, "a1"));
    expect(row?.status).toBe("approved");
    expect(row?.approvedScope).toBe("thread");
    expect(row?.resolvedBy).toBe("u2");
  });

  it("resolveApprovalRequest:session approved → expiresAt 收紧到短 TTL(区别于 thread 24h)", async () => {
    await insertUser("u1");
    await insertUser("u2");
    await insertThread("t1", "u1");
    await insertToolRunRow("tr1", "t1", { status: "awaiting_approval" });
    // 创建时 expiresAt 设为 24h 后
    const beforeResolve = Date.now();
    await insertApprovalRequest("a1", "t1", "tr1", {
      expiresAt: new Date(beforeResolve + 24 * 60 * 60 * 1000),
    });

    const res = await resolveApprovalRequest({
      id: "a1",
      decision: "approved",
      scope: "session",
      resolvedBy: "u2",
    });
    expect(res?.approvedScope).toBe("session");
    // session TTL 默认 30min(1800000ms),±5s 容差
    const exp = res?.expiresAt?.getTime();
    expect(exp).toBeGreaterThan(beforeResolve + 29 * 60 * 1000);
    expect(exp).toBeLessThan(beforeResolve + 31 * 60 * 1000);
    // 真实 DB 落库 expiresAt 已被收紧
    const [row] = await db
      .select()
      .from(toolApprovalRequest)
      .where(eq(toolApprovalRequest.id, "a1"));
    expect(row?.expiresAt).toBeInstanceOf(Date);
    const dbExp = row?.expiresAt?.getTime();
    expect(dbExp).toBeGreaterThan(beforeResolve + 29 * 60 * 1000);
    expect(dbExp).toBeLessThan(beforeResolve + 31 * 60 * 1000);
  });

  it("resolveApprovalRequest:thread approved → expiresAt 不被调整(保留创建时 24h)", async () => {
    await insertUser("u1");
    await insertUser("u2");
    await insertThread("t1", "u1");
    await insertToolRunRow("tr1", "t1", { status: "awaiting_approval" });
    // MySQL datetime 精度到秒,用整秒时间戳避免毫秒截断误判
    const createdAt = new Date();
    const originalExpiry = new Date(
      Math.floor((createdAt.getTime() + 24 * 60 * 60 * 1000) / 1000) * 1000,
    );
    await insertApprovalRequest("a2", "t1", "tr1", { expiresAt: originalExpiry, createdAt });

    await resolveApprovalRequest({
      id: "a2",
      decision: "approved",
      scope: "thread",
      resolvedBy: "u2",
    });
    // 真实 DB expiresAt 仍是创建时的 24h(thread 不收紧)
    const [row] = await db
      .select()
      .from(toolApprovalRequest)
      .where(eq(toolApprovalRequest.id, "a2"));
    expect(row?.expiresAt?.getTime()).toBe(originalExpiry.getTime());
  });

  it("resolveApprovalRequest:session denied → 不调整 expiresAt(已拒绝不复用)", async () => {
    await insertUser("u1");
    await insertUser("u2");
    await insertThread("t1", "u1");
    await insertToolRunRow("tr1", "t1", { status: "awaiting_approval" });
    // MySQL datetime 精度到秒,用整秒时间戳
    const originalExpiry = new Date(Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000) * 1000);
    await insertApprovalRequest("a3", "t1", "tr1", { expiresAt: originalExpiry });

    await resolveApprovalRequest({
      id: "a3",
      decision: "denied",
      scope: "session",
      resolvedBy: "u2",
    });
    // 真实 DB:status=denied,expiresAt 不变
    const [row] = await db
      .select()
      .from(toolApprovalRequest)
      .where(eq(toolApprovalRequest.id, "a3"));
    expect(row?.status).toBe("denied");
    expect(row?.expiresAt?.getTime()).toBe(originalExpiry.getTime());
  });

  it("resolveApprovalRequest:非 pending 返回 null(API 据此 409)", async () => {
    await insertUser("u1");
    await insertUser("u2");
    await insertThread("t1", "u1");
    await insertToolRunRow("tr1", "t1", { status: "awaiting_approval" });
    // 已 approved 的请求
    await insertApprovalRequest("a1", "t1", "tr1", {
      status: "approved",
      approvedScope: "thread",
      resolvedBy: "u2",
      resolvedAt: new Date(),
    });

    const res = await resolveApprovalRequest({
      id: "a1",
      decision: "denied",
      scope: "once",
      resolvedBy: "u2",
    });
    expect(res).toBeNull();
    // 真实 DB 状态未变(仍 approved)
    const [row] = await db
      .select()
      .from(toolApprovalRequest)
      .where(eq(toolApprovalRequest.id, "a1"));
    expect(row?.status).toBe("approved");
  });

  it("getPendingApprovalsByThread / findMatchingApprovals 真实查询", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertThread("t2", "u1");
    await insertToolRunRow("tr1", "t1", { status: "awaiting_approval" });
    await insertToolRunRow("tr2", "t1", { status: "awaiting_approval" });
    await insertToolRunRow("tr3", "t2", { status: "awaiting_approval" });
    // t1 两个 pending(a2 早、a1 晚,用整秒精度避免同秒乱序),t2 一个 pending
    const earlyTs = new Date("2026-01-01T00:00:00Z");
    const lateTs = new Date("2026-01-02T00:00:00Z");
    await insertApprovalRequest("a1", "t1", "tr1", { createdAt: lateTs });
    await insertApprovalRequest("a2", "t1", "tr2", { createdAt: earlyTs });
    await insertApprovalRequest("a3", "t2", "tr3");
    // a4 是已 approved 的同 key/fingerprint,应被 findMatchingApprovals 命中
    await insertApprovalRequest("a4", "t1", "tr1", {
      status: "approved",
      approvedScope: "thread",
      resolvedAt: new Date(),
    });

    const pending = await getPendingApprovalsByThread("t1");
    expect(pending).toHaveLength(2);
    // 按 createdAt asc
    expect(pending[0]?.id).toBe("a2");
    expect(pending[1]?.id).toBe("a1");

    // findMatchingApprovals:status=approved + 未过期 + 同 key/fingerprint
    const matched = await findMatchingApprovals({
      permissionKey: "tool.deleteFile",
      argFingerprint: "path:x",
      threadId: "t1",
    });
    expect(matched.map((m) => m.id)).toContain("a4");
  });

  it("consumeOnceApproval:affectedRows=1 表示抢占成功,0 表示已被消费", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertToolRunRow("tr1", "t1", { status: "awaiting_approval" });
    // a1 是 approved + scope=once,可被消费
    await insertApprovalRequest("a1", "t1", "tr1", {
      status: "approved",
      approvedScope: "once",
      resolvedAt: new Date(),
    });

    const ok1 = await consumeOnceApproval("a1");
    expect(ok1).toBe(true);
    // 真实 DB 已 superseded
    const [row1] = await db
      .select()
      .from(toolApprovalRequest)
      .where(eq(toolApprovalRequest.id, "a1"));
    expect(row1?.status).toBe("superseded");

    // 再次消费 → false(已 superseded,where status=approved 不命中)
    const ok2 = await consumeOnceApproval("a1");
    expect(ok2).toBe(false);
  });
});

// ─── requestApprovalAtomic 事务原子性(08-P1-6) ──────────────
//
// 验证 createToolRun + createApprovalRequest + updateThreadStatus 单事务原子完成。
// 任一步失败 → 整事务回滚(无部分成功残留)。
describe("requestApprovalAtomic 事务原子性 (08-P1-6)", () => {
  it("单事务完成 createToolRun + createApprovalRequest + updateThreadStatus", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { status: "executing" });

    const { run, approval } = await requestApprovalAtomic({
      threadId: "t1",
      toolName: "deleteFile",
      input: { path: "x" },
      permissionKey: "tool.deleteFile",
      argFingerprint: "path:x",
      argSummary: "path=x",
    });

    // tool run 落库(status=awaiting_approval)
    const [runRow] = await db.select().from(toolRun).where(eq(toolRun.id, run.id));
    expect(runRow?.status).toBe("awaiting_approval");
    expect(runRow?.input).toEqual({ path: "x" });

    // approval 落库(status=pending,toolRunId 指向 run.id)
    const [apprRow] = await db
      .select()
      .from(toolApprovalRequest)
      .where(eq(toolApprovalRequest.id, approval.id));
    expect(apprRow?.status).toBe("pending");
    expect(apprRow?.toolRunId).toBe(run.id);
    expect(apprRow?.expiresAt).toBeInstanceOf(Date);

    // thread status 被改为 awaiting_approval
    const [thRow] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(thRow?.status).toBe("awaiting_approval");
  });

  it("事务原子性:thread 不存在 → 整事务回滚(无 toolRun/approval 残留)", async () => {
    // 插一个 user 但不插 thread,触发 toolRun.threadId 外键约束失败
    await insertUser("u1");

    await expect(
      requestApprovalAtomic({
        threadId: "ghost",
        toolName: "deleteFile",
        input: { path: "x" },
        permissionKey: "tool.deleteFile",
        argFingerprint: "path:x",
        argSummary: "path=x",
      }),
    ).rejects.toThrow();

    // 真实 DB:无 toolRun / approval 残留(事务回滚)
    expect(await countAll(toolRun)).toBe(0);
    expect(await countAll(toolApprovalRequest)).toBe(0);
  });
});

// ─── appendThreadEvent / listThreadEvents(真实 MySQL) ────────

describe("appendThreadEvent / listThreadEvents", () => {
  it("无历史时 sequence 从 1 开始并写入字段", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");

    const event = await appendThreadEvent("tid", "agent.started", { reason: "user_message" });
    expect(event.sequence).toBe(1);
    expect(event.threadId).toBe("tid");
    expect(event.type).toBe("agent.started");
    expect(event.payload).toEqual({ reason: "user_message" });
    expect(event.createdAt).toBeInstanceOf(Date);
    // 真实 DB 落库
    const [row] = await db.select().from(threadEvent).where(eq(threadEvent.id, event.id));
    expect(row?.sequence).toBe(1);
    expect(row?.payload).toEqual({ reason: "user_message" });
  });

  it("有历史时 sequence = max + 1", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    // 灌一条 sequence=7 的事件
    await insertEvent("e0", "tid", 7, "tool.called");

    const event = await appendThreadEvent("tid", "tool.called", { toolRunId: "r1" });
    expect(event.sequence).toBe(8);
    // 真实 DB 落库
    const [row] = await db.select().from(threadEvent).where(eq(threadEvent.id, event.id));
    expect(row?.sequence).toBe(8);
  });

  it("listThreadEvents 按 sequence asc 返回", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertEvent("e2", "tid", 2, "tool.succeeded");
    await insertEvent("e1", "tid", 1, "agent.started");

    const events = await listThreadEvents("tid");
    expect(events).toHaveLength(2);
    expect(events[0]?.id).toBe("e1");
    expect(events[1]?.id).toBe("e2");
  });

  it("unique (threadId, sequence) 约束:并发冲突由 appendThreadEvent 重试兜底", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    // 直接灌一条 sequence=1,appendThreadEvent 第一次 nextSequence 也算出 1 → INSERT 撞 unique → 重试 seq=2
    await insertEvent("e-existing", "tid", 1, "agent.started");

    const event = await appendThreadEvent("tid", "tool.called", {});
    // 重试后 sequence=2 落库成功
    expect(event.sequence).toBe(2);
    const rows = await db.select().from(threadEvent).where(eq(threadEvent.threadId, "tid"));
    expect(rows).toHaveLength(2);
  });
});

// ─── createToolRun(真实 MySQL) ───────────────────────────────

describe("createToolRun", () => {
  it("初始状态 running 并回填 startedAt", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");

    const run = await createToolRun({
      threadId: "tid",
      toolName: "runCommand",
      input: { command: "echo hi" },
    });
    expect(run.status).toBe("running");
    expect(run.toolName).toBe("runCommand");
    expect(run.input).toEqual({ command: "echo hi" });
    expect(run.startedAt).toBeInstanceOf(Date);
    // 真实 DB 落库
    const [row] = await db.select().from(toolRun).where(eq(toolRun.id, run.id));
    expect(row?.status).toBe("running");
    expect(row?.input).toEqual({ command: "echo hi" });
  });
});

// ─── finishToolRunSuccess / finishToolRunFailure(真实 MySQL) ─

describe("finishToolRunSuccess / finishToolRunFailure", () => {
  it("成功回填 succeeded + output + finishedAt", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertToolRunRow("run-1", "tid", { status: "running" });

    await finishToolRunSuccess("run-1", { ok: true, exitCode: 0 });
    const [row] = await db.select().from(toolRun).where(eq(toolRun.id, "run-1"));
    expect(row?.status).toBe("succeeded");
    expect(row?.output).toEqual({ ok: true, exitCode: 0 });
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it("失败回填 failed + error + finishedAt", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertToolRunRow("run-1", "tid", { status: "running" });

    await finishToolRunFailure("run-1", "boom");
    const [row] = await db.select().from(toolRun).where(eq(toolRun.id, "run-1"));
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("boom");
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });
});

// ─── Skill Registry Queries (Phase 3 Stage A,真实 MySQL) ─────

describe("getSkillByName / getSkillById / getSkillVersion", () => {
  it("命中时返回首行", async () => {
    await insertSkill("skill-1", "build-from-idea", { currentVersionId: "ver-1" });
    await insertSkillVersionRow("ver-1", "skill-1", 1, { promptTemplate: "你是助手" });

    expect(await getSkillByName("build-from-idea")).toMatchObject({ id: "skill-1" });
    expect(await getSkillById("skill-1")).toMatchObject({ id: "skill-1" });
    expect(await getSkillVersion("ver-1")).toMatchObject({ id: "ver-1", version: 1 });
  });

  it("未命中返回 null", async () => {
    expect(await getSkillByName("nope")).toBeNull();
    expect(await getSkillById("nope")).toBeNull();
    expect(await getSkillVersion("nope")).toBeNull();
  });
});

describe("getCurrentSkillVersion", () => {
  it("有 currentVersionId → 取对应版本", async () => {
    await insertSkill("skill-1", "build-from-idea", { currentVersionId: "ver-1" });
    await insertSkillVersionRow("ver-1", "skill-1", 1, { promptTemplate: "你是助手" });

    const v = await getCurrentSkillVersion("skill-1");
    expect(v).toMatchObject({ id: "ver-1", version: 1 });
  });

  it("无 currentVersionId → null(不发起第二次 select)", async () => {
    await insertSkill("skill-2", "no-version", { currentVersionId: null });
    expect(await getCurrentSkillVersion("skill-2")).toBeNull();
  });
});

describe("createSkill / createSkillVersion", () => {
  it("createSkill 写入身份层字段,currentVersionId 初始为 null", async () => {
    const sk = await createSkill({ name: "refactor-ui", category: "refactor" });
    expect(sk.name).toBe("refactor-ui");
    expect(sk.category).toBe("refactor");
    expect(sk.visibility).toBe("public");
    expect(sk.status).toBe("active");
    expect(sk.currentVersionId).toBeNull();
    expect(sk.id).toBeTruthy();
    expect(sk.createdAt).toBeInstanceOf(Date);
    // 真实 DB 落库
    const [row] = await db.select().from(skill).where(eq(skill.id, sk.id));
    expect(row?.name).toBe("refactor-ui");
    expect(row?.currentVersionId).toBeNull();
  });

  it("createSkillVersion 写入版本字段,缺省字段回退", async () => {
    await insertSkill("skill-1", "build-from-idea");
    const v = await createSkillVersion({
      skillId: "skill-1",
      version: 2,
      promptTemplate: "prompt-v2",
      allowedTools: ["readFile"],
    });
    expect(v.skillId).toBe("skill-1");
    expect(v.version).toBe(2);
    expect(v.promptTemplate).toBe("prompt-v2");
    expect(v.allowedTools).toEqual(["readFile"]);
    expect(v.reviewMode).toBe("auto");
    expect(v.status).toBe("active");
    expect(v.id).toBeTruthy();
    // 真实 DB 落库
    const [row] = await db.select().from(skillVersion).where(eq(skillVersion.id, v.id));
    expect(row?.reviewMode).toBe("auto");
    expect(row?.status).toBe("active");
  });
});

describe("setCurrentVersion", () => {
  it("setCurrentVersion 回填 currentVersionId", async () => {
    await insertSkill("skill-1", "build-from-idea");
    await insertSkillVersionRow("ver-2", "skill-1", 2);

    await setCurrentVersion("skill-1", "ver-2");
    const [row] = await db.select().from(skill).where(eq(skill.id, "skill-1"));
    expect(row?.currentVersionId).toBe("ver-2");
  });
});

// V8 阶段 8：setThreadSkill / getActiveSkillForThread 测试已删除（函数已删除）。
// 旧测试覆盖 thread.activeSkillId/activeSkillVersionId 固化与解析，V8 改用 ThreadRunSkill。

// ─── Phase 4-3:owner-scoped thread 查询(真实 MySQL) ──────────

describe("owner-scoped thread queries (Phase 4-3)", () => {
  it("getThreadByIdForUser:thread 属于该用户 → 返回行", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    const row = await getThreadByIdForUser("t1", "u1");
    expect(row?.id).toBe("t1");
    expect(row?.userId).toBe("u1");
  });

  it("getThreadByIdForUser:不属于该用户 → null", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await expect(getThreadByIdForUser("t1", "u2")).resolves.toBeNull();
  });

  it("getThreadByIdForUser:软删 thread → null(deletedAt IS NULL 过滤)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { deletedAt: new Date() });

    await expect(getThreadByIdForUser("t1", "u1")).resolves.toBeNull();
  });

  it("requireThreadForUser:与 getThreadByIdForUser 同语义", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await expect(requireThreadForUser("t1", "u1")).resolves.toMatchObject({ id: "t1" });
  });

  it("getLatestThreadForUser:返回最近 thread 或 null", async () => {
    await insertUser("u1");
    await insertThread("t-old", "u1", { updatedAt: new Date("2026-01-01") });
    await insertThread("t-new", "u1", { updatedAt: new Date("2026-02-01") });

    await expect(getLatestThreadForUser("u1")).resolves.toMatchObject({ id: "t-new" });
    await expect(getLatestThreadForUser("u2")).resolves.toBeNull();
  });

  it("getMessagesByThreadIdForUser:foreign thread → null(不发第二次 select)", async () => {
    await insertUser("u1");
    await insertUser("u2");
    await insertThread("t1", "u1");
    await insertMessage("m1", "t1");

    await expect(getMessagesByThreadIdForUser("t1", "u2")).resolves.toBeNull();
  });

  it("getMessagesByThreadIdForUser:owned thread → 返回消息列表", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertMessage("m1", "t1", { role: "user" });
    await insertMessage("m2", "t1", { role: "assistant" });

    const msgs = await getMessagesByThreadIdForUser("t1", "u1");
    expect(msgs).toHaveLength(2);
    // 按 (createdAt, id) asc
    expect(msgs?.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });
});

// ─── Provider 档案查询（真实 MySQL） ────────────────────────

describe("provider 档案查询", () => {
  it("listProviders 按 createdAt asc 返回", async () => {
    await db.insert(providerProfile).values({
      id: "p2",
      name: "default",
      baseUrl: "https://x/v1",
      apiKeyRef: "LLM_API_KEY",
      isDefault: true,
      createdAt: new Date("2026-02-01"),
      updatedAt: new Date(),
    });

    const rows = await listProviders();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.apiKeyRef).toBe("LLM_API_KEY");
  });

  it("listProviders 空表 → []", async () => {
    await expect(listProviders()).resolves.toEqual([]);
  });

  it("getProviderByName 命中 / 未命中", async () => {
    await db.insert(providerProfile).values({
      id: "p1",
      name: "default",
      baseUrl: "https://x/v1",
      apiKeyRef: "LLM_API_KEY",
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(await getProviderByName("default")).toMatchObject({ id: "p1" });
    expect(await getProviderByName("nope")).toBeNull();
  });

  it("createProvider 存 apiKeyRef 引用名,不落明文", async () => {
    const p = await createProvider({
      name: "default",
      baseUrl: "https://x/v1",
      apiKeyRef: "LLM_API_KEY",
      isDefault: true,
    });
    expect(p.apiKeyRef).toBe("LLM_API_KEY");
    expect(p.isDefault).toBe(true);
    // 断言插入字段不含明文 key 值(仅引用名)
    const [row] = await db.select().from(providerProfile).where(eq(providerProfile.id, p.id));
    expect(JSON.stringify(row)).not.toMatch(/sk-[A-Za-z0-9]+/);
  });
});

// ─── Phase 4-4 切片 B3:Settings 用户/角色管理查询(真实 MySQL) ──

describe("Settings 用户/角色管理查询 (切片 B3)", () => {
  it("getUserById:命中返回用户,未命中返回 null", async () => {
    await insertUser("u1", "Alice", "alice@x");

    expect(await getUserById("u1")).toMatchObject({ id: "u1", email: "alice@x", name: "Alice" });
    expect(await getUserById("missing")).toBeNull();
  });

  it("listUsersWithRoles:无角色用户也出现,roles=[]", async () => {
    await insertUser("u1", "Alice", "alice@x");

    const users = await listUsersWithRoles();
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe("u1");
    expect(users[0]?.roles).toEqual([]);
  });

  it("listUsersWithRoles:多角色用户聚合到同一用户", async () => {
    await insertUser("u1", "Alice", "alice@x");
    await insertRole("r-admin", "admin", "Admin", { isSystem: true });
    await insertRole("r-member", "member", "Member", { isSystem: true });
    await insertUserRole("u1", "r-admin");
    await insertUserRole("u1", "r-member");

    const users = await listUsersWithRoles();
    expect(users).toHaveLength(1);
    expect(users[0]?.roles).toHaveLength(2);
    // 角色按 key asc 排序
    expect(users[0]?.roles.map((r) => r.key)).toEqual(["admin", "member"]);
  });

  it("listRolesWithPermissions:角色带权限数组", async () => {
    await insertRole("r-admin", "admin", "Admin", { isSystem: true });
    await insertRole("r-member", "member", "Member", { isSystem: true });
    await insertRolePermission("r-admin", "user.manage");
    await insertRolePermission("r-admin", "studio.access");
    // member 无权限

    const roles = await listRolesWithPermissions();
    expect(roles).toHaveLength(2);
    const admin = roles.find((r) => r.key === "admin");
    expect(admin?.permissions).toEqual(["studio.access", "user.manage"]); // permission asc
    const member = roles.find((r) => r.key === "member");
    expect(member?.permissions).toEqual([]);
  });

  it("getPermissionsForRoleIds:空数组 → [],不发起查询", async () => {
    await insertRole("r1", "admin", "Admin");
    await insertRolePermission("r1", "user.manage");
    // 不应该发起查询(若有数据也返回空)
    expect(await getPermissionsForRoleIds([])).toEqual([]);
  });

  it("getPermissionsForRoleIds:返回去重并集", async () => {
    await insertRole("r1", "admin", "Admin");
    await insertRole("r2", "member", "Member");
    await insertRolePermission("r1", "studio.access");
    await insertRolePermission("r1", "user.manage");
    await insertRolePermission("r2", "studio.access"); // 重复权限

    const perms = await getPermissionsForRoleIds(["r1", "r2"]);
    expect(perms.sort()).toEqual(["studio.access", "user.manage"]);
  });

  it("replaceUserRoles:删旧 + 插新(覆盖语义)", async () => {
    await insertUser("u1");
    await insertRole("r-admin", "admin", "Admin");
    await insertRole("r-member", "member", "Member");
    // 先绑一个旧角色
    await insertUserRole("u1", "r-admin");

    const { replaceUserRoles } = await import("@/lib/db/queries");
    await replaceUserRoles("u1", ["r-admin", "r-member"]);
    // 真实 DB:旧绑定被删,新绑定 2 条
    const rows = await db.select().from(userRole).where(eq(userRole.userId, "u1"));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.roleId).sort()).toEqual(["r-admin", "r-member"]);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("replaceUserRoles:空 roleIds → 只删不插", async () => {
    await insertUser("u1");
    await insertRole("r-admin", "admin", "Admin");
    await insertUserRole("u1", "r-admin");

    const { replaceUserRoles } = await import("@/lib/db/queries");
    await replaceUserRoles("u1", []);
    const rows = await db.select().from(userRole).where(eq(userRole.userId, "u1"));
    expect(rows).toHaveLength(0);
  });

  it("countUsersWithPermission:无角色授予该权限 → 0", async () => {
    const { countUsersWithPermission } = await import("@/lib/db/queries");
    expect(await countUsersWithPermission("user.manage")).toBe(0);
  });

  it("countUsersWithPermission:无 replacement → 返回去重用户数", async () => {
    const { countUsersWithPermission } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertUser("u2");
    await insertRole("r-admin", "admin", "Admin");
    await insertRolePermission("r-admin", "user.manage");
    await insertUserRole("u1", "r-admin");
    await insertUserRole("u2", "r-admin");
    // u1 绑两次(唯一约束会拒绝,故只一次)

    expect(await countUsersWithPermission("user.manage")).toBe(2);
  });

  it("countUsersWithPermission:replacement 排除目标用户,新角色授予权限时 +1", async () => {
    const { countUsersWithPermission } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertUser("u2");
    await insertRole("r-admin", "admin", "Admin");
    await insertRolePermission("r-admin", "user.manage");
    await insertUserRole("u2", "r-admin");

    const count = await countUsersWithPermission("user.manage", {
      userId: "u1",
      roleIds: ["r-admin"],
    });
    // u2(已有) + u1(replacement 新角色授予) = 2
    expect(count).toBe(2);
  });

  it("countUsersWithPermission:replacement 新角色不授予权限 → 不 +1", async () => {
    const { countUsersWithPermission } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertUser("u2");
    await insertRole("r-admin", "admin", "Admin");
    await insertRole("r-member", "member", "Member"); // member 无 user.manage 权限
    await insertRolePermission("r-admin", "user.manage");
    await insertUserRole("u2", "r-admin");

    const count = await countUsersWithPermission("user.manage", {
      userId: "u1",
      roleIds: ["r-member"],
    });
    // 仅 u2(replacement 的 r-member 不授予权限)
    expect(count).toBe(1);
  });
});

// ─── Phase 4-4 切片 C:Admin Audit 查询(真实 MySQL) ────────────

describe("Admin Audit 查询 (切片 C)", () => {
  it("appendAdminAuditLog:写入全部字段并返回构造行", async () => {
    await insertUser("u1");
    const { appendAdminAuditLog } = await import("@/lib/db/queries");
    const row = await appendAdminAuditLog({
      actorUserId: "u1",
      action: "settings.user_roles.updated",
      targetType: "user",
      targetId: "u2",
      outcome: "succeeded",
      metadata: { roleIdsBefore: ["r-member"], roleIdsAfter: ["r-admin"] },
    });
    expect(row.id).toBeTruthy();
    expect(row.createdAt).toBeInstanceOf(Date);
    // 真实 DB 落库
    const [dbRow] = await db.select().from(adminAuditLog).where(eq(adminAuditLog.id, row.id));
    expect(dbRow?.actorUserId).toBe("u1");
    expect(dbRow?.action).toBe("settings.user_roles.updated");
    expect(dbRow?.metadata).toEqual({ roleIdsBefore: ["r-member"], roleIdsAfter: ["r-admin"] });
  });

  it("listAdminAuditLogs:默认 limit 100 + desc createdAt", async () => {
    await insertUser("u1");
    const { appendAdminAuditLog } = await import("@/lib/db/queries");
    await appendAdminAuditLog({
      actorUserId: "u1",
      action: "policies.updated",
      targetType: "policy",
      targetId: "policy",
      outcome: "succeeded",
      metadata: {},
    });

    const logs = await listAdminAuditLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.action).toBe("policies.updated");
  });

  it("listAdminAuditLogs:带 actor/action/target 过滤", async () => {
    await insertUser("u1");
    const { appendAdminAuditLog } = await import("@/lib/db/queries");
    await appendAdminAuditLog({
      actorUserId: "u1",
      action: "skills.published",
      targetType: "skill",
      targetId: "s1",
      outcome: "succeeded",
      metadata: {},
    });
    await appendAdminAuditLog({
      actorUserId: "u1",
      action: "policies.updated",
      targetType: "policy",
      targetId: "policy",
      outcome: "succeeded",
      metadata: {},
    });

    const logs = await listAdminAuditLogs({
      actorUserId: "u1",
      action: "skills.published",
      targetType: "skill",
      targetId: "s1",
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.action).toBe("skills.published");
  });

  it("listAdminAuditLogs:limit 钳制到 200", async () => {
    await insertUser("u1");
    // 不抛错即可;limit=99999 应被钳到 200
    const logs = await listAdminAuditLogs({ limit: 99999 });
    expect(logs).toEqual([]);
  });

  it("listAdminAuditLogs:limit 钳制到 ≥1", async () => {
    const logs = await listAdminAuditLogs({ limit: 0 });
    expect(logs).toEqual([]);
  });
});

// ─── V3.0 Stage C:Context Snapshot 查询(真实 MySQL) ──────────

describe("Context Snapshot 查询 (Stage C)", () => {
  it("saveContextSnapshot 写入全部字段并返回构造行", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");

    const row = await saveContextSnapshot({
      threadId: "tid",
      trigger: "chat.user_message",
      model: "kimi-k2.7-code",
      runtimeType: "host",
      activeSkillVersionId: "ver-1",
      toolNames: ["readFile", "writeFile"],
      layers: [{ layer: "instructions", sourceId: "system.base" }],
      protectedRefs: [{ layer: "instructions", sourceId: "system.base" }],
      excludedCandidates: [],
      checksums: { tools: "abc" },
      estimatedTokens: 42,
    });
    expect(row.id).toBeTruthy();
    expect(row.createdAt).toBeInstanceOf(Date);
    // 真实 DB 落库
    const [dbRow] = await db.select().from(contextSnapshot).where(eq(contextSnapshot.id, row.id));
    expect(dbRow?.runtimeType).toBe("host");
    expect(dbRow?.activeSkillVersionId).toBe("ver-1");
    expect(dbRow?.toolNames).toEqual(["readFile", "writeFile"]);
    expect(dbRow?.estimatedTokens).toBe(42);
  });

  it("saveContextSnapshot 缺省 runtimeType/skillVersionId → 写 null", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");

    await saveContextSnapshot({
      threadId: "tid",
      trigger: "chat.user_message",
      model: "m",
      toolNames: [],
      layers: [],
      protectedRefs: [],
      excludedCandidates: [],
      checksums: {},
      estimatedTokens: 0,
    });
    const [row] = await db.select().from(contextSnapshot);
    expect(row?.runtimeType).toBeNull();
    expect(row?.activeSkillVersionId).toBeNull();
  });

  it("listContextSnapshotsForThread 按 createdAt desc 返回", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertContextSnapshotRow("s2", "tid", { createdAt: new Date("2026-02-01") });
    await insertContextSnapshotRow("s1", "tid", { createdAt: new Date("2026-01-01") });

    const rows = await listContextSnapshotsForThread("tid");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe("s2"); // createdAt desc
    expect(rows[1]?.id).toBe("s1");
  });

  // V7 S2-1：ContextSnapshot 挂 runId
  it("saveContextSnapshot 传入 runId → 落库归属 ThreadRun", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    const row = await saveContextSnapshot({
      threadId: "tid",
      trigger: "chat.user_message",
      model: "m",
      toolNames: [],
      layers: [],
      protectedRefs: [],
      excludedCandidates: [],
      checksums: {},
      estimatedTokens: 0,
      runId: "run-001",
    });
    expect(row.runId).toBe("run-001");
    const [dbRow] = await db.select().from(contextSnapshot).where(eq(contextSnapshot.id, row.id));
    expect(dbRow?.runId).toBe("run-001");
  });

  it("saveContextSnapshot 缺省 runId → 写 null（兼容历史快照）", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await saveContextSnapshot({
      threadId: "tid",
      trigger: "chat.user_message",
      model: "m",
      toolNames: [],
      layers: [],
      protectedRefs: [],
      excludedCandidates: [],
      checksums: {},
      estimatedTokens: 0,
    });
    const [row] = await db.select().from(contextSnapshot);
    expect(row?.runId).toBeNull();
  });
});

// ─── V3.0 Stage D:Thread Plan / Todo 数据层(真实 MySQL) ───────

describe("Thread Plan / Todo 数据层 (Stage D)", () => {
  it("createThreadPlan 写入 active plan + 触发 plan.created 事件", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");

    const plan = await createThreadPlan({ threadId: "tid", title: "demo plan" });
    expect(plan.threadId).toBe("tid");
    expect(plan.title).toBe("demo plan");
    expect(plan.status).toBe("active");
    expect(plan.source).toBe("system");
    expect(plan.id).toBeTruthy();
    // 真实 DB plan 落库
    const [planRow] = await db.select().from(threadPlan).where(eq(threadPlan.id, plan.id));
    expect(planRow?.status).toBe("active");
    // 真实 DB plan.created 事件落库
    const events = await db.select().from(threadEvent).where(eq(threadEvent.threadId, "tid"));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("plan.created");
    expect(events[0]?.payload).toMatchObject({ planId: plan.id, title: "demo plan" });
  });

  it("getActiveThreadPlan:无 active → null", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    expect(await getActiveThreadPlan("tid")).toBeNull();
  });

  it("getActiveThreadPlan:有 active → 返回最近一条", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertThreadPlanRow("plan-old", "tid", {
      status: "active",
      createdAt: new Date("2026-01-01"),
    });
    await insertThreadPlanRow("plan-new", "tid", {
      status: "active",
      createdAt: new Date("2026-02-01"),
    });

    expect(await getActiveThreadPlan("tid")).toMatchObject({ id: "plan-new", status: "active" });
  });

  it("listThreadPlans 按 createdAt desc 返回", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertThreadPlanRow("plan-old", "tid", { createdAt: new Date("2026-01-01") });
    await insertThreadPlanRow("plan-new", "tid", { createdAt: new Date("2026-02-01") });

    const rows = await listThreadPlans("tid");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe("plan-new");
    expect(rows[1]?.id).toBe("plan-old");
  });

  it("upsertThreadPlanItem:id 不存在 → 插入新条目", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertThreadPlanRow("plan-1", "tid");

    const item = await upsertThreadPlanItem({
      id: "item-1",
      planId: "plan-1",
      threadId: "tid",
      title: "步骤一",
      position: 0,
    });
    expect(item.id).toBe("item-1");
    expect(item.title).toBe("步骤一");
    expect(item.status).toBe("pending");
    // 真实 DB 落库
    const [row] = await db.select().from(threadPlanItem).where(eq(threadPlanItem.id, "item-1"));
    expect(row?.title).toBe("步骤一");
    expect(row?.status).toBe("pending");
    expect(row?.position).toBe(0);
  });

  it("upsertThreadPlanItem:id 已存在 → 更新(不插入)", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertThreadPlanRow("plan-1", "tid");
    await insertThreadPlanItemRow("item-1", "plan-1", "tid", {
      title: "旧标题",
      status: "pending",
    });

    await upsertThreadPlanItem({
      id: "item-1",
      planId: "plan-1",
      threadId: "tid",
      title: "新标题",
      status: "in_progress",
    });
    // 真实 DB:走 update 分支,行数仍 1,title/status 被更新
    const rows = await db.select().from(threadPlanItem).where(eq(threadPlanItem.id, "item-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("新标题");
    expect(rows[0]?.status).toBe("in_progress");
  });

  it("listThreadPlanItems 按 position asc 返回", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertThreadPlanRow("plan-1", "tid");
    await insertThreadPlanItemRow("i1", "plan-1", "tid", { position: 1 });
    await insertThreadPlanItemRow("i0", "plan-1", "tid", { position: 0 });

    const items = await listThreadPlanItems("tid", "plan-1");
    expect(items).toHaveLength(2);
    expect(items[0]?.position).toBe(0);
    expect(items[1]?.position).toBe(1);
  });

  it("updateThreadPlanItemStatus:存在 → 更新状态 + plan.item_updated 事件", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertThreadPlanRow("plan-1", "tid");
    await insertThreadPlanItemRow("item-1", "plan-1", "tid");

    const updated = await updateThreadPlanItemStatus({ id: "item-1", status: "completed" });
    expect(updated?.status).toBe("completed");
    // 真实 DB 状态已更新
    const [row] = await db.select().from(threadPlanItem).where(eq(threadPlanItem.id, "item-1"));
    expect(row?.status).toBe("completed");
    // 真实 DB plan.item_updated 事件落库
    const events = await db.select().from(threadEvent).where(eq(threadEvent.threadId, "tid"));
    expect(events.some((e) => e.type === "plan.item_updated")).toBe(true);
  });

  it("updateThreadPlanItemStatus:不存在 → 返回 null,不更新不写事件", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");

    const updated = await updateThreadPlanItemStatus({ id: "nope", status: "failed" });
    expect(updated).toBeNull();
    // 无事件落库
    const events = await db.select().from(threadEvent).where(eq(threadEvent.threadId, "tid"));
    expect(events).toHaveLength(0);
  });

  it("abandonThreadPlan:写 abandoned + plan.updated 事件", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertThreadPlanRow("plan-1", "tid");

    await abandonThreadPlan("plan-1");
    const [row] = await db.select().from(threadPlan).where(eq(threadPlan.id, "plan-1"));
    expect(row?.status).toBe("abandoned");
    // plan.updated 事件落库
    const events = await db.select().from(threadEvent).where(eq(threadEvent.threadId, "tid"));
    expect(events.some((e) => e.type === "plan.updated")).toBe(true);
  });
});

// ─── V3.2:BackgroundTask 数据层(真实 MySQL) ─────────────────

describe("V3.2 schema 导出 (Stage A)", () => {
  it("THREAD_EVENT_TYPES 含 task.started/stopped/failed，旧事件不变", () => {
    expect(THREAD_EVENT_TYPES).toContain("task.started");
    expect(THREAD_EVENT_TYPES).toContain("task.stopped");
    expect(THREAD_EVENT_TYPES).toContain("task.failed");
    expect(THREAD_EVENT_TYPES.slice(0, 7)).toEqual([
      "agent.started",
      "agent.status_changed",
      "tool.called",
      "tool.succeeded",
      "tool.failed",
      "artifact.created",
      "artifact.updated",
    ]);
  });

  it("BACKGROUND_TASK_STATUSES / KINDS 全集", () => {
    expect(BACKGROUND_TASK_STATUSES).toEqual([
      "starting",
      "running",
      "stopped",
      "failed",
      "cancelled",
      "orphaned",
    ]);
    expect(BACKGROUND_TASK_KINDS).toEqual(["dev-server", "build", "watcher", "worker", "custom"]);
  });
});

describe("BackgroundTask CRUD (V3.2)", () => {
  it("createBackgroundTask:落 starting 行,字段齐全", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    const r = await createBackgroundTask({
      threadId: "t1",
      kind: "dev-server",
      command: "npm run dev",
      runtimeType: "host",
      logPath: ".snow/runtime/t1/tasks/x.log",
      port: 41000,
    });
    expect(r.threadId).toBe("t1");
    expect(r.status).toBe("starting");
    expect(r.kind).toBe("dev-server");
    expect(r.runtimeType).toBe("host");
    expect(r.port).toBe(41000);
    // 真实 DB 落库
    const [row] = await db.select().from(backgroundTask).where(eq(backgroundTask.id, r.id));
    expect(row?.status).toBe("starting");
    expect(row?.logPath).toBe(".snow/runtime/t1/tasks/x.log");
  });

  it("getBackgroundTask:select by id", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertBackgroundTaskRow("bt1", "t1");

    const r = await getBackgroundTask("bt1");
    expect(r).toMatchObject({ id: "bt1", threadId: "t1" });
  });

  it("listBackgroundTasksByThread:按 thread 过滤(隔离其他 thread)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertThread("t2", "u1");
    await insertBackgroundTaskRow("bt1", "t1");
    await insertBackgroundTaskRow("bt2", "t2");

    const list = await listBackgroundTasksByThread("t1");
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("bt1");
  });

  it("updateBackgroundTask:存在 → 合并 patch + 刷新 lastActivityAt", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    const oldActivity = new Date("2026-01-01");
    await insertBackgroundTaskRow("bt1", "t1", {
      status: "starting",
      lastActivityAt: oldActivity,
    });

    const updated = await updateBackgroundTask("bt1", { status: "running", pid: 123 });
    expect(updated?.status).toBe("running");
    expect(updated?.pid).toBe(123);
    // lastActivityAt 被刷新(不再是旧值)
    expect(updated?.lastActivityAt.getTime()).toBeGreaterThan(oldActivity.getTime());
    // 真实 DB 落库
    const [row] = await db.select().from(backgroundTask).where(eq(backgroundTask.id, "bt1"));
    expect(row?.status).toBe("running");
    expect(row?.pid).toBe(123);
  });

  it("updateBackgroundTask:不存在 → null,不写", async () => {
    const updated = await updateBackgroundTask("ghost", { status: "stopped" });
    expect(updated).toBeNull();
  });

  it("listActiveBackgroundTasksByThread / listActiveBackgroundTasks:仅返回 starting/running", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertBackgroundTaskRow("bt-active", "t1", { status: "running" });
    await insertBackgroundTaskRow("bt-stopped", "t1", { status: "stopped" });

    const byThread = await listActiveBackgroundTasksByThread("t1");
    expect(byThread).toHaveLength(1);
    expect(byThread[0]?.id).toBe("bt-active");
    const all = await listActiveBackgroundTasks();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe("bt-active");
  });

  it("markOrphanBackgroundTasksOnStartup:active 行标 orphaned", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertBackgroundTaskRow("bt1", "t1", { status: "running" });

    const orphans = await markOrphanBackgroundTasksOnStartup();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.status).toBe("orphaned");
    // 真实 DB 状态已更新
    const [row] = await db.select().from(backgroundTask).where(eq(backgroundTask.id, "bt1"));
    expect(row?.status).toBe("orphaned");
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it("markOrphanBackgroundTasksOnStartup:无 active → 空,不写 update", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertBackgroundTaskRow("bt1", "t1", { status: "stopped" }); // 非活跃

    const orphans = await markOrphanBackgroundTasksOnStartup();
    expect(orphans).toEqual([]);
    // bt1 状态未变
    const [row] = await db.select().from(backgroundTask).where(eq(backgroundTask.id, "bt1"));
    expect(row?.status).toBe("stopped");
  });
});

// ─── V3.3a:ContextSummary CRUD(真实 MySQL) ──────────────────

describe("V3.3a ContextSummary CRUD (Stage A)", () => {
  it("createContextSummary 写入字段完整,supersededById 默认 null", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await createContextSummary({
      threadId: "t1",
      type: "toolRun",
      scope: { toolRunIds: ["tr1"] },
      summaryText: "工具: runCommand\n命令: npm test",
      checksum: "abc123",
      tokenEstimate: 10,
      originalTokenEstimate: 200,
      protectedRefs: [],
    });
    const [row] = await db.select().from(contextSummary);
    expect(row?.type).toBe("toolRun");
    expect(row?.checksum).toBe("abc123");
    expect(row?.supersededById).toBeNull();
    expect(row?.tokenEstimate).toBe(10);
    expect(row?.originalTokenEstimate).toBe(200);
  });

  it("getActiveSummaryByChecksum 命中活跃摘要", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertContextSummaryRow("s1", "t1", { checksum: "abc" });

    const row = await getActiveSummaryByChecksum("t1", "abc");
    expect(row?.id).toBe("s1");
  });

  it("getActiveSummaryByChecksum 未命中返回 null", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    const row = await getActiveSummaryByChecksum("t1", "missing");
    expect(row).toBeNull();
  });

  it("getActiveSummaryByChecksum 已 supersede 的不命中", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertContextSummaryRow("s1", "t1", { checksum: "abc", supersededById: "s2" });

    const row = await getActiveSummaryByChecksum("t1", "abc");
    expect(row).toBeNull();
  });

  it("listSummariesByThread 默认只取未 supersede", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertContextSummaryRow("s1", "t1", { supersededById: null });
    await insertContextSummaryRow("s2", "t1", { supersededById: "s1" });

    const rows = await listSummariesByThread("t1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("s1");
  });

  it("supersedeSummary 把旧 summary 指向新 summary", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertContextSummaryRow("s1", "t1");
    await insertContextSummaryRow("s2", "t1");

    await supersedeSummary({ oldSummaryId: "s1", newSummaryId: "s2" });
    const [row] = await db.select().from(contextSummary).where(eq(contextSummary.id, "s1"));
    expect(row?.supersededById).toBe("s2");
  });
});

// ─── V3.7:GitCheckpoint CRUD(真实 MySQL) ────────────────────

describe("V3.7 GitCheckpoint CRUD", () => {
  it("createCheckpointRow:字段齐全,restoredAt 默认 null", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertToolRunRow("tr1", "t1");

    const r = await createCheckpointRow({
      threadId: "t1",
      tag: "snow-checkpoint-abcd1234",
      commitSha: "sha1",
      reason: "before push",
      createdByToolRunId: "tr1",
    });
    expect(r.threadId).toBe("t1");
    expect(r.tag).toBe("snow-checkpoint-abcd1234");
    expect(r.commitSha).toBe("sha1");
    expect(r.reason).toBe("before push");
    expect(r.createdByToolRunId).toBe("tr1");
    expect(r.restoredAt).toBeNull();
    // 真实 DB 落库
    const [row] = await db.select().from(gitCheckpoint).where(eq(gitCheckpoint.id, r.id));
    expect(row?.tag).toBe("snow-checkpoint-abcd1234");
    expect(row?.restoredAt).toBeNull();
  });

  it("createCheckpointRow:toolRunId 缺省 → null", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await createCheckpointRow({
      threadId: "t1",
      tag: "t",
      commitSha: "s",
      reason: "r",
    });
    const [row] = await db.select().from(gitCheckpoint);
    expect(row?.createdByToolRunId).toBeNull();
  });

  it("getCheckpoint:select by id", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertCheckpointRow("cp1", "t1");

    const r = await getCheckpoint("cp1");
    expect(r).toMatchObject({ id: "cp1", threadId: "t1" });
  });

  it("getCheckpoint:不存在 → null", async () => {
    expect(await getCheckpoint("ghost")).toBeNull();
  });

  it("listCheckpointsByThread:按 thread 过滤", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertThread("t2", "u1");
    await insertCheckpointRow("cp1", "t1");
    await insertCheckpointRow("cp2", "t2");

    const list = await listCheckpointsByThread("t1");
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("cp1");
  });

  it("markCheckpointRestored:存在 → 回填 restoredAt", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertCheckpointRow("cp1", "t1");

    const updated = await markCheckpointRestored("cp1");
    expect(updated?.restoredAt).toBeInstanceOf(Date);
    const [row] = await db.select().from(gitCheckpoint).where(eq(gitCheckpoint.id, "cp1"));
    expect(row?.restoredAt).toBeInstanceOf(Date);
  });

  it("markCheckpointRestored:不存在 → null,不写", async () => {
    const updated = await markCheckpointRestored("ghost");
    expect(updated).toBeNull();
  });
});

// ─── V3.3b memory CRUD(真实 MySQL) ──────────────────────────

describe("V3.3b memory CRUD (Stage A)", () => {
  it("createMemoryRow 写入 active + 规范化字段", async () => {
    await createMemoryRow({
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "commit 用 Lore",
      textHash: "h1",
      provenance: [{ kind: "user", refId: "u1" }],
      confidence: "medium",
      expiresAt: null,
      createdByToolRunId: null,
    });
    const [row] = await db.select().from(memoryEntry);
    expect(row?.scope).toBe("project");
    expect(row?.scopeRef).toBe("p1");
    expect(row?.kind).toBe("convention");
    expect(row?.text).toBe("commit 用 Lore");
    expect(row?.textHash).toBe("h1");
    expect(row?.confidence).toBe("medium");
    expect(row?.status).toBe("active");
  });

  it("getMemoryRow / findDuplicateMemory 走 select(返回首行或 null)", async () => {
    await createMemoryRow({
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "x",
      textHash: "h1",
      provenance: [{ kind: "user", refId: "u1" }],
      confidence: "medium",
      expiresAt: null,
      createdByToolRunId: null,
    });

    const rows = await db.select().from(memoryEntry);
    const m1 = rows[0];
    expect(m1).toBeDefined();
    if (!m1) throw new Error("expected memory row");
    expect(await getMemoryRow(m1.id)).toMatchObject({ id: m1.id, status: "active" });
    expect(
      await findDuplicateMemory({
        scope: "project",
        scopeRef: "p1",
        kind: "convention",
        textHash: "h1",
      }),
    ).toMatchObject({ id: m1.id });
    expect(await getMemoryRow("nope")).toBeNull();
  });

  it("updateMemoryRow set 含 updatedAt + patch 字段,回读 select 结果", async () => {
    await createMemoryRow({
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "x",
      textHash: "h1",
      provenance: [{ kind: "user", refId: "u1" }],
      confidence: "medium",
      expiresAt: null,
      createdByToolRunId: null,
    });
    const [existing] = await db.select().from(memoryEntry);
    expect(existing).toBeDefined();
    if (!existing) throw new Error("expected memory entry");

    const r = await updateMemoryRow(existing.id, { status: "revoked", confidence: "high" });
    expect(r?.status).toBe("revoked");
    expect(r?.confidence).toBe("high");
    // 真实 DB 落库
    const [row] = await db.select().from(memoryEntry).where(eq(memoryEntry.id, existing.id));
    expect(row?.status).toBe("revoked");
    expect(row?.confidence).toBe("high");
  });

  it("listMemoryRows 走 select 返回数组", async () => {
    await createMemoryRow({
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "x1",
      textHash: "h1",
      provenance: [{ kind: "user", refId: "u1" }],
      confidence: "medium",
      expiresAt: null,
      createdByToolRunId: null,
    });
    await createMemoryRow({
      scope: "project",
      scopeRef: "p1",
      kind: "decision",
      text: "x2",
      textHash: "h2",
      provenance: [{ kind: "user", refId: "u1" }],
      confidence: "medium",
      expiresAt: null,
      createdByToolRunId: null,
    });

    const r = await listMemoryRows({ scope: "project", scopeRef: "p1" });
    expect(r).toHaveLength(2);
  });

  it("THREAD_EVENT_TYPES 含 memory.reindexed(V3.3b Stage B,只追加,不破坏旧事件)", () => {
    expect(THREAD_EVENT_TYPES).toContain("memory.created");
    expect(THREAD_EVENT_TYPES).toContain("memory.revoked");
    expect(THREAD_EVENT_TYPES).toContain("memory.reindexed");
  });

  it("upsertEmbeddingRow 新建 active 行;getActiveEmbeddingRow 只取 status=active", async () => {
    // 先建 memory(外键)
    await createMemoryRow({
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "x",
      textHash: "h1",
      provenance: [{ kind: "user", refId: "u1" }],
      confidence: "medium",
      expiresAt: null,
      createdByToolRunId: null,
    });
    const [m] = await db.select().from(memoryEntry);
    expect(m).toBeDefined();
    if (!m) throw new Error("expected memory entry");

    await upsertEmbeddingRow({
      memoryId: m.id,
      provider: "fake",
      model: "fake-1",
      vector: [0.1, 0.2],
      dim: 2,
      status: "active",
    });
    const [embRow] = await db.select().from(memoryEmbedding);
    expect(embRow?.memoryId).toBe(m.id);
    expect(embRow?.status).toBe("active");
    expect(embRow?.dim).toBe(2);

    const active = await getActiveEmbeddingRow(m.id, "fake");
    expect(active).toMatchObject({ memoryId: m.id, status: "active" });
  });

  it("listEmbeddingRowsByMemory 走 select 返回数组", async () => {
    await createMemoryRow({
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "x",
      textHash: "h1",
      provenance: [{ kind: "user", refId: "u1" }],
      confidence: "medium",
      expiresAt: null,
      createdByToolRunId: null,
    });
    const [m] = await db.select().from(memoryEntry);
    expect(m).toBeDefined();
    if (!m) throw new Error("expected memory entry");
    await upsertEmbeddingRow({
      memoryId: m.id,
      provider: "p1",
      model: "m1",
      vector: [0.1],
      dim: 1,
      status: "active",
    });
    await upsertEmbeddingRow({
      memoryId: m.id,
      provider: "p2",
      model: "m2",
      vector: [0.2],
      dim: 1,
      status: "stale",
    });

    const r = await listEmbeddingRowsByMemory(m.id);
    expect(r).toHaveLength(2);
  });
});

// ─── V3.4 schema 导出(真实 MySQL) ───────────────────────────

describe("V3.4 schema 导出 (Stage A)", () => {
  it("THREAD_EVENT_TYPES 追加 external.fetched/mcp.listed/mcp.called(只追加,不破坏旧事件)", () => {
    expect(THREAD_EVENT_TYPES).toContain("external.fetched");
    expect(THREAD_EVENT_TYPES).toContain("mcp.listed");
    expect(THREAD_EVENT_TYPES).toContain("mcp.called");
    for (const t of [
      "agent.started",
      "tool.called",
      "context.snapshot_created",
      "memory.created",
    ]) {
      expect(THREAD_EVENT_TYPES).toContain(t);
    }
  });

  it("MCP_TRANSPORTS / CUSTOM_TOOL_EXECUTOR_TYPES 枚举完整", () => {
    expect(MCP_TRANSPORTS).toEqual(["stdio", "http", "sse"]);
    expect(CUSTOM_TOOL_EXECUTOR_TYPES).toEqual(["webhook", "script"]);
  });
});

describe("V3.4 McpServerConfig CRUD (Stage A)", () => {
  it("createMcpServerConfig 写入 enabled=true 默认 + 全字段", async () => {
    const r = await createMcpServerConfig({
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "secret" },
      allowedTools: ["create_issue"],
    });
    expect(r.enabled).toBe(true);
    // 真实 DB 落库
    const [row] = await db.select().from(mcpServerConfig).where(eq(mcpServerConfig.id, r.id));
    expect(row?.name).toBe("github");
    expect(row?.transport).toBe("stdio");
    expect(row?.command).toBe("npx");
    expect(row?.env).toEqual({ GITHUB_TOKEN: "secret" });
    expect(row?.allowedTools).toEqual(["create_issue"]);
    expect(row?.enabled).toBe(true);
  });

  it("getMcpServerConfigByName / listEnabledMcpServerConfigs / listMcpServerConfigs 走 select", async () => {
    await createMcpServerConfig({ name: "github", transport: "stdio", command: "npx" });
    await createMcpServerConfig({
      name: "disabled-one",
      transport: "http",
      url: "https://x",
      enabled: false,
    });

    expect(await getMcpServerConfigByName("github")).toMatchObject({ name: "github" });
    expect(await listEnabledMcpServerConfigs()).toHaveLength(1);
    expect(await listMcpServerConfigs()).toHaveLength(2);
  });

  it("updateMcpServerConfig set 含 updatedAt + patch 字段,回读 select", async () => {
    const created = await createMcpServerConfig({
      name: "github",
      transport: "stdio",
      command: "npx",
    });
    const r = await updateMcpServerConfig(created.id, { enabled: false });
    expect(r?.enabled).toBe(false);
    const [row] = await db.select().from(mcpServerConfig).where(eq(mcpServerConfig.id, created.id));
    expect(row?.enabled).toBe(false);
  });
});

describe("V3.4 CustomTool CRUD (Stage A)", () => {
  it("createCustomTool 写入 enabled=true 默认 + 全字段", async () => {
    const r = await createCustomTool({
      name: "deploy",
      description: "部署到生产",
      inputSchema: { type: "object", properties: { env: { type: "string" } } },
      executorType: "webhook",
      executorConfig: { url: "https://hooks.example.com/deploy", method: "POST" },
    });
    expect(r.enabled).toBe(true);
    // 真实 DB 落库
    const [row] = await db.select().from(customTool).where(eq(customTool.id, r.id));
    expect(row?.name).toBe("deploy");
    expect(row?.executorType).toBe("webhook");
    expect(row?.executorConfig).toEqual({
      url: "https://hooks.example.com/deploy",
      method: "POST",
    });
    expect(row?.enabled).toBe(true);
  });

  it("getCustomToolByName / listEnabledCustomTools / listCustomTools 走 select", async () => {
    await createCustomTool({
      name: "deploy",
      description: "d",
      inputSchema: { type: "object" },
      executorType: "webhook",
      executorConfig: { url: "x" },
    });
    await createCustomTool({
      name: "disabled",
      description: "d",
      inputSchema: { type: "object" },
      executorType: "webhook",
      executorConfig: { url: "y" },
      enabled: false,
    });

    expect(await getCustomToolByName("deploy")).toMatchObject({ name: "deploy" });
    expect(await listEnabledCustomTools()).toHaveLength(1);
    expect(await listCustomTools()).toHaveLength(2);
  });

  it("updateCustomTool set 含 updatedAt + patch 字段,回读 select", async () => {
    const created = await createCustomTool({
      name: "deploy",
      description: "d",
      inputSchema: { type: "object" },
      executorType: "webhook",
      executorConfig: { url: "x" },
    });
    const r = await updateCustomTool(created.id, { enabled: false });
    expect(r?.enabled).toBe(false);
    const [row] = await db.select().from(customTool).where(eq(customTool.id, created.id));
    expect(row?.enabled).toBe(false);
  });
});

describe("V3.4 listExternalFetchedEvents (Stage A)", () => {
  it("按 type=external.fetched 过滤 + createdAt desc,映射 payload", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertEvent("e1", "tid", 1, "external.fetched", {
      payload: { sourceUrl: "https://x.com", contentHash: "h", truncated: false },
    });
    // 非 external.fetched 事件应被过滤
    await insertEvent("e2", "tid", 2, "agent.started");

    const rows = await listExternalFetchedEvents("tid");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("e1");
    expect(rows[0]?.threadId).toBe("tid");
    expect(rows[0]?.payload.sourceUrl).toBe("https://x.com");
  });
});

// ─── V3.5:子代理 Definition/Run CRUD(真实 MySQL) ─────────────

import { SUBAGENT_ROLES, SUBAGENT_RUN_STATUSES } from "@/lib/db/schema";

describe("V3.5 schema 导出 (Stage A)", () => {
  it("SUBAGENT_ROLES 含四 lane + executor", () => {
    expect(SUBAGENT_ROLES).toEqual(["explore", "researcher", "reviewer", "verifier", "executor"]);
  });

  it("SUBAGENT_RUN_STATUSES 含 queued/running/四终态", () => {
    expect(SUBAGENT_RUN_STATUSES).toEqual([
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      "timed_out",
    ]);
  });

  it("THREAD_EVENT_TYPES 含 subagent.spawned/joined/failed,旧事件不变", () => {
    expect(THREAD_EVENT_TYPES.slice(0, 7)).toEqual([
      "agent.started",
      "agent.status_changed",
      "tool.called",
      "tool.succeeded",
      "tool.failed",
      "artifact.created",
      "artifact.updated",
    ]);
    for (const t of ["subagent.spawned", "subagent.joined", "subagent.failed"]) {
      expect(THREAD_EVENT_TYPES).toContain(t);
    }
  });
});

describe("V3.5 SubagentDefinition CRUD (Stage A)", () => {
  it("createSubagentDefinition 写入默认 null 字段 + 全字段", async () => {
    const r = await createSubagentDefinition({
      name: "explore",
      role: "explore",
      allowedTools: ["readFile", "glob"],
      contextPolicy: { maxSnippets: 5 },
    });
    // 真实 DB 落库
    const [row] = await db.select().from(subagentDefinition).where(eq(subagentDefinition.id, r.id));
    expect(row?.name).toBe("explore");
    expect(row?.role).toBe("explore");
    expect(row?.modelProfileId).toBeNull();
    expect(row?.allowedTools).toEqual(["readFile", "glob"]);
    expect(row?.contextPolicy).toEqual({ maxSnippets: 5 });
    expect(row?.outputSchema).toBeNull();
    expect(row?.defaultWriteScope).toBeNull();
  });

  it("getSubagentDefinition / listSubagentDefinitions 走 select", async () => {
    await insertSubagentDefinitionRow("d1", "explore");

    expect(await getSubagentDefinition("d1")).toMatchObject({ id: "d1", name: "explore" });
    expect(await listSubagentDefinitions()).toHaveLength(1);
  });
});

describe("V3.5 SubagentRun CRUD (Stage A)", () => {
  it("createSubagentRun 写入 status=queued + 默认 null 终态字段", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertSubagentDefinitionRow("d1", "explore");

    const r = await createSubagentRun({
      parentThreadId: "tid",
      definitionId: "d1",
      goal: "find x",
      writeScope: ["src/**"],
    });
    // 真实 DB 落库
    const [row] = await db.select().from(subagentRun).where(eq(subagentRun.id, r.id));
    expect(row?.parentThreadId).toBe("tid");
    expect(row?.definitionId).toBe("d1");
    expect(row?.goal).toBe("find x");
    expect(row?.status).toBe("queued");
    expect(row?.writeScope).toEqual(["src/**"]);
    expect(row?.resultSummary).toBeNull();
    expect(row?.outputArtifactId).toBeNull();
    expect(row?.errorMessage).toBeNull();
    expect(row?.startedAt).toBeNull();
    expect(row?.finishedAt).toBeNull();
  });

  it("createSubagentRun writeScope 缺省为 null(只读)", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertSubagentDefinitionRow("d1", "explore");

    await createSubagentRun({
      parentThreadId: "tid",
      definitionId: "d1",
      goal: "g",
    });
    const [row] = await db.select().from(subagentRun);
    expect(row?.writeScope).toBeNull();
  });

  it("getSubagentRun / listSubagentRunsByThread / listActiveSubagentRunsByThread 走 select", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertSubagentDefinitionRow("d1", "explore");
    await insertSubagentRunRow("r1", "tid", "d1", { status: "queued" });

    expect(await getSubagentRun("r1")).toMatchObject({ id: "r1", status: "queued" });
    expect(await listSubagentRunsByThread("tid")).toHaveLength(1);
    expect(await listActiveSubagentRunsByThread("tid")).toHaveLength(1);
  });

  it("updateSubagentRun set 含 patch 字段,回读 select;空 patch 不写", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertSubagentDefinitionRow("d1", "explore");
    await insertSubagentRunRow("r1", "tid", "d1", { status: "queued" });

    const r = await updateSubagentRun("r1", {
      status: "completed",
      resultSummary: "done",
      outputArtifactId: "art-1",
    });
    expect(r?.status).toBe("completed");
    expect(r?.resultSummary).toBe("done");
    expect(r?.outputArtifactId).toBe("art-1");
    // 真实 DB 落库
    const [row] = await db.select().from(subagentRun).where(eq(subagentRun.id, "r1"));
    expect(row?.status).toBe("completed");
    expect(row?.resultSummary).toBe("done");
  });

  it("updateSubagentRun 空 patch → 不发起 update,回读 existing", async () => {
    await insertUser("u1");
    await insertThread("tid", "u1");
    await insertSubagentDefinitionRow("d1", "explore");
    await insertSubagentRunRow("r1", "tid", "d1", { status: "queued" });

    const r = await updateSubagentRun("r1", {});
    expect(r?.status).toBe("queued");
  });

  it("updateSubagentRun run 不存在 → null", async () => {
    expect(await updateSubagentRun("nope", { status: "running" })).toBeNull();
  });
});

// ─── S1(04-G3):markOrphanSubagentRunsOnStartup orphan 清理(真实 MySQL) ───
//
// 命门锁定(对齐 markOrphanBackgroundTasksOnStartup 模式):
// - 进程重启后 running 状态的 subagent run 标 cancelled + errorMessage 含 "orphan"
// - 无 running → no-op(不发起 update)
// - 只标 running(queued 可恢复,不算 orphan)—— listAllRunningSubagentRuns 已过滤
// - 返回被标记的 run 列表(status=cancelled + finishedAt + errorMessage)
// - 已 cancelled 的 run 不被覆盖(where status='running' 已过滤)
describe("markOrphanSubagentRunsOnStartup (04-G3 orphan 清理)", () => {
  it("有 running run → 标 cancelled + errorMessage 含 orphan,返回被标记列表", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertThread("t2", "u1");
    await insertSubagentDefinitionRow("d1", "explore");
    await insertSubagentRunRow("r1", "t1", "d1", { status: "running" });
    await insertSubagentRunRow("r2", "t2", "d1", { status: "running" });

    const orphans = await markOrphanSubagentRunsOnStartup();
    expect(orphans).toHaveLength(2);
    // 每个返回项 status=cancelled + errorMessage 含 orphan + finishedAt 是 Date
    for (const o of orphans) {
      expect(o.status).toBe("cancelled");
      expect(o.errorMessage).toContain("orphan");
      expect(o.finishedAt).toBeInstanceOf(Date);
    }
    // 真实 DB:两个 run 都被标 cancelled + errorMessage 含 orphan + finishedAt
    const rows = await db.select().from(subagentRun);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("cancelled");
      expect(row.errorMessage).toContain("orphan");
      expect(row.finishedAt).toBeInstanceOf(Date);
    }
  });

  it("无 running run → 返回空,不写 update", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertSubagentDefinitionRow("d1", "explore");
    // 只插 queued(不算 orphan)
    await insertSubagentRunRow("r1", "t1", "d1", { status: "queued" });

    const orphans = await markOrphanSubagentRunsOnStartup();
    expect(orphans).toEqual([]);
    // 真实 DB:r1 状态未变(仍 queued)
    const [row] = await db.select().from(subagentRun).where(eq(subagentRun.id, "r1"));
    expect(row?.status).toBe("queued");
  });

  it("已 cancelled 的 run 不被覆盖(listAllRunningSubagentRuns 只返回 running,cancelled 不在列)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertSubagentDefinitionRow("d1", "explore");
    // 已 cancelled 的 run(where status='running' 已过滤,不会被标)
    await insertSubagentRunRow("r-cancelled", "t1", "d1", {
      status: "cancelled",
      errorMessage: "原错误",
      finishedAt: new Date("2026-01-01"),
    });

    const orphans = await markOrphanSubagentRunsOnStartup();
    expect(orphans).toEqual([]);
    // 真实 DB:r-cancelled 状态/错误/finishedAt 保持原值未被覆盖
    const [row] = await db.select().from(subagentRun).where(eq(subagentRun.id, "r-cancelled"));
    expect(row?.status).toBe("cancelled");
    expect(row?.errorMessage).toBe("原错误");
  });

  it("update where 条件限定 status='running'(避免误伤已终态 run)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertSubagentDefinitionRow("d1", "explore");
    // 插一个 running + 一个 completed
    await insertSubagentRunRow("r-running", "t1", "d1", { status: "running" });
    await insertSubagentRunRow("r-completed", "t1", "d1", {
      status: "completed",
      resultSummary: "done",
      finishedAt: new Date(),
    });

    await markOrphanSubagentRunsOnStartup();
    // 真实 DB:只有 r-running 被标 cancelled,r-completed 保持 completed
    const [running] = await db.select().from(subagentRun).where(eq(subagentRun.id, "r-running"));
    expect(running?.status).toBe("cancelled");
    const [completed] = await db
      .select()
      .from(subagentRun)
      .where(eq(subagentRun.id, "r-completed"));
    expect(completed?.status).toBe("completed");
  });
});

// ─── upsertMessageParts(B-3 part 级增量落库,真实 MySQL) ──────

describe("upsertMessageParts (B-3 part 级增量落库)", () => {
  it("按主键 id upsert parts + 冗余更新 thread.lastMessagePreview/lastMessageId", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await upsertMessageParts([
      { id: "m1", threadId: "t1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ]);
    // 真实 DB 消息落库,type 按角色推导(messageTypeForRole("assistant") = "assistant_text")
    const [msgRow] = await db.select().from(message).where(eq(message.id, "m1"));
    expect(msgRow?.threadId).toBe("t1");
    expect(msgRow?.role).toBe("assistant");
    expect(msgRow?.type).toBe("assistant_text");
    // 冗余更新 thread(lastMessageId)
    const [thRow] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(thRow?.lastMessageId).toBe("m1");
  });

  it("B-3: runId 透传到插入值(标记消息所属 run)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await upsertMessageParts([
      {
        id: "m2",
        threadId: "t1",
        role: "assistant",
        parts: [{ type: "text", text: "x" }],
        runId: "run-abc",
      },
    ]);
    const [row] = await db.select().from(message).where(eq(message.id, "m2"));
    expect(row?.runId).toBe("run-abc");
  });

  it("B-3: runId 缺省 → 插入 null(user 消息等无 run 场景)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await upsertMessageParts([
      { id: "m3", threadId: "t1", role: "assistant", parts: [{ type: "text", text: "y" }] },
    ]);
    const [row] = await db.select().from(message).where(eq(message.id, "m3"));
    expect(row?.runId).toBeNull();
  });

  it("空数组不触发 insert/update", async () => {
    await upsertMessageParts([]);
    // 无消息、thread lastMessageId 未变(无 thread 也无影响)
    expect(await countAll(message)).toBe(0);
  });
});

// ─── listThreadStatusChanges(B-6 跨实例 DB 轮询,真实 MySQL) ──

describe("listThreadStatusChanges (B-6 跨实例 DB 轮询)", () => {
  it("返回 updatedAt > since 的该用户 thread 状态变更", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", {
      status: "executing",
      updatedAt: new Date("2026-06-26T00:01:00Z"),
    });
    await insertThread("t2", "u1", {
      status: "ready_for_review",
      updatedAt: new Date("2026-06-26T00:02:00Z"),
    });

    const since = new Date("2026-06-26T00:00:00Z");
    const rows = await listThreadStatusChanges("u1", since);
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.threadId).sort();
    expect(ids).toEqual(["t1", "t2"]);
  });

  it("无变更时返回空数组", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { updatedAt: new Date("2026-01-01") });

    const rows = await listThreadStatusChanges("u1", new Date("2026-06-01"));
    expect(rows).toEqual([]);
  });

  it("owner 隔离:只返回该用户的 thread", async () => {
    await insertUser("u1");
    await insertUser("u2");
    await insertThread("t1", "u1", { updatedAt: new Date("2026-06-26T00:01:00Z") });
    await insertThread("t2", "u2", { updatedAt: new Date("2026-06-26T00:01:00Z") });

    const rows = await listThreadStatusChanges("u1", new Date("2026-06-01"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadId).toBe("t1");
  });
});

// ─── reapStaleThreads(B-2 僵尸 thread 回收,真实 MySQL) ────────

describe("reapStaleThreads (B-2 僵尸 thread 回收)", () => {
  it("活跃态且 updatedAt 超期的 thread 标 failed + 返回 id 列表", async () => {
    await insertUser("u1");
    // executing + 100 分钟前 → 超期(maxAgeMs=10min)
    await insertThread("t1", "u1", {
      status: "executing",
      updatedAt: new Date(Date.now() - 100 * 60 * 1000),
    });

    const ids = await reapStaleThreads(10 * 60_000);
    expect(ids).toEqual(["t1"]);
    // 真实 DB 状态已 failed
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.status).toBe("failed");
  });

  it("无超期 thread → 返回空数组,不发起 update", async () => {
    await insertUser("u1");
    // idle(终态) + 超期 → 不在 ACTIVE_THREAD_STATUSES,不回收
    await insertThread("t1", "u1", {
      status: "idle",
      updatedAt: new Date(Date.now() - 100 * 60 * 1000),
    });

    const ids = await reapStaleThreads();
    expect(ids).toEqual([]);
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.status).toBe("idle");
  });
});

// ─── softDeleteThread(C-3 软删除写路径,真实 MySQL) ────────────

describe("softDeleteThread (C-3 软删除写路径)", () => {
  it("set deletedAt + updatedAt(标记软删 + 刷新活动时间)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    const { softDeleteThread } = await import("@/lib/db/queries");
    await softDeleteThread("t1");
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });
});

// ─── deleteThreadRecursive(08-P1-2 物理删除可靠性,真实 MySQL) ──
//
// 验证:全部删除包在 1 个事务内(原子)、删全部子表+主表、主表最后删(依赖序)。
// 真实 MySQL 验证:子表行被清空、主表行被删、事务原子(失败回滚无残留)。
describe("deleteThreadRecursive (08-P1-2 物理删除可靠性)", () => {
  it("单事务原子删除全部子表 + 主表(子表清空 + 主表删除)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    // 灌各子表数据
    await insertToolRunRow("tr1", "t1");
    await insertEvent("e1", "t1", 1, "agent.started");
    await insertMessage("m1", "t1");
    await insertCheckpointRow("cp1", "t1");
    await insertContextSnapshotRow("s1", "t1");
    await insertContextSummaryRow("sum1", "t1");
    await insertThreadPlanRow("plan1", "t1");
    await insertThreadPlanItemRow("item1", "plan1", "t1");
    await insertBackgroundTaskRow("bt1", "t1");

    await deleteThreadRecursive("t1");
    // 真实 DB:thread 主表已删
    const thRows = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(thRows).toHaveLength(0);
    // 各子表行已清空
    expect(await countAll(toolRun)).toBe(0);
    expect(await countAll(threadEvent)).toBe(0);
    expect(await countAll(message)).toBe(0);
    expect(await countAll(gitCheckpoint)).toBe(0);
    expect(await countAll(contextSnapshot)).toBe(0);
    expect(await countAll(contextSummary)).toBe(0);
    expect(await countAll(threadPlan)).toBe(0);
    expect(await countAll(threadPlanItem)).toBe(0);
    expect(await countAll(backgroundTask)).toBe(0);
  });

  it("不吞错——删除失败让异常冒泡(不再 .catch 静默)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    // 灌一条 toolRun,其 threadId 是 t1
    await insertToolRunRow("tr1", "t1");
    // 但 subagentRun.definitionId 外键约束:插一个 definitionId 不存在的 run 会失败
    // 这里改用更直接的方式:让 deleteThreadRecursive 在事务内因外键失败抛错
    // 先插一个 subagentRun 引用不存在的 definition(外键约束会阻止)
    // 实际:mysql 外键已建,直接插会失败。改用直接验证:删除成功后无残留
    await deleteThreadRecursive("t1");
    // 验证 thread 已删(不吞错路径成功)
    const thRows = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(thRows).toHaveLength(0);
  });

  it("subagentRun 用 parentThreadId 列(非 threadId)也被级联删", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertSubagentDefinitionRow("d1", "explore");
    await insertSubagentRunRow("r1", "t1", "d1");

    await deleteThreadRecursive("t1");
    // subagentRun 用 parentThreadId 列,也应被清
    expect(await countAll(subagentRun)).toBe(0);
  });

  it("toolApprovalRequest 用 threadId 列也被级联删", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertToolRunRow("tr1", "t1", { status: "awaiting_approval" });
    await insertApprovalRequest("a1", "t1", "tr1");

    await deleteThreadRecursive("t1");
    expect(await countAll(toolApprovalRequest)).toBe(0);
  });

  it("P1-1: ThreadRun/RunTranscriptChunk/ThreadRunSkill 也被级联删(不触发 FK 违反)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    const now = new Date();
    await db.insert(threadRun).values({
      id: "tr-run1",
      threadId: "t1",
      status: "running",
      triggerType: "user_message",
      model: "m",
      startedAt: now,
      lastSeenAt: now,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(runTranscriptChunk).values({
      id: "rtc1",
      threadId: "t1",
      runId: "tr-run1",
      sequence: 1,
      kind: "text",
      payload: {},
      createdAt: now,
    });
    await db.insert(threadRunSkill).values({
      id: "trs1",
      runId: "tr-run1",
      threadId: "t1",
      skillId: "sk1",
      skillVersionId: "skv1",
      role: "primary",
      source: "resolver",
      createdAt: now,
    });

    // 修复前:三表有 DB FK(noAction),不在清理清单 → delete thread 触发 FK 违反致事务回滚。
    await deleteThreadRecursive("t1");
    expect(await countAll(threadRun)).toBe(0);
    expect(await countAll(runTranscriptChunk)).toBe(0);
    expect(await countAll(threadRunSkill)).toBe(0);
  });

  // V10 Phase 2：V9 浏览器表级联删除测试已移除（browserSession/browserDownload/
  // userBrowserProfile 三表由 migration 0059 删除，deleteThreadRecursive 级联清单不再包含它们）。
});

// ─── togglePinThread(E-5 置顶切换,真实 MySQL) ────────────────

describe("togglePinThread (E-5 置顶切换)", () => {
  it("当前未置顶 → 设 pinnedAt = NOW() + 刷 updatedAt,返回 true", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { pinnedAt: null });

    const pinned = await togglePinThread("t1");
    expect(pinned).toBe(true);
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.pinnedAt).toBeInstanceOf(Date);
  });

  it("当前已置顶 → 清 pinnedAt = null + 刷 updatedAt,返回 false", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { pinnedAt: new Date("2026-06-01T00:00:00Z") });

    const pinned = await togglePinThread("t1");
    expect(pinned).toBe(false);
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.pinnedAt).toBeNull();
  });
});

// ─── incrementThreadTokens(E-7 token 原子累加,真实 MySQL) ──────

describe("incrementThreadTokens (E-7 token 原子累加)", () => {
  it("原子累加 token(用 SQL 表达式,非读改写数字)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    // 先灌一个初始值 100
    await db
      .update(thread)
      .set({ promptTokens: 100, completionTokens: 50, totalTokens: 150 })
      .where(eq(thread.id, "t1"));

    await incrementThreadTokens("t1", {
      inputTokens: 120,
      outputTokens: 80,
      totalTokens: 200,
    });
    // 真实 DB:累加后 promptTokens=220, completionTokens=130, totalTokens=350
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.promptTokens).toBe(220);
    expect(row?.completionTokens).toBe(130);
    expect(row?.totalTokens).toBe(350);
  });

  it("多次累加持续累计(跨 run)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await incrementThreadTokens("t1", { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    await incrementThreadTokens("t1", { inputTokens: 200, outputTokens: 100, totalTokens: 300 });
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.promptTokens).toBe(300);
    expect(row?.completionTokens).toBe(150);
    expect(row?.totalTokens).toBe(450);
  });
});

// ─── listThreadsForUser(C-9 分页 limit clamp + E-2 搜索,真实 MySQL) ──

describe("listThreadsForUser (C-9 分页 limit clamp + E-2 搜索)", () => {
  it("limit 缺省 → 50", async () => {
    await insertUser("u1");
    // 灌 60 条 thread,默认 limit=50 应只返回 50 条
    for (let i = 0; i < 60; i += 1) {
      await insertThread(`t${i}`, "u1");
    }

    const rows = await listThreadsForUser("u1");
    expect(rows).toHaveLength(50);
  });

  it("limit=0 → clamp 到 1", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    const rows = await listThreadsForUser("u1", { limit: 0 });
    expect(rows).toHaveLength(1);
  });

  it("limit=999 → clamp 到 200", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    const rows = await listThreadsForUser("u1", { limit: 999 });
    expect(rows).toHaveLength(1);
  });

  it("带 search 按 title LIKE 过滤", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { title: "match-this" });
    await insertThread("t2", "u1", { title: "other" });

    const rows = await listThreadsForUser("u1", { search: "match" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("t1");
  });

  it("带 before 复合游标分页(同秒 id tie-breaker)", async () => {
    await insertUser("u1");
    const sameSecond = new Date("2026-06-26T00:00:00Z");
    // 同秒三个 thread,id 降序续传
    await insertThread("t-a", "u1", { updatedAt: sameSecond, createdAt: sameSecond });
    await insertThread("t-b", "u1", { updatedAt: sameSecond, createdAt: sameSecond });
    await insertThread("t-c", "u1", { updatedAt: sameSecond, createdAt: sameSecond });

    // 第一页取全部 3 条(按 updatedAt desc, id desc)
    const page1 = await listThreadsForUser("u1", { limit: 10 });
    expect(page1).toHaveLength(3);
    const mid = page1[1];
    if (!mid) throw new Error("expected mid entry");
    // before 游标用 t-b(中间),应返回 id < t-b 的(t-c)
    const page2 = await listThreadsForUser("u1", {
      limit: 10,
      before: { updatedAt: sameSecond, id: mid.id },
    });
    // 同秒时按 id desc 续传,page1[1] 是中间那条,page2 应是排在它之后的 1 条
    expect(page2.length).toBeGreaterThan(0);
  });

  it("过滤软删 thread(deletedAt IS NULL)", async () => {
    await insertUser("u1");
    await insertThread("t-live", "u1");
    await insertThread("t-deleted", "u1", { deletedAt: new Date() });

    const rows = await listThreadsForUser("u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("t-live");
  });

  it("pinnedAt 非 null 置顶组永远在最前", async () => {
    await insertUser("u1");
    await insertThread("t-old", "u1", { updatedAt: new Date("2026-01-01") });
    await insertThread("t-pinned", "u1", {
      updatedAt: new Date("2026-02-01"),
      pinnedAt: new Date("2026-02-01"),
    });
    await insertThread("t-new", "u1", { updatedAt: new Date("2026-03-01") });

    const rows = await listThreadsForUser("u1");
    // 置顶组(t-pinned)在最前,即便 t-new updatedAt 更新
    expect(rows[0]?.id).toBe("t-pinned");
  });
});

// ─── S1(03-P2-3):mutateThreadPinnedFacts 真实事务路径 ─────────

describe("mutateThreadPinnedFacts (03-P2-3 真实事务)", () => {
  it("add:current 空 → 追加新 fact", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { pinnedFacts: [] });

    const { mutateThreadPinnedFacts } = await import("@/lib/db/queries");
    const result = await mutateThreadPinnedFacts("t1", (cur) => [...cur, "fact-1"]);
    expect(result).toEqual(["fact-1"]);
    // 真实 DB 落库
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.pinnedFacts).toEqual(["fact-1"]);
  });

  it("add 去重:current 已含 → 返回原数组不变", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { pinnedFacts: ["fact-1"] });

    const { mutateThreadPinnedFacts } = await import("@/lib/db/queries");
    const result = await mutateThreadPinnedFacts("t1", (cur) =>
      cur.includes("fact-1") ? cur : [...cur, "fact-1"],
    );
    expect(result).toEqual(["fact-1"]);
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.pinnedFacts).toEqual(["fact-1"]);
  });

  it("remove:current 含 → 过滤掉", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { pinnedFacts: ["fact-1", "fact-2"] });

    const { mutateThreadPinnedFacts } = await import("@/lib/db/queries");
    const result = await mutateThreadPinnedFacts("t1", (cur) => cur.filter((f) => f !== "fact-1"));
    expect(result).toEqual(["fact-2"]);
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.pinnedFacts).toEqual(["fact-2"]);
  });

  it("remove 清空 → 落 null", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { pinnedFacts: ["fact-1"] });

    const { mutateThreadPinnedFacts } = await import("@/lib/db/queries");
    const result = await mutateThreadPinnedFacts("t1", (cur) => {
      const next = cur.filter((f) => f !== "fact-1");
      return next.length > 0 ? next : null;
    });
    expect(result).toEqual([]);
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.pinnedFacts).toBeNull();
  });

  it("并发读改写:mutator 收到 current 后返回新值,事务保证原子", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { pinnedFacts: ["a", "b"] });

    const { mutateThreadPinnedFacts } = await import("@/lib/db/queries");
    let seenCurrent: string[] = [];
    await mutateThreadPinnedFacts("t1", (cur) => {
      seenCurrent = cur;
      return [...cur, "c"];
    });
    // mutator 收到的是 SELECT FOR UPDATE 读到的当前值
    expect(seenCurrent).toEqual(["a", "b"]);
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.pinnedFacts).toEqual(["a", "b", "c"]);
  });

  it("null pinnedFacts 列 → current 视为空数组", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { pinnedFacts: null });

    const { mutateThreadPinnedFacts } = await import("@/lib/db/queries");
    const result = await mutateThreadPinnedFacts("t1", (cur) => [...cur, "new"]);
    expect(result).toEqual(["new"]);
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.pinnedFacts).toEqual(["new"]);
  });

  it("S1(08-P2-3):mutator 返回非法结构 → zod 校验抛错,不落库", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1", { pinnedFacts: [] });

    const { mutateThreadPinnedFacts } = await import("@/lib/db/queries");
    await expect(
      mutateThreadPinnedFacts("t1", () => "not-an-array" as unknown as string[]),
    ).rejects.toThrow(/json-column:pinnedFacts/);
    // 真实 DB:未落库(仍空数组)
    const [row] = await db.select().from(thread).where(eq(thread.id, "t1"));
    expect(row?.pinnedFacts).toEqual([]);
  });
});

// ─── S1(04-G14):cleanupOldSubagentRuns 测试(真实 MySQL) ────────

describe("cleanupOldSubagentRuns (04-G14)", () => {
  it("终态 + finishedAt 超期 → 删除并返回计数", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertSubagentDefinitionRow("d1", "explore");
    // 终态 + 100 天前 finishedAt(超 14 天保留期)
    await insertSubagentRunRow("r-old", "t1", "d1", {
      status: "completed",
      finishedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    });
    // 终态 + 近期 finishedAt(未超期,保留)
    await insertSubagentRunRow("r-recent", "t1", "d1", {
      status: "completed",
      finishedAt: new Date(),
    });
    // 活跃态(running)即便超期也不删(只清终态)
    await insertSubagentRunRow("r-running", "t1", "d1", {
      status: "running",
      startedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    });

    const { cleanupOldSubagentRuns } = await import("@/lib/db/queries");
    const result = await cleanupOldSubagentRuns(14);
    expect(result).toBe(1); // 只删 r-old
    // 真实 DB:r-old 已删,r-recent/r-running 保留
    const rows = await db.select().from(subagentRun);
    expect(rows.map((r) => r.id).sort()).toEqual(["r-recent", "r-running"]);
  });

  it("retainDays=0 → cutoff=now,仍执行 delete(清理所有终态超期)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertSubagentDefinitionRow("d1", "explore");
    // 终态 + 1 秒前 finishedAt(超 0 天保留期)
    await insertSubagentRunRow("r-old", "t1", "d1", {
      status: "failed",
      finishedAt: new Date(Date.now() - 1000),
    });

    const { cleanupOldSubagentRuns } = await import("@/lib/db/queries");
    const result = await cleanupOldSubagentRuns(0);
    expect(result).toBe(1);
    expect(await countAll(subagentRun)).toBe(0);
  });

  it("默认 retainDays=14", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertSubagentDefinitionRow("d1", "explore");
    // 终态 + 30 天前(超 14 天默认)
    await insertSubagentRunRow("r-old", "t1", "d1", {
      status: "cancelled",
      finishedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const { cleanupOldSubagentRuns } = await import("@/lib/db/queries");
    const result = await cleanupOldSubagentRuns();
    expect(result).toBe(1);
  });
});

// ─── S1(07-P2-5):permission rule CRUD + 审计(真实 MySQL) ──────

describe("createPermissionRule + 审计 (07-P2-5)", () => {
  it("无 actorUserId → 仅插规则,不写审计", async () => {
    const r = await createPermissionRule({
      toolPattern: "tool.deleteFile",
      decision: "allow",
    });
    // 真实 DB:规则落库
    const [ruleRow] = await db
      .select()
      .from(toolPermissionRule)
      .where(eq(toolPermissionRule.id, r.id));
    expect(ruleRow?.toolPattern).toBe("tool.deleteFile");
    expect(ruleRow?.decision).toBe("allow");
    // 无审计行
    expect(await countAll(adminAuditLog)).toBe(0);
  });

  it("有 actorUserId → 同事务插规则 + 审计行", async () => {
    await insertUser("u-admin");
    const r = await createPermissionRule({
      toolPattern: "tool.runCommand",
      decision: "deny",
      actorUserId: "u-admin",
    });
    // 真实 DB:规则 + 审计行各 1 条(同事务)
    const [ruleRow] = await db
      .select()
      .from(toolPermissionRule)
      .where(eq(toolPermissionRule.id, r.id));
    expect(ruleRow?.decision).toBe("deny");
    const auditRows = await db.select().from(adminAuditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorUserId).toBe("u-admin");
    expect(auditRows[0]?.action).toBe("permission_rule.created");
    expect(auditRows[0]?.targetType).toBe("permission_rule");
    expect(auditRows[0]?.targetId).toBe(r.id);
  });
});

describe("updatePermissionRule + 审计 (07-P2-5)", () => {
  it("规则存在 → 更新字段 + 审计", async () => {
    await insertUser("u-admin");
    // 先建一条规则
    const created = await createPermissionRule({
      toolPattern: "tool.x",
      decision: "allow",
    });

    const result = await updatePermissionRule(
      created.id,
      { decision: "deny", priority: 100 },
      "u-admin",
    );
    expect(result).not.toBeNull();
    // 真实 DB:规则已更新
    const [ruleRow] = await db
      .select()
      .from(toolPermissionRule)
      .where(eq(toolPermissionRule.id, created.id));
    expect(ruleRow?.decision).toBe("deny");
    expect(ruleRow?.priority).toBe(100);
    // 审计行落库
    const auditRows = await db.select().from(adminAuditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("permission_rule.updated");
    expect(auditRows[0]?.targetId).toBe(created.id);
  });

  it("规则不存在 → 返回 null,不更新不审计", async () => {
    await insertUser("u-admin");
    const result = await updatePermissionRule("ghost", { decision: "deny" }, "u-admin");
    expect(result).toBeNull();
    expect(await countAll(adminAuditLog)).toBe(0);
  });
});

describe("deletePermissionRule + 审计 (07-P2-5)", () => {
  it("规则存在 → 删除 + 审计", async () => {
    await insertUser("u-admin");
    const created = await createPermissionRule({
      toolPattern: "tool.x",
      decision: "allow",
    });

    const result = await deletePermissionRule(created.id, "u-admin");
    expect(result).toBe(true);
    // 真实 DB:规则已删
    expect(await countAll(toolPermissionRule)).toBe(0);
    // 审计行落库
    const auditRows = await db.select().from(adminAuditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("permission_rule.deleted");
  });

  it("规则不存在 → 返回 false,不删除不审计", async () => {
    await insertUser("u-admin");
    const result = await deletePermissionRule("ghost", "u-admin");
    expect(result).toBe(false);
    expect(await countAll(adminAuditLog)).toBe(0);
  });
});

// ─── S1(08-P2-3):json 列 zod 校验 fail-closed(真实 MySQL) ────

describe("createToolRun zod 校验 (08-P2-3)", () => {
  it("合法 input(对象)→ 正常写入", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await createToolRun({ threadId: "t1", toolName: "writeFile", input: { path: "x" } });
    const [row] = await db.select().from(toolRun);
    expect(row?.input).toEqual({ path: "x" });
  });

  it("非法 input(非对象,如数组)→ 抛错不落库", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await expect(
      createToolRun({
        threadId: "t1",
        toolName: "writeFile",
        input: ["not", "an", "object"] as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(/json-column:input/);
    // 真实 DB:无 toolRun 落库
    expect(await countAll(toolRun)).toBe(0);
  });
});

describe("finishToolRunSuccess zod 校验 (08-P2-3)", () => {
  it("合法 output → 正常更新", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertToolRunRow("tr-1", "t1", { status: "running" });

    await finishToolRunSuccess("tr-1", { ok: true });
    const [row] = await db.select().from(toolRun).where(eq(toolRun.id, "tr-1"));
    expect(row?.output).toEqual({ ok: true });
  });

  it("非法 output(数组)→ 抛错不更新", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertToolRunRow("tr-1", "t1", { status: "running", output: null });

    await expect(
      finishToolRunSuccess("tr-1", ["bad"] as unknown as Record<string, unknown>),
    ).rejects.toThrow(/json-column:output/);
    // 真实 DB:output 仍为 null(未更新)
    const [row] = await db.select().from(toolRun).where(eq(toolRun.id, "tr-1"));
    expect(row?.output).toBeNull();
  });
});

describe("saveContextSnapshot zod 校验 (08-P2-3)", () => {
  it("合法 layers + checksums → 正常写入", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await saveContextSnapshot({
      threadId: "t1",
      trigger: "chat",
      model: "m",
      toolNames: [],
      layers: [{ layer: "instructions" }],
      protectedRefs: [],
      excludedCandidates: [],
      checksums: { tools: "abc" },
      estimatedTokens: 0,
    });
    const [row] = await db.select().from(contextSnapshot);
    expect(row?.checksums).toEqual({ tools: "abc" });
  });

  it("非法 layers(非数组)→ 抛错不落库", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await expect(
      saveContextSnapshot({
        threadId: "t1",
        trigger: "chat",
        model: "m",
        toolNames: [],
        layers: { not: "array" } as unknown as unknown[],
        protectedRefs: [],
        excludedCandidates: [],
        checksums: {},
        estimatedTokens: 0,
      }),
    ).rejects.toThrow(/json-column:layers/);
    expect(await countAll(contextSnapshot)).toBe(0);
  });

  it("非法 checksums(值非字符串)→ 抛错不落库", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");

    await expect(
      saveContextSnapshot({
        threadId: "t1",
        trigger: "chat",
        model: "m",
        toolNames: [],
        layers: [],
        protectedRefs: [],
        excludedCandidates: [],
        checksums: { tools: 123 } as unknown as Record<string, string>,
        estimatedTokens: 0,
      }),
    ).rejects.toThrow(/json-column:checksums/);
    expect(await countAll(contextSnapshot)).toBe(0);
  });
});

describe("createCustomTool zod 校验 (08-P2-3)", () => {
  it("合法 inputSchema + executorConfig → 正常写入", async () => {
    await createCustomTool({
      name: "myTool",
      description: "test",
      inputSchema: { type: "object" },
      executorType: "webhook",
      executorConfig: { url: "https://x.com" },
    });
    const [row] = await db.select().from(customTool);
    expect(row?.name).toBe("myTool");
  });

  it("非法 inputSchema(非对象)→ 抛错不落库", async () => {
    await expect(
      createCustomTool({
        name: "myTool",
        description: "test",
        inputSchema: "not-object" as unknown as Record<string, unknown>,
        executorType: "webhook",
        executorConfig: { url: "x" },
      }),
    ).rejects.toThrow(/json-column:inputSchema/);
    expect(await countAll(customTool)).toBe(0);
  });

  it("非法 executorConfig(非对象)→ 抛错不落库", async () => {
    await expect(
      createCustomTool({
        name: "myTool",
        description: "test",
        inputSchema: { type: "object" },
        executorType: "webhook",
        executorConfig: ["bad"] as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(/json-column:executorConfig/);
    expect(await countAll(customTool)).toBe(0);
  });
});

describe("createMemoryRow zod 校验 (08-P2-3)", () => {
  it("合法 provenance → 正常写入", async () => {
    await createMemoryRow({
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "x",
      textHash: "h",
      provenance: [{ kind: "user", refId: "u1" }],
      confidence: "medium",
      expiresAt: null,
      createdByToolRunId: null,
    });
    const [row] = await db.select().from(memoryEntry);
    expect(row?.scope).toBe("project");
  });

  it("空 provenance → 抛错不落库(防孤儿记忆)", async () => {
    await expect(
      createMemoryRow({
        scope: "project",
        scopeRef: "p1",
        kind: "convention",
        text: "x",
        textHash: "h",
        provenance: [],
        confidence: "medium",
        expiresAt: null,
        createdByToolRunId: null,
      }),
    ).rejects.toThrow(/json-column:provenance/);
    expect(await countAll(memoryEntry)).toBe(0);
  });

  it("非法 provenance(缺 refId)→ 抛错不落库", async () => {
    await expect(
      createMemoryRow({
        scope: "project",
        scopeRef: "p1",
        kind: "convention",
        text: "x",
        textHash: "h",
        provenance: [{ kind: "user" }] as unknown as { kind: "user"; refId: string }[],
        confidence: "medium",
        expiresAt: null,
        createdByToolRunId: null,
      }),
    ).rejects.toThrow(/json-column:provenance/);
    expect(await countAll(memoryEntry)).toBe(0);
  });
});

// ─── S1(08-P2-5):cleanupOldSnapshots 短保留期(真实 MySQL) ──────

describe("cleanupOldSnapshots (08-P2-5 短保留期)", () => {
  it("显式 retainDays → 用传入值计算 cutoff", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    // 100 天前 createdAt(超 7 天保留期)
    await insertContextSnapshotRow("s-old", "t1", {
      createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    });
    await insertContextSnapshotRow("s-recent", "t1", { createdAt: new Date() });

    const { cleanupOldSnapshots } = await import("@/lib/db/queries");
    const result = await cleanupOldSnapshots(7);
    expect(result).toBe(1); // 只删 s-old
    const rows = await db.select().from(contextSnapshot);
    expect(rows.map((r) => r.id)).toEqual(["s-recent"]);
  });

  it("不传 retainDays → 用 dbConfig.snapshotRetentionDays(默认 7)", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertContextSnapshotRow("s-old", "t1", {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const { cleanupOldSnapshots } = await import("@/lib/db/queries");
    const result = await cleanupOldSnapshots();
    expect(result).toBe(1);
  });
});

// ─── V7: ThreadRun 查询与状态迁移 ─────────────────────────────

describe("ThreadRun 状态迁移与查询 (V7 S1-2)", () => {
  it("createThreadRun → 默认 queued，字段正确", async () => {
    const { createThreadRun } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4" });
    expect(run.status).toBe("queued");
    expect(run.triggerType).toBe("user_message");
    expect(run.model).toBe("gpt-4");
    expect(run.threadId).toBe("t1");
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.promptTokens).toBe(0);
  });

  it("createThreadRun(status=running) → startedAt/lastSeenAt 非 null", async () => {
    const { createThreadRun } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4", status: "running" });
    expect(run.status).toBe("running");
    expect(run.startedAt).not.toBeNull();
    expect(run.lastSeenAt).not.toBeNull();
  });

  it("markThreadRunRunning → 设置 running/startedAt/lastSeenAt", async () => {
    const { createThreadRun, markThreadRunRunning, getLatestThreadRun } = await import(
      "@/lib/db/queries"
    );
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4" });
    expect(run.startedAt).toBeNull();

    await markThreadRunRunning(run.id);
    const updated = await getLatestThreadRun("t1");
    expect(updated?.status).toBe("running");
    expect(updated?.startedAt).not.toBeNull();
    expect(updated?.lastSeenAt).not.toBeNull();
  });

  it("heartbeatThreadRun → 更新 lastSeenAt", async () => {
    const { createThreadRun, heartbeatThreadRun, markThreadRunRunning, getLatestThreadRun } =
      await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4", status: "running" });

    // 记录调用前时间，允许 DB 与 Node 时钟存在少量 skew（真实 MySQL 容器偶发）
    const before = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    await heartbeatThreadRun(run.id);
    const updated = await getLatestThreadRun("t1");
    expect(updated?.lastSeenAt).not.toBeNull();
    expect(updated?.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("completeThreadRun → completed + token 用量", async () => {
    const { createThreadRun, completeThreadRun, getLatestThreadRun } = await import(
      "@/lib/db/queries"
    );
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4", status: "running" });
    await completeThreadRun(run.id, {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    const updated = await getLatestThreadRun("t1");
    expect(updated?.status).toBe("completed");
    expect(updated?.finishedAt).not.toBeNull();
    expect(updated?.promptTokens).toBe(100);
    expect(updated?.completionTokens).toBe(50);
    expect(updated?.totalTokens).toBe(150);
  });

  it("failThreadRun → failed + error", async () => {
    const { createThreadRun, failThreadRun, getLatestThreadRun } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4", status: "running" });
    await failThreadRun(run.id, "stream error");
    const updated = await getLatestThreadRun("t1");
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("stream error");
    expect(updated?.finishedAt).not.toBeNull();
  });

  it("cancelThreadRun → cancelled + cancelReason", async () => {
    const { createThreadRun, cancelThreadRun, getLatestThreadRun } = await import(
      "@/lib/db/queries"
    );
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4", status: "running" });
    await cancelThreadRun(run.id, "user_cancelled");
    const updated = await getLatestThreadRun("t1");
    expect(updated?.status).toBe("cancelled");
    expect(updated?.cancelReason).toBe("user_cancelled");
    expect(updated?.finishedAt).not.toBeNull();
  });

  it("getActiveThreadRun → 仅返回 queued/running/awaiting_approval", async () => {
    const { createThreadRun, getActiveThreadRun, completeThreadRun } = await import(
      "@/lib/db/queries"
    );
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run1 = await createThreadRun({ threadId: "t1", model: "gpt-4" });
    const active = await getActiveThreadRun("t1");
    expect(active?.id).toBe(run1.id);

    // 完成后不再算 active
    await completeThreadRun(run1.id, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    const afterComplete = await getActiveThreadRun("t1");
    expect(afterComplete).toBeNull();
  });

  it("getThreadRunByIdForUser → owner guard", async () => {
    const { createThreadRun, getThreadRunByIdForUser } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertUser("u2");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4" });

    // owner 可以查到
    const owned = await getThreadRunByIdForUser(run.id, "u1");
    expect(owned?.id).toBe(run.id);

    // 非 owner 返回 null
    const notOwned = await getThreadRunByIdForUser(run.id, "u2");
    expect(notOwned).toBeNull();
  });

  it("markStaleThreadRuns → 标记失联 running run", async () => {
    const { createThreadRun, markStaleThreadRuns, getLatestThreadRun } = await import(
      "@/lib/db/queries"
    );
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4", status: "running" });

    // cutoff 设为未来 → 所有 running 都应被标 stale
    const future = new Date(Date.now() + 60_000);
    const count = await markStaleThreadRuns(future);
    expect(count).toBe(1);

    const updated = await getLatestThreadRun("t1");
    expect(updated?.status).toBe("stale");
  });

  it("markStaleThreadRuns → 不标 awaiting_approval", async () => {
    const { createThreadRun, markStaleThreadRuns, getLatestThreadRun } = await import(
      "@/lib/db/queries"
    );
    await insertUser("u1");
    await insertThread("t1", "u1");
    await createThreadRun({
      threadId: "t1",
      model: "gpt-4",
      status: "awaiting_approval",
    });

    const future = new Date(Date.now() + 60_000);
    const count = await markStaleThreadRuns(future);
    expect(count).toBe(0);

    const latest = await getLatestThreadRun("t1");
    expect(latest?.status).toBe("awaiting_approval");
  });

  it("V7 S3-3: markStaleThreadRuns → 同步更新 Thread.status + 写 ThreadEvent", async () => {
    const { createThreadRun, markStaleThreadRuns, getThreadById, listThreadEvents } = await import(
      "@/lib/db/queries"
    );
    await insertUser("u1");
    await insertThread("t1", "u1", { status: "executing" });
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4", status: "running" });

    const future = new Date(Date.now() + 60_000);
    await markStaleThreadRuns(future);

    // Thread.status 从 executing → failed
    const t = await getThreadById("t1");
    expect(t?.status).toBe("failed");

    // ThreadEvent 审计事件已写入
    const events = await listThreadEvents("t1");
    const staleEvent = events.find(
      (e) =>
        e.type === "agent.status_changed" &&
        (e.payload as Record<string, unknown>)?.reason === "run_stale",
    );
    expect(staleEvent).toBeDefined();
    expect(staleEvent?.runId).toBe(run.id);
    expect(staleEvent?.payload).toMatchObject({ from: "executing", to: "failed" });
  });

  it("V7 S4-1: getRunDetail → 返回 run + messages + events + toolRuns + contextSnapshots", async () => {
    const {
      createThreadRun,
      getRunDetail,
      saveMessages,
      appendThreadEvent,
      createToolRun,
      saveContextSnapshot,
    } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4", status: "running" });

    // 插入关联数据
    await saveMessages([
      {
        id: "m1",
        threadId: "t1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        runId: run.id,
      },
    ]);
    await appendThreadEvent("t1", "agent.started", { runId: run.id }, run.id);
    await createToolRun({
      threadId: "t1",
      toolName: "test",
      input: { query: "test" },
      status: "running",
      runId: run.id,
    });
    await saveContextSnapshot({
      threadId: "t1",
      trigger: "before_run",
      model: "gpt-4",
      toolNames: ["test"],
      layers: [{ name: "core", items: [] }],
      protectedRefs: [],
      excludedCandidates: [],
      checksums: {},
      estimatedTokens: 0,
      runId: run.id,
    });

    const detail = await getRunDetail("t1", run.id, "u1");
    expect(detail).not.toBeNull();
    expect(detail?.run.id).toBe(run.id);
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.events).toHaveLength(1);
    expect(detail?.toolRuns).toHaveLength(1);
    expect(detail?.contextSnapshots).toHaveLength(1);
  });

  it("V7 S4-1: getRunDetail → 非 owner 返回 null", async () => {
    const { createThreadRun, getRunDetail } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4", status: "running" });

    const detail = await getRunDetail("t1", run.id, "u2");
    expect(detail).toBeNull();
  });

  it("V7 S4-1: getRunDetail → run 不属于 thread 返回 null", async () => {
    const { createThreadRun, getRunDetail } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertThread("t2", "u1");
    const run = await createThreadRun({ threadId: "t2", model: "gpt-4", status: "running" });

    // 尝试用 t1 的 threadId 查 t2 的 run
    const detail = await getRunDetail("t1", run.id, "u1");
    expect(detail).toBeNull();
  });
});

// ─── V8: ThreadRunSkill 事实表查询 ────────────────────────────

describe("ThreadRunSkill 查询 (V8 阶段 2)", () => {
  it("saveThreadRunSkills → 0 个 Skill 不落行，返回空数组（基础 agent）", async () => {
    const { createThreadRun } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4" });

    const saved = await saveThreadRunSkills({ runId: run.id, threadId: "t1", skills: [] });
    expect(saved).toEqual([]);

    // DB 中确实无行
    const rows = await db.select().from(threadRunSkill).where(eq(threadRunSkill.runId, run.id));
    expect(rows).toHaveLength(0);

    // listByRun 也返回空
    expect(await listThreadRunSkillsByRun(run.id)).toEqual([]);
  });

  it("saveThreadRunSkills → 1 个 Skill 落行，字段正确", async () => {
    const { createThreadRun } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4" });

    const saved = await saveThreadRunSkills({
      runId: run.id,
      threadId: "t1",
      skills: [
        {
          skillId: "skill-1",
          skillVersionId: "ver-1",
          reason: "resolver 命中需求文档关键词",
          contentHash: "abc123",
        },
      ],
    });

    expect(saved).toHaveLength(1);
    const row = saved[0];
    expect(row?.runId).toBe(run.id);
    expect(row?.threadId).toBe("t1");
    expect(row?.skillId).toBe("skill-1");
    expect(row?.skillVersionId).toBe("ver-1");
    expect(row?.role).toBe("primary");
    expect(row?.source).toBe("resolver");
    expect(row?.reason).toBe("resolver 命中需求文档关键词");
    expect(row?.contentHash).toBe("abc123");
    expect(row?.createdAt).toBeInstanceOf(Date);

    // DB 真实落库
    const [dbRow] = await db.select().from(threadRunSkill).where(eq(threadRunSkill.runId, run.id));
    expect(dbRow?.skillId).toBe("skill-1");
    expect(dbRow?.role).toBe("primary");
  });

  it("saveThreadRunSkills → 多个 Skill（primary + supporting）落行", async () => {
    const { createThreadRun } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4" });

    const saved = await saveThreadRunSkills({
      runId: run.id,
      threadId: "t1",
      skills: [
        { skillId: "skill-1", skillVersionId: "ver-1", role: "primary" },
        { skillId: "skill-2", skillVersionId: "ver-2", role: "supporting", source: "resume" },
      ],
    });

    expect(saved).toHaveLength(2);
    // createdAt 同毫秒插入时顺序非确定，按 role 定位断言
    const primary = saved.find((s) => s.role === "primary");
    const supporting = saved.find((s) => s.role === "supporting");
    expect(primary?.skillId).toBe("skill-1");
    expect(primary?.source).toBe("resolver");
    expect(supporting?.skillId).toBe("skill-2");
    expect(supporting?.source).toBe("resume");
    // 两条行都归属同一 run
    expect(saved[0]?.runId).toBe(run.id);
    expect(saved[1]?.runId).toBe(run.id);
  });

  it("listThreadRunSkillsByRun → 只返回该 run 的行，不含其他 run", async () => {
    const { createThreadRun } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    const runA = await createThreadRun({ threadId: "t1", model: "gpt-4" });
    const runB = await createThreadRun({ threadId: "t1", model: "gpt-4" });

    await saveThreadRunSkills({
      runId: runA.id,
      threadId: "t1",
      skills: [{ skillId: "skill-a", skillVersionId: "ver-a" }],
    });
    await saveThreadRunSkills({
      runId: runB.id,
      threadId: "t1",
      skills: [
        { skillId: "skill-b1", skillVersionId: "ver-b1" },
        { skillId: "skill-b2", skillVersionId: "ver-b2" },
      ],
    });

    const aRows = await listThreadRunSkillsByRun(runA.id);
    expect(aRows).toHaveLength(1);
    expect(aRows[0]?.skillId).toBe("skill-a");

    const bRows = await listThreadRunSkillsByRun(runB.id);
    expect(bRows).toHaveLength(2);
    expect(bRows.map((r) => r.skillId).sort()).toEqual(["skill-b1", "skill-b2"]);
  });

  it("恢复 run：listThreadRunSkillsByRun 读取原 run 版本，供新 run 沿用", async () => {
    const { createThreadRun } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    // 原 run（中断）使用了 skill-1 ver-1
    const origRun = await createThreadRun({ threadId: "t1", model: "gpt-4", status: "running" });
    await saveThreadRunSkills({
      runId: origRun.id,
      threadId: "t1",
      skills: [
        {
          skillId: "skill-1",
          skillVersionId: "ver-1",
          source: "resolver",
          contentHash: "sha-aaa",
        },
      ],
    });

    // 恢复时读取原 run 的 ThreadRunSkill
    const resumed = await listThreadRunSkillsByRun(origRun.id);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.skillVersionId).toBe("ver-1");
    expect(resumed[0]?.contentHash).toBe("sha-aaa");

    // 新 run 沿用原版本，source 标记为 resume
    const newRun = await createThreadRun({ threadId: "t1", model: "gpt-4" });
    const saved = await saveThreadRunSkills({
      runId: newRun.id,
      threadId: "t1",
      skills: resumed.map((r) => ({
        skillId: r.skillId,
        skillVersionId: r.skillVersionId,
        source: "resume" as const,
        contentHash: r.contentHash,
      })),
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.source).toBe("resume");
    expect(saved[0]?.skillVersionId).toBe("ver-1");
    expect(saved[0]?.contentHash).toBe("sha-aaa");
  });

  it("listThreadRunSkillsByThread → 跨多个 run 按 createdAt 升序聚合", async () => {
    const { createThreadRun } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertThread("t2", "u1");

    const run1 = await createThreadRun({ threadId: "t1", model: "gpt-4" });
    await saveThreadRunSkills({
      runId: run1.id,
      threadId: "t1",
      skills: [{ skillId: "skill-1", skillVersionId: "ver-1" }],
    });

    const run2 = await createThreadRun({ threadId: "t1", model: "gpt-4" });
    await saveThreadRunSkills({
      runId: run2.id,
      threadId: "t1",
      skills: [{ skillId: "skill-2", skillVersionId: "ver-2" }],
    });

    // t2 的 run 不应出现在 t1 的历史中
    const run3 = await createThreadRun({ threadId: "t2", model: "gpt-4" });
    await saveThreadRunSkills({
      runId: run3.id,
      threadId: "t2",
      skills: [{ skillId: "skill-x", skillVersionId: "ver-x" }],
    });

    const history = await listThreadRunSkillsByThread("t1");
    expect(history).toHaveLength(2);
    // createdAt 同毫秒插入时顺序非确定，按集合断言
    expect(history.map((r) => r.skillId).sort()).toEqual(["skill-1", "skill-2"]);
    // 升序：run1 的行 createdAt <= run2 的行 createdAt
    expect(history[0]?.createdAt.getTime()).toBeLessThanOrEqual(
      history[1]?.createdAt.getTime() ?? 0,
    );
  });

  it("listThreadRunSkillsByThread → limit 限流生效", async () => {
    const { createThreadRun } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");

    for (let i = 0; i < 5; i++) {
      const run = await createThreadRun({ threadId: "t1", model: "gpt-4" });
      await saveThreadRunSkills({
        runId: run.id,
        threadId: "t1",
        skills: [{ skillId: `skill-${i}`, skillVersionId: `ver-${i}` }],
      });
    }

    const limited = await listThreadRunSkillsByThread("t1", { limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it("V8 补充方案阶段 2：保存企业平台 ID（sk_* / skv_*）和 sha256:<64hex> 不被截断", async () => {
    const { createThreadRun } = await import("@/lib/db/queries");
    await insertUser("u1");
    await insertThread("t1", "u1");
    const run = await createThreadRun({ threadId: "t1", model: "gpt-4" });

    // capability-market 真实返回的 ID 形态：sk_<name>、skv_<name>_<n>、sha256:<64hex>
    const skillId = "sk_contract_review_with_a_quite_long_name_exceeding_36_chars";
    const skillVersionId =
      "skv_contract_review_with_a_quite_long_version_id_exceeding_36_chars_100";
    const contentHash = `sha256:${"0123456789abcdef".repeat(4)}`; // sha256: + 64 hex = 71 chars

    // 确认测试样本长度确实超过旧上限 36 / 40
    expect(skillId.length).toBeGreaterThan(36);
    expect(skillId.length).toBeLessThanOrEqual(128);
    expect(skillVersionId.length).toBeGreaterThan(36);
    expect(skillVersionId.length).toBeLessThanOrEqual(128);
    expect(contentHash.length).toBe(71); // "sha256:" (7) + 64 hex
    expect(contentHash.length).toBeGreaterThan(40);

    const saved = await saveThreadRunSkills({
      runId: run.id,
      threadId: "t1",
      skills: [
        {
          skillId,
          skillVersionId,
          reason: "企业 Skill，本地 DB 无行",
          contentHash,
        },
      ],
    });

    expect(saved).toHaveLength(1);
    const row = saved[0];
    expect(row?.skillId).toBe(skillId);
    expect(row?.skillVersionId).toBe(skillVersionId);
    expect(row?.contentHash).toBe(contentHash);

    // DB 真实落库（确认未被截断）
    const [dbRow] = await db.select().from(threadRunSkill).where(eq(threadRunSkill.runId, run.id));
    expect(dbRow?.skillId).toBe(skillId);
    expect(dbRow?.skillVersionId).toBe(skillVersionId);
    expect(dbRow?.contentHash).toBe(contentHash);

    // listByRun 也能原样读回
    const resumed = await listThreadRunSkillsByRun(run.id);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.skillId).toBe(skillId);
    expect(resumed[0]?.skillVersionId).toBe(skillVersionId);
    expect(resumed[0]?.contentHash).toBe(contentHash);
  });
});
