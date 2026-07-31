/**
 * S13-C03 runtime_fact 域迁移转换器。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §runtime_fact
 * - ../v11-agentkit-platform/10-core-data-model.md §6（invocation）、§6.6（tool_call）、§6.9（runtime_event_ingress）
 *
 * 映射：
 * - ToolRun → V11ToolCall（status→callState；input→argumentsRedactedJson；output→resultSummaryJson；
 *   threadId/runId 不存在为异常）
 * - RunTranscriptChunk → V11RuntimeEventIngress（kind→candidateType；payload→payloadJson + payloadHash；
 *   runId 不存在为异常）
 * - ThreadRunSkill → V11ExecutionBinding（skillId/skillVersionId→agentRevisionId 经 Agent 迁移映射；
 *   skillId 不在迁移映射为异常）
 * - ContextSnapshot → V11ContextCheckpoint（layers→sourceRangesJson；checksums→sourceRangesHash；
 *   skillResolverInput/skillResolverOutput 不迁移；runId 不存在为异常）
 *
 * 迁移原则：
 * - 只迁可证明事实；无法映射的 skillId 或不存在的 runId/threadId 入异常队列，不猜测。
 * - 跨表依赖按域顺序保证：ToolRun → RunTranscriptChunk → ThreadRunSkill → ContextSnapshot。
 * - 保留源 id 作为目标 id（V11ExecutionBinding 例外：invocationId 为主键），便于跨表关联追溯。
 * - runtime_fact 域依赖 conversation 域（ThreadRun→V11Invocation）和 agent_skill 域（Agent→V11AgentRevision）。
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import { agent as agentTable, threadRun as threadRunTable } from "@/lib/db/schema";
import { DEFAULT_TENANT_ID } from "@/lib/v11/identity/tenant-queries";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { v11Agent } from "@/lib/v11/schema/agent";
import { v11ExecutionBinding, v11Invocation as v11InvocationTable } from "@/lib/v11/schema/runtime";
import { v11ToolCall as v11ToolCallTable } from "@/lib/v11/schema/tool-call";
import { eq, max } from "drizzle-orm";

// ─── 迁移占位常量 ──────────────────────────────────────────

/**
 * 旧数据无 ToolSchemaRevision 概念，迁移时使用占位值。
 * V11ToolCall.toolSchemaRevisionId 为逻辑外键（无 DB 级 FK 约束），占位值可安全写入。
 */
const LEGACY_TOOL_SCHEMA_REVISION_ID = "00000000-0000-4000-8000-000000000005";

/**
 * 旧数据无 RuntimeRevision 概念，迁移时使用占位值。
 * V11ExecutionBinding.runtimeRevisionId 为逻辑外键（无 DB 级 FK 约束），占位值可安全写入。
 */
const LEGACY_RUNTIME_REVISION_ID = "00000000-0000-4000-8000-000000000003";

/**
 * 旧数据无 DeploymentRoute 概念，迁移时使用占位值。
 * V11ExecutionBinding.deploymentRouteId 为逻辑外键（无 DB 级 FK 约束），占位值可安全写入。
 */
const LEGACY_DEPLOYMENT_ROUTE_ID = "00000000-0000-4000-8000-000000000004";

/** ContextCheckpoint 默认过期天数（90 天后可清理）。 */
const CHECKPOINT_DEFAULT_TTL_DAYS = 90;

// ─── 辅助函数 ──────────────────────────────────────────────

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

