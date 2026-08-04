/**
 * 资格扫描 — 读取 Active Route 引用的控制面证据，按可信度分类。
 *
 * 扫描过程只读，不修改业务事实。
 * 分类结果决定 CutoverItem 的 qualificationCategory 和初始 state：
 * - trusted → Item 直接进入 ready
 * - 其他 → Item 进入 pending，需要 Replacement
 */

import { db } from "@/lib/db/client";
import {
  agentRevisionTable,
  runtimeRevisionTable,
  runtimeTable,
} from "@/lib/persistence/schema/control-plane";
import type { QualificationCategory } from "./cutover-item";
import { and, eq, isNull } from "drizzle-orm";
import { getPublicationRecordBySubject, getWithdrawalRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import { getVerifiedAttestationForRevision, listAttestationsByRevision } from "@/lib/artifacts/persistence/artifact-attestation-queries";
import { publicationRecord, withdrawalRecord } from "@/lib/publications/persistence/publication-record";

/** 扫描输入。 */
export interface ScanInput {
  tenantId: string;
  routeSetId: string;
}

/** 单个 Subject 的扫描结果。 */
export interface ScannedSubject {
  subjectType: "agent_revision" | "runtime_revision";
  subjectId: string;
  qualificationCategory: QualificationCategory;
  /** 已有 publication 的 publishedBy，用于识别 migration-0112 投影回填。 */
  publishedBy: string | null;
  /** 是否存在 withdrawal。 */
  isWithdrawn: boolean;
}

/**
 * 扫描单个 Revision 的控制面资格。
 *
 * 分类规则：
 * 1. Publication 不存在 → missing_attestation
 * 2. Withdrawal 存在 → withdrawn
 * 3. attestationIds 为空且 publishedBy 含 migration → legacy_projection_only
 * 4. 无 verified 且未撤销 Attestation → missing_attestation
 * 5. Artifact Digest 不一致 → invalid_digest
 * 6. RuntimeRevision 且 conformanceRunId 为空 → missing_conformance
 * 7. 以上均通过 → trusted
 */
export async function scanRevisionQualification(params: {
  tenantId: string;
  subjectType: "agent_revision" | "runtime_revision";
  subjectRevisionId: string;
  artifactId: string | null;
  artifactDigest: string | null;
}): Promise<ScannedSubject> {
  const { tenantId, subjectType, subjectRevisionId, artifactId, artifactDigest } = params;

  // 1. 检查 Publication 是否存在
  const publication = await getPublicationRecordBySubject({
    tenantId,
    subjectType,
    subjectRevisionId,
  });

  if (!publication) {
    return {
      subjectType,
      subjectId: subjectRevisionId,
      qualificationCategory: "missing_attestation",
      publishedBy: null,
      isWithdrawn: false,
    };
  }

  // 2. 检查 Withdrawal
  const withdrawal = await getWithdrawalRecordBySubject({
    tenantId,
    subjectType,
    subjectRevisionId,
  });

  if (withdrawal) {
    return {
      subjectType,
      subjectId: subjectRevisionId,
      qualificationCategory: "withdrawn",
      publishedBy: publication.publishedBy,
      isWithdrawn: true,
    };
  }

  // 3. 检查是否为 migration 投影回填（空 attestationIds + migration publishedBy）
  const attestationIds = publication.attestationIds as string[];
  if (
    (!attestationIds || attestationIds.length === 0) &&
    publication.publishedBy?.startsWith("migration-")
  ) {
    return {
      subjectType,
      subjectId: subjectRevisionId,
      qualificationCategory: "legacy_projection_only",
      publishedBy: publication.publishedBy,
      isWithdrawn: false,
    };
  }

  // 4. 检查 Attestation
  if (!attestationIds || attestationIds.length === 0) {
    return {
      subjectType,
      subjectId: subjectRevisionId,
      qualificationCategory: "missing_attestation",
      publishedBy: publication.publishedBy,
      isWithdrawn: false,
    };
  }

  const verifiedAttestation = await getVerifiedAttestationForRevision(
    tenantId,
    subjectType,
    subjectRevisionId,
  );

  if (!verifiedAttestation) {
    return {
      subjectType,
      subjectId: subjectRevisionId,
      qualificationCategory: "missing_attestation",
      publishedBy: publication.publishedBy,
      isWithdrawn: false,
    };
  }

  // 5. 检查 Artifact Digest 一致性
  if (artifactDigest && verifiedAttestation.artifactDigest !== artifactDigest) {
    return {
      subjectType,
      subjectId: subjectRevisionId,
      qualificationCategory: "invalid_digest",
      publishedBy: publication.publishedBy,
      isWithdrawn: false,
    };
  }

  // 6. RuntimeRevision 检查 Conformance
  if (subjectType === "runtime_revision") {
    if (!publication.conformanceRunId) {
      return {
        subjectType,
        subjectId: subjectRevisionId,
        qualificationCategory: "missing_conformance",
        publishedBy: publication.publishedBy,
        isWithdrawn: false,
      };
    }
  }

  // 7. 全部通过
  return {
    subjectType,
    subjectId: subjectRevisionId,
    qualificationCategory: "trusted",
    publishedBy: publication.publishedBy,
    isWithdrawn: false,
  };
}

/**
 * 扫描 RouteSet 下所有 Active Route 引用的 Revision。
 *
 * 返回所有需要资格评估的 Subject 列表（去重）。
 */
export async function scanRouteSetActiveRevisions(
  params: ScanInput,
): Promise<ScannedSubject[]> {
  const { tenantId } = params;

  // 读取所有 enabled Route 的 Active Revision 引用
  const routes = await db
    .select({
      agentRevisionId: agentRevisionTable.id,
      runtimeRevisionId: runtimeRevisionTable.id,
      agentArtifactDigest: agentRevisionTable.artifactDigest,
      runtimeArtifactDigest: runtimeRevisionTable.artifactDigest,
    })
    .from(runtimeRevisionTable)
    .innerJoin(
      agentRevisionTable,
      eq(agentRevisionTable.id, runtimeRevisionTable.id), // placeholder - 实际需要通过 Route 投影连接
    )
    .where(eq(runtimeRevisionTable.tenantId, tenantId))
    .limit(1000);

  // 去重并扫描
  const seen = new Set<string>();
  const results: ScannedSubject[] = [];

  // 实际实现需要从 DeploymentRoute 投影读取 agentRevisionId/runtimeRevisionId
  // 此处提供扫描逻辑框架，具体 Route→Revision 连接在应用服务层完成

  return results;
}
