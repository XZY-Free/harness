import type { VerificationState } from "@/lib/artifacts/domain/artifact";
/**
 * ArtifactAttestation 只读查询。
 *
 * 从 artifact-attestation-queries.ts 拆出，职责：
 * - getAttestationById / listAttestationsByRevision / listAttestationsByDigest /
 *   listAttestations / getVerifiedAttestationForRevision：纯读，不写事务。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §4.1-4.2、
 *         ../v11-agentkit-platform/10-core-data-model.md §8.2。
 */
import {
  type ArtifactAttestation,
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";

// ─── 仓储：查询 ────────────────────────────────────────────

/** 按 id 获取 attestation（跨租户隔离）。不存在返回 null。 */
export async function getAttestationById(
  tenantId: string,
  attestationId: string,
): Promise<ArtifactAttestation | null> {
  const [row] = await db
    .select({ attestation: artifactAttestation, revocation: attestationRevocationRecord })
    .from(artifactAttestation)
    .leftJoin(
      attestationRevocationRecord,
      eq(attestationRevocationRecord.attestationId, artifactAttestation.id),
    )
    .where(
      and(eq(artifactAttestation.id, attestationId), eq(artifactAttestation.tenantId, tenantId)),
    )
    .limit(1);
  return row ? withEffectiveRevocation(row.attestation, row.revocation) : null;
}

/** 按 revision 列出 attestation（按 createdAt 降序；跨租户隔离）。 */
export async function listAttestationsByRevision(
  tenantId: string,
  artifactType: string,
  artifactRevisionId: string,
  options?: { verificationState?: VerificationState },
): Promise<ArtifactAttestation[]> {
  const conditions = [
    eq(artifactAttestation.tenantId, tenantId),
    eq(artifactAttestation.artifactType, artifactType),
    eq(artifactAttestation.artifactRevisionId, artifactRevisionId),
  ];
  if (options?.verificationState) {
    conditions.push(eq(artifactAttestation.verificationState, options.verificationState));
  }
  const rows = await db
    .select({ attestation: artifactAttestation, revocation: attestationRevocationRecord })
    .from(artifactAttestation)
    .leftJoin(
      attestationRevocationRecord,
      eq(attestationRevocationRecord.attestationId, artifactAttestation.id),
    )
    .where(and(...conditions))
    .orderBy(desc(artifactAttestation.createdAt));
  return rows.map((row) => withEffectiveRevocation(row.attestation, row.revocation));
}

/** 按 digest 列出 attestation（按 createdAt 降序；跨租户隔离）。 */
export async function listAttestationsByDigest(
  tenantId: string,
  artifactDigest: string,
): Promise<ArtifactAttestation[]> {
  const rows = await db
    .select({ attestation: artifactAttestation, revocation: attestationRevocationRecord })
    .from(artifactAttestation)
    .leftJoin(
      attestationRevocationRecord,
      eq(attestationRevocationRecord.attestationId, artifactAttestation.id),
    )
    .where(
      and(
        eq(artifactAttestation.tenantId, tenantId),
        eq(artifactAttestation.artifactDigest, artifactDigest),
      ),
    )
    .orderBy(desc(artifactAttestation.createdAt));
  return rows.map((row) => withEffectiveRevocation(row.attestation, row.revocation));
}

/** listAttestations 过滤选项。 */
export interface ListAttestationsOptions {
  artifactType?: string;
  artifactRevisionId?: string;
  artifactDigest?: string;
  verificationState?: VerificationState;
  /** true=仅未撤销；false=仅已撤销；undefined=全部。 */
  revoked?: boolean;
  limit?: number;
}

/** 列出租户内 attestation（按 createdAt 降序；跨租户隔离）。 */
export async function listAttestations(
  tenantId: string,
  options?: ListAttestationsOptions,
): Promise<{ items: ArtifactAttestation[]; nextCursor: string | null }> {
  const conditions = [eq(artifactAttestation.tenantId, tenantId)];
  if (options?.artifactType) {
    conditions.push(eq(artifactAttestation.artifactType, options.artifactType));
  }
  if (options?.artifactRevisionId) {
    conditions.push(eq(artifactAttestation.artifactRevisionId, options.artifactRevisionId));
  }
  if (options?.artifactDigest) {
    conditions.push(eq(artifactAttestation.artifactDigest, options.artifactDigest));
  }
  if (options?.verificationState) {
    conditions.push(eq(artifactAttestation.verificationState, options.verificationState));
  }
  if (options?.revoked === true) {
    const revokedCondition = or(
      isNotNull(attestationRevocationRecord.id),
      isNotNull(artifactAttestation.revokedAt),
    );
    if (revokedCondition) conditions.push(revokedCondition);
  } else if (options?.revoked === false) {
    const activeCondition = and(
      isNull(attestationRevocationRecord.id),
      isNull(artifactAttestation.revokedAt),
    );
    if (activeCondition) conditions.push(activeCondition);
  }

  const limit = options?.limit ?? 50;
  const fetchLimit = limit + 1;
  const rows = await db
    .select({ attestation: artifactAttestation, revocation: attestationRevocationRecord })
    .from(artifactAttestation)
    .leftJoin(
      attestationRevocationRecord,
      eq(attestationRevocationRecord.attestationId, artifactAttestation.id),
    )
    .where(and(...conditions))
    .orderBy(desc(artifactAttestation.createdAt))
    .limit(fetchLimit);

  const hasMore = rows.length > limit;
  const selected = hasMore ? rows.slice(0, limit) : rows;
  const items = selected.map((row) => withEffectiveRevocation(row.attestation, row.revocation));
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({ created_at: last.createdAt.toISOString(), id: last.id }),
        ).toString("base64url")
      : null;

  return { items, nextCursor };
}

