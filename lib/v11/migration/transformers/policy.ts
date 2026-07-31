/**
 * S13-C03 policy 域迁移转换器。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §2.5（policy 域 4 张表）
 * - ../v11-agentkit-platform/10-core-data-model.md §4.4（policy_set / policy_revision）、§6.8（permission_decision）
 *
 * 映射：
 * - PolicyConfig → V11PolicySet + V11PolicyRevision（KV→版本化策略修订；
 *   key→policySetKey；value→revisionJson）
 * - PolicyConfigHistory → AuditEvent（actionType=policy.publish；
 *   beforeSnapshot/afterSnapshot 不迁移只保留 changedKeys + hash）
 * - ToolPermissionRule → V11PermissionDecision + V11Policy（decision allow/deny/ask →
 *   allow/pause/block；scope 无法映射为异常）
 * - ToolApprovalRequest → V11UserActionRequest + V11PermissionDecision（status→requestState；
 *   approvedScope→decisionScope；threadId/toolRunId 不存在为异常）
 *
 * 迁移原则：
 * - 只迁可证明事实；无法映射的 scope 入异常队列，不猜测。
 * - 跨表依赖按域顺序保证：PolicyConfig → PolicyConfigHistory → ToolPermissionRule → ToolApprovalRequest。
 * - 保留源 id 作为目标 id，便于跨表关联追溯；跨表新建的用 randomUUID()。
 * - rulesHash 使用 sha256: 前缀 + hex（V11PolicyRevision.rulesHash 为 varchar(128)）；
 *   beforeHash / afterHash 仅 hex 无前缀（AuditEvent.beforeHash/afterHash 为 varchar(64)）。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { thread as threadTable, toolRun as toolRunTable } from "@/lib/db/schema";
import { DEFAULT_TENANT_ID } from "@/lib/v11/identity/tenant-queries";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { v11PolicySet } from "@/lib/v11/schema/permission";
import { eq } from "drizzle-orm";

/**
 * 旧 ToolPermissionRule 无 PolicySet 归属，迁移时使用占位策略集。
 * V11PolicySet.policySetId 为逻辑外键（无 DB 级 FK 约束），占位值可安全写入。
 */
const LEGACY_TOOL_PERMISSION_POLICY_SET_ID = "00000000-0000-4000-8000-000000000003";

/** 旧 ToolApprovalRequest 无 Turn 概念，迁移时使用占位值（与 conversation 域一致）。 */
const LEGACY_TURN_ID = "00000000-0000-4000-8000-000000000002";

/** 旧 ToolApprovalRequest 无 Invocation 引用且 ToolRun.runId 为空时使用占位值。 */
const LEGACY_INVOCATION_ID = "00000000-0000-4000-8000-000000000004";

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

/** 计算 sha256 内容哈希（sha256: 前缀 + hex），用于 V11PolicyRevision.rulesHash（varchar(128)）。 */
function computeSha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** 计算 sha256 hex 摘要（无前缀），用于 AuditEvent.beforeHash/afterHash（varchar(64)）。 */
function computeSha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ─── ToolPermissionRule decision → V11 decision 映射 ─────

/** 映射 ToolPermissionRule.decision（allow/deny/ask）→ V11 decision（allow/pause/block）；无法映射返回 null。 */
function mapLegacyDecision(decision: string): "allow" | "pause" | "block" | null {
  switch (decision) {
    case "allow":
      return "allow";
    case "deny":
      return "block";
    case "ask":
      return "pause";
    default:
      return null;
  }
}

// ─── ToolPermissionRule scope → V11 scopeJson 映射 ───────

/** 映射 ToolPermissionRule.scope + scopeRef → V11 scopeJson；无法映射返回 null。 */
function mapLegacyScope(scope: string, scopeRef: unknown): { type: string; ref?: string } | null {
  switch (scope) {
    case "global":
    case "tenant":
      // global/tenant 映射为租户级 scope，不限定具体资源
      return { type: "tenant" };
    case "thread":
      // thread scope 需要 scopeRef（threadId）；缺失为异常
      if (!scopeRef) return null;
      return { type: "thread", ref: String(scopeRef) };
    default:
      // project/skill 无直接 V11 scope 映射
      return null;
  }
}

