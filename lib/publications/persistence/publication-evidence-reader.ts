/**
 * Publication Evidence Reader — 从数据库读取 Active Publication 快照。
 *
 * 所有模块必须通过此 Reader 读取发布事实，
 * 不得自行构造 SQL 查询判断 Publication 是否 Active。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §1.2
 */

import { db } from "@/lib/db/client";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import type { ActivePublicationSnapshot } from "@/lib/publications/domain/publication-eligibility";
import type { PublicationSubjectType } from "@/lib/publications/domain/publication-record";
import { and, desc, eq, isNull } from "drizzle-orm";

/**
 * 读取指定 Revision 的 Active Publication 快照。
 *
 * 条件：
 * - PublicationRecord 存在
 * - WithdrawalRecord 不存在（LEFT JOIN + IS NULL）
 * - tenantId 匹配
 *
 * 不存在或已撤回返回 null。
 */
export async function loadActivePublicationSnapshot(params: {
  tenantId: string;
  subjectType: PublicationSubjectType;
  subjectRevisionId: string;
}): Promise<ActivePublicationSnapshot | null> {
  const [row] = await db
    .select({
      pub: publicationRecord,
      wd: withdrawalRecord,
    })
    .from(publicationRecord)
    .leftJoin(
      withdrawalRecord,
      eq(withdrawalRecord.publicationRecordId, publicationRecord.id),
    )
    .where(
      and(
        eq(publicationRecord.tenantId, params.tenantId),
        eq(publicationRecord.subjectType, params.subjectType),
        eq(publicationRecord.subjectRevisionId, params.subjectRevisionId),
        isNull(withdrawalRecord.id),
      ),
    )
    .orderBy(desc(publicationRecord.publishedAt))
    .limit(1);

  if (!row) return null;

  return {
    publicationRecordId: row.pub.id,
    subjectType: row.pub.subjectType,
    subjectRevisionId: row.pub.subjectRevisionId,
    evidenceSetDigest: row.pub.evidenceSetDigest,
    attestationIds: row.pub.attestationIds,
    conformanceRunId: row.pub.conformanceRunId,
    withdrawalRecordId: null, // 已过滤无撤回记录
    publishedAt: row.pub.publishedAt,
  };
}

/**
 * 批量读取多个 Revision 的 Active Publication 快照。
 *
 * 返回 Map<revisionId, snapshot>，不存在或已撤回的不会出现在 Map 中。
 */
export async function loadActivePublicationSnapshots(params: {
  tenantId: string;
  revisions: Array<{ subjectType: PublicationSubjectType; subjectRevisionId: string }>;
}): Promise<Map<string, ActivePublicationSnapshot>> {
  const result = new Map<string, ActivePublicationSnapshot>();

  for (const rev of params.revisions) {
    const snapshot = await loadActivePublicationSnapshot({
      tenantId: params.tenantId,
      subjectType: rev.subjectType,
      subjectRevisionId: rev.subjectRevisionId,
    });
    if (snapshot) {
      result.set(rev.subjectRevisionId, snapshot);
    }
  }

  return result;
}
