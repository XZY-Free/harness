/**
 * Runtime Conformance 统一资格模型。
 *
 * 统一检查：
 * - Run 存在
 * - Run 属于 Tenant
 * - Run 属于 RuntimeRevision
 * - Overall Passed
 * - Artifact Digest 一致
 * - Config Digest 一致
 * - Protocol Contract 一致
 * - Suite Revision 一致
 * - 16 个 Case 完整
 * - Case 唯一
 * - 全部 Passed
 * - 验证格式符合当前 Policy
 *
 * 所有模块（RouteSet 激活、Projection、Binding）
 * 必须通过此模型判断 Conformance 资格，不得各自实现。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §1.3
 */

import {
  ALL_CONFORMANCE_CASES,
  CONFORMANCE_SUITE_REVISION,
  type ConformanceCaseId,
} from "@/lib/runtimes/domain/runtime-conformance-contract";

/**
 * Conformance 资格快照 — Store 读取的完整 Conformance 事实。
 */
export interface ConformanceEligibilitySnapshot {
  /** Run ID。 */
  runId: string;
  /** 租户 ID。 */
  tenantId: string;
  /** RuntimeRevision ID。 */
  runtimeRevisionId: string;
  /** 整体结果。 */
  overallResult: "passed" | "failed" | "error" | "cancelled";
  /** Runtime Artifact Digest。 */
  runtimeArtifactDigest: string;
  /** Runtime Config Digest。 */
  runtimeConfigDigest: string;
  /** Protocol Contract Revision。 */
  protocolContractRevision: string;
  /** Suite Revision。 */
  suiteRevision: string;
  /** Conformance 格式。 */
  conformanceFormat: "legacy_hmac" | "standard_dsse";
  /** Case 结果列表。 */
  caseResults: Array<{ caseId: string; passed: boolean }>;
}

/**
 * Conformance 资格校验结果。
 */
export interface ConformanceEligibilityResult {
  eligible: boolean;
  errors: ConformanceEligibilityError[];
}

/** Conformance 资格错误。 */
export interface ConformanceEligibilityError {
  code: ConformanceEligibilityErrorCode;
  message: string;
}

/** Conformance 资格错误码。 */
export type ConformanceEligibilityErrorCode =
  | "conformance_run_not_found"
  | "conformance_tenant_mismatch"
  | "conformance_revision_mismatch"
  | "conformance_not_passed"
  | "conformance_artifact_digest_mismatch"
  | "conformance_config_digest_mismatch"
  | "conformance_protocol_mismatch"
  | "conformance_suite_revision_mismatch"
  | "conformance_cases_incomplete"
  | "conformance_cases_not_unique"
  | "conformance_case_failed"
  | "conformance_format_not_allowed";

/**
 * Conformance 资格校验期望值。
 */
export interface ConformanceEligibilityExpectation {
  expectedTenantId: string;
  expectedRuntimeRevisionId: string;
  expectedRuntimeArtifactDigest: string;
  expectedRuntimeConfigDigest: string;
  expectedProtocolContractRevision: string;
  /** 允许的 Conformance 格式。过渡期含 legacy_hmac，正式期排除。 */
  allowedFormats: ("legacy_hmac" | "standard_dsse")[];
}

const DEFAULT_ALLOWED_FORMATS: ("legacy_hmac" | "standard_dsse")[] = [
  "legacy_hmac",
  "standard_dsse",
];

/**
 * Conformance 资格策略 — 纯函数，无副作用。
 */
