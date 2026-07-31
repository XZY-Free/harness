/**
 * S13-C03 misc 域迁移转换器。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §misc
 * - ../v11-agentkit-platform/10-core-data-model.md §2.1（Device）、§8（AuditEvent）、§6.9（RuntimeEventIngress）
 *
 * 映射：
 * - ChatExample → 无直接 V11 目标（skip: true，非核心实体，改 env/seed 或 V11 catalog 配置）
 * - AuditFailureLog → V11RuntimeEventIngress（rejected 通道）+ AuditEvent（审计失败重试记录）
 *   - payload 为不可迁字段（unmigratableFields），不迁移；用 errorMessage + toolName 构造摘要负载
 *   - runId 对应的 V11Invocation 不存在时跳过 ingress 目标（DB 级 FK 约束），仅写 AuditEvent
 * - DesktopDevice → V11Device（deviceId→deviceKey；status→deviceState；userId→userIdentityId）
 *   - userId 对应的 UserIdentity 不存在为异常
 *   - publicKey 为不可迁字段（unmigratableFields），但 V11Device.publicKey 必填，仍需迁移（占位脱敏）
 * - AdminAuditLog → AuditEvent（action→actionType 目录化；无法映射入异常队列）
 *   - metadata 为不可迁字段（unmigratableFields），用 outcome 构造 reason
 *
 * 迁移原则：
 * - 只迁可证明事实；无法映射的 action 入异常队列，不猜测。
 * - 跨表依赖按域顺序保证：ChatExample（skip）→ AuditFailureLog → DesktopDevice → AdminAuditLog。
 * - 保留源 id 作为目标 id，便于跨表关联追溯。
 * - userId → userIdentityId 需查询 UserIdentity 表（identity 域已迁移，源 id 直接复用）。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { DEFAULT_TENANT_ID } from "@/lib/v11/identity/tenant-queries";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { userIdentity as userIdentityTable } from "@/lib/v11/schema/identity";
import { v11Invocation as v11InvocationTable } from "@/lib/v11/schema/runtime";
import { eq } from "drizzle-orm";

// ─── toDate 辅助函数 ───────────────────────────────────────

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

// ─── AdminAuditLog action → AuditEvent actionType 映射 ─────

/**
 * 旧 AdminAuditLog.action → V11 AuditEvent.actionType 映射表。
 * 仅映射语义一致的 action；未列出的 action 入异常队列（anomaly condition: action 不在 AUDIT_ACTION_TYPES）。
 *
 * 事实源：AUDIT_ACTION_TYPES 目录（@/lib/v11/schema/audit.ts）。
 * - policies.updated → policy.publish（策略更新即策略发布）
 * - skills.published → agent.publish（Skill 发布对应 Agent 发布）
 * - skills.rolled_back → agent.retract（Skill 回滚对应 Agent 撤回）
 * - skills.created → agent.revision.create（Skill 创建对应 Agent Revision 创建）
 * - workspace.file.deleted → deletion.request（文件删除）
 * - thread.purged → deletion.request（会话彻底删除）
 */
const ADMIN_AUDIT_ACTION_MAP: ReadonlyMap<string, string> = new Map([
  ["policies.updated", "policy.publish"],
  ["skills.published", "agent.publish"],
  ["skills.rolled_back", "agent.retract"],
  ["skills.created", "agent.revision.create"],
  ["workspace.file.deleted", "deletion.request"],
  ["thread.purged", "deletion.request"],
]);

// ─── 1. ChatExample → 跳过（无 V11 目标）──────────────────

/**
 * ChatExample 无直接 V11 目标（非核心实体）。
 * 默认处理：改 env/seed 或迁入 V11 catalog 配置。迁移时 skip。
 */
const chatExampleTransformer: MigrationTransformer = () => {
  return { targets: [], skip: true };
};

// ─── 2. AuditFailureLog → V11RuntimeEventIngress + AuditEvent ─

