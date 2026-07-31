/**
 * S13-C03 background_subagent 域迁移转换器。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §background_subagent
 * - ../v11-agentkit-platform/10-core-data-model.md §6.1（Job）、§6.2（Invocation）、§6.5（ThreadRelation）
 *
 * 映射：
 * - BackgroundTask → V11Job + V11Invocation
 *   - kind→jobType；status→jobState/executionState
 *   - pid/containerName/port/logPath 为 unmigratableFields，不迁移
 *   - threadId 不存在为异常
 * - SubagentRun → V11Thread + V11ThreadRelation + V11Invocation
 *   - status→relationState/executionState；parentThreadId→parentThreadId
 *   - transcriptPath 为 unmigratableField，不迁移
 *   - parentThreadId 不存在为异常
 *   - 注：V11ThreadRelation.childThreadId 需 DB FK 到 V11Thread，旧 SubagentRun 无子 Thread，
 *     故创建支撑 V11Thread（id=源 id）满足 FK。
 *
 * 迁移原则：
 * - 只迁可证明事实；无法映射的 agentId/ownerUserId/primaryAgentId 用 legacy-migrated 占位。
 * - 保留源 id 作为目标 id（BackgroundTask.id→V11Job.id；SubagentRun.id→V11Thread.id）。
 * - 跨表依赖按域顺序保证：conversation 域先于 background_subagent 域，parentThreadId 在 V11Thread 中存在。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { thread as threadTable } from "@/lib/db/schema";
import { DEFAULT_TENANT_ID } from "@/lib/v11/identity/tenant-queries";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { eq } from "drizzle-orm";

/** legacy 占位 ID（旧记录无对应 V11 Agent/User 时的占位值，逻辑外键不强制）。 */
const LEGACY_MIGRATED = "legacy-migrated";

/** 默认完成策略（all_success：全部 Invocation 成功才完成）。 */
const DEFAULT_COMPLETION_POLICY_JSON = JSON.stringify({ type: "all_success" });

/**
 * 将旧记录中的 datetime 值（可能为 Date / ISO 字符串 / null）规范化为 Date | null。
 * db.execute() 原生 SQL 返回的 datetime 列为字符串，需转为 Date 供 drizzle 插入。
 */
function normalizeDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return null;
}

// ─── BackgroundTask 状态映射 ───────────────────────────────

/** BackgroundTask.kind → V11Job.jobType 映射。未知 kind 默认 system。 */
function mapBackgroundTaskKindToJobType(kind: string): string {
  switch (kind) {
    case "build":
    case "worker":
      return "batch";
    case "dev-server":
    case "watcher":
    case "custom":
      return "system";
    default:
      return "system";
  }
}

/** BackgroundTask.status → V11Job.jobState 映射。 */
function mapBackgroundTaskStatusToJobState(status: string): string {
  switch (status) {
    case "starting":
      return "queued";
    case "running":
      return "running";
    case "stopped":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "orphaned":
      return "failed"; // 孤儿进程映射为失败（Job 无 lost 状态）
    default:
      return "queued";
  }
}

/** BackgroundTask.status → V11Invocation.executionState 映射。 */
function mapBackgroundTaskStatusToInvocationState(status: string): string {
  switch (status) {
    case "starting":
      return "queued";
    case "running":
      return "running";
    case "stopped":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "orphaned":
      return "lost";
    default:
      return "queued";
  }
}

// ─── SubagentRun 状态映射 ──────────────────────────────────

/** SubagentRun.status → V11ThreadRelation.relationState 映射。 */
function mapSubagentRunStatusToRelationState(status: string): string {
  switch (status) {
    case "queued":
      return "creating";
    case "running":
      return "active";
    case "completed":
      return "completed";
    case "failed":
    case "timed_out":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "creating";
  }
}

/** SubagentRun.status → V11Invocation.executionState 映射。 */
function mapSubagentRunStatusToInvocationState(status: string): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "timed_out":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "queued";
  }
}

// ─── BackgroundTask → V11Job + V11Invocation ────────────────

