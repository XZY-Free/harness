/**
 * Tenant Bootstrap（关口02 02-6 · 冻结方案 §8 / §54-P1）。
 *
 * Tenant 创建必须在同一事务建立 Governance + Policy 双 baseline：
 * - GovernanceConfigSet("runtime-execution", enabled) + initial
 *   GovernanceConfigRevision(revisionNo=1, published, INITIAL_GOVERNANCE_CONFIG)
 * - PolicySet("tool-execution", enabled) + initial
 *   PolicyRevision(revisionNo=1, published, defaultDecision=pause, Policy rows=[])
 * - 并回填双方 currentRevisionId。
 *
 * 铁律（冻结方案 §5.4）：
 * - INITIAL_GOVERNANCE_CONFIG 全仓只存在一份，唯一用途 = 创建 Tenant initial Revision。
 * - 运行期 DB 缺失/非 published/digest 错/跨租户/非法 → fail-closed，绝不 return
 *   INITIAL_GOVERNANCE_CONFIG（本模块不提供任何"回退默认"读取路径）。
 * - 不允许出现"有 Tenant 但无 Governance / 有 Tenant 但无 Policy"。
 */
import { randomUUID } from "node:crypto";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { type DbOrTx, db } from "@/lib/db/client";
import { isMysqlDuplicateEntryError } from "@/lib/db/mysql-error";
import { GOVERNANCE_CONFIG_SET_KEY, INITIAL_GOVERNANCE_CONFIG } from "@/lib/governance/config";
import {
  type GovernanceConfig,
  governanceConfigRevisionTable,
  governanceConfigSetTable,
} from "@/lib/persistence/schema/governance-config";
import { tenant } from "@/lib/persistence/schema/identity";
import { policyRevisionTable, policySetTable } from "@/lib/persistence/schema/permission";
import { eq } from "drizzle-orm";

// INITIAL_GOVERNANCE_CONFIG / GOVERNANCE_CONFIG_SET_KEY 唯一源在 lib/governance/config.ts（§5.4）。
export { GOVERNANCE_CONFIG_SET_KEY, INITIAL_GOVERNANCE_CONFIG } from "@/lib/governance/config";

/** 默认租户 key（单租户阶段固定）。 */
export const DEFAULT_TENANT_KEY = "default";
export const DEFAULT_TENANT_NAME = "Default Tenant";
/** 默认租户 id 固定，便于 dev 模式和测试复用。 */
export const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000000";

/** PolicySet 正式稳定 key（冻结方案 §6.1）。 */
export const POLICY_SET_KEY = "tool-execution";

/** 计算 Governance configDigest：sha256: + SHA256(canonical(configJson))（§5.3）。 */
export function computeGovernanceConfigDigest(config: GovernanceConfig): string {
  return computeCanonicalDigest(config);
}

/**
 * Policy rulesHash 输入规则形状（冻结方案 §7）。
 * 排除 DB row id / createdAt / updatedAt / revisionId / revisionNo。
 */
export interface PolicyRuleDigestInput {
  ruleKey: string;
  toolPattern: string;
  argMatcher: unknown;
  decision: string;
  scope: unknown;
  priority: number;
  reason: string | null;
}

const DECISION_RANK: Record<string, number> = { block: 3, pause: 2, allow: 1 };

/**
 * 计算 Policy rulesHash（冻结方案 §6.6 / §7）。
 * 排序：priority DESC → decision(block>pause>allow) → toolPattern ASC → ruleKey ASC。
 * 之后 canonical(payload) → sha256: + SHA256。
 * 同一语义规则复制到新 Revision 内容不变 → rulesHash 保持一致（正确行为）。
 */
export function computePolicyRulesHash(
  defaultDecision: string,
  rules: PolicyRuleDigestInput[],
): string {
  const sorted = [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority; // DESC
    const da = DECISION_RANK[a.decision] ?? 0;
    const dbRank = DECISION_RANK[b.decision] ?? 0;
    if (da !== dbRank) return dbRank - da; // block > pause > allow
    if (a.toolPattern !== b.toolPattern) return a.toolPattern < b.toolPattern ? -1 : 1; // ASC
    return a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0; // ASC
  });
  const payload = {
    defaultDecision,
    rules: sorted.map((r) => ({
      ruleKey: r.ruleKey,
      toolPattern: r.toolPattern,
      argMatcher: r.argMatcher,
      decision: r.decision,
      scope: r.scope,
      priority: r.priority,
      reason: r.reason,
    })),
  };
  return computeCanonicalDigest(payload);
}