/** 计算 sha256 内容哈希（sha256: 前缀 + hex）。 */
function computeSha256(content: unknown): string {
  const json = typeof content === "string" ? content : JSON.stringify(content ?? null);
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

// ─── ToolRun status → V11ToolCall callState ───────────────

/** 映射 ToolRun.status → V11ToolCall.callState；无法映射默认 proposed。 */
function mapToolRunStatusToCallState(status: string): string {
  switch (status) {
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "awaiting_approval":
      return "paused";
    default:
      return "proposed";
  }
}

// ─── ThreadRunSkill role → 是否迁移为 ExecutionBinding ───

/**
 * V11ExecutionBinding 与 Invocation 为 1:1（invocationId 为主键）。
 * 旧 ThreadRunSkill 允许同一 run 多条（primary + supporting），
 * 只迁 role=primary 的记录为 V11ExecutionBinding，supporting 跳过。
 */

// ─── 1. ToolRun → V11ToolCall ─────────────────────────────

const toolRunTransformer: MigrationTransformer = async (record) => {
  const toolRunId = String(record.id ?? "");
  if (!toolRunId) {
    return { targets: [], anomalyReason: "ToolRun.id 为空" };
  }

  const threadId = String(record.threadId ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "ToolRun.threadId 为空" };
  }

  const runId = record.runId ? String(record.runId) : "";
  if (!runId) {
    return { targets: [], anomalyReason: "ToolRun.runId 为空（无法映射 invocationId）" };
  }

  // 验证 runId 对应的 V11Invocation 存在（须先迁移 conversation 域 ThreadRun）
  const [invocation] = await db
    .select({ id: v11InvocationTable.id })
    .from(v11InvocationTable)
    .where(eq(v11InvocationTable.id, runId))
    .limit(1);
  if (!invocation) {
    return {
      targets: [],
      anomalyReason: `runId ${runId} 对应的 V11Invocation 不存在（须先迁移 conversation 域 ThreadRun）`,
    };
  }

  const status = String(record.status ?? "running");
  const callState = mapToolRunStatusToCallState(status);
  const toolName = String(record.toolName ?? "");
  const input = record.input ?? {};
  const output = record.output ?? null;
  const argumentsHash = computeSha256(input);

  // callSequence：查询当前 Invocation 内最大值 + 1（保证唯一）
  const [seqRow] = await db
    .select({ maxSeq: max(v11ToolCallTable.callSequence) })
    .from(v11ToolCallTable)
    .where(eq(v11ToolCallTable.invocationId, runId));
  const callSequence = Number(seqRow?.maxSeq ?? 0) + 1;

  const startedAt = record.startedAt ? toDate(record.startedAt) : null;
  const finishedAt = record.finishedAt ? toDate(record.finishedAt) : null;
  // ToolRun 表无 createdAt 列，使用 startedAt 作为 createdAt/updatedAt 来源
  const createdAt = record.createdAt ? toDate(record.createdAt) : (startedAt ?? new Date());

  return {
    targets: [
      {
        table: "V11ToolCall",
        data: {
          id: toolRunId,
          tenantId: DEFAULT_TENANT_ID,
          invocationId: runId,
          threadId,
          turnId: null,
          jobId: null,
          callSequence,
          toolId: toolName,
          toolSchemaRevisionId: LEGACY_TOOL_SCHEMA_REVISION_ID,
          schemaHash: computeSha256(toolName),
          callState,
          // operationId 为幂等键，同 toolId+operationId 唯一。旧 ToolRun 无 operationId 概念，
          // 每条 ToolRun 是独立调用，使用 toolRunId 保证唯一性，避免同 toolName 多次调用冲突。
          operationId: toolRunId,
          argumentsRedactedJson: input,
          argumentsHash,
          environmentLeaseId: null,
          resultSummaryJson: output,
          resultArtifactId: null,
          itemId: null,
          errorCode: status === "failed" && record.error ? "legacy_failed" : null,
          errorSummary: status === "failed" && record.error ? String(record.error) : null,
          startedAt,
          finishedAt,
          createdAt,
          updatedAt: createdAt,
        },
      },
    ],
  };
};

// ─── 2. RunTranscriptChunk → V11RuntimeEventIngress ───────

