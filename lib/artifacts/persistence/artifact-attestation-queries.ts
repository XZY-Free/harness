/**
 * ArtifactAttestation 仓储与发布门禁。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md -4.2、
 * ../v11-agentkit-platform/11-api-and-event-boundaries.md §6（artifact-attestations:verify）、
 * ../v11-agentkit-platform/10-core-data-model.md 、
 * ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md 。
 *
 * 职责：
 * - insertAttestation：数据写入。
 * - verifyAndPersistAttestation：委托 Artifact 应用服务持久化。
 * - 调用 verifyArtifactAttestation 独立校验（调用方不能自报 verified）。
 * - 无论成功失败都持久化 attestation 记录（verified 写 verifiedAt，failed 写 failureCode）。
 * - 无论成功失败都写 AuditEvent（action_type=artifact.attestation.verify）。
 * - 失败抛 ArtifactAttestationFailedError（含 failureCode），RouteSet 不变化。
 * - assertAttestationGate：发布门禁，校验 attestation 已 verified 且引用正确 revision。
 * - revokeAttestation：撤销 attestation（S12-W04）。
 *
 * 只读查询已拆至 artifact-attestation-reader.ts；本模块 re-export 以保持向后兼容。
 *
 * 审计语义：
 * - 验证动作（无论成功失败）写 AuditEvent，action_type=artifact.attestation.verify。
 * - 发布动作（agent.publish / runtime implicit）写 AuditEvent。
 * - 失败原因摘要写入 audit.afterHash（不存原文），不泄露内部漏洞细节给无权调用者。
 */
