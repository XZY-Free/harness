/**
 * Permission Policy Revision 仓储与应用服务（关口02 02-6 · 冻结方案 §6 / §7 / §30 / §31 / §33 / §35 / §54-P3）。
 *
 * 正式 Policy 管理全链：**只通过新建 PolicyRevision 发布**，绝不原地修改 published rows（§30）。
 * Studio 修改规则 = 复制旧 rules 保留 ruleKey → 应用增删改 → validate → canonicalize →
 * rulesHash → 新 published Revision → 切 currentRevisionId → versionNo+1 → AuditEvent(policy.publish)（§31）。
 *
 * 关键不变量：
 * - `ruleKey`：跨 Revision 稳定规则身份（§6.3）。未修改规则复制到新 Revision → ruleKey 不变；
 *   修改 → ruleKey 不变、内容变；新增 → 新 ruleKey；删除 → 新 Revision 不再出现。
 * - `UNIQUE(policyRevisionId, ruleKey)` 由 schema 保证。
 * - 正式决策值仅 allow/pause/block（§P3，Legacy allow/ask/deny 转换删除）。
 * - toolPattern 只支持 `*` | 完整 Tool Key | `prefix.*`（§6.4，无任意正则）。
 * - argMatcher 只允许已定义、可验证、可脱敏字段（pathRegex/commandRegex/risk）；
 *   未识别字段 / 非法正则 / ReDoS 风险 → fail-closed，Policy Revision 不能发布（§6.5）。
 * - Audit 只记录 hash + actor + requestId + reason，不复制完整规则内容 / Secret / 原始参数（§35）。
 */
import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { type AuditActor, computeContentHash } from "@/lib/identity/audit";
import {
  type PolicyRuleDigestInput,
  computePolicyRulesHash,
} from "@/lib/identity/tenant-bootstrap";
import { auditEvent } from "@/lib/persistence/schema/control-plane";
import {
  PERMISSION_DECISION_VALUES,
  type PermissionDecisionValue,
} from "@/lib/persistence/schema/permission";
import {
  type Policy,
  type PolicyRevision,
  type PolicySet,
  policyRevisionTable,
  policySetTable,
  policyTable,
} from "@/lib/persistence/schema/permission";
import { assertSafeRegex } from "@/lib/security/regex-safety";
import { and, eq, max } from "drizzle-orm";

/** 稳定 PolicySet key（冻结方案 §6.1）。 */
export const POLICY_SET_KEY = "tool-execution";

/** 正式决策值集合（无 allow/ask/deny 中的 ask/deny）。 */
export const POLICY_DECISION_VALUES = PERMISSION_DECISION_VALUES;

/** argMatcher 允许字段（§6.5：当前已定义、可验证、可脱敏）。 */
const ARG_MATCHER_KEYS = new Set(["pathRegex", "commandRegex", "risk"]);
/**
 * toolPattern 合法形态（§6.4）：`*` | 完整 key | prefix.*。
 * 完整 key 为「非空段 + 非空段 …」的 dot 连接（如 tool.writeFile）；prefix.* 为 key + `.*`。
 * 拒绝空段（前导/尾随/连续点，如 `a..*`）与任意正则（`^foo` 等）。
 */
const KEY_SEGMENT = "[A-Za-z0-9_-]+";
const KEY_CHAIN = `${KEY_SEGMENT}(?:\\.${KEY_SEGMENT})*`;
const EXACT_KEY_RE = new RegExp(`^${KEY_CHAIN}$`);
const PREFIX_STAR_RE = new RegExp(`^${KEY_CHAIN}\\.\\*$`);

/** 规则输入（客户端/UI 表达；ruleKey 跨 Revision 稳定身份）。 */
export interface PolicyRuleInput {
  ruleKey: string;
  toolPattern: string;
  argMatcher: { pathRegex?: string; commandRegex?: string; risk?: string } | null;
  decision: PermissionDecisionValue;
  scope: { type: string; ref?: string };
  priority: number;
  reason: string | null;
}

/** 加载失败（Set 缺失 / 跨租户）。 */
export class PolicyLoadError extends Error {
  readonly code = "POLICY_LOAD_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "PolicyLoadError";
  }
}