const runTranscriptChunkTransformer: MigrationTransformer = async (record) => {
  const chunkId = String(record.id ?? "");
  if (!chunkId) {
    return { targets: [], anomalyReason: "RunTranscriptChunk.id 为空" };
  }

  const runId = String(record.runId ?? "");
  if (!runId) {
    return { targets: [], anomalyReason: "RunTranscriptChunk.runId 为空" };
  }

  // 验证 runId 对应的 V11Invocation 存在（V11RuntimeEventIngress 有 DB 级 FK 约束）
  const [invocation] = await db
    .select({ id: v11InvocationTable.id })
    .from(v11InvocationTable)
    .where(eq(v11InvocationTable.id, runId))
    .limit(1);
  if (!invocation) {
    return {
      targets: [],
      anomalyReason: `runId ${runId} 对应的 V11Invocation 不存在（须先迁移 conversation 域 ThreadRun）`,
    };
  }

  const sequence = Number(record.sequence ?? 0);
  const kind = String(record.kind ?? "");
  if (!kind) {
    return { targets: [], anomalyReason: "RunTranscriptChunk.kind 为空" };
  }

  const payload = record.payload ?? {};
  const payloadHash = computeSha256(payload);
  const receivedAt = toDate(record.createdAt);

  return {
    targets: [
      {
        table: "V11RuntimeEventIngress",
        data: {
          id: chunkId,
          invocationId: runId,
          tenantId: DEFAULT_TENANT_ID,
          producerEventId: chunkId,
          producerSequence: sequence,
          candidateType: kind,
          schemaVersion: 1,
          payloadHash,
          payloadJson: payload,
          ingressState: "accepted",
          mappedItemId: null,
          mappedThreadEventId: null,
          mappedJobEventId: null,
          receivedAt,
          mappedAt: null,
          rejectedReason: null,
        },
      },
    ],
  };
};

// ─── 3. ThreadRunSkill → V11ExecutionBinding ──────────────

const threadRunSkillTransformer: MigrationTransformer = async (record) => {
  const skillBindingId = String(record.id ?? "");
  if (!skillBindingId) {
    return { targets: [], anomalyReason: "ThreadRunSkill.id 为空" };
  }

  const runId = String(record.runId ?? "");
  if (!runId) {
    return { targets: [], anomalyReason: "ThreadRunSkill.runId 为空" };
  }

  const role = String(record.role ?? "primary");
  // V11ExecutionBinding 与 Invocation 为 1:1，只迁 primary 角色的绑定
  if (role !== "primary") {
    return { targets: [], skip: true };
  }

  // 验证 runId 对应的 V11Invocation 存在（V11ExecutionBinding 有 DB 级 FK 约束）
  const [invocation] = await db
    .select({ id: v11InvocationTable.id })
    .from(v11InvocationTable)
    .where(eq(v11InvocationTable.id, runId))
    .limit(1);
  if (!invocation) {
    return {
      targets: [],
      anomalyReason: `runId ${runId} 对应的 V11Invocation 不存在（须先迁移 conversation 域 ThreadRun）`,
    };
  }

  // 已存在 V11ExecutionBinding（同一 run 多个 primary skill）：跳过后续
  const [existingBinding] = await db
    .select({ invocationId: v11ExecutionBinding.invocationId })
    .from(v11ExecutionBinding)
    .where(eq(v11ExecutionBinding.invocationId, runId))
    .limit(1);
  if (existingBinding) {
    return { targets: [], skip: true };
  }

  const skillId = String(record.skillId ?? "");
  if (!skillId) {
    return { targets: [], anomalyReason: "ThreadRunSkill.skillId 为空" };
  }

  // skillId/skillVersionId → agentRevisionId（经 Agent 迁移映射）
  // 查询旧 Agent 表：skillId 匹配的 Agent（须先迁移 agent_skill 域 Agent）
  const [agentRow] = await db
    .select({ id: agentTable.id })
    .from(agentTable)
    .where(eq(agentTable.skillId, skillId))
    .limit(1);
  if (!agentRow) {
    return {
      targets: [],
      anomalyReason: `skillId ${skillId} 不在迁移映射（无对应 Agent）`,
    };
  }

  // 查询 V11Agent 获取 currentRevisionId（须先迁移 agent_skill 域 Agent）
  const [v11AgentRow] = await db
    .select({ currentRevisionId: v11Agent.currentRevisionId })
    .from(v11Agent)
    .where(eq(v11Agent.id, agentRow.id))
    .limit(1);
  if (!v11AgentRow || !v11AgentRow.currentRevisionId) {
    return {
      targets: [],
      anomalyReason: `Agent ${agentRow.id} 的 V11AgentRevision 不存在（须先迁移 agent_skill 域 Agent）`,
    };
  }

  const agentRevisionId = v11AgentRow.currentRevisionId;

  // 从旧 ThreadRun 获取 model 信息（V11ExecutionBinding.modelProvider/modelId 必填）
  const [runRow] = await db
    .select({ model: threadRunTable.model })
    .from(threadRunTable)
    .where(eq(threadRunTable.id, runId))
    .limit(1);
  const model = runRow?.model ?? "legacy";
  const modelProvider = String(model.split("-")[0] ?? "legacy");
  const modelId = model;

  // 计算 configHash（规范化字段后 sha256）
  const configHash = computeSha256({
    agentRevisionId,
    runtimeRevisionId: LEGACY_RUNTIME_REVISION_ID,
    modelProvider,
    modelId,
  });

  const boundAt = toDate(record.createdAt);

  return {
    targets: [
      {
        table: "V11ExecutionBinding",
        data: {
          invocationId: runId,
          tenantId: DEFAULT_TENANT_ID,
          agentRevisionId,
          runtimeRevisionId: LEGACY_RUNTIME_REVISION_ID,
          deploymentRouteId: LEGACY_DEPLOYMENT_ROUTE_ID,
          modelProvider,
          modelId,
          modelRevisionRef: null,
          initialEnvironmentLeaseId: null,
          workspaceBindingId: null,
          policyRevisionId: null,
          contextCheckpointId: null,
          configHash,
          boundAt,
        },
      },
    ],
  };
};