// ─── ToolApprovalRequest status → V11 映射 ───────────────

/** 映射 ToolApprovalRequest.status → V11UserActionRequest.requestState。 */
function mapApprovalStatusToRequestState(status: string): "pending" | "resolved" | "expired" {
  switch (status) {
    case "pending":
      return "pending";
    case "approved":
    case "denied":
      return "resolved";
    case "expired":
    case "superseded":
      return "expired";
    default:
      return "pending";
  }
}

/** 映射 ToolApprovalRequest.status → V11UserActionRequest.resolution；未决议时为 null。 */
function mapApprovalStatusToResolution(status: string): "approve" | "deny" | null {
  switch (status) {
    case "approved":
      return "approve";
    case "denied":
      return "deny";
    default:
      return null;
  }
}

/** 映射 ToolApprovalRequest.status → V11PermissionDecision.decision。 */
function mapApprovalStatusToDecision(status: string): "allow" | "pause" | "block" {
  switch (status) {
    case "approved":
      return "allow";
    case "denied":
      return "block";
    default:
      // pending/expired/superseded 映射为 pause（暂停等待用户操作）
      return "pause";
  }
}

// ─── 1. PolicyConfig → V11PolicySet + V11PolicyRevision ──

const policyConfigTransformer: MigrationTransformer = (record) => {
  const key = String(record.key ?? "");
  if (!key) {
    return { targets: [], anomalyReason: "PolicyConfig.key 为空" };
  }

  const value = record.value ?? null;
  const revisionJson = value;
  const rulesHash = computeSha256(JSON.stringify(value ?? null));
  const updatedAt = toDate(record.updatedAt);
  const policySetId = randomUUID();
  const revisionId = randomUUID();

  return {
    targets: [
      {
        table: "V11PolicySet",
        data: {
          id: policySetId,
          tenantId: DEFAULT_TENANT_ID,
          policySetKey: key,
          ownerUserId: null,
          currentRevisionId: revisionId,
          lifecycleState: "enabled",
          versionNo: 1,
          createdAt: updatedAt,
          updatedAt,
          deletedAt: null,
        },
      },
      {
        table: "V11PolicyRevision",
        data: {
          id: revisionId,
          policySetId,
          revisionNo: 1,
          revisionJson,
          rulesHash,
          revisionState: "published",
          createdBy: "legacy-migration",
          createdAt: updatedAt,
          publishedAt: updatedAt,
        },
      },
    ],
  };
};

// ─── 2. PolicyConfigHistory → AuditEvent ─────────────────

const policyConfigHistoryTransformer: MigrationTransformer = (record) => {
  // PolicyConfigHistory 列名为 snake_case（changed_by / before_snapshot / after_snapshot / changed_keys / changed_at）
  const sourceId = String(record.id ?? "");
  const changedBy = String(record.changed_by ?? "system");
  const beforeSnapshot = String(record.before_snapshot ?? "");
  const afterSnapshot = String(record.after_snapshot ?? "");
  const changedKeys = record.changed_keys ? String(record.changed_keys) : null;
  const changedAt = toDate(record.changed_at);

  const beforeHash = computeSha256Hex(beforeSnapshot);
  const afterHash = computeSha256Hex(afterSnapshot);

  return {
    targets: [
      {
        table: "AuditEvent",
        data: {
          id: sourceId.length > 0 ? sourceId : randomUUID(),
          tenantId: DEFAULT_TENANT_ID,
          actorType: "user",
          actorId: changedBy,
          actionType: "policy.publish",
          targetType: "policy",
          targetId: null,
          beforeHash,
          afterHash,
          reason: changedKeys,
          requestId: "legacy-migration",
          occurredAt: changedAt,
        },
      },
    ],
  };
};

