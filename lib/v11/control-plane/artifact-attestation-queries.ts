/**
 * V11 ArtifactAttestation 仓储与发布门禁（S03-C03）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §4.1-4.2、
 *         ../v11-agentkit-platform/11-api-and-event-boundaries.md §6（artifact-attestations:verify）、
 *         ../v11-agentkit-platform/10-core-data-model.md §8.2、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W04。
 *
 * 职责：
 * - insertAttestation / getAttestationById / listAttestationsByRevision / listAttestationsByDigest /
 *   getVerifiedAttestationForRevision：数据访问。
 * - verifyAndPersistAttestation：完整验证流程（独立校验 + 持久化 + 审计）。
 *   - 调用 verifyArtifactAttestation 独立校验（调用方不能自报 verified）。
 *   - 无论成功失败都持久化 attestation 记录（verified 写 verifiedAt，failed 写 failureCode）。
 *   - 无论成功失败都写 AuditEvent（action_type=artifact.attestation.verify）。
 *   - 失败抛 ArtifactAttestationFailedError（含 failureCode），RouteSet 不变化。
 * - assertAttestationGate：发布门禁，校验 attestation 已 verified 且引用正确 revision。
 * - publishAgentRevisionWithAttestation：正式 Application Service 的兼容 Facade。
 * - publishRuntimeRevisionWithAttestation：Runtime 发布门禁 + 原发布流程 wrapper。
 *
 * 审计语义：
 * - 验证动作（无论成功失败）写 AuditEvent，action_type=artifact.attestation.verify。
 * - 发布动作（agent.publish / runtime implicit）写 AuditEvent。
 * - 失败原因摘要写入 audit.afterHash（不存原文），不泄露内部漏洞细节给无权调用者。
 */
import { randomUUID } from "node:crypto";
import {
  type PublishAgentRevisionResult,
  createPublishAgentRevision,
} from "@/lib/agents/application/publish-agent-revision";
import {
  AgentPublicationPrerequisiteError,
  AgentPublicationVersionConflictError,
  AgentRevisionPublicationNotFoundError,
  AgentRevisionPublicationStateError,
} from "@/lib/agents/domain/agent-revision-publication-policy";
import { db } from "@/lib/db/client";
import {
  AgentVersionConflictError,
  RevisionNotFoundError,
  RevisionStateError,
} from "@/lib/v11/control-plane/agent-revision-queries";
import {
  ArtifactAttestationFailedError,
  ArtifactNotVerifiedError,
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type VerifyAttestationInput,
  verifyArtifactAttestation,
} from "@/lib/v11/control-plane/artifact-attestation";
import { mysqlAgentPublicationStore } from "@/lib/v11/control-plane/mysql-agent-publication-store";
import type { ConformanceCaseResult } from "@/lib/v11/control-plane/runtime-conformance";
import { publishRuntimeRevision } from "@/lib/v11/control-plane/runtime-revision-queries";
import { type AuditActor, recordAuditEvent } from "@/lib/v11/identity/audit";
import type { V11AgentRevision } from "@/lib/v11/schema/agent";
import {
  type AttestationFailureCode,
  type V11ArtifactAttestation,
  type VerificationState,
  v11ArtifactAttestation,
} from "@/lib/v11/schema/artifact";
import type { V11RuntimeRevision } from "@/lib/v11/schema/runtime";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

// ─── 仓储：insertAttestation ───────────────────────────────

