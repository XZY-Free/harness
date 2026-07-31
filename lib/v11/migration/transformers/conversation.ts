/**
 * S13-C03 conversation 域迁移转换器。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §conversation
 * - ../v11-agentkit-platform/10-core-data-model.md §5（thread/turn/item/event）、§6（invocation）
 *
 * 映射：
 * - Thread → V11Thread（status→lifecycleState；userId→ownerUserId；deletedAt 保留软删除）
 * - Message → V11ThreadItem（parts→contentJson；role/type→itemType；runId→invocationId）
 * - ThreadEvent → V11ThreadEvent（sequence→eventSequence bigint；payload→payloadJson；type→eventType）
 * - ThreadRun → V11Invocation + V11InvocationAttempt（status→executionState；triggerType→invocationKind）
 *
 * 迁移原则：
 * - 只迁可证明事实；无法映射的 type/role 入异常队列，不猜测。
 * - 跨表依赖按域顺序保证：Thread → Message → ThreadEvent → ThreadRun。
 * - 保留源 id 作为目标 id，便于跨表关联追溯。
 * - userId → ownerUserId 需查询 UserIdentity 表（identity 域已迁移，源 id 直接复用）。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { thread as threadTable } from "@/lib/db/schema";
import { DEFAULT_TENANT_ID } from "@/lib/v11/identity/tenant-queries";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { v11ThreadItem as v11ThreadItemTable } from "@/lib/v11/schema/conversation";
import { userIdentity as userIdentityTable } from "@/lib/v11/schema/identity";
import { v11Invocation as v11InvocationTable } from "@/lib/v11/schema/runtime";
import { eq, max } from "drizzle-orm";

/**
 * 旧 Thread 无 Agent 引用，迁移时使用占位值（agent_skill 域迁移后回填）。
 * V11Thread.primaryAgentId 为逻辑外键（无 DB 级 FK 约束），占位值可安全写入。
 */
const LEGACY_PRIMARY_AGENT_ID = "00000000-0000-4000-8000-000000000001";

/**
 * 旧 Message 无 Turn 概念，迁移时使用占位值（后续阶段回填）。
 * V11ThreadItem.turnId 为逻辑外键（无 DB 级 FK 约束），占位值可安全写入。
 */
const LEGACY_TURN_ID = "00000000-0000-4000-8000-000000000002";

/** 计算 content hash（sha256，带算法前缀）。 */
function computeContentHash(content: unknown): string {
  const json = JSON.stringify(content ?? null);
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

/**
 * 将 Date 值规范化（兼容 string/Date 输入）。
 *
 * 关键：迁移 runner 通过 db.execute 原始 SQL 读取源记录，drizzle mysql2 session 的 typeCast
 * 将 DATETIME/TIMESTAMP/DATE 列统一返回为字符串（见 drizzle-orm/mysql2/session.js 的 typeCast）。
 * 该字符串是 UTC 表示（drizzle mapToDriverValue 用 Date.toISOString() 写入，去 Z 后落库）。
 * 因此必须按 UTC 解析——与 drizzle mapFromDriverValue（new Date(value.replace(" ","T")+"Z")）一致；
 * 若直接 new Date(str) 会按本地时区解析，导致 8h（Asia/Shanghai）偏移，破坏时间戳保真。
 */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const str = String(value);
  // 形如 "2024-06-01 12:00:00" 或 "2024-06-01 12:00:00.000"（drizzle typeCast 返回的 DATETIME 串）
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(str)) {
    return new Date(`${str.replace(" ", "T")}Z`);
  }
  return new Date(str);
}

// ─── Thread status → V11Thread lifecycleState ─────────────

/** Thread 终态 status（映射为 archived）。 */
const THREAD_TERMINAL_STATUSES = new Set(["completed", "cancelled"]);

/** 映射 Thread.status → V11Thread.lifecycleState；deletedAt 优先。 */
function mapThreadLifecycleState(
  status: string,
  deletedAt: unknown,
): "active" | "archived" | "deleted" {
  if (deletedAt !== null && deletedAt !== undefined) return "deleted";
  if (THREAD_TERMINAL_STATUSES.has(status)) return "archived";
  return "active";
}