/** 生命周期不允许发布。 */
export class PolicySetStateError extends Error {
  readonly code = "POLICY_SET_STATE";
  constructor(setKey: string, state: string) {
    super(`PolicySet(${setKey}) 生命周期 ${state} 不允许发布`);
    this.name = "PolicySetStateError";
  }
}

/** versionNo 并发冲突（If-Match 不匹配）。 */
export class PolicyVersionConflictError extends Error {
  readonly code = "POLICY_VERSION_CONFLICT";
  readonly expectedVersionNo: number;
  readonly actualVersionNo: number;
  constructor(expectedVersionNo: number, actualVersionNo: number) {
    super(`PolicySet versionNo 不匹配（期望 ${expectedVersionNo}，实际 ${actualVersionNo}）`);
    this.name = "PolicyVersionConflictError";
    this.expectedVersionNo = expectedVersionNo;
    this.actualVersionNo = actualVersionNo;
  }
}

/** 规则校验失败（fail-closed，§6.4 / §6.5）。 */
export class PolicyValidationError extends Error {
  readonly code = "POLICY_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

/** 已加载的当前 PolicySet + Revision + Rules（读路径）。 */
export interface LoadedPolicy {
  set: PolicySet;
  revision: PolicyRevision;
  rules: Policy[];
  defaultDecision: PermissionDecisionValue;
  rulesHash: string;
}

/** 当前 Set + Revision（事务内/外复用）。 */
export async function loadPolicySetAndRevision(
  tx: DbOrTx,
  tenantId: string,
  policySetKey: string = POLICY_SET_KEY,
): Promise<{ set: PolicySet; revision: PolicyRevision | null }> {
  const [set] = await tx
    .select()
    .from(policySetTable)
    .where(
      and(eq(policySetTable.tenantId, tenantId), eq(policySetTable.policySetKey, policySetKey)),
    )
    .limit(1);
  if (!set) {
    throw new PolicyLoadError(`PolicySet 不存在: ${policySetKey}`);
  }
  if (!set.currentRevisionId) {
    return { set, revision: null };
  }
  const [revision] = await tx
    .select()
    .from(policyRevisionTable)
    .where(eq(policyRevisionTable.id, set.currentRevisionId))
    .limit(1);
  if (!revision) {
    throw new PolicyLoadError(`PolicyRevision 不存在: ${set.currentRevisionId}`);
  }
  if (revision.policySetId !== set.id) {
    throw new PolicyLoadError(`PolicyRevision 跨 Set 引用: ${revision.id}`);
  }
  return { set, revision };
}

/** 读某 Revision 的 Policy rows（按 priority DESC → ruleKey ASC 排序稳定展示）。 */
export async function listPoliciesByRevision(tx: DbOrTx, revisionId: string): Promise<Policy[]> {
  const rows = await tx
    .select()
    .from(policyTable)
    .where(eq(policyTable.policyRevisionId, revisionId));
  return rows.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0;
  });
}

/** 加载当前生效 Policy（Set + Revision + Rules + digest），读路径核心。 */
export async function loadPolicySetAndRules(
  tenantId: string,
  policySetKey: string = POLICY_SET_KEY,
): Promise<LoadedPolicy> {
  const { set, revision } = await loadPolicySetAndRevision(db, tenantId, policySetKey);
  if (!revision) {
    throw new PolicyLoadError(`PolicySet 无 currentRevisionId: ${set.id}`);
  }
  if (revision.revisionState !== "published") {
    throw new PolicyLoadError(
      `PolicyRevision 非 published: ${revision.id} (${revision.revisionState})`,
    );
  }
  const rules = await listPoliciesByRevision(db, revision.id);
  return {
    set,
    revision,
    rules,
    defaultDecision: revision.defaultDecision,
    rulesHash: revision.rulesHash,
  };
}

/**
 * 加载 ExecutionBinding 冻结的精确 PolicyRevision（§16.3）。
 *
 * 与 loadPolicySetAndRules（读 current）不同，这里按 id 读取 Binding 冻结的那一版：
 * - 必须属于 tenant 的 PolicySet("tool-execution")（跨租户/跨 Set → PolicyLoadError）。
 * - 必须为 published（withdrawn/draft 不可再用于评估）。
 * - 返回该 Revision 的 Policy rows 与 defaultDecision/rulesHash，供重算 digest 校验。
 */
