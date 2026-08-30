/**
 * Revision 执行资格组合模型 — 唯一权威领域定义。
 *
 * 统一 RouteSet 激活、Projection 构建、ExecutionBinding 验证三处资格判断。
 *
 * ExecutionBinding 的 Runtime 证据始终完整；Agent 证据只能全 null 或全完整。
 */

import type { ArtifactEvidenceSnapshot } from "@/lib/artifacts/domain/artifact-evidence";
import type { ActivePublicationSnapshot } from "@/lib/publications/domain/publication-eligibility";
import {
  type RuntimeConformanceEvidence,
  validateRuntimePublicationConformanceEvidence,
} from "@/lib/runtime/domain/runtime-conformance-eligibility";

// ─── Policy Revision Snapshot ────────────────────────────

/**
 * Policy Revision 快照；Route 未引用 Policy 时为 null。
 *
 * Route 未引用 Policy → null（允许）
 * Route 引用 Policy → 必须存在且 published（revisionState = "published" 且非 "withdrawn"）
 */
export interface PolicyRevisionSnapshot {
  id: string;
  revisionState: "draft" | "published" | "withdrawn";
  publishedAt: Date | null;
}

// ─── Policy Requirement（Fail-closed）─────────────────

/**
 * Policy 引用需求 — 明确区分"没有引用"和"引用了但读取失败"。
 *
 * { kind: "none" } → Route 故意不引用 Policy（允许）
 * { kind: "referenced", policyRevisionId, policyRevision } → Route 引用了 Policy
 *
 * kind="none" 表示"没引用"，kind="referenced" 且 policyRevision 存在表示"引用有效"。
 */
export type PolicyRequirement =
  | { kind: "none" }
  | {
      kind: "referenced";
      policyRevisionId: string;
      policyRevision: PolicyRevisionSnapshot;
    };

/**
 * Policy 引用读取失败码。
 *
 * 传入 Policy ID 但读取异常时的精确分类，替代笼统的 null。
 */
export const POLICY_REQUIREMENT_FAILURE_CODES = [
  "policy_revision_not_found",
  "policy_revision_cross_tenant",
  "policy_revision_not_published",
  "policy_revision_withdrawn",
] as const;
export type PolicyRequirementFailureCode = (typeof POLICY_REQUIREMENT_FAILURE_CODES)[number];

/**
 * Policy 引用读取结果。
 *
 * ok=true → PolicyRequirement（kind="none" 或 kind="referenced"）
 * ok=false → 读取失败（精确失败码）
 */
export type PolicyRequirementResult =
  | { ok: true; requirement: PolicyRequirement }
  | { ok: false; failureCode: PolicyRequirementFailureCode; failureReason: string };

// ─── Evidence Snapshot ───────────────────────────────────

/**
 * Revision 执行资格快照 — target 判别联合（Agent 与 Runtime Authority 分离）。
 *
 * 这是唯一权威的执行资格数据结构，任何模块不得自行定义第二套。
 * - Agent target：只含 Agent 维度证据 + public policy，不含任何 Runtime 字段。
 * - Runtime target：只含 Runtime 维度证据 + public policy，不含任何 Agent 字段。
 *
 * Agent target 不得出现 runtimeRevisionId placeholder、flat alias 或 fallback。
 *
 * policyRevision 使用结构化快照表达。
 * 所有字段必须来自事实源，禁止硬编码。
 */
export interface AgentTargetEvidenceSnapshot {
  kind: "agent";
  /** 租户 ID。 */
  tenantId: string;
  /** Agent Revision ID（agent target 恒非空）。 */
  agentRevisionId: string;
  /** Agent Active Publication（null = 未发布或已撤回）。 */
  agentPublication: ActivePublicationSnapshot | null;
  /** Agent 生命周期状态。 */
  agentLifecycleState: "active" | "archived";
  /** Agent Revision 发布状态。 */
  agentRevisionState: "draft" | "published" | "withdrawn";
  /** Policy 引用需求。kind="none" = Route 未引用 Policy；kind="referenced" = 引用了 Policy。 */
  policyRequirement: PolicyRequirement;
}