/**
 * 审计失败重试记录 → 事件账本 reject 通道 + 审计账本。
 *
 * - V11RuntimeEventIngress：ingressState=rejected（reject 通道），candidateType=execution.failed
 *   - 需要 runId 对应的 V11Invocation 存在（DB 级 FK 约束）；不存在时跳过此目标
 * - AuditEvent：始终写入，actionType=event.quarantine.resolve（隔离事件处置）
 *   - 记录审计失败这一事实，actorType=system（系统自动记录）
 * - payload 为不可迁字段，不迁移；用 errorMessage + toolName 构造摘要负载
 */
const auditFailureLogTransformer: MigrationTransformer = async (record) => {
  const logId = String(record.id ?? "");
  if (!logId) {
    return { targets: [], anomalyReason: "AuditFailureLog.id 为空" };
  }

  const threadId = String(record.threadId ?? "");
  if (!threadId) {
    return { targets: [], anomalyReason: "AuditFailureLog.threadId 为空" };
  }

  const errorMessage = String(record.errorMessage ?? "");
  const toolName = record.toolName ? String(record.toolName) : null;
  const retryCount = Number(record.retryCount ?? 0);
  const createdAt = toDate(record.createdAt);

  // payload 为不可迁字段，不迁移；用 errorMessage + toolName 构造摘要负载
  const summaryPayload = {
    threadId,
    toolName,
    errorMessage,
    retryCount,
  };
  // payloadHash 带 "sha256:" 前缀（用于 V11RuntimeEventIngress.payloadHash，varchar(128) 允许）
  const payloadHash = computeSha256(summaryPayload);
  // AuditEvent.afterHash 为 varchar(64)，仅存储 hex 部分（不带 "sha256:" 前缀，避免长度超限）
  const afterHashHex = payloadHash.slice("sha256:".length);

  const targets: {
    readonly table: string;
    readonly data: Record<string, unknown>;
  }[] = [];

  // V11RuntimeEventIngress：需要 runId 对应的 V11Invocation 存在（DB 级 FK 约束）
  const runId = record.runId ? String(record.runId) : null;
  if (runId) {
    const [invocation] = await db
      .select({ id: v11InvocationTable.id })
      .from(v11InvocationTable)
      .where(eq(v11InvocationTable.id, runId))
      .limit(1);
    if (invocation) {
      targets.push({
        table: "V11RuntimeEventIngress",
        data: {
          id: logId,
          invocationId: runId,
          tenantId: DEFAULT_TENANT_ID,
          producerEventId: logId,
          producerSequence: retryCount,
          candidateType: "execution.failed",
          schemaVersion: 1,
          payloadHash,
          payloadJson: summaryPayload,
          ingressState: "rejected",
          mappedItemId: null,
          mappedThreadEventId: null,
          mappedJobEventId: null,
          receivedAt: createdAt,
          mappedAt: null,
          rejectedReason: errorMessage.slice(0, 256),
        },
      });
    }
  }

  // AuditEvent：始终写入（记录审计失败这一事实）
  targets.push({
    table: "AuditEvent",
    data: {
      id: randomUUID(),
      tenantId: DEFAULT_TENANT_ID,
      actorType: "system",
      actorId: "system",
      actionType: "event.quarantine.resolve",
      targetType: "audit_failure_log",
      targetId: logId,
      beforeHash: null,
      afterHash: afterHashHex,
      reason: errorMessage,
      requestId: `legacy-audit-failure:${logId}`,
      occurredAt: createdAt,
    },
  });

  return { targets };
};

// ─── 3. DesktopDevice → V11Device ──────────────────────────

/**
 * Desktop 设备绑定 → V11 可信设备身份。
 *
 * - deviceId → deviceKey（租户内稳定唯一键）
 * - status → deviceState（active/revoked 直接映射）
 * - userId → userIdentityId（须先迁移 identity 域 User）
 * - name → deviceName；version → appVersion
 * - publicKey 为不可迁字段（unmigratableFields），但 V11Device.publicKey 必填，迁移占位脱敏值
 *   （私钥只在 Desktop Keychain，迁移阶段无法获取原始公钥；用 legacy 占位满足 NOT NULL 约束）
 *
 * 异常条件：userId 对应的 UserIdentity 不存在。
 */