/** 插入 attestation 记录。 */
export async function insertAttestation(params: {
  tenantId: string;
  artifactType: string;
  artifactRevisionId: string;
  artifactDigest: string;
  signatureBundleRef: string;
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
}): Promise<V11ArtifactAttestation> {
  const id = randomUUID();
  await db.insert(v11ArtifactAttestation).values({
    id,
    tenantId: params.tenantId,
    artifactType: params.artifactType,
    artifactRevisionId: params.artifactRevisionId,
    artifactDigest: params.artifactDigest,
    signatureBundleRef: params.signatureBundleRef,
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
  const [row] = await db
    .select()
    .from(v11ArtifactAttestation)
    .where(eq(v11ArtifactAttestation.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`insertAttestation: 行未找到（id=${id}）`);
  }
  return row;
}

// ─── 仓储：查询 ────────────────────────────────────────────

/** 按 id 获取 attestation（跨租户隔离）。不存在返回 null。 */
export async function getAttestationById(
  tenantId: string,
  attestationId: string,
): Promise<V11ArtifactAttestation | null> {
  const [row] = await db
    .select()
    .from(v11ArtifactAttestation)
    .where(
      and(
        eq(v11ArtifactAttestation.id, attestationId),
        eq(v11ArtifactAttestation.tenantId, tenantId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 按 revision 列出 attestation（按 createdAt 降序；跨租户隔离）。 */
export async function listAttestationsByRevision(
  tenantId: string,
  artifactType: string,
  artifactRevisionId: string,
  options?: { verificationState?: VerificationState },
): Promise<V11ArtifactAttestation[]> {
  const conditions = [
    eq(v11ArtifactAttestation.tenantId, tenantId),
    eq(v11ArtifactAttestation.artifactType, artifactType),
    eq(v11ArtifactAttestation.artifactRevisionId, artifactRevisionId),
  ];
  if (options?.verificationState) {
    conditions.push(eq(v11ArtifactAttestation.verificationState, options.verificationState));
  }
  return db
    .select()
    .from(v11ArtifactAttestation)
    .where(and(...conditions))
    .orderBy(desc(v11ArtifactAttestation.createdAt));
}

/** 按 digest 列出 attestation（按 createdAt 降序；跨租户隔离）。 */
export async function listAttestationsByDigest(
  tenantId: string,
  artifactDigest: string,
): Promise<V11ArtifactAttestation[]> {
  return db
    .select()
    .from(v11ArtifactAttestation)
    .where(
      and(
        eq(v11ArtifactAttestation.tenantId, tenantId),
        eq(v11ArtifactAttestation.artifactDigest, artifactDigest),
      ),
    )
    .orderBy(desc(v11ArtifactAttestation.createdAt));
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
): Promise<{ items: V11ArtifactAttestation[]; nextCursor: string | null }> {
  const conditions = [eq(v11ArtifactAttestation.tenantId, tenantId)];
  if (options?.artifactType) {
    conditions.push(eq(v11ArtifactAttestation.artifactType, options.artifactType));
  }
  if (options?.artifactRevisionId) {
    conditions.push(eq(v11ArtifactAttestation.artifactRevisionId, options.artifactRevisionId));
  }
  if (options?.artifactDigest) {
    conditions.push(eq(v11ArtifactAttestation.artifactDigest, options.artifactDigest));
  }
  if (options?.verificationState) {
    conditions.push(eq(v11ArtifactAttestation.verificationState, options.verificationState));
  }
  if (options?.revoked === true) {
    conditions.push(isNotNull(v11ArtifactAttestation.revokedAt));
  } else if (options?.revoked === false) {
    conditions.push(isNull(v11ArtifactAttestation.revokedAt));
  }

  const limit = options?.limit ?? 50;
  const fetchLimit = limit + 1;
  const rows = await db
    .select()
    .from(v11ArtifactAttestation)
    .where(and(...conditions))
    .orderBy(desc(v11ArtifactAttestation.createdAt))
    .limit(fetchLimit);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
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
): Promise<V11ArtifactAttestation | null> {
  const list = await db
    .select()
    .from(v11ArtifactAttestation)
    .where(
      and(
        eq(v11ArtifactAttestation.tenantId, tenantId),
        eq(v11ArtifactAttestation.artifactType, artifactType),
        eq(v11ArtifactAttestation.artifactRevisionId, artifactRevisionId),
        eq(v11ArtifactAttestation.verificationState, "verified"),
        isNull(v11ArtifactAttestation.revokedAt),
      ),
    )
    .orderBy(desc(v11ArtifactAttestation.createdAt))
    .limit(1);
  return list[0] ?? null;
}

// ─── 完整验证流程：verifyAndPersistAttestation ─────────────

/**
 * 完整验证流程：独立校验 + 持久化 + 审计。
 *
 * 行为：
 * 1. 调用 verifyArtifactAttestation 独立校验（调用方不能自报 verified）。
 * 2. 无论成功失败都持久化 attestation 记录。
 *    - verified：写 verifiedAt = now，failureCode = null。
 *    - failed：写 verifiedAt = now，failureCode = 分类码。
 * 3. 无论成功失败都写 AuditEvent（action_type=artifact.attestation.verify）。
 *    - afterHash = 验证结果摘要的 hash（不存原文，不泄露内部漏洞细节）。
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
): Promise<V11ArtifactAttestation> {
  const result = await verifyArtifactAttestation(input, store, builderKeys);
  const now = new Date();

  // 持久化 attestation 记录（无论成功失败；成功时附带 provenance/scan 摘要）
  const attestation = await insertAttestation({
    tenantId: input.tenantId,
    artifactType: input.artifactType,
    artifactRevisionId: input.artifactRevisionId,
    artifactDigest: input.artifactDigest,
    signatureBundleRef: input.signatureBundleRef,
    sbomRef: input.sbomRef,
    provenanceRef: input.provenanceRef,
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
  });

  // 写 AuditEvent（无论成功失败；afterHash 是结果摘要的 hash，不存原文）
  const auditSummary = {
    attestation_id: attestation.id,
    artifact_type: input.artifactType,
    artifact_revision_id: input.artifactRevisionId,
    artifact_digest: input.artifactDigest,
    builder_identity: input.builderIdentity,
    verification_state: result.verificationState,
    failure_code: result.failureCode ?? null,
  };
  await recordAuditEvent({
    actor,
    actionType: "artifact.attestation.verify",
    targetType: "artifact_attestation",
    targetId: attestation.id,
    after: auditSummary,
    reason:
      result.verificationState === "verified"
        ? "制品证明验证通过"
        : (result.failureReason ?? "制品证明验证失败"),
    requestId,
    occurredAt: now,
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
): Promise<V11ArtifactAttestation> {
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
  return attestation;
}

// ─── 撤销：revokeAttestation ───────────────────────────────

/** Attestation 不存在或已撤销错误。 */
export class AttestationNotFoundError extends Error {
  constructor(
    public readonly attestationId: string,
    message: string,
  ) {
    super(message);
    this.name = "AttestationNotFoundError";
  }
}

/** Attestation 已撤销错误。 */
export class AttestationAlreadyRevokedError extends Error {
  constructor(
    public readonly attestationId: string,
    message: string,
  ) {
    super(message);
    this.name = "AttestationAlreadyRevokedError";
  }
}

/**
 * 撤销 attestation（S12-W04）。
 *
 * 行为：
 * 1. 校验 attestation 存在且属于当前租户。
 * 2. 校验未已撤销（幂等保护：已撤销抛错而非静默成功）。
 * 3. 设置 revokedAt / revokedBy / revocationReason。
 * 4. 写 AuditEvent（action_type=artifact.attestation.revoke）。
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
): Promise<V11ArtifactAttestation> {
  const attestation = await getAttestationById(tenantId, attestationId);
  if (!attestation) {
    throw new AttestationNotFoundError(
      attestationId,
      `attestation 不存在或跨租户: ${attestationId}`,
    );
  }
  if (attestation.revokedAt !== null) {
    throw new AttestationAlreadyRevokedError(
      attestationId,
      `attestation 已撤销（revokedAt=${attestation.revokedAt.toISOString()}）`,
    );
  }

  const now = new Date();
  await db
    .update(v11ArtifactAttestation)
    .set({
      revokedAt: now,
      revokedBy: actor.actorId,
      revocationReason: reason,
    })
    .where(eq(v11ArtifactAttestation.id, attestationId));

  const [updated] = await db
    .select()
    .from(v11ArtifactAttestation)
    .where(eq(v11ArtifactAttestation.id, attestationId))
    .limit(1);

  // 写 AuditEvent
  await recordAuditEvent({
    actor,
    actionType: "artifact.attestation.revoke",
    targetType: "artifact_attestation",
    targetId: attestationId,
    before: {
      artifact_type: attestation.artifactType,
      artifact_revision_id: attestation.artifactRevisionId,
      artifact_digest: attestation.artifactDigest,
      builder_identity: attestation.builderIdentity,
      verification_state: attestation.verificationState,
    },
    after: {
      revoked_at: now.toISOString(),
      revoked_by: actor.actorId,
      revocation_reason: reason,
    },
    reason,
    requestId,
    occurredAt: now,
  });

  return updated ?? attestation;
}

// ─── 发布门禁 + Agent 发布 wrapper ─────────────────────────

/** publishAgentRevisionWithAttestation 结果。 */
export interface PublishAgentRevisionWithAttestationResult {
  revision: V11AgentRevision;
  attestation: V11ArtifactAttestation;
  auditEventId: string;
}

const publishAgentRevisionApplication = createPublishAgentRevision({
  store: mysqlAgentPublicationStore,
});

export interface PublishAgentRevisionIdempotencyCompletion {
  recordId: string;
  idempotencyKey: string;
  httpStatus: number;
  responseRef?: string | null;
  serializeResponse: (result: PublishAgentRevisionResult) => string;
}

/**
 * AgentRevision 发布门禁 + 发布流程。
 *
 * 正式实现位于 lib/agents/application/publish-agent-revision.ts。本 Facade 保留旧签名和错误类型，
 * 由 Application Service 在单一事务内完成门禁、Revision、Agent 指针、Audit、Outbox 和 Idempotency。
 *
 * 失败时事务整体回滚；门禁失败继续抛 ArtifactNotVerifiedError 兼容旧调用方。
 *
 * @throws ArtifactNotVerifiedError attestation 不存在/未验证/引用不一致
 * @throws RevisionNotFoundError Revision 不存在（来自 publishRevision）
 * @throws RevisionStateError Revision 非 draft 状态（来自 publishRevision）
 * @throws AgentVersionConflictError Agent 乐观锁冲突（来自 publishRevision）
 */
export async function publishAgentRevisionWithAttestation(
  tenantId: string,
  revisionId: string,
  agentExpectedVersionNo: number,
  attestationId: string,
  actor: AuditActor,
  requestId?: string,
  idempotency?: PublishAgentRevisionIdempotencyCompletion,
): Promise<PublishAgentRevisionWithAttestationResult> {
  const effectiveRequestId = requestId ?? randomUUID();
  try {
    const result = await publishAgentRevisionApplication({
      tenantId,
      revisionId,
      agentExpectedVersionNo,
      attestationId,
      actor,
      requestId: effectiveRequestId,
      idempotencyKey: idempotency?.idempotencyKey ?? `compat:${effectiveRequestId}`,
      idempotency,
    });
    return {
      revision: result.revision as V11AgentRevision,
      attestation: result.attestation as V11ArtifactAttestation,
      auditEventId: result.auditEventId,
    };
  } catch (error) {
    if (error instanceof AgentPublicationPrerequisiteError) {
      throw new ArtifactNotVerifiedError(error.attestationId, error.message);
    }
    if (error instanceof AgentPublicationVersionConflictError) {
      throw new AgentVersionConflictError(error.agentId, error.expectedVersionNo);
    }
    if (error instanceof AgentRevisionPublicationNotFoundError) {
      throw new RevisionNotFoundError(error.revisionId);
    }
    if (error instanceof AgentRevisionPublicationStateError) {
      throw new RevisionStateError(error.revisionId, error.fromState, "published", error.message);
    }
    throw error;
  }
}

// ─── 发布门禁 + Runtime 发布 wrapper ───────────────────────

/** publishRuntimeRevisionWithAttestation 结果。 */
export interface PublishRuntimeRevisionWithAttestationResult {
  revision: V11RuntimeRevision;
  attestation: V11ArtifactAttestation;
  auditEventId: string;
}

/**
 * RuntimeRevision 发布门禁 + 发布流程（attestation + conformance 双门禁）。
 *
 * 步骤：
 * 1. assertAttestationGate：校验 attestation 已 verified 且引用正确 revision。
 * 2. publishRuntimeRevision：执行原发布流程（conformance 门禁 + draft → published + 回填 Runtime.currentRevisionId）。
 * 3. 写 AuditEvent（action_type=runtime.publish，targetType=runtime_revision）。
 *    S11-W02 已新增 runtime.publish actionType，原过渡方案写 route.update 已替换。
 *
 * 失败时（门禁失败或发布失败）不写发布审计；门禁失败抛 ArtifactNotVerifiedError。
 *
 * @throws ArtifactNotVerifiedError attestation 不存在/未验证/引用不一致
 * @throws RuntimeRevisionNotFoundError Revision 不存在（来自 publishRuntimeRevision）
 * @throws RuntimeRevisionStateError Revision 非 draft 状态（来自 publishRuntimeRevision）
 * @throws ConformanceGateError conformance 门禁失败（来自 publishRuntimeRevision）
 * @throws RuntimeVersionConflictError Runtime 乐观锁冲突（来自 publishRuntimeRevision）
 */
export async function publishRuntimeRevisionWithAttestation(
  tenantId: string,
  revisionId: string,
  runtimeExpectedVersionNo: number,
  conformanceResults: ConformanceCaseResult[],
  attestationId: string,
  actor: AuditActor,
  requestId?: string,
): Promise<PublishRuntimeRevisionWithAttestationResult> {
  // 1. attestation 发布门禁
  const attestation = await assertAttestationGate(
    tenantId,
    "runtime_revision",
    revisionId,
    attestationId,
  );

  // 2. 执行原发布流程（含 conformance 门禁）
  const revision = await publishRuntimeRevision(
    tenantId,
    revisionId,
    runtimeExpectedVersionNo,
    conformanceResults,
  );

  // 3. 写 AuditEvent（runtime.publish：S11-W02 细化，原过渡方案写 route.update）
  const auditEvent = await recordAuditEvent({
    actor,
    actionType: "runtime.publish",
    targetType: "runtime_revision",
    targetId: revisionId,
    after: {
      runtime_id: revision.runtimeId,
      revision_no: revision.revisionNo,
      revision_state: revision.revisionState,
      attestation_id: attestationId,
      artifact_digest: attestation.artifactDigest,
    },
    reason: "RuntimeRevision 发布（attestation + conformance 双门禁通过）",
    requestId,
  });

  return {
    revision,
    attestation,
    auditEventId: auditEvent.id,
  };
}

// ─── Re-exports ────────────────────────────────────────────

export type { V11ArtifactAttestation } from "@/lib/v11/schema/artifact";
export type {
  AttestationFailureCode,
  VerificationState,
} from "@/lib/v11/schema/artifact";
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
} from "@/lib/v11/control-plane/artifact-attestation";