// ─── 4. ContextSnapshot → V11ContextCheckpoint ────────────

const contextSnapshotTransformer: MigrationTransformer = async (record) => {
  const snapshotId = String(record.id ?? "");
  if (!snapshotId) {
    return { targets: [], anomalyReason: "ContextSnapshot.id 为空" };
  }

  const runId = record.runId ? String(record.runId) : "";
  if (!runId) {
    return { targets: [], anomalyReason: "ContextSnapshot.runId 为空（无法映射 invocationId）" };
  }

  // 验证 runId 对应的 V11Invocation 存在
  const [invocation] = await db
    .select({ id: v11InvocationTable.id })
    .from(v11InvocationTable)
    .where(eq(v11InvocationTable.id, runId))
    .limit(1);
  if (!invocation) {
    return {
      targets: [],
      anomalyReason: `runId ${runId} 对应的 V11Invocation 不存在（须先迁移 conversation 域 ThreadRun）`,
    };
  }

  // layers → sourceRangesJson；checksums → sourceRangesHash
  // skillResolverInput/skillResolverOutput 为不可迁字段，不迁移
  const layers = record.layers ?? [];
  const checksums = record.checksums ?? {};
  const sourceRangesJson = layers;
  const sourceRangesHash = computeSha256(layers);

  // summaryRef + summaryHash：旧数据无对象存储引用，使用 legacy 引用
  const summaryRef = `legacy:context-snapshot:${snapshotId}`;
  const summaryHash = computeSha256(checksums);

  // token 账目：estimatedTokens → inputTokens；afterTokens ?? estimatedTokens → retainedTokens
  const estimatedTokens = Number(record.estimatedTokens ?? 0);
  const afterTokens = record.afterTokens != null ? Number(record.afterTokens) : null;
  const compressed = Boolean(record.compressed);
  const inputTokens = estimatedTokens;
  const retainedTokens = afterTokens ?? estimatedTokens;
  const compressedTokens = compressed ? Math.max(0, estimatedTokens - retainedTokens) : 0;

  const createdAt = toDate(record.createdAt);
  // 默认过期时间：createdAt + 90 天
  const expiresAt = new Date(
    createdAt.getTime() + CHECKPOINT_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  return {
    targets: [
      {
        table: "V11ContextCheckpoint",
        data: {
          id: snapshotId,
          tenantId: DEFAULT_TENANT_ID,
          invocationId: runId,
          checkpointType: "assembly",
          sourceRangesJson,
          sourceRangesHash,
          summaryRef,
          summaryRedacted: null,
          summaryHash,
          inputTokens,
          retainedTokens,
          compressedTokens,
          createdAt,
          expiresAt,
        },
      },
    ],
  };
};

// ─── 导出 runtime_fact 域转换器注册表 ──────────────────────

/** 创建 runtime_fact 域的全部转换器（key = 物理表名）。 */
export function createRuntimeFactTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ["ToolRun", toolRunTransformer],
    ["RunTranscriptChunk", runTranscriptChunkTransformer],
    ["ThreadRunSkill", threadRunSkillTransformer],
    ["ContextSnapshot", contextSnapshotTransformer],
  ]);
}
