import { randomUUID } from "node:crypto";
import { computePublicationEvidenceSetDigest } from "@/lib/publications/domain/publication-record";
import {
  type PublicationConformanceCaseId,
  validateCompletePublicationConformanceResult,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  ArtifactEvidencePolicy,
  RuntimeArtifactAttestationInvalidError,
  RuntimeArtifactAttestationRequiredError,
  RuntimeConformanceCaseFailedError,
  RuntimeConformanceRunInvalidError,
  RuntimeConformanceRunRequiredError,
  RuntimePublicationIdempotencyCompletionError,
  RuntimePublicationVersionConflictError,
  RuntimeRevisionNotFoundError,
  RuntimeRevisionStateError,
} from "@/lib/runtime/domain/runtime-revision-publication-policy";
import type {
  RuntimePublicationActorType,
  RuntimePublicationAttestation,
  RuntimePublicationStore,
} from "@/lib/runtime/persistence/runtime-publication-store";

export interface PublishRuntimeRevisionResult {
  revision: {
    id: string;
    runtimeId: string;
    revisionNo: number;
    revisionState: string;
    runtimeEvidenceKind: "hosted_artifact" | "external_endpoint";
    runtimeTargetDigest: string;
    runtimeArtifactRef: string | null;
    artifactDigest: string | null;
    configHash: string;
    protocolContractRevision: string;
    publishedAt: Date | null;
  };
  /** 可选 Attestation；hosted_artifact 必填，external_endpoint 必须为 null（03 §3/§4）。 */
  attestation: RuntimePublicationAttestation | null;
  conformanceResults: Array<{
    caseId: string;
    passed: boolean;
    reason: string | null;
    adapterDigest: string | null;
    testEnvironment: string | null;
    evidenceRef: string | null;
    testedAt: Date;
  }>;
  publicationRecordId: string;
  auditEventId: string;
  outboxEventId: string;
}

export interface PublishRuntimeRevisionCommand {
  tenantId: string;
  revisionId: string;
  runtimeExpectedVersionNo: number;
  /** 必填：已完成且与 Revision 绑定一致的 ConformanceRun。 */
  conformanceRunId: string;
  /**
   * hosted_artifact 必填：验证通过且与 Revision/Artifact 绑定一致的 ArtifactAttestation。
   * external_endpoint 必须为空（外部运行时不伪造 Runtime Artifact — 03 §4）。
   */
  attestationId?: string | null;
  actor: {
    tenantId: string;
    actorType: RuntimePublicationActorType;
    actorId: string;
  };
  requestId: string;
  idempotencyKey: string;
  idempotency?: {
    recordId: string;
    httpStatus: number;
    responseRef?: string | null;
    serializeResponse: (result: PublishRuntimeRevisionResult) => string;
  };
}

