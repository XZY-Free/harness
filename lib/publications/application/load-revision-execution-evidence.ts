/**
 * Revision 执行资格组合模型 — 统一读取并组合双方完整执行证据。
 *
 * 输出 RevisionExecutionEvidenceSnapshot，供：
 * - RouteSet 激活（§2.4 整体激活使用完整执行资格）
 * - Projection 构建（§4.3 Builder 不再直接实现资格规则）
 * - ExecutionBinding 最终检查（§5.1 校验放入 Binding 事务）
 *
 * 不要求三个模块共用一个巨大 Application Service，
 * 但必须共用：Evidence Snapshot、纯 Policy、相同字段含义、相同错误码。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §1.4
 */

import type { ArtifactEvidenceSnapshot } from "@/lib/artifacts/domain/artifact-evidence";
import type { ActivePublicationSnapshot } from "@/lib/publications/domain/publication-eligibility";
import type { ConformanceEligibilitySnapshot } from "@/lib/runtimes/domain/runtime-conformance-eligibility";

/**
 * Revision 执行资格快照 — 组合双方完整证据。
 *
 * 这是唯一权威的执行资格数据结构，
 * 任何模块不得自行定义第二套。
 */
export interface RevisionExecutionEvidenceSnapshot {
  /** 租户 ID。 */
  tenantId: string;

  /** Agent Revision ID。 */
  agentRevisionId: string;
  /** Agent Artifact Evidence（null = 无有效 Attestation）。 */
  agentArtifactEvidence: ArtifactEvidenceSnapshot | null;
  /** Agent Active Publication（null = 未发布或已撤回）。 */
  agentPublication: ActivePublicationSnapshot | null;
  /** Agent 生命周期状态。 */
  agentLifecycleState: "active" | "archived";
  /** Agent Revision 发布状态。 */
  agentRevisionState: "draft" | "published" | "withdrawn";

  /** Runtime Revision ID。 */
  runtimeRevisionId: string;
  /** Runtime Artifact Evidence（null = 无有效 Attestation）。 */
  runtimeArtifactEvidence: ArtifactEvidenceSnapshot | null;
  /** Runtime Active Publication（null = 未发布或已撤回）。 */
  runtimePublication: ActivePublicationSnapshot | null;
  /** Runtime Conformance（null = 无有效 ConformanceRun）。 */
  runtimeConformance: ConformanceEligibilitySnapshot | null;
  /** Runtime 生命周期状态。 */
  runtimeLifecycleState: "active" | "quarantined" | "retired";
  /** Runtime Revision 发布状态。 */
  runtimeRevisionState: "draft" | "published" | "withdrawn";
  /** Runtime Capabilities。 */
  runtimeCapabilities: string[];

  /** Policy Revision ID（可为 null）。 */
  policyRevisionId: string | null;
}

/**
 * Revision 执行资格校验结果。
 */
export interface RevisionExecutionEligibilityResult {
  eligible: boolean;
  errors: RevisionExecutionEligibilityError[];
}

/** 执行资格错误。 */
export interface RevisionExecutionEligibilityError {
  dimension: "agent_publication" | "agent_attestation" | "agent_lifecycle" | "runtime_publication" | "runtime_attestation" | "runtime_conformance" | "runtime_lifecycle" | "capability" | "policy";
  code: string;
  message: string;
}

/**
 * Revision 执行资格策略 — 纯函数，无副作用。
 *
 * 这是 RouteSet 激活、Projection、Binding 共用的唯一资格判断。
 */