const desktopDeviceTransformer: MigrationTransformer = async (record) => {
  const deviceId = String(record.id ?? "");
  if (!deviceId) {
    return { targets: [], anomalyReason: "DesktopDevice.id 为空" };
  }

  const userId = String(record.userId ?? "");
  if (!userId) {
    return { targets: [], anomalyReason: "DesktopDevice.userId 为空" };
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

  const deviceKey = String(record.deviceId ?? "");
  if (!deviceKey) {
    return { targets: [], anomalyReason: "DesktopDevice.deviceId 为空（无法映射 deviceKey）" };
  }

  // publicKey 为不可迁字段（unmigratableFields），但 V11Device.publicKey 必填
  // 迁移占位脱敏值：私钥只在 Desktop Keychain，迁移阶段无法获取原始公钥
  const publicKey = `legacy-public-key:${deviceId}`;
  const deviceName = String(record.name ?? "");
  const appVersion = String(record.version ?? "");
  const status = String(record.status ?? "active");
  const deviceState: "active" | "revoked" = status === "revoked" ? "revoked" : "active";

  const lastActiveAt = toDate(record.lastActiveAt);
  const revokedAt = record.revokedAt ? toDate(record.revokedAt) : null;
  const createdAt = toDate(record.createdAt);

  return {
    targets: [
      {
        table: "Device",
        data: {
          id: deviceId,
          tenantId: DEFAULT_TENANT_ID,
          userId: ui.id,
          deviceKey,
          publicKey,
          deviceName,
          appVersion,
          deviceState,
          lastActiveAt,
          revokedAt,
          createdAt,
        },
      },
    ],
  };
};

// ─── 4. AdminAuditLog → AuditEvent ─────────────────────────

/**
 * 管理审计日志 → V11 公共审计账本。
 *
 * - action → actionType 目录化（经 ADMIN_AUDIT_ACTION_MAP 映射）；无法映射入异常队列
 * - actorUserId → actorId（须先迁移 identity 域 User，源 id 直接复用）
 * - outcome → reason（succeeded/failed 隐含于 reason 文本）
 * - metadata 为不可迁字段（unmigratableFields），不迁移
 * - actorType 固定为 user（管理操作均由用户发起）
 *
 * 异常条件：action 不在 AUDIT_ACTION_TYPES 目录（经映射表转换后仍无对应）。
 */
const adminAuditLogTransformer: MigrationTransformer = (record) => {
  const logId = String(record.id ?? "");
  if (!logId) {
    return { targets: [], anomalyReason: "AdminAuditLog.id 为空" };
  }

  const action = String(record.action ?? "");
  if (!action) {
    return { targets: [], anomalyReason: "AdminAuditLog.action 为空" };
  }

  // action → actionType 映射；不在目录的入异常队列
  const actionType = ADMIN_AUDIT_ACTION_MAP.get(action);
  if (!actionType) {
    return {
      targets: [],
      anomalyReason: `action "${action}" 不在 AUDIT_ACTION_TYPES 目录`,
    };
  }

  const actorUserId = String(record.actorUserId ?? "");
  if (!actorUserId) {
    return { targets: [], anomalyReason: "AdminAuditLog.actorUserId 为空" };
  }

  const targetType = String(record.targetType ?? "");
  const targetId = String(record.targetId ?? "");
  const outcome = String(record.outcome ?? "succeeded");
  const createdAt = toDate(record.createdAt);

  // metadata 为不可迁字段（unmigratableFields），不迁移；用 outcome 构造 reason
  const reason = `legacy audit: ${action} ${outcome}`;

  return {
    targets: [
      {
        table: "AuditEvent",
        data: {
          id: logId,
          tenantId: DEFAULT_TENANT_ID,
          actorType: "user",
          actorId: actorUserId,
          actionType,
          targetType,
          targetId,
          beforeHash: null,
          afterHash: null,
          reason,
          requestId: `legacy-admin-audit:${logId}`,
          occurredAt: createdAt,
        },
      },
    ],
  };
};

// ─── 导出 misc 域转换器注册表 ──────────────────────────────

/** 创建 misc 域的全部转换器（key = 物理表名）。 */
export function createMiscTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ["ChatExample", chatExampleTransformer],
    ["AuditFailureLog", auditFailureLogTransformer],
    ["DesktopDevice", desktopDeviceTransformer],
    ["AdminAuditLog", adminAuditLogTransformer],
  ]);
}