export async function loadFrozenPolicyRevision(
  tx: DbOrTx,
  tenantId: string,
  policyRevisionId: string,
  policySetKey: string = POLICY_SET_KEY,
): Promise<LoadedPolicy> {
  const { set } = await loadPolicySetAndRevision(tx, tenantId, policySetKey);
  const [revision] = await tx
    .select()
    .from(policyRevisionTable)
    .where(eq(policyRevisionTable.id, policyRevisionId))
    .limit(1);
  if (!revision) {
    throw new PolicyLoadError(`PolicyRevision 不存在: ${policyRevisionId}`);
  }
  if (revision.policySetId !== set.id) {
    throw new PolicyLoadError(`PolicyRevision 跨 Set 引用: ${revision.id}`);
  }
  if (revision.revisionState !== "published") {
    throw new PolicyLoadError(
      `PolicyRevision 非 published: ${revision.id} (${revision.revisionState})`,
    );
  }
  const rules = await listPoliciesByRevision(tx, revision.id);
  return {
    set,
    revision,
    rules,
    defaultDecision: revision.defaultDecision,
    rulesHash: revision.rulesHash,
  };
}

/** 计算某 Revision 的 rulesHash 输入（§7：排除 row id/createdAt/updatedAt/revisionId/revisionNo）。 */
export function toRulesDigestInput(rules: Policy[]): PolicyRuleDigestInput[] {
  return rules.map((r) => ({
    ruleKey: r.ruleKey,
    toolPattern: r.toolPattern,
    argMatcher: (r.argMatcherJson as unknown) ?? null,
    decision: r.decision,
    scope: r.scopeJson,
    priority: r.priority,
    reason: r.reason,
  }));
}

/** 规则输入 → digest 输入（§7）。 */
function toInputDigestInput(rules: PolicyRuleInput[]): PolicyRuleDigestInput[] {
  return rules.map((r) => ({
    ruleKey: r.ruleKey,
    toolPattern: r.toolPattern,
    argMatcher: r.argMatcher,
    decision: r.decision,
    scope: r.scope,
    priority: r.priority,
    reason: r.reason,
  }));
}

/** 校验规则集合（fail-closed，§6.4 / §6.5）。 */
function validateRules(rules: PolicyRuleInput[]): void {
  const seen = new Set<string>();
  for (const r of rules) {
    if (!r.ruleKey || r.ruleKey.length === 0 || r.ruleKey.length > 128) {
      throw new PolicyValidationError("ruleKey 必须为 1–128 字符非空字符串");
    }
    if (seen.has(r.ruleKey)) {
      throw new PolicyValidationError(`ruleKey 重复: ${r.ruleKey}`);
    }
    seen.add(r.ruleKey);

    // §6.4 toolPattern：`*` | 完整 key | prefix.*。
    if (
      !(
        r.toolPattern === "*" ||
        EXACT_KEY_RE.test(r.toolPattern) ||
        PREFIX_STAR_RE.test(r.toolPattern)
      )
    ) {
      throw new PolicyValidationError(
        `toolPattern 非法: "${r.toolPattern}"（仅支持 * / 完整 Tool Key / prefix.*）`,
      );
    }

    // §P3：正式 API 只接受 allow/pause/block。
    if (!PERMISSION_DECISION_VALUES.includes(r.decision)) {
      throw new PolicyValidationError(`decision 非法: ${r.decision}（仅 allow/pause/block）`);
    }

    // §6.5 argMatcher：只允许已知字段，非法正则/ReDoS fail-closed。
    if (r.argMatcher !== null && r.argMatcher !== undefined) {
      if (typeof r.argMatcher !== "object" || Array.isArray(r.argMatcher)) {
        throw new PolicyValidationError("argMatcher 必须为对象或 null");
      }
      for (const key of Object.keys(r.argMatcher)) {
        if (!ARG_MATCHER_KEYS.has(key)) {
          throw new PolicyValidationError(`argMatcher 未识别字段: ${key}（fail-closed）`);
        }
        const val = (r.argMatcher as Record<string, unknown>)[key];
        if (typeof val !== "string") {
          throw new PolicyValidationError(`argMatcher.${key} 必须为字符串`);
        }
        if (key === "pathRegex" || key === "commandRegex") {
          try {
            assertSafeRegex(val, `argMatcher.${key}`);
          } catch (err) {
            // 统一为 PolicyValidationError（fail-closed，§6.5 非法正则/ReDoS 拒绝发布）。
            throw new PolicyValidationError(`argMatcher.${key} 非法：${(err as Error).message}`);
          }
        }
      }
    }

    // scope：必须为 { type: string, ref?: string }。
    if (typeof r.scope !== "object" || r.scope === null || Array.isArray(r.scope)) {
      throw new PolicyValidationError("scope 必须为对象");
    }
    if (typeof r.scope.type !== "string" || r.scope.type.length === 0) {
      throw new PolicyValidationError("scope.type 必须为非空字符串");
    }

    // priority：整数。
    if (!Number.isInteger(r.priority)) {
      throw new PolicyValidationError("priority 必须为整数");
    }
  }
}