const backgroundTaskTransformer: MigrationTransformer = async (record) => {
  const sourceId = String(record.id ?? "");
  if (!sourceId) {
    return { targets: [], anomalyReason: "BackgroundTask.id 为空" };
  }

  const threadId = String(record.threadId ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "threadId 为空" };
  }

  // 验证 threadId 存在（异常条件：threadId 不存在）
  const [threadRow] = await db
    .select({ id: threadTable.id })
    .from(threadTable)
    .where(eq(threadTable.id, threadId))
    .limit(1);
  if (!threadRow) {
    return { targets: [], anomalyReason: `threadId ${threadId} 不存在` };
  }

  const kind = String(record.kind ?? "");
  const status = String(record.status ?? "");
  const jobType = mapBackgroundTaskKindToJobType(kind);
  const jobState = mapBackgroundTaskStatusToJobState(status);
  const executionState = mapBackgroundTaskStatusToInvocationState(status);

  const startedAt = normalizeDate(record.startedAt);
  const finishedAt = normalizeDate(record.finishedAt);

  const jobId = sourceId; // 保留源 id
  const invocationId = randomUUID();

  return {
    targets: [
      {
        table: "V11Job",
        data: {
          id: jobId,
          tenantId: DEFAULT_TENANT_ID,
          agentId: LEGACY_MIGRATED,
          jobType,
          triggerRef: `legacy_background_task:${jobId}`,
          jobState,
          threadId, // 关联 Thread（结果投影用）
          completionPolicyJson: DEFAULT_COMPLETION_POLICY_JSON,
          createdAt: startedAt ?? new Date(),
          startedAt,
          finishedAt,
          updatedAt: new Date(),
        },
      },
      {
        table: "V11Invocation",
        data: {
          id: invocationId,
          tenantId: DEFAULT_TENANT_ID,
          threadId: null, // 后台 Job 执行，threadId 为空
          jobId,
          invocationSequence: 1,
          invocationKind: "job",
          executionState,
          startedAt,
          finishedAt,
          createdAt: startedAt ?? new Date(),
          updatedAt: new Date(),
        },
      },
    ],
  };
};

// ─── SubagentRun → V11Thread + V11ThreadRelation + V11Invocation ──

const subagentRunTransformer: MigrationTransformer = async (record) => {
  const sourceId = String(record.id ?? "");
  if (!sourceId) {
    return { targets: [], anomalyReason: "SubagentRun.id 为空" };
  }

  const parentThreadId = String(record.parentThreadId ?? "");
  if (!parentThreadId) {
    return { targets: [], anomalyReason: "parentThreadId 为空" };
  }

  // 验证 parentThreadId 存在（异常条件：parentThreadId 不存在）
  const [threadRow] = await db
    .select({ id: threadTable.id })
    .from(threadTable)
    .where(eq(threadTable.id, parentThreadId))
    .limit(1);
  if (!threadRow) {
    return { targets: [], anomalyReason: `parentThreadId ${parentThreadId} 不存在` };
  }

  const status = String(record.status ?? "");
  const relationState = mapSubagentRunStatusToRelationState(status);
  const executionState = mapSubagentRunStatusToInvocationState(status);

  const startedAt = normalizeDate(record.startedAt);
  const finishedAt = normalizeDate(record.finishedAt);
  const createdAt = normalizeDate(record.createdAt) ?? new Date();

  // V11ThreadRelation.childThreadId 需 DB FK 到 V11Thread；
  // 旧 SubagentRun 无子 Thread，故创建支撑 V11Thread（id=源 id）满足 FK。
  const childThreadId = sourceId;

  return {
    targets: [
      {
        table: "V11Thread",
        data: {
          id: childThreadId,
          tenantId: DEFAULT_TENANT_ID,
          ownerUserId: LEGACY_MIGRATED,
          primaryAgentId: LEGACY_MIGRATED,
          lifecycleState: "active",
          createdAt,
          updatedAt: createdAt,
        },
      },
      {
        table: "V11ThreadRelation",
        data: {
          id: randomUUID(),
          parentThreadId,
          childThreadId,
          relationType: "delegate",
          relationState,
          createdAt,
          completedAt: finishedAt,
        },
      },
      {
        table: "V11Invocation",
        data: {
          id: randomUUID(),
          tenantId: DEFAULT_TENANT_ID,
          threadId: childThreadId,
          invocationSequence: 1,
          invocationKind: "initial",
          executionState,
          startedAt,
          finishedAt,
          createdAt,
          updatedAt: new Date(),
        },
      },
    ],
  };
};

// ─── 导出 background_subagent 域转换器注册表 ─────────────────

/** 创建 background_subagent 域的全部转换器（key = 物理表名）。 */
export function createBackgroundSubagentTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ["BackgroundTask", backgroundTaskTransformer],
    ["SubagentRun", subagentRunTransformer],
  ]);
}