/** 获取 revision 的最新 verified 且未撤销 attestation（用于发布门禁查询）。不存在返回 null。 */
export async function getVerifiedAttestationForRevision(
  tenantId: string,
  artifactType: string,
  artifactRevisionId: string,
): Promise<ArtifactAttestation | null> {
  const list = await db
    .select({ attestation: artifactAttestation, revocation: attestationRevocationRecord })
    .from(artifactAttestation)
    .innerJoin(artifact, eq(artifact.id, artifactAttestation.artifactId))
    .leftJoin(
      attestationRevocationRecord,
      eq(attestationRevocationRecord.attestationId, artifactAttestation.id),
    )
    .where(
      and(
        eq(artifactAttestation.tenantId, tenantId),
        eq(artifactAttestation.artifactType, artifactType),
        eq(artifactAttestation.artifactRevisionId, artifactRevisionId),
        eq(artifactAttestation.verificationState, "verified"),
        isNotNull(artifactAttestation.artifactId),
        eq(artifact.tenantId, tenantId),
        eq(artifact.digest, artifactAttestation.artifactDigest),
        isNull(attestationRevocationRecord.id),
        isNull(artifactAttestation.revokedAt),
      ),
    )
    .orderBy(desc(artifactAttestation.createdAt))
    .limit(1);
  const row = list[0];
  return row ? withEffectiveRevocation(row.attestation, row.revocation) : null;
}

function withEffectiveRevocation(
  attestation: ArtifactAttestation,
  revocation: typeof attestationRevocationRecord.$inferSelect | null,
): ArtifactAttestation {
  if (!revocation) return attestation;
  return {
    ...attestation,
    revokedAt: revocation.revokedAt,
    revokedBy: revocation.revokedBy,
    revocationReason: revocation.reason,
  };
}

// ─── Type re-exports ───────────────────────────────────────

export type { ArtifactAttestation } from "@/lib/artifacts/persistence/artifact-record";
export type { VerificationState } from "@/lib/artifacts/domain/artifact";