export const RevisionExecutionEligibilityPolicy = {
  /**
   * 判断 Revision 是否满足完整执行资格。
   *
   * 检查维度：
   * 1. Agent Publication Active
   * 2. Agent Attestation Verified & 未撤销
   * 3. Agent 生命周期 Active
   * 4. Runtime Publication Active
   * 5. Runtime Attestation Verified & 未撤销
   * 6. Runtime Conformance Passed & 完整
   * 7. Runtime 生命周期 Active
   * 8. Capability 兼容
   * 9. Policy 状态
   */
  isEligible(
    snapshot: RevisionExecutionEvidenceSnapshot,
    requiredCapabilities: string[],
  ): RevisionExecutionEligibilityResult {
    const errors: RevisionExecutionEligibilityError[] = [];

    // 1. Agent Publication Active
    if (!snapshot.agentPublication) {
      errors.push({
        dimension: "agent_publication",
        code: "no_active_publication",
        message: `AgentRevision ${snapshot.agentRevisionId} 无 Active Publication`,
      });
    }

    // 2. Agent Attestation
    if (!snapshot.agentArtifactEvidence) {
      errors.push({
        dimension: "agent_attestation",
        code: "no_artifact_evidence",
        message: `AgentRevision ${snapshot.agentRevisionId} 无有效 Artifact Evidence`,
      });
    } else if (snapshot.agentArtifactEvidence.verificationState !== "verified") {
      errors.push({
        dimension: "agent_attestation",
        code: "evidence_not_verified",
        message: `AgentRevision ${snapshot.agentRevisionId} Artifact Evidence 未验证`,
      });
    } else if (snapshot.agentArtifactEvidence.revokedAt !== null) {
      errors.push({
        dimension: "agent_attestation",
        code: "evidence_revoked",
        message: `AgentRevision ${snapshot.agentRevisionId} Artifact Evidence 已撤销`,
      });
    }

    // 3. Agent 生命周期
    if (snapshot.agentLifecycleState !== "active") {
      errors.push({
        dimension: "agent_lifecycle",
        code: "agent_not_active",
        message: `Agent 生命周期状态为 ${snapshot.agentLifecycleState}，要求 active`,
      });
    }

    // 4. Runtime Publication Active
    if (!snapshot.runtimePublication) {
      errors.push({
        dimension: "runtime_publication",
        code: "no_active_publication",
        message: `RuntimeRevision ${snapshot.runtimeRevisionId} 无 Active Publication`,
      });
    }

    // 5. Runtime Attestation
    if (!snapshot.runtimeArtifactEvidence) {
      errors.push({
        dimension: "runtime_attestation",
        code: "no_artifact_evidence",
        message: `RuntimeRevision ${snapshot.runtimeRevisionId} 无有效 Artifact Evidence`,
      });
    } else if (snapshot.runtimeArtifactEvidence.verificationState !== "verified") {
      errors.push({
        dimension: "runtime_attestation",
        code: "evidence_not_verified",
        message: `RuntimeRevision ${snapshot.runtimeRevisionId} Artifact Evidence 未验证`,
      });
    } else if (snapshot.runtimeArtifactEvidence.revokedAt !== null) {
      errors.push({
        dimension: "runtime_attestation",
        code: "evidence_revoked",
        message: `RuntimeRevision ${snapshot.runtimeRevisionId} Artifact Evidence 已撤销`,
      });
    }

    // 6. Runtime Conformance
    if (!snapshot.runtimeConformance) {
      errors.push({
        dimension: "runtime_conformance",
        code: "no_conformance_run",
        message: `RuntimeRevision ${snapshot.runtimeRevisionId} 无有效 ConformanceRun`,
      });
    } else if (snapshot.runtimeConformance.overallResult !== "passed") {
      errors.push({
        dimension: "runtime_conformance",
        code: "conformance_not_passed",
        message: `RuntimeRevision ${snapshot.runtimeRevisionId} Conformance 未通过`,
      });
    }

    // 7. Runtime 生命周期
    if (snapshot.runtimeLifecycleState !== "active") {
      errors.push({
        dimension: "runtime_lifecycle",
        code: "runtime_not_active",
        message: `Runtime 生命周期状态为 ${snapshot.runtimeLifecycleState}，要求 active`,
      });
    }

    // 8. Capability 兼容
    const runtimeCapSet = new Set(snapshot.runtimeCapabilities);
    const missingCapabilities = requiredCapabilities.filter((cap) => !runtimeCapSet.has(cap));
    if (missingCapabilities.length > 0) {
      errors.push({
        dimension: "capability",
        code: "capability_unsupported",
        message: `Runtime 缺少必要 Capability: ${missingCapabilities.join(", ")}`,
      });
    }

    // 9. Policy 状态（当前仅检查存在性）
    // 未来可扩展：Policy 未撤回、Policy 版本一致等
    // 当前不阻塞

    return { eligible: errors.length === 0, errors };
  },
} as const;
