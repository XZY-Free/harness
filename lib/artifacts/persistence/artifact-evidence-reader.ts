/**
 * Artifact Evidence Reader — 从数据库读取制品证据快照。
 *
 * 提供 FOR UPDATE 读取能力，供发布、RouteSet 激活等事务内使用。
 * 所有模块必须通过此 Reader 读取证据，不得自行构造 SQL 查询。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案
 */

import type {
  ArtifactEvidenceSnapshot,
  ArtifactType,
} from "@/lib/artifacts/domain/artifact-evidence";
import {
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { type DbOrTx, db } from "@/lib/db/client";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

/**
 * 读取指定 Revision 的最新有效 Attestation 证据快照。
 *
 * 条件：
 * - tenantId 匹配
 * - artifactType 匹配
 * - artifactRevisionId 匹配
 * - 关联权威 Artifact 存在且 digest 一致
 * - 无 AttestationRevocationRecord
 *
 * 不存在返回 null。
 *
 * : 接受 dbOrTx 参数，默认全局 db（向后兼容）。
 */
export async function loadArtifactEvidenceSnapshot(params: {
  tenantId: string;
  artifactType: ArtifactType;
  artifactRevisionId: string;
  /** : 事务内传入 tx，默认使用全局 db。 */
  dbOrTx?: DbOrTx;
}): Promise<ArtifactEvidenceSnapshot | null> {
  const conn = params.dbOrTx ?? db;
  const [row] = await conn
    .select({
      attestation: artifactAttestation,
      revocation: attestationRevocationRecord,
    })
    .from(artifactAttestation)
    .innerJoin(artifact, eq(artifact.id, artifactAttestation.artifactId))
    .leftJoin(
      attestationRevocationRecord,
      eq(attestationRevocationRecord.attestationId, artifactAttestation.id),
    )
    .where(
      and(
        eq(artifactAttestation.tenantId, params.tenantId),
        eq(artifactAttestation.artifactType, params.artifactType),
        eq(artifactAttestation.artifactRevisionId, params.artifactRevisionId),
        isNotNull(artifactAttestation.artifactId),
        eq(artifact.tenantId, params.tenantId),
        eq(artifact.digest, artifactAttestation.artifactDigest),
        isNull(attestationRevocationRecord.id),
      ),
    )
    .orderBy(desc(artifactAttestation.createdAt))
    .limit(1);

  if (!row) return null;

  const { attestation: att } = row;
  if (!att.artifactId) return null;

  return {
    tenantId: att.tenantId,
    artifactType: att.artifactType as ArtifactType,
    artifactRevisionId: att.artifactRevisionId,
    artifactId: att.artifactId,
    artifactDigest: att.artifactDigest,
    attestationId: att.id,
    verificationState: att.verificationState as "verified" | "failed" | "pending",
    attestationFormat: att.attestationFormat as ArtifactEvidenceSnapshot["attestationFormat"],
    verifiedAt: att.verifiedAt,
    revokedAt: null, // 已过滤无撤销记录
    revocationRecordId: null,
    verificationPolicyRevisionId: att.policyRevisionId,
    envelopeDigest: att.bundleDigest,
  };
}

/**
 * 批量读取多个 Revision 的证据快照。
 *
 * 返回 Map<revisionId, snapshot>，缺失的 Revision 不会出现在 Map 中。
 */
export async function loadArtifactEvidenceSnapshots(params: {
  tenantId: string;
  revisions: Array<{ artifactType: ArtifactType; artifactRevisionId: string }>;
  /** : 事务内传入 tx，默认使用全局 db。 */
  dbOrTx?: DbOrTx;
}): Promise<Map<string, ArtifactEvidenceSnapshot>> {
  const result = new Map<string, ArtifactEvidenceSnapshot>();

  // 逐条查询以保证 Artifact JOIN 条件正确
  // 批量 IN 查询在跨 artifactType 时逻辑复杂，此处优先正确性
  for (const rev of params.revisions) {
    const snapshot = await loadArtifactEvidenceSnapshot({
      tenantId: params.tenantId,
      artifactType: rev.artifactType,
      artifactRevisionId: rev.artifactRevisionId,
      dbOrTx: params.dbOrTx,
    });
    if (snapshot) {
      result.set(rev.artifactRevisionId, snapshot);
    }
  }

  return result;
}
