/**
 * Governance Config 发布 Application Service（关口02 02-6 · 冻结方案 §32 / §54-P2）。
 *
 * 事务（§32）：
 *   SELECT GovernanceConfigSet FOR UPDATE
 *   → 校验生命周期（enabled 才可发布；disabled/retired 拒绝）
 *   → validate config
 *   → 计算 configDigest
 *   → create 新 Revision（published）
 *   → Set.currentRevisionId = 新 Revision
 *   → Set.versionNo + 1
 *   → AuditEvent(governance.config.publish)（同事务，§32 要求 commit 前落审计）
 *   → commit
 *
 * If-Match/versionNo 由调用方（Route）按 §33 校验后传入 expectedVersionNo；
 * 本服务在事务内再次校验，防并发覆盖（§33「不得最后写入覆盖其他管理员刚发布的 Revision」）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { canonicalizeGovernanceConfig } from "@/lib/governance/compiler";
import { GOVERNANCE_CONFIG_SET_KEY, validateGovernanceConfig } from "@/lib/governance/config";
import { loadGovernanceSetAndRevision } from "@/lib/governance/governance-repository";
import { type AuditActor, computeContentHash } from "@/lib/identity/audit";
import { auditEvent } from "@/lib/persistence/schema/control-plane";
import {
  type GovernanceConfig,
  type GovernanceConfigRevision,
  type GovernanceConfigSet,
  governanceConfigRevisionTable,
  governanceConfigSetTable,
} from "@/lib/persistence/schema/governance-config";
import { and, eq, max } from "drizzle-orm";

/** 发布前置/状态错误（并发/生命周期）。 */
export class GovernancePublishError extends Error {
  readonly code = "GOVERNANCE_PUBLISH_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "GovernancePublishError";
  }
}

/** 生命周期不允许发布。 */
export class GovernanceSetStateError extends GovernancePublishError {
  constructor(setKey: string, state: string) {
    super(`GovernanceConfigSet(${setKey}) 生命周期 ${state} 不允许发布`);
    this.name = "GovernanceSetStateError";
  }
}

/** versionNo 并发冲突（If-Match 不匹配）。 */
export class GovernanceVersionConflictError extends GovernancePublishError {
  readonly expectedVersionNo: number;
  readonly actualVersionNo: number;
  constructor(expectedVersionNo: number, actualVersionNo: number) {
    super(
      `GovernanceConfigSet versionNo 不匹配（期望 ${expectedVersionNo}，实际 ${actualVersionNo}）`,
    );
    this.name = "GovernanceVersionConflictError";
    this.expectedVersionNo = expectedVersionNo;
    this.actualVersionNo = actualVersionNo;
  }
}

export interface PublishGovernanceConfigParams {
  tenantId: string;
  configSetKey?: string;
  newConfig: GovernanceConfig;
  /** Route 从 If-Match 解析的期望 versionNo（§33）；null 表示不强制校验。 */
  expectedVersionNo: number | null;
  actor: AuditActor;
  requestId: string;
}

export interface PublishGovernanceConfigResult {
  set: GovernanceConfigSet;
  revision: GovernanceConfigRevision;
  configDigest: string;
  auditEventId: string;
}

/** 计算 Set 内下一个 revisionNo（MAX + 1；无记录则 1）。 */
async function nextRevisionNo(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  configSetId: string,
): Promise<number> {
  const [row] = await tx
    .select({ m: max(governanceConfigRevisionTable.revisionNo) })
    .from(governanceConfigRevisionTable)
    .where(eq(governanceConfigRevisionTable.configSetId, configSetId));
  return (row?.m ?? 0) + 1;
}

/** 发布 Governance 配置（§32 单事务，审计同事务落库）。 */
export async function publishGovernanceConfig(
  params: PublishGovernanceConfigParams,
): Promise<PublishGovernanceConfigResult> {
  const { tenantId, newConfig, expectedVersionNo, actor, requestId } = params;
  const configSetKey = params.configSetKey ?? GOVERNANCE_CONFIG_SET_KEY;

  // 校验在事务外提前失败（快速返回，不占锁）。
  validateGovernanceConfig(newConfig);
  const configDigest = canonicalizeGovernanceConfig(newConfig);

  return db.transaction(async (tx) => {
    const { set, revision: currentRevision } = await loadGovernanceSetAndRevision(
      tx,
      tenantId,
      configSetKey,
    );

    // 生命周期门禁：enabled 才可发布。
    if (set.lifecycleState !== "enabled") {
      throw new GovernanceSetStateError(configSetKey, set.lifecycleState);
    }

    // If-Match/versionNo 并发校验（§33）。
    if (expectedVersionNo !== null && set.versionNo !== expectedVersionNo) {
      throw new GovernanceVersionConflictError(expectedVersionNo, set.versionNo);
    }

    // 审计契约：beforeHash/afterHash 用 computeContentHash（64 hex 无前缀，lib/identity/audit），
    // 与 auditEvent.beforeHash varchar(64) 一致；configDigest（sha256: 前缀 71 字符）只用于 configDigest 列。
    const beforeHash = computeContentHash(currentRevision.configJson);
    const afterHash = computeContentHash(newConfig);

    const revisionNo = await nextRevisionNo(tx, set.id);
    const revisionId = randomUUID();
    const publishedAt = new Date();

    // 1. 新建 published Revision。
    await tx.insert(governanceConfigRevisionTable).values({
      id: revisionId,
      configSetId: set.id,
      revisionNo,
      configJson: newConfig,
      configDigest,
      revisionState: "published",
      createdBy: actor.actorId,
      publishedAt,
    });

    // 2. 原子切换 currentRevisionId + versionNo + 1。
    await tx
      .update(governanceConfigSetTable)
      .set({ currentRevisionId: revisionId, versionNo: set.versionNo + 1, updatedAt: new Date() })
      .where(eq(governanceConfigSetTable.id, set.id));

    // 3. AuditEvent(governance.config.publish) —— 同事务（§32 / §35）。
    const auditEventId = randomUUID();
    await tx.insert(auditEvent).values({
      id: auditEventId,
      tenantId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actionType: "governance.config.publish",
      targetType: "governance_config",
      targetId: set.id,
      beforeHash,
      afterHash,
      reason: null,
      requestId,
      occurredAt: publishedAt,
    });

    const [updatedSet] = await tx
      .select()
      .from(governanceConfigSetTable)
      .where(eq(governanceConfigSetTable.id, set.id))
      .limit(1);
    if (!updatedSet) {
      throw new GovernancePublishError(`GovernanceConfigSet 读取失败: ${set.id}`);
    }
    const [revision] = await tx
      .select()
      .from(governanceConfigRevisionTable)
      .where(eq(governanceConfigRevisionTable.id, revisionId))
      .limit(1);
    if (!revision) {
      throw new GovernancePublishError(`GovernanceConfigRevision 读取失败: ${revisionId}`);
    }

    return { set: updatedSet, revision, configDigest, auditEventId };
  });
}
