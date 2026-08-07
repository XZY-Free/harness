/**
 * Revision 执行资格组合模型 — 唯一权威领域定义。
 *
 * §03: 从 publications/application 移至 control-plane/domain，
 * 统一 RouteSet 激活、Projection 构建、ExecutionBinding 验证三处资格判断。
 *
 * 参见：SnowHarness专题01最终差距整改与正式链路收口实施方案 §03
 */

import type { ArtifactEvidenceSnapshot } from "@/lib/artifacts/domain/artifact-evidence";
import type { ActivePublicationSnapshot } from "@/lib/publications/domain/publication-eligibility";
import type { ConformanceEligibilitySnapshot } from "@/lib/runtimes/domain/runtime-conformance-eligibility";

// ─── Policy Revision Snapshot ────────────────────────────

/**
 * Policy Revision 快照（: 替代原 policyRevisionId: string | null）。
 *
 * Route 未引用 Policy → null（允许）
 * Route 引用 Policy → 必须存在且 published（revisionState = "published" 且非 "withdrawn"）
 */
export interface PolicyRevisionSnapshot {
 id: string;
 revisionState: "draft" | "published" | "withdrawn";
 publishedAt: Date | null;
}

// ─── Policy Requirement (: Fail-closed) ───────────────

/**
 * Policy 引用需求 — 明确区分"没有引用"和"引用了但读取失败"。
 *
 * { kind: "none" } → Route 故意不引用 Policy（允许）
 * { kind: "referenced", policyRevisionId, policyRevision } → Route 引用了 Policy
 *
 * 此类型消除了 policyRevisionId: null 的歧义：
 * - 旧语义：null 同时表示"没引用"和"引用失败"
 * - 新语义：kind="none" 表示"没引用"，kind="referenced" 且 policyRevision 存在表示"引用有效"
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
 * Revision 执行资格快照 — 组合双方完整证据。
 *
 * 这是唯一权威的执行资格数据结构，
 * 任何模块不得自行定义第二套。
 *
 * : policyRevisionId 升级为 policyRevision 对象。
 * : 所有字段必须真实读取，禁止硬编码。
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
 /** Runtime Capabilities（: 必须经过 fail-closed 解析）。 */
 runtimeCapabilities: string[];

 /** : Policy 引用需求。kind="none" = Route 未引用 Policy；kind="referenced" = 引用了 Policy。 */
 policyRequirement: PolicyRequirement;
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
 | "agent_attestation"
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
 * : Policy 状态正式阻断（不再"当前不阻塞"）。
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
 * 9. Policy 状态（: 正式阻断）
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

 // 3b. Agent Revision 发布状态
 if (snapshot.agentRevisionState !== "published") {
  errors.push({
  dimension: "agent_publication",
  code: "agent_revision_not_published",
  message: `AgentRevision ${snapshot.agentRevisionId} 状态为 ${snapshot.agentRevisionState}，要求 published`,
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

 // 7b. Runtime Revision 发布状态
 if (snapshot.runtimeRevisionState !== "published") {
  errors.push({
  dimension: "runtime_publication",
  code: "runtime_revision_not_published",
  message: `RuntimeRevision ${snapshot.runtimeRevisionId} 状态为 ${snapshot.runtimeRevisionState}，要求 published`,
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

 // 9. : Policy 引用 — Fail-closed 校验
 // kind="referenced" → Policy 必须存在且 revisionState = "published"（非 draft/withdrawn）
 // kind="none" → Route 不引用 Policy，不阻断
 if (snapshot.policyRequirement.kind === "referenced") {
 const policy = snapshot.policyRequirement.policyRevision;
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

 return { eligible: errors.length === 0, errors };
 },
} as const;

// ─── Capability Parsing (: Fail-closed) ─────────────

/**
 * : 从 AgentRevision.agentInterfaceRequirementsJson 提取必要 Capability 列表。
 *
 * Fail-closed 语义：
 * - 字段缺失且合同允许缺失 → []（无要求）
 * - 字段存在但不是合法结构 → 抛 EligibilityError
 * - 字段包含非字符串项 → 抛 EligibilityError
 */
export function extractRequiredCapabilities(jsonValue: unknown): string[] {
 // 字段缺失 → 合同允许缺失，返回空数组
 if (jsonValue === null || jsonValue === undefined) return [];

 // 字段存在但不是对象 → 非法结构
 if (typeof jsonValue !== "object" || Array.isArray(jsonValue)) {
 throw new EligibilityError("capability_contract_invalid", "agentInterfaceRequirements 不是合法对象结构");
 }

 const obj = jsonValue as { required?: unknown };
 // required 字段缺失 → 等同于无要求
 if (obj.required === undefined || obj.required === null) return [];

 // required 存在但不是数组 → 非法结构
 if (!Array.isArray(obj.required)) {
 throw new EligibilityError("capability_contract_invalid", "agentInterfaceRequirements.required 不是数组");
 }

 // 检查数组每一项是否为字符串
 for (const item of obj.required) {
 if (typeof item !== "string") {
 throw new EligibilityError("capability_contract_invalid", "agentInterfaceRequirements.required 包含非字符串项");
 }
 }

 return obj.required.filter((c): c is string => c.length > 0);
}

/**
 * : 从 RuntimeRevision.runtimeCapabilitiesJson 提取 Capability 列表。
 *
 * Fail-closed 语义：
 * - 字段缺失 → []（Runtime 无能力声明）
 * - 字段存在但不是数组 → 抛 EligibilityError
 * - 数组包含非字符串项 → 抛 EligibilityError
 */
export function extractRuntimeCapabilities(jsonValue: unknown): string[] {
 // 字段缺失 → 无能力声明
 if (jsonValue === null || jsonValue === undefined) return [];

 // 字段存在但不是数组 → 非法结构
 if (!Array.isArray(jsonValue)) {
 throw new EligibilityError("runtime_capability_contract_invalid", "runtimeCapabilities 不是数组");
 }

 // 检查数组每一项是否为字符串
 for (const item of jsonValue) {
 if (typeof item !== "string") {
 throw new EligibilityError("runtime_capability_contract_invalid", "runtimeCapabilities 包含非字符串项");
 }
 }

 return (jsonValue as unknown[]).filter((c: unknown): c is string => typeof c === "string" && c.length > 0);
}

// ─── Errors ───────────────────────────────────────────────

/** 执行资格错误（: Capability 解析 fail-closed 时抛出）。 */
export class EligibilityError extends Error {
 constructor(
 public readonly code: string,
 message: string,
 ) {
 super(message);
 this.name = "EligibilityError";
 }
}
