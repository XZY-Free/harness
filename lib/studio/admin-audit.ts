/**
 * 切片 C Stage B：Admin Audit 脱敏 + 摘要 + 记录服务。
 *
 * 审计 metadata 必须可追踪但不含敏感 payload（约束 4）。本模块是唯一的脱敏边界：
 * 各 route 用 summarize* 构造「只含 key 名 / 字节数 / reasonCode」的摘要，再经
 * sanitizeAuditMetadata 防御性二次脱敏，最后由 recordAdminAudit 落库。
 *
 * 脱敏规则（§7）：
 * - 丢弃 key 名含 secret/token/password/apiKey/content/commandOutput（大小写不敏感）的项。
 * - string 截断到 256 字符。
 * - 数组截断到 50 项。
 * - 嵌套对象最大深度 2（root=0；depth>2 折叠为占位）。
 * - 文件操作只记 path + bytes，content 由 key 名规则直接剔除。
 * - legacy summarizePolicyChange（PolicyConfig 审计）已随 02-6 P9 物理删除；正式 Policy Revision
 *   审计摘要由 /studio/governance 侧按 Policy Revision 维度构造。
 */
import { type DbOrTx, db } from "@/lib/db/client";
import { generateRequestId } from "@/lib/http";
import { assertAuditActionTypeKnown } from "@/lib/identity/audit";
import { appendAuditEvent, listAuditEvents } from "@/lib/identity/audit-queries";
import type { AuditEvent, AuditOutcome } from "@/lib/persistence/schema/audit";
import { userIdentity } from "@/lib/persistence/schema/identity";
import { and, eq, inArray } from "drizzle-orm";

export const STUDIO_AUDIT_ACTIONS = [
  "settings.user_roles.updated",
  "policies.updated",
  "skills.published",
  "skills.rolled_back",
  "skills.created",
  "skills.updated",
  "skills.deleted",
  "skills.matched",
  "skills.synced",
  "skills.unsynced",
  "workspace.file.written",
  "workspace.file.deleted",
  "tool.high_risk.executed",
  "permission_rule.created",
  "permission_rule.updated",
  "permission_rule.deleted",
  "thread.purged",
  "approval.resolved",
] as const;
export type StudioAuditAction = (typeof STUDIO_AUDIT_ACTIONS)[number];

export interface StudioAuditInput {
  actorUserId: string;
  action: StudioAuditAction;
  targetType: string;
  targetId: string;
  outcome: AuditOutcome;
  metadata: Record<string, unknown>;
  requestId?: string;
}

export type StudioAuditRow = AuditEvent & {
  actorName: string | null;
  actorEmail: string | null;
};

/** key 名命中以下子串（小写）即剔除。 */
const REDACT_KEY_PATTERNS = [
  "secret",
  "token",
  "password",
  "apikey",
  "content",
  "commandoutput",
] as const;

const MAX_STRING = 256;
const MAX_ARRAY = 50;
/** 嵌套对象最大深度：root=0，depth>2 折叠。 */
const MAX_DEPTH = 2;

function isRedactableKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEY_PATTERNS.some((p) => lower.includes(p));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return undefined; // function / symbol / bigint 等丢弃
  if (depth > MAX_DEPTH) {
    return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((v) => sanitizeValue(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isRedactableKey(k)) continue;
    const child = sanitizeValue(v, depth + 1);
    if (child !== undefined) out[k] = child;
  }
  return out;
}

/**
 * 脱敏审计 metadata。剔除 secret-like key、截断长 string/数组、折叠超深对象。
 * 输出保证可 JSON 序列化（不含 function / undefined / 循环）。
 */
export function sanitizeAuditMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const out = sanitizeValue(input, 0);
  return out && typeof out === "object" && !Array.isArray(out)
    ? (out as Record<string, unknown>)
    : {};
}

/** 生成用户角色覆盖摘要：before/after roleIds（不含 email 等个人字段，由 route 按需补）。 */
export function summarizeRoleChange(
  beforeRoleIds: string[],
  afterRoleIds: string[],
): { roleIdsBefore: string[]; roleIdsAfter: string[] } {
  return { roleIdsBefore: beforeRoleIds, roleIdsAfter: afterRoleIds };
}

/**
 * 记录一条审计：对 metadata 做防御性脱敏后写入 AuditEvent。
 * 各 route 在原权限通过、进入业务写意图后调用（成功 / 业务失败两路）。
 */
export async function recordAdminAudit(input: StudioAuditInput, tx?: DbOrTx): Promise<void> {
  assertAuditActionTypeKnown(input.action);
  const client = tx ?? db;
  const [actor] = await client
    .select({ tenantId: userIdentity.tenantId })
    .from(userIdentity)
    .where(eq(userIdentity.id, input.actorUserId))
    .limit(1);
  if (!actor) throw new Error(`Studio 审计 actor 不存在: ${input.actorUserId}`);
  const metadataRedacted = sanitizeAuditMetadata(input.metadata);
  await appendAuditEvent(
    {
      tenantId: actor.tenantId,
      actorType: "user",
      actorId: input.actorUserId,
      actionType: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      outcome: input.outcome,
      metadataRedacted,
      reason: typeof metadataRedacted.reasonCode === "string" ? metadataRedacted.reasonCode : null,
      requestId: input.requestId ?? generateRequestId(),
    },
    client,
  );
}

/** Studio 审计只读投影：Authority 仍是 AuditEvent，名称只从 UserIdentity 补充。 */
export async function listStudioAuditEvents(params: {
  tenantId: string;
  limit?: number;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  action?: StudioAuditAction;
}): Promise<StudioAuditRow[]> {
  const events = await listAuditEvents({
    tenantId: params.tenantId,
    actorType: params.actorUserId ? "user" : undefined,
    actorId: params.actorUserId,
    targetType: params.targetType,
    targetId: params.targetId,
    actionType: params.action,
    limit: Math.min(200, Math.max(1, Math.floor(params.limit ?? 100))),
    order: "desc",
  });
  const actorIds = Array.from(
    new Set(events.filter((event) => event.actorType === "user").map((event) => event.actorId)),
  );
  const actors =
    actorIds.length > 0
      ? await db
          .select({
            id: userIdentity.id,
            name: userIdentity.displayName,
            email: userIdentity.email,
          })
          .from(userIdentity)
          .where(
            and(eq(userIdentity.tenantId, params.tenantId), inArray(userIdentity.id, actorIds)),
          )
      : [];
  const actorsById = new Map(actors.map((actor) => [actor.id, actor]));
  return events.map((event) => ({
    ...event,
    actorName: actorsById.get(event.actorId)?.name ?? null,
    actorEmail: actorsById.get(event.actorId)?.email ?? null,
  }));
}