// ─── Message role/type → V11ThreadItem itemType + authorType ─

/** Message type/role → V11ThreadItem itemType + authorType 映射结果。 */
interface ItemMapping {
  readonly itemType: string;
  readonly authorType: string;
}

/** 按 type 优先、role 兜底映射 itemType + authorType；无法映射返回 null。 */
function mapMessageItemType(messageType: string | null, role: string): ItemMapping | null {
  // type 优先映射
  if (messageType === "user_input") return { itemType: "user_message", authorType: "user" };
  if (messageType === "assistant_text") return { itemType: "agent_message", authorType: "agent" };
  if (messageType === "tool_call" || messageType === "tool_result") {
    return { itemType: "tool_call", authorType: "tool" };
  }
  // system 消息无直接 itemType 对应，映射为 user_message 保留内容
  if (messageType === "system") return { itemType: "user_message", authorType: "system" };

  // type 为空或未识别时，按 role 兜底
  if (role === "user") return { itemType: "user_message", authorType: "user" };
  if (role === "assistant") return { itemType: "agent_message", authorType: "agent" };
  if (role === "tool") return { itemType: "tool_call", authorType: "tool" };
  if (role === "system") return { itemType: "user_message", authorType: "system" };

  return null;
}

// ─── ThreadRun status → V11Invocation executionState ──────

/** 映射 ThreadRun.status → V11Invocation.executionState。 */
function mapRunStatusToExecutionState(status: string): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "awaiting_approval":
      return "waiting_user";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "stale":
      return "lost";
    default:
      return "queued";
  }
}

/** 映射 ThreadRun.status → V11InvocationAttempt.attemptState（无 waiting_user）。 */
function mapRunStatusToAttemptState(status: string): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
    case "awaiting_approval":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "stale":
      return "lost";
    default:
      return "queued";
  }
}

/** 映射 ThreadRun.triggerType → V11Invocation.invocationKind。 */
function mapTriggerTypeToInvocationKind(triggerType: string): string {
  if (triggerType.includes("job")) return "job";
  return "initial";
}

// ─── Thread → V11Thread ────────────────────────────────────

const threadTransformer: MigrationTransformer = async (record) => {
  const threadId = String(record.id ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "Thread.id 为空" };
  }

  const userId = String(record.userId ?? "");
  if (!userId) {
    return { targets: [], anomalyReason: "Thread.userId 为空" };
  }

  const status = String(record.status ?? "idle");

  // 异常条件：status=deleted 且无 deletedAt
  if (status === "deleted" && (record.deletedAt === null || record.deletedAt === undefined)) {
    return { targets: [], anomalyReason: "status=deleted 且无 deletedAt" };
  }

  // 查询 UserIdentity（须先迁移 identity 域 User）；源 id 直接复用
  const [ui] = await db
    .select({ id: userIdentityTable.id })
    .from(userIdentityTable)
    .where(eq(userIdentityTable.id, userId))
    .limit(1);
  if (!ui) {
    return {
      targets: [],
      anomalyReason: `User ${userId} 的 UserIdentity 不存在（须先迁移 identity 域 User）`,
    };
  }

  const deletedAt = record.deletedAt ? toDate(record.deletedAt) : null;
  const lifecycleState = mapThreadLifecycleState(status, deletedAt);
  const updatedAt = toDate(record.updatedAt);
  const createdAt = toDate(record.createdAt);

  return {
    targets: [
      {
        table: "V11Thread",
        data: {
          id: threadId,
          tenantId: DEFAULT_TENANT_ID,
          ownerUserId: ui.id,
          primaryAgentId: LEGACY_PRIMARY_AGENT_ID,
          defaultWorkspaceId: null,
          activeGoalId: null,
          title: record.title ? String(record.title) : null,
          defaultModelRef: record.model ? String(record.model) : null,
          defaultEnvironmentDefinitionId: null,
          lifecycleState,
          lastActivityAt: updatedAt,
          lastTurnSequence: 0,
          lastItemSequence: 0,
          lastEventSequence: 0,
          pendingQueueVersionNo: 1,
          versionNo: 1,
          createdAt,
          updatedAt,
          deletedAt,
        },
      },
    ],
  };
};

