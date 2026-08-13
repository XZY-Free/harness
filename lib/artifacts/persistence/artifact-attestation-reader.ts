import type { VerificationState } from "@/lib/artifacts/domain/artifact";
/**
 * ArtifactAttestation 只读查询。
 *
 * 从 artifact-attestation-queries.ts 拆出，职责：
 * - getAttestationById / listAttestationsByRevision / listAttestationsByDigest /
 * listAttestations / getVerifiedAttestationForRevision：纯读，不写事务。
 *
 * 事实源：docs/architecture/security.md -4.2、
 * docs/architecture/persistence.md 。
 */
import {
 type ArtifactAttestation,
 type AttestationRevocationRecord,
 artifact,
 artifactAttestation,
 attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

/**
 * Attestation 与其撤销记录的组合读取结果。
 *
 * 撤销事实的唯一 Authority 是 AttestationRevocationRecord：
 * revocation === null 即未撤销，不存在第二处撤销状态。
 */
export interface ArtifactAttestationWithRevocation {
 attestation: ArtifactAttestation;
 revocation: AttestationRevocationRecord | null;
}

// ─── 仓储：查询 ────────────────────────────────────────────

/** 按 id 获取 attestation（跨租户隔离）。不存在返回 null。 */
export async function getAttestationById(
 tenantId: string,
 attestationId: string,
): Promise<ArtifactAttestationWithRevocation | null> {
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
 return row ? { attestation: row.attestation, revocation: row.revocation } : null;
}

/** 按 revision 列出 attestation（按 createdAt 降序；跨租户隔离）。 */
export async function listAttestationsByRevision(
 tenantId: string,
 artifactType: string,
 artifactRevisionId: string,
 options?: { verificationState?: VerificationState },
): Promise<ArtifactAttestationWithRevocation[]> {
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
 return rows.map((row) => ({ attestation: row.attestation, revocation: row.revocation }));
}

/** 按 digest 列出 attestation（按 createdAt 降序；跨租户隔离）。 */
export async function listAttestationsByDigest(
 tenantId: string,
 artifactDigest: string,
): Promise<ArtifactAttestationWithRevocation[]> {
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
 return rows.map((row) => ({ attestation: row.attestation, revocation: row.revocation }));
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
): Promise<{ items: ArtifactAttestationWithRevocation[]; nextCursor: string | null }> {
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
 conditions.push(isNotNull(attestationRevocationRecord.id));
 } else if (options?.revoked === false) {
 conditions.push(isNull(attestationRevocationRecord.id));
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
 const items = selected.map((row) => ({
 attestation: row.attestation,
 revocation: row.revocation,
 }));
 const last = items[items.length - 1];
 const nextCursor =
 hasMore && last
 ? Buffer.from(
 JSON.stringify({
 created_at: last.attestation.createdAt.toISOString(),
 id: last.attestation.id,
 }),
 ).toString("base64url")
 : null;

 return { items, nextCursor };
}

/** 获取 revision 的最新 verified 且未撤销 attestation（用于发布门禁查询）。不存在返回 null。 */
export async function getVerifiedAttestationForRevision(
 tenantId: string,
 artifactType: string,
 artifactRevisionId: string,
): Promise<ArtifactAttestationWithRevocation | null> {
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
 ),
 )
 .orderBy(desc(artifactAttestation.createdAt))
 .limit(1);
 const row = list[0];
 return row ? { attestation: row.attestation, revocation: row.revocation } : null;
}

// ─── Type re-exports ───────────────────────────────────────

export type { ArtifactAttestation } from "@/lib/artifacts/persistence/artifact-record";
export type { VerificationState } from "@/lib/artifacts/domain/artifact";