// ─── 3. ToolPermissionRule → V11PermissionDecision + V11Policy ─

const toolPermissionRuleTransformer: MigrationTransformer = async (record) => {
  const ruleId = String(record.id ?? "");
  if (!ruleId) {
    return { targets: [], anomalyReason: "ToolPermissionRule.id 为空" };
  }

  const scope = String(record.scope ?? "global");
  const scopeRef = record.scopeRef ?? null;
  const decision = String(record.decision ?? "");
  const mappedDecision = mapLegacyDecision(decision);
  if (!mappedDecision) {
    return {
      targets: [],
      anomalyReason: `decision "${decision}" 无对应 V11 decision 映射`,
    };
  }

  const mappedScope = mapLegacyScope(scope, scopeRef);
  if (!mappedScope) {
    return {
      targets: [],
      anomalyReason: `scope "${scope}" 无法映射为 V11 scopeJson`,
    };
  }

  const toolPattern = String(record.toolPattern ?? "");
  const argMatcher = record.argMatcher ?? null;
  const reason = record.reason ? String(record.reason) : null;
  const priority = Number(record.priority ?? 0);
  const createdAt = toDate(record.createdAt);
  const updatedAt = toDate(record.updatedAt);

  // 查询或创建 legacy 策略集（所有 ToolPermissionRule 共用一个占位策略集）
  const policySetId = LEGACY_TOOL_PERMISSION_POLICY_SET_ID;
  const [existingSet] = await db
    .select({ id: v11PolicySet.id })
    .from(v11PolicySet)
    .where(eq(v11PolicySet.id, policySetId))
    .limit(1);

  const targets: Array<{
    table: string;
    data: Record<string, unknown>;
  }> = [];

  if (!existingSet) {
    // 首条规则：创建占位策略集 + 初始修订
    const revisionId = randomUUID();
    targets.push({
      table: "V11PolicySet",
      data: {
        id: policySetId,
        tenantId: DEFAULT_TENANT_ID,
        policySetKey: "legacy-tool-permission-rules",
        ownerUserId: null,
        currentRevisionId: revisionId,
        lifecycleState: "enabled",
        versionNo: 1,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      },
    });
    targets.push({
      table: "V11PolicyRevision",
      data: {
        id: revisionId,
        policySetId,
        revisionNo: 1,
        revisionJson: { source: "legacy-tool-permission-rules" },
        rulesHash: computeSha256("legacy-tool-permission-rules"),
        revisionState: "published",
        createdBy: "legacy-migration",
        createdAt,
        publishedAt: createdAt,
      },
    });
  }

  // V11Policy：单条持久化策略规则
  targets.push({
    table: "V11Policy",
    data: {
      id: ruleId,
      tenantId: DEFAULT_TENANT_ID,
      policySetId,
      policyRevisionId: null,
      toolPattern,
      argMatcherJson: argMatcher,
      decision: mappedDecision,
      scopeJson: mappedScope,
      reason,
      priority,
      createdAt,
      updatedAt,
    },
  });

  // V11PermissionDecision：策略级决策记录（toolCallId 使用占位值标识 legacy 规则）
  targets.push({
    table: "V11PermissionDecision",
    data: {
      id: randomUUID(),
      tenantId: DEFAULT_TENANT_ID,
      toolCallId: `legacy-policy-rule-${ruleId}`,
      decisionSequence: 1,
      decision: mappedDecision,
      policyRevisionId: null,
      reasonCodesJson: ["legacy_policy_rule"],
      riskSummaryJson: { toolPattern, scope: mappedScope },
      decisionSummary: reason,
      decidedBy: "policy_engine",
      decidedAt: updatedAt,
      createdAt,
    },
  });

  return { targets };
};

// ─── 4. ToolApprovalRequest → V11UserActionRequest + V11PermissionDecision ─