// ─── Message → V11ThreadItem ───────────────────────────────

const messageTransformer: MigrationTransformer = async (record) => {
  const messageId = String(record.id ?? "");
  if (!messageId) {
    return { targets: [], anomalyReason: "Message.id 为空" };
  }

  const threadId = String(record.threadId ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "Message.threadId 为空" };
  }

  // 查询旧 Thread 表验证 threadId 存在（孤儿消息入异常队列）
  const [threadRow] = await db
    .select({ id: threadTable.id })
    .from(threadTable)
    .where(eq(threadTable.id, threadId))
    .limit(1);
  if (!threadRow) {
    return { targets: [], anomalyReason: `Thread ${threadId} 不存在（孤儿消息）` };
  }

  const role = String(record.role ?? "");
  const rawType = record.type ?? null;
  const messageType = rawType ? String(rawType) : null;
  const mapping = mapMessageItemType(messageType, role);
  if (!mapping) {
    return {
      targets: [],
      anomalyReason: `Message type="${messageType}" role="${role}" 无对应 V11 itemType`,
    };
  }

  // parts → contentJson
  const parts = record.parts ?? [];
  const contentJson = parts;
  const contentHash = computeContentHash(parts);

  // runId → invocationId（ThreadRun 迁移后 Invocation.id = ThreadRun.id）
  const invocationId = record.runId ? String(record.runId) : null;

  // itemSequence：查询当前 Thread 内最大值 + 1（保证唯一）
  const [seqRow] = await db
    .select({ maxSeq: max(v11ThreadItemTable.itemSequence) })
    .from(v11ThreadItemTable)
    .where(eq(v11ThreadItemTable.threadId, threadId));
  const itemSequence = Number(seqRow?.maxSeq ?? 0) + 1;

  const createdAt = toDate(record.createdAt);

  return {
    targets: [
      {
        table: "V11ThreadItem",
        data: {
          id: messageId,
          threadId,
          turnId: LEGACY_TURN_ID,
          itemSequence,
          itemType: mapping.itemType,
          itemState: "completed",
          authorType: mapping.authorType,
          authorId: null,
          contentJson,
          contentHash,
          contextPolicy: "include",
          invocationId,
          supersededByItemId: null,
          createdAt,
          updatedAt: createdAt,
        },
      },
    ],
  };
};

// ─── ThreadEvent → V11ThreadEvent ──────────────────────────

const threadEventTransformer: MigrationTransformer = async (record) => {
  const eventId = String(record.id ?? "");
  if (!eventId) {
    return { targets: [], anomalyReason: "ThreadEvent.id 为空" };
  }

  const threadId = String(record.threadId ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "ThreadEvent.threadId 为空" };
  }

  // 查询旧 Thread 表验证 threadId 存在
  const [threadRow] = await db
    .select({ id: threadTable.id })
    .from(threadTable)
    .where(eq(threadTable.id, threadId))
    .limit(1);
  if (!threadRow) {
    return { targets: [], anomalyReason: `Thread ${threadId} 不存在` };
  }

  const sequence = Number(record.sequence ?? 0);
  const eventType = String(record.type ?? "");
  if (!eventType) {
    return { targets: [], anomalyReason: "ThreadEvent.type 为空" };
  }

  const payload = record.payload ?? {};
  const invocationId = record.runId ? String(record.runId) : null;
  const occurredAt = toDate(record.createdAt);

  return {
    targets: [
      {
        table: "V11ThreadEvent",
        data: {
          id: eventId,
          threadId,
          eventSequence: sequence,
          eventType,
          schemaVersion: 1,
          turnId: null,
          itemId: null,
          invocationId,
          actorType: "system",
          actorId: null,
          payloadJson: payload,
          correlationId: null,
          causationId: null,
          idempotencyKey: null,
          occurredAt,
          ingestedAt: occurredAt,
        },
      },
    ],
  };
};