import { randomUUID } from "node:crypto";
import { createRecordArtifactAttestation } from "@/lib/artifacts/application/record-artifact-attestation";
import {
 AttestationAlreadyRevokedError,
 AttestationNotFoundError,
 createRevokeArtifactAttestation,
} from "@/lib/artifacts/application/revoke-artifact-attestation";
import { type VerificationState, isSha256Digest } from "@/lib/artifacts/domain/artifact";
import {
 ArtifactAttestationFailedError,
 ArtifactNotVerifiedError,
 type AttestationFailureCode,
 type BuilderKeyRegistry,
 type ManagedArtifactStore,
 type VerifyAttestationInput,
 verifyArtifactAttestation,
} from "@/lib/artifacts/domain/artifact-attestation";
import {
 getAttestationById,
 getVerifiedAttestationForRevision,
 listAttestations,
 listAttestationsByDigest,
 listAttestationsByRevision,
} from "@/lib/artifacts/persistence/artifact-attestation-reader";
import type { ListAttestationsOptions } from "@/lib/artifacts/persistence/artifact-attestation-reader";
import {
 type ArtifactAttestation,
 artifact,
 artifactAttestation,
 type attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import {
 mysqlArtifactAttestationPersistenceStore,
 mysqlAttestationRevocationStore,
} from "@/lib/artifacts/persistence/mysql-artifact-attestation-store";
import { db } from "@/lib/db/client";
import type { AuditActor } from "@/lib/identity/audit";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

const recordArtifactAttestation = createRecordArtifactAttestation({
 store: mysqlArtifactAttestationPersistenceStore,
});
const revokeArtifactAttestation = createRevokeArtifactAttestation({
 store: mysqlAttestationRevocationStore,
});

// ─── 仓储：insertAttestation ───────────────────────────────

/** 插入 attestation 记录。 */
export async function insertAttestation(params: {
 tenantId: string;
 artifactType: string;
 artifactRevisionId: string;
 artifactDigest: string;
 dsseEnvelopeRef: string;
 sbomRef: string;
 provenanceRef: string;
 builderIdentity: string;
 verificationState: VerificationState;
 policyRevisionId?: string | null;
 failureCode?: string | null;
 verifiedAt?: Date | null;
 sourceRevision?: string | null;
 buildPipeline?: string | null;
 dependencyLockFileHash?: string | null;
 buildTime?: Date | null;
 scanSummaryJson?: Record<string, unknown> | null;
}): Promise<ArtifactAttestation> {
 const id = randomUUID();
 return db.transaction(async (tx) => {
 let authorityId: string | null = null;
 if (isSha256Digest(params.artifactDigest)) {
 const [existing] = await tx
 .select()
 .from(artifact)
 .where(
 and(eq(artifact.tenantId, params.tenantId), eq(artifact.digest, params.artifactDigest)),
 )
 .limit(1);
 if (existing) {
 authorityId = existing.id;
 } else {
 authorityId = randomUUID();
 await tx.insert(artifact).values({
 id: authorityId,
 tenantId: params.tenantId,
 kind: params.artifactType as typeof artifact.$inferInsert.kind,
 digest: params.artifactDigest,
 sourceRevision: params.sourceRevision ?? null,
 buildMetadata: null,
 createdAt: params.verifiedAt ?? new Date(),
 });
 }
 }
 await tx.insert(artifactAttestation).values({
 id,
 tenantId: params.tenantId,
 artifactId: authorityId,
 artifactType: params.artifactType,
 artifactRevisionId: params.artifactRevisionId,
 artifactDigest: params.artifactDigest,
 dsseEnvelopeRef: params.dsseEnvelopeRef,
 sbomRef: params.sbomRef,
 provenanceRef: params.provenanceRef,
 builderIdentity: params.builderIdentity,
 verificationState: params.verificationState,
 policyRevisionId: params.policyRevisionId ?? null,
 failureCode: params.failureCode ?? null,
 verifiedAt: params.verifiedAt ?? null,
 sourceRevision: params.sourceRevision ?? null,
 buildPipeline: params.buildPipeline ?? null,
 dependencyLockFileHash: params.dependencyLockFileHash ?? null,
 buildTime: params.buildTime ?? null,
 scanSummaryJson: params.scanSummaryJson ?? null,
 });
 const [row] = await tx
 .select()
 .from(artifactAttestation)
 .where(eq(artifactAttestation.id, id))
 .limit(1);
 if (!row) throw new Error(`insertAttestation: 行未找到（id=${id}）`);
 return row;
 });
}

// ─── 完整验证流程：verifyAndPersistAttestation ─────────────

/**
 * 完整验证流程：独立校验 + 持久化 + 审计。
 *
 * 行为：
 * 1. 调用 verifyArtifactAttestation 独立校验（调用方不能自报 verified）。
 * 2. 无论成功失败都持久化 attestation 记录。
 * - verified：写 verifiedAt = now，failureCode = null。
 * - failed：写 verifiedAt = now，failureCode = 分类码。
 * 3. 无论成功失败都写 AuditEvent（action_type=artifact.attestation.verify）。
 * - afterHash = 验证结果摘要的 hash（不存原文，不泄露内部漏洞细节）。
 * 4. 失败时抛 ArtifactAttestationFailedError（含 failureCode），RouteSet 不变化。
 *
 * @throws ArtifactAttestationFailedError 验证失败（已持久化失败记录与审计）
 */
export async function verifyAndPersistAttestation(
 input: VerifyAttestationInput,
 store: ManagedArtifactStore,
 builderKeys: BuilderKeyRegistry,
 actor: AuditActor,
 requestId?: string,
 idempotency?: {
 recordId: string;
 httpStatus: number | ((verificationState: VerificationState) => number);
 responseRef?: string | null;
 serializeResponse: (attestation: ArtifactAttestation) => string;
 },
): Promise<ArtifactAttestation> {
 const result = await verifyArtifactAttestation(input, store, builderKeys);
 const now = new Date();

 const attestation = await recordArtifactAttestation({
 tenantId: input.tenantId,
 artifactType: input.artifactType,
 artifactRevisionId: input.artifactRevisionId,
 artifactDigest: input.artifactDigest,
 dsseEnvelopeRef: input.dsseEnvelopeRef,
 sbomRef: result.sbomRef ?? "",
 provenanceRef: result.provenanceRef ?? "",
 builderIdentity: input.builderIdentity,
 verificationState: result.verificationState,
 policyRevisionId: input.policyRevisionId ?? null,
 failureCode: result.failureCode ?? null,
 verifiedAt: now,
 sourceRevision: result.provenanceSummary?.sourceRevision ?? null,
 buildPipeline: result.provenanceSummary?.buildPipeline ?? null,
 dependencyLockFileHash: result.provenanceSummary?.dependencyLockFile ?? null,
 buildTime: result.provenanceSummary ? new Date(result.provenanceSummary.buildTime) : null,
 scanSummaryJson: result.scanSummary ?? null,
 actor,
 requestId: requestId ?? randomUUID(),
 idempotency: idempotency
 ? {
 ...idempotency,
 httpStatus:
 typeof idempotency.httpStatus === "function"
 ? idempotency.httpStatus(result.verificationState)
 : idempotency.httpStatus,
 }
 : undefined,
 });

 // 失败时抛错（已持久化失败记录与审计）
 if (result.verificationState === "failed") {
 throw new ArtifactAttestationFailedError(
 result.failureCode as AttestationFailureCode,
 result.failureReason ?? "制品证明验证失败",
 );
 }

 return attestation;
}

// ─── 发布门禁：assertAttestationGate ───────────────────────

/**
 * 发布门禁：校验 attestation 已 verified 且引用正确 revision。
 *
 * 校验：
 * 1. attestation 存在且属于当前租户。
 * 2. verificationState = verified。
 * 3. artifactType 与期望一致。
 * 4. artifactRevisionId 与期望 revisionId 一致。
 *
 * @throws ArtifactNotVerifiedError 任一校验失败
 */
export async function assertAttestationGate(
 tenantId: string,
 expectedArtifactType: string,
 expectedRevisionId: string,
 attestationId: string,
): Promise<ArtifactAttestation> {
 const attestation = await getAttestationById(tenantId, attestationId);
 if (!attestation) {
 throw new ArtifactNotVerifiedError(
 attestationId,
 `attestation 不存在或跨租户: ${attestationId}`,
 );
 }
 if (attestation.verificationState !== "verified") {
 throw new ArtifactNotVerifiedError(
 attestationId,
 `attestation 未验证（state=${attestation.verificationState}, failureCode=${attestation.failureCode ?? "n/a"}）`,
 );
 }
 if (attestation.revokedAt !== null) {
 throw new ArtifactNotVerifiedError(
 attestationId,
 `attestation 已撤销（revokedAt=${attestation.revokedAt.toISOString()}, reason=${attestation.revocationReason ?? "n/a"}）`,
 );
 }
 if (attestation.artifactType !== expectedArtifactType) {
 throw new ArtifactNotVerifiedError(
 attestationId,
 `attestation artifactType 不匹配（期望 ${expectedArtifactType}, 实际 ${attestation.artifactType}）`,
 );
 }
 if (attestation.artifactRevisionId !== expectedRevisionId) {
 throw new ArtifactNotVerifiedError(
 attestationId,
 `attestation artifactRevisionId 不匹配（期望 ${expectedRevisionId}, 实际 ${attestation.artifactRevisionId}）`,
 );
 }
 if (!attestation.artifactId) {
 throw new ArtifactNotVerifiedError(attestationId, "attestation 未引用权威 Artifact");
 }
 const [authority] = await db
 .select({ id: artifact.id })
 .from(artifact)
 .where(
 and(
 eq(artifact.id, attestation.artifactId),
 eq(artifact.tenantId, tenantId),
 eq(artifact.digest, attestation.artifactDigest),
 ),
 )
 .limit(1);
 if (!authority) {
 throw new ArtifactNotVerifiedError(
 attestationId,
 "attestation 的 Artifact ID 与 digest 不一致",
 );
 }
 return attestation;
}

// ─── 撤销：revokeAttestation ───────────────────────────────

/**
 * 撤销 attestation（S12-W04）。
 *
 * 行为：
 * 1. 校验 attestation 存在且属于当前租户。
 * 2. 校验未已撤销（幂等保护：已撤销抛错而非静默成功）。
 * 3. 追加 AttestationRevocationRecord，不改写原 Attestation。
 * 4. 在同一事务写 AuditEvent 与 Outbox。
 *
 * 撤销后：
 * - getVerifiedAttestationForRevision 不再返回此 attestation。
 * - assertAttestationGate 拒绝已撤销 attestation。
 * - 新 Invocation / 发布 / 路由引用被阻止。
 *
 * @throws AttestationNotFoundError 不存在或跨租户
 * @throws AttestationAlreadyRevokedError 已撤销
 */
export async function revokeAttestation(
 tenantId: string,
 attestationId: string,
 actor: AuditActor,
 reason: string,
 requestId?: string,
): Promise<ArtifactAttestation> {
 const result = await revokeArtifactAttestation({
 tenantId,
 attestationId,
 actor,
 reason,
 requestId: requestId ?? randomUUID(),
 });
 return withEffectiveRevocation(result.attestation, result.revocation);
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

// ─── Re-exports ────────────────────────────────────────────

export {
 getAttestationById,
 listAttestationsByRevision,
 listAttestationsByDigest,
 listAttestations,
 getVerifiedAttestationForRevision,
} from "@/lib/artifacts/persistence/artifact-attestation-reader";
export type { ListAttestationsOptions } from "@/lib/artifacts/persistence/artifact-attestation-reader";

export type { ArtifactAttestation } from "@/lib/artifacts/persistence/artifact-record";
export { AttestationAlreadyRevokedError, AttestationNotFoundError };
export type { VerificationState } from "@/lib/artifacts/domain/artifact";
export type { AttestationFailureCode } from "@/lib/artifacts/domain/artifact-attestation";
export {
 ArtifactAttestationFailedError,
 ArtifactNotVerifiedError,
 type BuilderKeyRegistry,
 type ManagedArtifactStore,
 type VerifyAttestationInput,
 type VerifyAttestationResult,
 computeArtifactDigest,
 isManagedRef,
 isValidArtifactDigest,
 verifyArtifactAttestation,
} from "@/lib/artifacts/domain/artifact-attestation";
