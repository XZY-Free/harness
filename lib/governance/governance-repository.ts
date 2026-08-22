/**
 * Governance Config Repository（关口02 02-6 · 冻结方案 §5.4 / §54-P2）。
 *
 * loadGovernanceConfigFromDB 是运行期唯一正式读取路径，fail-closed（§5.4）：
 * - Set 不存在
 * - currentRevision 不存在
 * - Revision 不是 published
 * - Digest 错误
 * - 跨租户（Revision 不属于该 Set / Set 不属于该 tenant）
 * - 非法 config
 * 以上全部抛错，绝不 return INITIAL_GOVERNANCE_CONFIG。
 */
import { type DbOrTx, db } from "@/lib/db/client";
import { canonicalizeGovernanceConfig } from "@/lib/governance/compiler";
import { GOVERNANCE_CONFIG_SET_KEY } from "@/lib/governance/config";
import {
  type GovernanceConfig,
  type GovernanceConfigRevision,
  type GovernanceConfigSet,
  governanceConfigRevisionTable,
  governanceConfigSetTable,
} from "@/lib/persistence/schema/governance-config";
import { and, eq } from "drizzle-orm";

/** Governance 读取/加载失败（fail-closed 统一异常）。 */
export class GovernanceLoadError extends Error {
  readonly code = "GOVERNANCE_LOAD_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "GovernanceLoadError";
  }
}

/** 已加载的 Governance 配置（current published Revision）。 */
export interface LoadedGovernanceConfig {
  set: GovernanceConfigSet;
  revision: GovernanceConfigRevision;
  config: GovernanceConfig;
  configDigest: string;
}

/** 当前生效 Set + Revision（读路径核心；事务内/外用 tx 传参复用）。 */
export async function loadGovernanceSetAndRevision(
  tx: DbOrTx,
  tenantId: string,
  configSetKey: string = GOVERNANCE_CONFIG_SET_KEY,
): Promise<{ set: GovernanceConfigSet; revision: GovernanceConfigRevision }> {
  const [set] = await tx
    .select()
    .from(governanceConfigSetTable)
    .where(
      and(
        eq(governanceConfigSetTable.tenantId, tenantId),
        eq(governanceConfigSetTable.configSetKey, configSetKey),
      ),
    )
    .limit(1);
  if (!set) {
    throw new GovernanceLoadError(`GovernanceConfigSet 不存在: ${configSetKey}`);
  }
  if (!set.currentRevisionId) {
    throw new GovernanceLoadError(`GovernanceConfigSet 无 currentRevisionId: ${set.id}`);
  }
  const [revision] = await tx
    .select()
    .from(governanceConfigRevisionTable)
    .where(eq(governanceConfigRevisionTable.id, set.currentRevisionId))
    .limit(1);
  if (!revision) {
    throw new GovernanceLoadError(`GovernanceConfigRevision 不存在: ${set.currentRevisionId}`);
  }
  // 跨租户/归属校验：Revision 必须属于该 Set（Set 已按 tenantId 过滤）。
  if (revision.configSetId !== set.id) {
    throw new GovernanceLoadError(`GovernanceConfigRevision 跨 Set 引用: ${revision.id}`);
  }
  return { set, revision };
}

/**
 * 按冻结 Revision id 加载 Governance 配置（§24：Binding 冻结值，非 Tenant current）。
 *
 * dispatch/redispatch 下发 Runtime 时必须使用 ExecutionBinding 冻结的
 * `governanceConfigRevisionId`，禁止读 currentRevisionId 重选。fail-closed：
 * - Revision 不存在
 * - 跨租户（Revision 不属于该 tenant 的 Set）
 * - Revision 非 published
 * - configDigest 不一致
 * 以上全部抛错。
 */
export async function loadFrozenGovernanceConfig(
  tenantId: string,
  revisionId: string,
): Promise<LoadedGovernanceConfig> {
  const [set] = await db
    .select()
    .from(governanceConfigSetTable)
    .where(eq(governanceConfigSetTable.tenantId, tenantId))
    .limit(1);
  if (!set) {
    throw new GovernanceLoadError(`GovernanceConfigSet 不存在 (tenant=${tenantId})`);
  }
  const [revision] = await db
    .select()
    .from(governanceConfigRevisionTable)
    .where(eq(governanceConfigRevisionTable.id, revisionId))
    .limit(1);
  if (!revision) {
    throw new GovernanceLoadError(`GovernanceConfigRevision 不存在: ${revisionId}`);
  }
  if (revision.configSetId !== set.id) {
    throw new GovernanceLoadError(`GovernanceConfigRevision 跨租户引用: ${revisionId}`);
  }
  if (revision.revisionState !== "published") {
    throw new GovernanceLoadError(
      `GovernanceConfigRevision 非 published: ${revisionId} (${revision.revisionState})`,
    );
  }
  const config = revision.configJson;
  const expectedDigest = canonicalizeGovernanceConfig(config);
  if (revision.configDigest !== expectedDigest) {
    throw new GovernanceLoadError(`Governance configDigest 不匹配: ${revisionId}`);
  }
  return { set, revision, config, configDigest: revision.configDigest };
}

/**
 * 加载当前生效 Governance 配置（fail-closed，§5.4）。
 * 运行期绝不回退 INITIAL_GOVERNANCE_CONFIG。
 */
export async function loadGovernanceConfigFromDB(
  tenantId: string,
): Promise<LoadedGovernanceConfig> {
  const { set, revision } = await loadGovernanceSetAndRevision(db, tenantId);
  if (revision.revisionState !== "published") {
    throw new GovernanceLoadError(
      `GovernanceConfigRevision 非 published: ${revision.id} (${revision.revisionState})`,
    );
  }
  const config = revision.configJson;
  const expectedDigest = canonicalizeGovernanceConfig(config);
  if (revision.configDigest !== expectedDigest) {
    throw new GovernanceLoadError(`Governance configDigest 不匹配: ${revision.id}`);
  }
  return { set, revision, config, configDigest: revision.configDigest };
}