export const ConformanceEligibilityPolicy = {
  /**
   * 判断 Conformance Run 是否满足执行资格。
   */
  isEligible(
    snapshot: ConformanceEligibilitySnapshot | null,
    expectation: ConformanceEligibilityExpectation,
  ): ConformanceEligibilityResult {
    const errors: ConformanceEligibilityError[] = [];

    if (!snapshot) {
      return {
        eligible: false,
        errors: [{ code: "conformance_run_not_found", message: "ConformanceRun 不存在" }],
      };
    }

    // Tenant 一致
    if (snapshot.tenantId !== expectation.expectedTenantId) {
      errors.push({
        code: "conformance_tenant_mismatch",
        message: `ConformanceRun 租户不一致（Run: ${snapshot.tenantId}, 期望: ${expectation.expectedTenantId}）`,
      });
    }

    // Revision 绑定一致
    if (snapshot.runtimeRevisionId !== expectation.expectedRuntimeRevisionId) {
      errors.push({
        code: "conformance_revision_mismatch",
        message: `ConformanceRun 绑定其他 Revision（${snapshot.runtimeRevisionId}）`,
      });
    }

    // Overall Passed
    if (snapshot.overallResult !== "passed") {
      errors.push({
        code: "conformance_not_passed",
        message: `ConformanceRun 未通过（overallResult: ${snapshot.overallResult}）`,
      });
    }

    // Artifact Digest 一致
    if (snapshot.runtimeArtifactDigest !== expectation.expectedRuntimeArtifactDigest) {
      errors.push({
        code: "conformance_artifact_digest_mismatch",
        message: `Artifact Digest 不一致（Run: ${snapshot.runtimeArtifactDigest}, 期望: ${expectation.expectedRuntimeArtifactDigest}）`,
      });
    }

    // Config Digest 一致
    if (snapshot.runtimeConfigDigest !== expectation.expectedRuntimeConfigDigest) {
      errors.push({
        code: "conformance_config_digest_mismatch",
        message: `Config Digest 不一致（Run: ${snapshot.runtimeConfigDigest}, 期望: ${expectation.expectedRuntimeConfigDigest}）`,
      });
    }

    // Protocol Contract 一致
    if (snapshot.protocolContractRevision !== expectation.expectedProtocolContractRevision) {
      errors.push({
        code: "conformance_protocol_mismatch",
        message: `Protocol Contract 不一致（Run: ${snapshot.protocolContractRevision}, 期望: ${expectation.expectedProtocolContractRevision}）`,
      });
    }

    // Suite Revision 一致
    if (snapshot.suiteRevision !== CONFORMANCE_SUITE_REVISION) {
      errors.push({
        code: "conformance_suite_revision_mismatch",
        message: `Suite Revision 不一致（Run: ${snapshot.suiteRevision}, 期望: ${CONFORMANCE_SUITE_REVISION}）`,
      });
    }

    // 16 个 Case 完整
    if (snapshot.caseResults.length !== ALL_CONFORMANCE_CASES.length) {
      errors.push({
        code: "conformance_cases_incomplete",
        message: `Conformance 结果不完整（期望 ${ALL_CONFORMANCE_CASES.length} 个 Case，实际 ${snapshot.caseResults.length} 个）`,
      });
    }

    // Case 唯一
    const caseIdSet = new Set(snapshot.caseResults.map((c) => c.caseId));
    if (caseIdSet.size !== snapshot.caseResults.length) {
      errors.push({
        code: "conformance_cases_not_unique",
        message: "Conformance Case ID 存在重复",
      });
    }

    // 全部 Passed
    const failedCases = snapshot.caseResults.filter((c) => !c.passed);
    if (failedCases.length > 0) {
      errors.push({
        code: "conformance_case_failed",
        message: `Conformance Case 失败: ${failedCases.map((c) => c.caseId).join(", ")}`,
      });
    }

    // 格式允许
    const allowedFormats = expectation.allowedFormats ?? DEFAULT_ALLOWED_FORMATS;
    if (!allowedFormats.includes(snapshot.conformanceFormat)) {
      errors.push({
        code: "conformance_format_not_allowed",
        message: `Conformance 格式 ${snapshot.conformanceFormat} 在当前阶段不允许`,
      });
    }

    return { eligible: errors.length === 0, errors };
  },
} as const;
