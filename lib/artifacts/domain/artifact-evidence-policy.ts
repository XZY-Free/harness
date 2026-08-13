/**
 * Artifact Evidence 统一资格策略 — 三个明确入口。
 *
 * 所有 Attestation 资格判断集中于此，
 * Store、Publication、Resolver 不得分别增加新的判断实现。
 *
 * 三个入口共享基础规则：
 * - Tenant 一致
 * - Artifact Type 一致
 * - Revision 绑定一致
 * - Artifact ID 存在
 * - Verified
 * - 未撤销
 * - Digest 一致
 * - 格式允许
 *
 * 各入口可以增加不同要求，但不得复制基础规则。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案
 */

import type {
 ArtifactEvidenceErrorCode,
 ArtifactEvidenceSnapshot,
 ArtifactEvidenceValidationError,
 ArtifactEvidenceValidationResult,
 ArtifactType,
 AttestationFormat,
} from "./artifact-evidence";

// ─── 配置 ─────────────────────────────────────────────────

export interface ArtifactEvidencePolicyConfig {
 /** 发布允许的 Attestation 格式。 */
 allowedFormatsForPublication: AttestationFormat[];
 /** Route 激活允许的 Attestation 格式。 */
 allowedFormatsForRouteActivation: AttestationFormat[];
 /** 执行允许的 Attestation 格式。 */
 allowedFormatsForExecution: AttestationFormat[];
}

const DEFAULT_CONFIG: ArtifactEvidencePolicyConfig = {
 allowedFormatsForPublication: ["in_toto_dsse"],
 allowedFormatsForRouteActivation: ["in_toto_dsse"],
 allowedFormatsForExecution: ["in_toto_dsse"],
};

// ─── 基础规则 ────────────────────────────────────────────

function validateBaseRules(
 snapshot: ArtifactEvidenceSnapshot,
 context: {
 expectedTenantId: string;
 expectedArtifactType: ArtifactType;
 expectedRevisionId: string;
 expectedDigest: string | null;
 },
 allowedFormats: AttestationFormat[],
): ArtifactEvidenceValidationError[] {
 const errors: ArtifactEvidenceValidationError[] = [];

 if (snapshot.tenantId !== context.expectedTenantId) {
 errors.push({
 code: "evidence_tenant_mismatch",
 message: `租户不一致（Attestation: ${snapshot.tenantId}, 期望: ${context.expectedTenantId}）`,
 });
 }

 if (snapshot.artifactType !== context.expectedArtifactType) {
 errors.push({
 code: "evidence_artifact_type_mismatch",
 message: `制品类型不一致（Attestation: ${snapshot.artifactType}, 期望: ${context.expectedArtifactType}）`,
 });
 }

 if (snapshot.artifactRevisionId !== context.expectedRevisionId) {
 errors.push({
 code: "evidence_revision_binding_mismatch",
 message: `Attestation 绑定其他 Revision（${snapshot.artifactRevisionId}，期望: ${context.expectedRevisionId}）`,
 });
 }

 if (!snapshot.artifactId) {
 errors.push({
 code: "evidence_missing_artifact_id",
 message: "Attestation 未引用权威 Artifact",
 });
 }

 if (snapshot.verificationState !== "verified") {
 errors.push({
 code: "evidence_not_verified",
 message: `验证状态不是 verified（实际: ${snapshot.verificationState}）`,
 });
 }

 if (snapshot.revokedAt !== null) {
 errors.push({
 code: "evidence_revoked",
 message: "Attestation 已撤销",
 });
 }

 if (context.expectedDigest !== null && snapshot.artifactDigest !== context.expectedDigest) {
 errors.push({
 code: "evidence_digest_mismatch",
 message: `Artifact Digest 不一致（Attestation: ${snapshot.artifactDigest}, 期望: ${context.expectedDigest}）`,
 });
 }

 if (!allowedFormats.includes(snapshot.attestationFormat)) {
 errors.push({
 code: "evidence_format_not_allowed",
 message: `Attestation 格式 ${snapshot.attestationFormat} 在当前阶段不允许（允许: ${allowedFormats.join(", ")}）`,
 });
 }

 return errors;
}

// ─── 策略入口 ────────────────────────────────────────────

/**
 * 创建 Artifact Evidence 统一资格策略。
 */
export function createArtifactEvidencePolicy(
 configOverrides?: Partial<ArtifactEvidencePolicyConfig>,
) {
 const config = { ...DEFAULT_CONFIG, ...configOverrides };

 return {
 /**
 * 入口 1：发布资格校验。
 *
 * 供 Agent 和 Runtime 的 PublishRevision 使用。
 * 基础规则 + 格式允许检查。
 */
 validateForPublication(
 snapshot: ArtifactEvidenceSnapshot,
 context: {
 expectedTenantId: string;
 expectedArtifactType: ArtifactType;
 expectedRevisionId: string;
 expectedDigest: string | null;
 },
 ): ArtifactEvidenceValidationResult {
 const errors = validateBaseRules(snapshot, context, config.allowedFormatsForPublication);
 return { valid: errors.length === 0, errors };
 },

 /**
 * 入口 2：Route 激活资格校验。
 *
 * 供 ActivateRouteSet 使用。
 * 基础规则 + 格式允许检查。
 * 当前与发布相同，未来可能增加额外约束（如要求 in-toto 格式）。
 */
 validateForRouteActivation(
 snapshot: ArtifactEvidenceSnapshot,
 context: {
 expectedTenantId: string;
 expectedArtifactType: ArtifactType;
 expectedRevisionId: string;
 expectedDigest: string | null;
 },
 ): ArtifactEvidenceValidationResult {
 const errors = validateBaseRules(snapshot, context, config.allowedFormatsForRouteActivation);
 return { valid: errors.length === 0, errors };
 },

 /**
 * 入口 3：新执行资格校验。
 *
 * 供 ExecutionBinding 创建使用。
 * 基础规则 + 格式允许检查。
 */
 validateForNewExecution(
 snapshot: ArtifactEvidenceSnapshot,
 context: {
 expectedTenantId: string;
 expectedArtifactType: ArtifactType;
 expectedRevisionId: string;
 expectedDigest: string | null;
 },
 ): ArtifactEvidenceValidationResult {
 const errors = validateBaseRules(snapshot, context, config.allowedFormatsForExecution);
 return { valid: errors.length === 0, errors };
 },
 };
}

/**
 * 默认策略实例 — 零配置即可使用。
 */
export const ArtifactEvidencePolicy = createArtifactEvidencePolicy();