/** 校验 defaultDecision（allow/pause/block）。 */
function validateDefaultDecision(value: string): asserts value is PermissionDecisionValue {
  if (!PERMISSION_DECISION_VALUES.includes(value as PermissionDecisionValue)) {
    throw new PolicyValidationError(`defaultDecision 非法: ${value}（仅 allow/pause/block）`);
  }
}

/** Set 内下一个 revisionNo（MAX + 1；无记录则 1）。 */
async function nextRevisionNo(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  policySetId: string,
): Promise<number> {
  const [row] = await tx
    .select({ m: max(policyRevisionTable.revisionNo) })
    .from(policyRevisionTable)
    .where(eq(policyRevisionTable.policySetId, policySetId));
  return (row?.m ?? 0) + 1;
}

export interface CreatePolicyRevisionParams {
  tenantId: string;
  policySetKey?: string;
  /** 无匹配规则时生效的默认决策（§6.2，随 Revision 冻结）。 */
  defaultDecision: PermissionDecisionValue;
  /** 目标完整规则集合（§31：复制旧 rules 保留 ruleKey → 应用增删改）。 */
  rules: PolicyRuleInput[];
  /** Route 从 If-Match 解析的期望 versionNo（§33）；null 表示不强制校验。 */
  expectedVersionNo: number | null;
  actor: AuditActor;
  requestId: string;
}

export interface CreatePolicyRevisionResult {
  set: PolicySet;
  revision: PolicyRevision;
  rules: Policy[];
  rulesHash: string;
  auditEventId: string;
}

/**
 * 发布一个新的 Policy Revision（§31 单事务）。
 *
 *   SELECT PolicySet FOR UPDATE
 *   → 生命周期门禁（enabled）
 *   → If-Match/versionNo 并发校验（§33）
 *   → 复制旧 rules 保留 ruleKey
 *   → 应用增删改（upsert by ruleKey；缺席即删除）
 *   → validate → canonicalize → rulesHash
 *   → 新 published Revision
 *   → PolicySet.currentRevisionId = 新 Revision
 *   → PolicySet.versionNo + 1
 *   → AuditEvent(policy.publish)（同事务，§31 / §35）
 *   → commit
 */