/**
 * 在同一事务为租户建立 Governance + Policy 双 baseline（冻结方案 §8）。
 * 幂等（以 UNIQUE(tenantId, configSetKey/policySetKey) 约束 + 调用方并发兜底）。
 */
export async function bootstrapTenantBaselines(
  tx: DbOrTx,
  tenantId: string,
  actorId: string,
): Promise<void> {
  // ── GovernanceConfigSet + initial GovernanceConfigRevision ──
  const gcsId = randomUUID();
  const gcrId = randomUUID();
  const configDigest = computeGovernanceConfigDigest(INITIAL_GOVERNANCE_CONFIG);
  await tx.insert(governanceConfigSetTable).values({
    id: gcsId,
    tenantId,
    configSetKey: GOVERNANCE_CONFIG_SET_KEY,
    ownerUserId: null,
    currentRevisionId: gcrId,
    lifecycleState: "enabled",
    versionNo: 1,
  });
  await tx.insert(governanceConfigRevisionTable).values({
    id: gcrId,
    configSetId: gcsId,
    revisionNo: 1,
    configJson: INITIAL_GOVERNANCE_CONFIG,
    configDigest,
    revisionState: "published",
    createdBy: actorId,
    publishedAt: new Date(),
  });

  // ── PolicySet + initial PolicyRevision（defaultDecision=pause, rules=[]）──
  const psId = randomUUID();
  const prId = randomUUID();
  const rulesHash = computePolicyRulesHash("pause", []);
  await tx.insert(policySetTable).values({
    id: psId,
    tenantId,
    policySetKey: POLICY_SET_KEY,
    ownerUserId: null,
    currentRevisionId: prId,
    lifecycleState: "enabled",
    versionNo: 1,
  });
  await tx.insert(policyRevisionTable).values({
    id: prId,
    policySetId: psId,
    revisionNo: 1,
    defaultDecision: "pause",
    rulesHash,
    revisionState: "published",
    createdBy: actorId,
    publishedAt: new Date(),
  });
}

/**
 * 幂等确保默认租户存在，并在创建时同事务建立 Governance + Policy 双 baseline。
 * - 已存在：直接返回（不重复建 baseline）。
 * - 不存在：单事务插入 Tenant + 双 baseline（原子；任一步失败全回滚）。
 */
export async function ensureDefaultTenant(): Promise<{
  id: string;
  key: string;
  name: string;
  status: string;
}> {
  const [existing] = await db
    .select({
      id: tenant.id,
      key: tenant.key,
      name: tenant.name,
      status: tenant.status,
    })
    .from(tenant)
    .where(eq(tenant.key, DEFAULT_TENANT_KEY))
    .limit(1);

  if (existing) {
    return existing;
  }

  try {
    await db.transaction(async (tx) => {
      // 并发兜底：事务内再查一次，已存在则跳过。
      const [row] = await tx
        .select({ id: tenant.id })
        .from(tenant)
        .where(eq(tenant.key, DEFAULT_TENANT_KEY))
        .limit(1);
      if (row) {
        return;
      }
      await tx.insert(tenant).values({
        id: DEFAULT_TENANT_ID,
        key: DEFAULT_TENANT_KEY,
        name: DEFAULT_TENANT_NAME,
        status: "active",
      });
      await bootstrapTenantBaselines(tx, DEFAULT_TENANT_ID, "system");
    });
  } catch (err) {
    // 并发竞争：另一事务已先创建租户。落败事务的 insert 遇到 DEFAULT_TENANT_ID
    // 主键/唯一键重复，事务已整体 rollback（bootstrap 未落库）。仅吞掉 duplicate
    // key，其余错误继续抛出。
    const isDuplicate = isMysqlDuplicateEntryError(err);
    if (!isDuplicate) {
      throw err;
    }
  }

  const [created] = await db
    .select({
      id: tenant.id,
      key: tenant.key,
      name: tenant.name,
      status: tenant.status,
    })
    .from(tenant)
    .where(eq(tenant.key, DEFAULT_TENANT_KEY))
    .limit(1);

  if (!created) {
    throw new Error("无法创建默认租户");
  }
  return created;
}
