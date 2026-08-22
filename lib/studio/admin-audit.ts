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
import {
  type AppendAdminAuditLogInput,
  type DbTxClient,
  appendAdminAuditLog,
} from "@/lib/db/queries";

export type { AppendAdminAuditLogInput };

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
 * 记录一条审计：对 metadata 做防御性脱敏后调用 appendAdminAuditLog 落库。
 * 各 route 在原权限通过、进入业务写意图后调用（成功 / 业务失败两路）。
 */
export async function recordAdminAudit(
  input: AppendAdminAuditLogInput,
  tx?: DbTxClient,
): Promise<void> {
  await appendAdminAuditLog({ ...input, metadata: sanitizeAuditMetadata(input.metadata) }, tx);
}