export function createPublishRuntimeRevision(dependencies: {
  store: RuntimePublicationStore;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;

  return async function publishRuntimeRevision(
    command: PublishRuntimeRevisionCommand,
  ): Promise<PublishRuntimeRevisionResult> {
    // 1. 校验 actor tenant
    if (command.actor.tenantId !== command.tenantId) {
      throw new Error("RuntimeRevision 发布 actor tenant 与命令 tenant 不一致");
    }

    // 2. 校验必填证明（类型已保证非空，此处显式防御）
    if (!command.conformanceRunId) {
      throw new RuntimeConformanceRunRequiredError(command.revisionId);
    }

    return dependencies.store.transaction(async (session) => {
      // 4. FOR UPDATE 读取 Revision
      const revision = await session.findRevision(command.tenantId, command.revisionId);
      if (!revision) throw new RuntimeRevisionNotFoundError(command.revisionId);

      // 5. 校验 draft 状态
      if (revision.revisionState !== "draft") {
        throw new RuntimeRevisionStateError(
          revision.id,
          revision.revisionState,
          "published",
          "只有 draft 状态可发布",
        );
      }

      // 6. FOR UPDATE 读取 Runtime
      const runtime = await session.findRuntime(command.tenantId, revision.runtimeId);
      if (!runtime || runtime.versionNo !== command.runtimeExpectedVersionNo) {
        throw new RuntimePublicationVersionConflictError(
          revision.runtimeId,
          command.runtimeExpectedVersionNo,
        );
      }

      // 7. 按 runtimeEvidenceKind 分派证据门禁（03 §3/§4：Hosted 不降级，External 不伪造）
      let attestation: RuntimePublicationAttestation | null = null;
      let attestationIds: string[] = [];
      if (revision.runtimeEvidenceKind === "hosted_artifact") {
        if (!command.attestationId) {
          throw new RuntimeArtifactAttestationRequiredError(command.revisionId);
        }
        if (!revision.artifactId || !revision.artifactDigest || !revision.runtimeArtifactRef) {
          throw new RuntimeArtifactAttestationInvalidError(
            revision.id,
            command.attestationId,
            "hosted_artifact 证据不完整：Revision 缺少 artifact 绑定",
          );
        }
        const found = await session.findVerifiedAttestation({
          tenantId: command.tenantId,
          revisionId: revision.id,
          attestationId: command.attestationId,
        });
        if (!found) {
          throw new RuntimeArtifactAttestationInvalidError(
            revision.id,
            command.attestationId,
            "Attestation 不存在、不可用或已撤销",
          );
        }
        const evidenceResult = ArtifactEvidencePolicy.validateForPublication(found, {
          expectedTenantId: revision.tenantId,
          expectedArtifactType: "runtime_revision",
          expectedRevisionId: revision.id,
          expectedDigest: revision.artifactDigest,
        });
        if (!evidenceResult.valid) {
          throw new RuntimeArtifactAttestationInvalidError(
            revision.id,
            found.attestationId,
            evidenceResult.errors.map((e) => e.message).join("; "),
          );
        }
        attestation = found;
        attestationIds = [found.attestationId];
      } else if (command.attestationId) {
        throw new RuntimeArtifactAttestationInvalidError(
          revision.id,
          command.attestationId,
          "external_endpoint 证据不允许携带 Artifact Attestation（不得伪造 Runtime Artifact）",
        );
      }

      // 10-14. FOR UPDATE 读取 ConformanceRun，校验绑定一致性和 Case 完整性
      const conformanceRun = await session.findPassedConformanceRun({
        tenantId: command.tenantId,
        revisionId: revision.id,
        conformanceRunId: command.conformanceRunId,
      });
      if (!conformanceRun) {
        throw new RuntimeConformanceRunInvalidError(
          revision.id,
          command.conformanceRunId,
          "ConformanceRun 不存在或未通过",
        );
      }

      // 11-13. 校验 Run 与 Revision 的绑定一致（被测对象统一为 runtimeTargetDigest — 03 §6）
      if (conformanceRun.runtimeTargetDigest !== revision.runtimeTargetDigest) {
        throw new RuntimeConformanceRunInvalidError(
          revision.id,
          conformanceRun.id,
          `Runtime Target Digest 不一致（Run: ${conformanceRun.runtimeTargetDigest}, Revision: ${revision.runtimeTargetDigest}）`,
        );
      }
      if (conformanceRun.runtimeConfigDigest !== revision.configHash) {
        throw new RuntimeConformanceRunInvalidError(
          revision.id,
          conformanceRun.id,
          `Config Digest 不一致（Run: ${conformanceRun.runtimeConfigDigest}, Revision: ${revision.configHash}）`,
        );
      }
      if (conformanceRun.protocolContractRevision !== revision.protocolContractRevision) {
        throw new RuntimeConformanceRunInvalidError(
          revision.id,
          conformanceRun.id,
          `Protocol Contract Revision 不一致（Run: ${conformanceRun.protocolContractRevision}, Revision: ${revision.protocolContractRevision}）`,
        );
      }

      // 14. 校验 Case 完整性和全部通过
      const caseValidation = validateCompletePublicationConformanceResult(conformanceRun.results);
      if (!caseValidation.valid) {
        throw new RuntimeConformanceCaseFailedError(
          conformanceRun.results
            .filter((r) => !r.passed)
            .map((r) => r.caseId as PublicationConformanceCaseId),
        );
      }

      const publishedAt = now();
      const conformanceResults = conformanceRun.results;

      // 15. 创建 PublicationRecord（hosted: attestationIds 非空；external: 空数组 + target digest 附加证据）
      const publicationRecordId = newId();
      await session.appendPublication({
        id: publicationRecordId,
        tenantId: command.tenantId,
        revisionId: revision.id,
        evidenceSetDigest: computePublicationEvidenceSetDigest({
          attestationIds,
          conformanceRunId: conformanceRun.id,
          approvals: [],
          additionalEvidence: {
            evidenceManifestDigest: conformanceRun.evidenceManifestDigest,
            runtime_target_digest: revision.runtimeTargetDigest,
            runtime_evidence_kind: revision.runtimeEvidenceKind,
          },
        }),
        attestationIds,
        publishedByType: command.actor.actorType,
        publishedBy: command.actor.actorId,
        publishedAt,
        idempotencyKey: command.idempotencyKey,
        idempotencyRecordId: command.idempotency?.recordId ?? null,
        conformanceRunId: conformanceRun.id,
      });

      // 16. CAS 更新 Revision 为 published
      if (!(await session.markRevisionPublished(revision.id, publishedAt))) {
        throw new RuntimeRevisionStateError(
          revision.id,
          revision.revisionState,
          "published",
          "Revision 已被并发发布或状态已变化",
        );
      }

      // 17. CAS 更新 Runtime 指针 + 发布原子启用（draft→enabled，与 Agent 发布同一模式）
      if (
        !(await session.setRuntimeCurrentRevision({
          tenantId: command.tenantId,
          runtimeId: revision.runtimeId,
          revisionId: revision.id,
          expectedVersionNo: command.runtimeExpectedVersionNo,
          updatedAt: publishedAt,
          enableIfDraft: true,
        }))
      ) {
        throw new RuntimePublicationVersionConflictError(
          revision.runtimeId,
          command.runtimeExpectedVersionNo,
        );
      }

      // 18. 写 Audit
      const auditEventId = newId();
      await session.appendAudit({
        id: auditEventId,
        tenantId: command.tenantId,
        actorType: command.actor.actorType,
        actorId: command.actor.actorId,
        revisionId: revision.id,
        after: {
          runtime_id: revision.runtimeId,
          revision_no: revision.revisionNo,
          revision_state: "published",
          runtime_evidence_kind: revision.runtimeEvidenceKind,
          runtime_target_digest: revision.runtimeTargetDigest,
          attestation_id: attestation?.attestationId ?? null,
          artifact_digest: attestation?.artifactDigest ?? null,
          publication_record_id: publicationRecordId,
          conformance_run_id: conformanceRun.id,
        },
        reason: "RuntimeRevision 发布（conformance 门禁通过）",
        requestId: command.requestId,
        occurredAt: publishedAt,
      });

      // 18. 写 Outbox
      const outboxEventId = newId();
      await session.appendOutbox({
        id: outboxEventId,
        tenantId: command.tenantId,
        eventKey: `runtime-revision-published:${revision.id}`,
        eventType: "runtime.revision.published",
        aggregateId: revision.id,
        aggregateVersion: revision.revisionNo,
        payload: {
          runtime_id: revision.runtimeId,
          revision_id: revision.id,
          revision_no: revision.revisionNo,
          runtime_evidence_kind: revision.runtimeEvidenceKind,
          attestation_id: attestation?.attestationId ?? null,
          audit_event_id: auditEventId,
          publication_record_id: publicationRecordId,
          conformance_run_id: conformanceRun.id,
        },
        occurredAt: publishedAt,
      });

      const result: PublishRuntimeRevisionResult = {
        revision: { ...revision, revisionState: "published", publishedAt },
        attestation,
        conformanceResults,
        publicationRecordId,
        auditEventId,
        outboxEventId,
      };

      // 18. 完成 Idempotency
      if (command.idempotency) {
        const completed = await session.completeIdempotency({
          recordId: command.idempotency.recordId,
          httpStatus: command.idempotency.httpStatus,
          responseRef: command.idempotency.responseRef ?? null,
          responseRedactedJson: command.idempotency.serializeResponse(result),
          completedAt: publishedAt,
        });
        if (!completed) {
          throw new RuntimePublicationIdempotencyCompletionError(command.idempotency.recordId);
        }
      }

      // 19. 提交事务
      return result;
    });
  };
}