export async function createPolicyRevision(
  params: CreatePolicyRevisionParams,
): Promise<CreatePolicyRevisionResult> {
  const { tenantId, defaultDecision, rules, expectedVersionNo, actor, requestId } = params;
  const policySetKey = params.policySetKey ?? POLICY_SET_KEY;

  // 校验在事务外提前失败（快速返回，不占锁）。
  validateDefaultDecision(defaultDecision);
  validateRules(rules);
  const newRulesHash = computePolicyRulesHash(defaultDecision, toInputDigestInput(rules));

  return db.transaction(async (tx) => {
    const { set, revision: currentRevision } = await loadPolicySetAndRevision(
      tx,
      tenantId,
      policySetKey,
    );

    if (set.lifecycleState !== "enabled") {
      throw new PolicySetStateError(policySetKey, set.lifecycleState);
    }
    if (expectedVersionNo !== null && set.versionNo !== expectedVersionNo) {
      throw new PolicyVersionConflictError(expectedVersionNo, set.versionNo);
    }

    // 复制旧 rules 保留 ruleKey（§6.3）。
    const prevRules: Policy[] = currentRevision
      ? await listPoliciesByRevision(tx, currentRevision.id)
      : [];

    const revisionNo = await nextRevisionNo(tx, set.id);
    const revisionId = randomUUID();
    const publishedAt = new Date();

    // 1. 新建 published Revision。
    await tx.insert(policyRevisionTable).values({
      id: revisionId,
      policySetId: set.id,
      revisionNo,
      defaultDecision,
      rulesHash: newRulesHash,
      revisionState: "published",
      createdBy: actor.actorId,
      publishedAt,
    });

    // 2. 写入该 Revision 的 Policy rows（ruleKey 稳定；删旧的、保留/新增/更新）。
    await tx.delete(policyTable).where(eq(policyTable.policyRevisionId, revisionId));
    for (const rule of rules) {
      await tx.insert(policyTable).values({
        id: randomUUID(),
        tenantId,
        policySetId: set.id,
        policyRevisionId: revisionId,
        ruleKey: rule.ruleKey,
        toolPattern: rule.toolPattern,
        argMatcherJson: rule.argMatcher as unknown,
        decision: rule.decision,
        scopeJson: rule.scope,
        reason: rule.reason,
        priority: rule.priority,
      });
    }

    // 3. 原子切换 currentRevisionId + versionNo + 1。
    await tx
      .update(policySetTable)
      .set({ currentRevisionId: revisionId, versionNo: set.versionNo + 1, updatedAt: new Date() })
      .where(eq(policySetTable.id, set.id));

    // 4. AuditEvent(policy.publish) —— 同事务（§31 / §35）。
    // beforeHash = previous rules hash，afterHash = new rules hash；审计列 varchar(64)，
    // 用 computeContentHash（64 hex 无前缀），rulesHash（sha256: 前缀）只用于 rulesHash 列。
    const auditEventId = randomUUID();
    await tx.insert(auditEvent).values({
      id: auditEventId,
      tenantId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actionType: "policy.publish",
      targetType: "policy",
      targetId: set.id,
      beforeHash: computeContentHash({
        defaultDecision: currentRevision?.defaultDecision ?? defaultDecision,
        rules: toRulesDigestInput(prevRules),
      }),
      afterHash: computeContentHash({
        defaultDecision,
        rules: toInputDigestInput(rules),
      }),
      reason: null,
      requestId,
      occurredAt: publishedAt,
    });

    const [updatedSet] = await tx
      .select()
      .from(policySetTable)
      .where(eq(policySetTable.id, set.id))
      .limit(1);
    if (!updatedSet) throw new PolicyLoadError(`PolicySet 读取失败: ${set.id}`);
    const [revision] = await tx
      .select()
      .from(policyRevisionTable)
      .where(eq(policyRevisionTable.id, revisionId))
      .limit(1);
    if (!revision) throw new PolicyLoadError(`PolicyRevision 读取失败: ${revisionId}`);
    const insertedRules = await listPoliciesByRevision(tx, revisionId);

    return {
      set: updatedSet,
      revision,
      rules: insertedRules,
      rulesHash: newRulesHash,
      auditEventId,
    };
  });
}

/**
 * withdraw：把 published Revision 置为 withdrawn，只阻止新 Binding，不影响既有 Invocation（§12.2）。
 * 不改变 currentRevisionId / versionNo / 不产生 AuditEvent（非发布动作）。
 */
export async function withdrawPolicyRevision(
  tenantId: string,
  policySetKey: string,
  revisionId: string,
): Promise<PolicyRevision> {
  const { set } = await loadPolicySetAndRevision(db, tenantId, policySetKey);
  const [revision] = await db
    .select()
    .from(policyRevisionTable)
    .where(and(eq(policyRevisionTable.id, revisionId), eq(policyRevisionTable.policySetId, set.id)))
    .limit(1);
  if (!revision) throw new PolicyLoadError(`PolicyRevision 不存在: ${revisionId}`);
  if (revision.revisionState !== "published") {
    throw new PolicyValidationError(`PolicyRevision 非 published，无法 withdraw: ${revisionId}`);
  }
  await db
    .update(policyRevisionTable)
    .set({ revisionState: "withdrawn" })
    .where(eq(policyRevisionTable.id, revisionId));
  return { ...revision, revisionState: "withdrawn" as const };
}