/** Runtime target Evidence — 只含 Runtime 维度证据 + public policy。 */
export interface RuntimeTargetEvidenceSnapshot {
  kind: "runtime";
  /** 租户 ID。 */
  tenantId: string;
  /** Runtime Revision ID。 */
  runtimeRevisionId: string;
  /** Runtime Artifact Evidence（null = 无有效 Attestation）。 */
  runtimeArtifactEvidence: ArtifactEvidenceSnapshot | null;
  /** Runtime Active Publication（null = 未发布或已撤回）。 */
  runtimePublication: ActivePublicationSnapshot | null;
  /** Runtime Conformance（规范化 Evidence；null = 无有效 ConformanceRun）。 */
  runtimeConformance: RuntimeConformanceEvidence | null;
  /** Runtime 生命周期状态。 */
  runtimeLifecycleState: "active" | "quarantined" | "retired";
  /** Runtime Revision 发布状态。 */
  runtimeRevisionState: "draft" | "published" | "withdrawn";
  /** Runtime 证据种类（hosted 要求 artifact 全集；external 无 artifact — ）。 */
  runtimeEvidenceKind: "hosted_artifact" | "external_endpoint";
  /** Policy 引用需求。kind="none" = Route 未引用 Policy；kind="referenced" = 引用了 Policy。 */
  policyRequirement: PolicyRequirement;
}

export type RevisionExecutionEvidenceSnapshot =
  | AgentTargetEvidenceSnapshot
  | RuntimeTargetEvidenceSnapshot;

/** Snapshot 公共字段访问器（policyRequirement / tenantId 两种 target 都有）。 */
export function snapshotPolicyRequirement(
  snapshot: RevisionExecutionEvidenceSnapshot,
): PolicyRequirement {
  return snapshot.policyRequirement;
}

// ─── Eligibility Result ──────────────────────────────────

/** 执行资格校验结果。 */
export interface RevisionExecutionEligibilityResult {
  eligible: boolean;
  errors: RevisionExecutionEligibilityError[];
}

/** 执行资格错误。 */
export interface RevisionExecutionEligibilityError {
  dimension:
    | "agent_publication"
    | "agent_lifecycle"
    | "runtime_publication"
    | "runtime_attestation"
    | "runtime_conformance"
    | "runtime_lifecycle"
    | "capability"
    | "policy";
  code: string;
  message: string;
}

// ─── Eligibility Policy (pure) ───────────────────────────

/**
 * Revision 执行资格策略 — 纯函数，无副作用。
 *
 * 这是 RouteSet 激活、Projection、Binding 共用的唯一资格判断。
 * Policy 状态参与执行资格判断，非 published 状态必须阻断。
 */