const toolApprovalRequestTransformer: MigrationTransformer = async (record) => {
  const requestId = String(record.id ?? "");
  if (!requestId) {
    return { targets: [], anomalyReason: "ToolApprovalRequest.id 为空" };
  }

  const threadId = String(record.threadId ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "ToolApprovalRequest.threadId 为空" };
  }

  const toolRunId = String(record.toolRunId ?? "");
  if (!toolRunId) {
    return { targets: [], anomalyReason: "ToolApprovalRequest.toolRunId 为空" };
  }

  // 验证 threadId 存在（旧 Thread 表）
  const [threadRow] = await db
    .select({ id: threadTable.id })
    .from(threadTable)
    .where(eq(threadTable.id, threadId))
    .limit(1);
  if (!threadRow) {
    return {
      targets: [],
      anomalyReason: `Thread ${threadId} 不存在`,
    };
  }

  // 验证 toolRunId 存在（旧 ToolRun 表）
  const [toolRunRow] = await db
    .select({ id: toolRunTable.id, runId: toolRunTable.runId })
    .from(toolRunTable)
    .where(eq(toolRunTable.id, toolRunId))
    .limit(1);
  if (!toolRunRow) {
    return {
      targets: [],
      anomalyReason: `ToolRun ${toolRunId} 不存在`,
    };
  }

  const status = String(record.status ?? "pending");
  const requestState = mapApprovalStatusToRequestState(status);
  const resolution = mapApprovalStatusToResolution(status);
  const decision = mapApprovalStatusToDecision(status);
  const approvedScope = record.approvedScope ? String(record.approvedScope) : null;

  const toolName = String(record.toolName ?? "");
  const argSummary = String(record.argSummary ?? "");
  const promptJson = { toolName, argSummary, permissionKey: record.permissionKey ?? null };

  const resolvedBy = record.resolvedBy ? String(record.resolvedBy) : null;
  const resolvedAt = record.resolvedAt ? toDate(record.resolvedAt) : null;
  const expiresAt = record.expiresAt ? toDate(record.expiresAt) : null;
  const createdAt = toDate(record.createdAt);

  // invocationId：优先从 ToolRun.runId 获取（ThreadRun 迁移后 V11Invocation.id = ThreadRun.id）
  const invocationId = toolRunRow.runId ? String(toolRunRow.runId) : LEGACY_INVOCATION_ID;

  return {
    targets: [
      {
        table: "V11UserActionRequest",
        data: {
          id: requestId,
          tenantId: DEFAULT_TENANT_ID,
          threadId,
          turnId: LEGACY_TURN_ID,
          invocationId,
          toolCallId: toolRunId,
          itemId: null,
          requestType: "confirmation",
          purpose: "tool_confirm",
          requestState,
          promptJson,
          inputSchemaJson: null,
          authStateHash: null,
          nonceHash: null,
          expiresAt,
          resolution,
          resolvedBy,
          resolvedAt,
          responseRedactedJson: null,
          grantId: null,
          versionNo: 1,
          createdAt,
          updatedAt: resolvedAt ?? createdAt,
        },
      },
      {
        table: "V11PermissionDecision",
        data: {
          id: randomUUID(),
          tenantId: DEFAULT_TENANT_ID,
          toolCallId: toolRunId,
          decisionSequence: 1,
          decision,
          policyRevisionId: null,
          reasonCodesJson: ["legacy_approval_request"],
          // approvedScope → decisionScope（存入 riskSummaryJson）
          riskSummaryJson: approvedScope ? { decisionScope: approvedScope } : null,
          decisionSummary: argSummary,
          decidedBy: resolvedBy ?? "system",
          decidedAt: resolvedAt ?? createdAt,
          createdAt,
        },
      },
    ],
  };
};

// ─── 导出 policy 域转换器注册表 ──────────────────────────

/** 创建 policy 域的全部转换器（key = 物理表名）。 */
export function createPolicyTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ["PolicyConfig", policyConfigTransformer],
    ["PolicyConfigHistory", policyConfigHistoryTransformer],
    ["ToolPermissionRule", toolPermissionRuleTransformer],
    ["ToolApprovalRequest", toolApprovalRequestTransformer],
  ]);
}
