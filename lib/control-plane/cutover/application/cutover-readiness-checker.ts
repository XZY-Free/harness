/**
 * §7.1: Cutover Item Ready 正式条件验证。
 *
 * 只有同时满足以下事实才能进入 ready：
 *
 * Agent Revision:
 *   - Replacement AgentRevision 存在
 *   - Artifact 绑定完成（artifactId + artifactDigest 非空）
 *   - Attestation verificationState = verified
 *   - PublicationRecord 存在（active）
 *   - RevisionState published
 *
 * Runtime Revision:
 *   - Replacement RuntimeRevision 存在
 *   - Artifact 绑定完成
 *   - Attestation verificationState = verified
 *   - ConformanceRun overallResult = passed
 *   - PublicationRecord 存在（active）
 *   - RevisionState published
 *
 * 禁止：创建 Draft 后直接 Ready。
 */

import { db } from "@/lib/db/client";
import { agentRevisionTable } from "@/lib/persistence/schema/agents";
import { runtimeRevisionTable } from "@/lib/persistence/schema/runtimes";
import { artifactAttestation } from "@/lib/artifacts/persistence/artifact-record";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import { runtimeConformanceRun } from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import { and, eq } from "drizzle-orm";

/** Readiness 检查结果。 */
export interface ReadinessResult {
  ready: true;
}

export interface ReadinessFailure {
  ready: false;
  /** 不满足的条件列表。 */
  failingConditions: string[];
}

/** §7.1 Agent Revision Ready 条件验证。 */
export async function checkAgentRevisionReadiness(params: {
  replacementRevisionId: string;
}): Promise<ReadinessResult | ReadinessFailure> {
  const { replacementRevisionId } = params;
  const failingConditions: string[] = [];

  // 1. Replacement Revision 存在且 published
  const [revision] = await db
    .select({
      id: agentRevisionTable.id,
      revisionState: agentRevisionTable.revisionState,
      artifactId: agentRevisionTable.artifactId,
      artifactDigest: agentRevisionTable.artifactDigest,
    })
    .from(agentRevisionTable)
    .where(eq(agentRevisionTable.id, replacementRevisionId))
    .limit(1);

  if (!revision) {
    return { ready: false, failingConditions: ["revision_not_found"] };
  }
  if (revision.revisionState !== "published") {
    failingConditions.push("revision_not_published");
  }

  // 2. Artifact 绑定完成
  if (!revision.artifactId || !revision.artifactDigest) {
    failingConditions.push("artifact_not_bound");
  }

  // 3. Attestation verified
  const [attestation] = await db
    .select({ verificationState: artifactAttestation.verificationState })
    .from(artifactAttestation)
    .where(
      and(
        eq(artifactAttestation.artifactRevisionId, replacementRevisionId),
        eq(artifactAttestation.artifactType, "agent"),
      ),
    )
    .limit(1);

  if (!attestation || attestation.verificationState !== "verified") {
    failingConditions.push("attestation_not_verified");
  }

  // 4. PublicationRecord 存在（即 active；withdrawal 是单独表）
  const [publication] = await db
    .select({ id: publicationRecord.id })
    .from(publicationRecord)
    .where(
      and(
        eq(publicationRecord.subjectType, "agent_revision"),
        eq(publicationRecord.subjectRevisionId, replacementRevisionId),
      ),
    )
    .limit(1);

  if (!publication) {
    failingConditions.push("publication_not_active");
  }

  if (failingConditions.length > 0) {
    return { ready: false, failingConditions };
  }

  return { ready: true };
}

/** §7.1 Runtime Revision Ready 条件验证。 */
export async function checkRuntimeRevisionReadiness(params: {
  replacementRevisionId: string;
}): Promise<ReadinessResult | ReadinessFailure> {
  const { replacementRevisionId } = params;
  const failingConditions: string[] = [];

  // 1. Replacement Revision 存在且 published
  const [revision] = await db
    .select({
      id: runtimeRevisionTable.id,
      revisionState: runtimeRevisionTable.revisionState,
      artifactId: runtimeRevisionTable.artifactId,
      artifactDigest: runtimeRevisionTable.artifactDigest,
    })
    .from(runtimeRevisionTable)
    .where(eq(runtimeRevisionTable.id, replacementRevisionId))
    .limit(1);

  if (!revision) {
    return { ready: false, failingConditions: ["revision_not_found"] };
  }
  if (revision.revisionState !== "published") {
    failingConditions.push("revision_not_published");
  }

  // 2. Artifact 绑定完成
  if (!revision.artifactId || !revision.artifactDigest) {
    failingConditions.push("artifact_not_bound");
  }

  // 3. Attestation verified
  const [attestation] = await db
    .select({ verificationState: artifactAttestation.verificationState })
    .from(artifactAttestation)
    .where(
      and(
        eq(artifactAttestation.artifactRevisionId, replacementRevisionId),
        eq(artifactAttestation.artifactType, "runtime"),
      ),
    )
    .limit(1);

  if (!attestation || attestation.verificationState !== "verified") {
    failingConditions.push("attestation_not_verified");
  }

  // 4. ConformanceRun passed
  const [conformance] = await db
    .select({ overallResult: runtimeConformanceRun.overallResult })
    .from(runtimeConformanceRun)
    .where(eq(runtimeConformanceRun.runtimeRevisionId, replacementRevisionId))
    .limit(1);

  if (!conformance || conformance.overallResult !== "passed") {
    failingConditions.push("conformance_not_passed");
  }

  // 5. PublicationRecord 存在（即 active）
  const [publication] = await db
    .select({ id: publicationRecord.id })
    .from(publicationRecord)
    .where(
      and(
        eq(publicationRecord.subjectType, "runtime_revision"),
        eq(publicationRecord.subjectRevisionId, replacementRevisionId),
      ),
    )
    .limit(1);

  if (!publication) {
    failingConditions.push("publication_not_active");
  }

  if (failingConditions.length > 0) {
    return { ready: false, failingConditions };
  }

  return { ready: true };
}

/** 统一入口：根据 subjectType 调用对应的 Readiness 检查。 */
export async function checkItemReadiness(params: {
  subjectType: "agent_revision" | "runtime_revision";
  replacementRevisionId: string;
}): Promise<ReadinessResult | ReadinessFailure> {
  if (params.subjectType === "agent_revision") {
    return checkAgentRevisionReadiness({ replacementRevisionId: params.replacementRevisionId });
  }
  return checkRuntimeRevisionReadiness({ replacementRevisionId: params.replacementRevisionId });
}