export const RevisionExecutionEligibilityPolicy = {
  /**
   * 判断 Revision 是否满足完整执行资格。
   *
   * 检查维度：
   * 1. Agent Publication Active（含冻结的 AgentContractSnapshot 证据完整）
   * 2. Agent 生命周期 Active
   * 3. Runtime Publication Active
   * 4. Runtime Attestation Verified & 未撤销（external_endpoint 除外）
   * 5. Runtime Conformance Passed & 完整
   * 6. Runtime 生命周期 Active
   * 7. Policy 状态
   *
   * 冻结架构：不得检查 Agent required capabilities 是否被 RuntimeRevision
   * capabilities 支持（外部 Agent 自己是能力提供方，不是"装在某 RuntimeRevision 里的
   * Agent"，§14）。因此本 Policy 不做 capability 交叉校验。
   */
  isEligible(snapshot: RevisionExecutionEvidenceSnapshot): RevisionExecutionEligibilityResult {
    // Agent 与 Runtime Authority 分离：按 target 判别分支。Agent target 只校验 Agent 维度 + policy；
    // Runtime target 只校验 Runtime 维度 + policy。互不读取对方证据。
    return snapshot.kind === "agent"
      ? this.evaluateAgent(snapshot)
      : this.evaluateRuntime(snapshot);
  },

  /** Agent target 资格 — 只校验 Agent publication / lifecycle / revision state + public policy。 */
  evaluateAgent(snapshot: AgentTargetEvidenceSnapshot): RevisionExecutionEligibilityResult {
    const errors: RevisionExecutionEligibilityError[] = [];

    // 1. Agent Publication Active + 冻结的 AgentContractSnapshot 证据完整
    //（Agent 是源码不可见黑盒；发布权威是 Contract 证据，不是 source Artifact/Attestation）。
    if (!snapshot.agentPublication) {
      errors.push({
        dimension: "agent_publication",
        code: "no_active_publication",
        message: `AgentRevision ${snapshot.agentRevisionId} 无 Active Publication`,
      });
    } else if (
      !snapshot.agentPublication.agentContractSnapshotId ||
      !snapshot.agentPublication.agentContractDigest ||
      !snapshot.agentPublication.agentCapabilityDigest ||
      !snapshot.agentPublication.agentContextDigest
    ) {
      errors.push({
        dimension: "agent_publication",
        code: "agent_contract_evidence_missing",
        message: `AgentRevision ${snapshot.agentRevisionId} Publication 缺少 AgentContractSnapshot 证据`,
      });
    }

    // 2. Agent 生命周期
    if (snapshot.agentLifecycleState !== "active") {
      errors.push({
        dimension: "agent_lifecycle",
        code: "agent_not_active",
        message: `Agent 生命周期状态为 ${snapshot.agentLifecycleState}，要求 active`,
      });
    }

    // 3. Agent Revision 发布状态
    if (snapshot.agentRevisionState !== "published") {
      errors.push({
        dimension: "agent_publication",
        code: "agent_revision_not_published",
        message: `AgentRevision ${snapshot.agentRevisionId} 状态为 ${snapshot.agentRevisionState}，要求 published`,
      });
    }

    // 4. Policy 引用 — Fail-closed（两种 target 共用公共规则）
    this.collectPolicyErrors(snapshot.policyRequirement, errors);

    return { eligible: errors.length === 0, errors };
  },

  /** Runtime target 资格 — 只校验 Runtime evidence + public policy。 */
  evaluateRuntime(snapshot: RuntimeTargetEvidenceSnapshot): RevisionExecutionEligibilityResult {
    const errors: RevisionExecutionEligibilityError[] = [];

    // 1. Runtime Publication Active
    if (!snapshot.runtimePublication) {
      errors.push({
        dimension: "runtime_publication",
        code: "no_active_publication",
        message: `RuntimeRevision ${snapshot.runtimeRevisionId} 无 Active Publication`,
      });
    }

    // 2. Runtime Attestation — Runtime evidence all-or-nothing：
    // external_endpoint 无 Runtime Artifact（不伪造），跳过 Attestation 维度；
    // hosted_artifact 要求全集 verified 且未撤销。
    if (snapshot.runtimeEvidenceKind !== "external_endpoint") {
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
    }

    // 3. Runtime Conformance — 调用统一纯验证器，每个错误映射为 runtime_conformance dimension
    const conformanceResult = validateRuntimePublicationConformanceEvidence(
      snapshot.runtimeConformance,
    );
    for (const conformanceError of conformanceResult.errors) {
      errors.push({
        dimension: "runtime_conformance",
        code: conformanceError.code,
        message: conformanceError.message,
      });
    }

    // 4. Runtime 生命周期
    if (snapshot.runtimeLifecycleState !== "active") {
      errors.push({
        dimension: "runtime_lifecycle",
        code: "runtime_not_active",
        message: `Runtime 生命周期状态为 ${snapshot.runtimeLifecycleState}，要求 active`,
      });
    }

    // 5. Runtime Revision 发布状态
    if (snapshot.runtimeRevisionState !== "published") {
      errors.push({
        dimension: "runtime_publication",
        code: "runtime_revision_not_published",
        message: `RuntimeRevision ${snapshot.runtimeRevisionId} 状态为 ${snapshot.runtimeRevisionState}，要求 published`,
      });
    }

    // 6. Policy 引用 — Fail-closed（两种 target 共用公共规则）
    this.collectPolicyErrors(snapshot.policyRequirement, errors);

    return { eligible: errors.length === 0, errors };
  },

  /** 公共 policy fail-closed 校验。 */
  collectPolicyErrors(
    requirement: PolicyRequirement,
    errors: RevisionExecutionEligibilityError[],
  ): void {
    // kind="referenced" → Policy 必须存在且 revisionState = "published"（非 draft/withdrawn）
    // kind="none" → Route 不引用 Policy，不阻断
    if (requirement.kind === "referenced") {
      const policy = requirement.policyRevision;
      if (policy.revisionState === "withdrawn") {
        errors.push({
          dimension: "policy",
          code: "policy_withdrawn",
          message: `PolicyRevision ${policy.id} 已撤回`,
        });
      } else if (policy.revisionState !== "published") {
        errors.push({
          dimension: "policy",
          code: "policy_not_published",
          message: `PolicyRevision ${policy.id} 状态为 ${policy.revisionState}，要求 published`,
        });
      }
    }
  },
} as const;

// ─── Errors ───────────────────────────────────────────────

/** Capability 解析无法满足 fail-closed 要求时抛出的执行资格错误。 */
export class EligibilityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EligibilityError";
  }
}