// ─── ThreadRun → V11Invocation + V11InvocationAttempt ──────

const threadRunTransformer: MigrationTransformer = async (record) => {
  const runId = String(record.id ?? "");
  if (!runId) {
    return { targets: [], anomalyReason: "ThreadRun.id 为空" };
  }

  const threadId = String(record.threadId ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "ThreadRun.threadId 为空" };
  }

  // 查询旧 Thread 表验证 threadId 存在
  const [threadRow] = await db
    .select({ id: threadTable.id })
    .from(threadTable)
    .where(eq(threadTable.id, threadId))
    .limit(1);
  if (!threadRow) {
    return { targets: [], anomalyReason: `Thread ${threadId} 不存在` };
  }

  const status = String(record.status ?? "queued");
  const triggerType = String(record.triggerType ?? "user_message");
  const executionState = mapRunStatusToExecutionState(status);
  const attemptState = mapRunStatusToAttemptState(status);
  const invocationKind = mapTriggerTypeToInvocationKind(triggerType);

  // invocationSequence：查询当前 Thread 内最大值 + 1（保证唯一）
  const [seqRow] = await db
    .select({ maxSeq: max(v11InvocationTable.invocationSequence) })
    .from(v11InvocationTable)
    .where(eq(v11InvocationTable.threadId, threadId));
  const invocationSequence = Number(seqRow?.maxSeq ?? 0) + 1;

  const startedAt = record.startedAt ? toDate(record.startedAt) : null;
  const finishedAt = record.finishedAt ? toDate(record.finishedAt) : null;
  const lastHeartbeatAt = record.lastSeenAt ? toDate(record.lastSeenAt) : null;
  const createdAt = toDate(record.createdAt);

  // 错误信息：failed 取 error，cancelled 取 cancelReason
  const isFailed = status === "failed";
  const isCancelled = status === "cancelled";
  const errorCode = isFailed ? "legacy_failed" : isCancelled ? "legacy_cancelled" : null;
  const errorSummary = isFailed
    ? record.error
      ? String(record.error)
      : null
    : isCancelled
      ? record.cancelReason
        ? String(record.cancelReason)
        : null
      : null;

  // triggerMessageId → triggerItemId（Message 迁移后 V11ThreadItem.id = Message.id）
  const triggerItemId = record.triggerMessageId ? String(record.triggerMessageId) : null;

  return {
    targets: [
      {
        table: "V11Invocation",
        data: {
          id: runId,
          tenantId: DEFAULT_TENANT_ID,
          threadId,
          turnId: null,
          jobId: null,
          invocationSequence,
          invocationKind,
          executionState,
          triggerItemId,
          replacesInvocationId: null,
          outputItemId: null,
          resultRef: null,
          runtimeSessionBindingId: null,
          runtimeExecutionRef: null,
          startedAt,
          finishedAt,
          lastHeartbeatAt,
          errorCode,
          errorSummary,
          versionNo: 1,
          createdAt,
          updatedAt: createdAt,
        },
      },
      {
        table: "V11InvocationAttempt",
        data: {
          id: randomUUID(),
          invocationId: runId,
          attemptNo: 1,
          attemptState,
          environmentLeaseId: null,
          workerRef: null,
          runtimeExecutionRef: null,
          checkpointRef: null,
          retryReasonCode: null,
          startedAt,
          finishedAt,
          lastHeartbeatAt,
          errorCode,
          errorSummary,
          createdAt,
          updatedAt: createdAt,
        },
      },
    ],
  };
};

// ─── 导出 conversation 域转换器注册表 ──────────────────────

/** 创建 conversation 域的全部转换器（key = 物理表名）。 */
export function createConversationTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ["Thread", threadTransformer],
    ["Message", messageTransformer],
    ["ThreadEvent", threadEventTransformer],
    ["ThreadRun", threadRunTransformer],
  ]);
}
