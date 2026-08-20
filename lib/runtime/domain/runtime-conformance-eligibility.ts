/**
 * Runtime Publication Conformance 统一资格验证 — 单一纯函数。
 *
 * 校验以下内容：
 * - Run 存在
 * - Run 属于 Tenant（期望值来自当前 RuntimeRevision）
 * - Run 属于 RuntimeRevision
 * - Overall Passed
 * - Artifact Digest 一致
 * - Config Digest 一致
 * - Protocol Contract 一致
 * - Suite Revision 一致
 * - Publication Case 集合精确等于 PUBLICATION_CONFORMANCE_CASES
 *   （缺失、重复、未知 Case ID 一律失败，即使数量正确且全部 passed）
 * - Case 唯一
 * - 全部 Passed
 * - 验证格式允许
 *
 * 缺失值显式 null 并 fail-closed，禁止用空字符串兜底。
 *
 * RouteSet 激活、Projection、Binding 必须通过
 * RevisionExecutionEligibilityPolicy 间接调用此验证器，不得各自实现第二套。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案
 */

import {
  PUBLICATION_CONFORMANCE_CASES,
  PUBLICATION_CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtime/domain/runtime-conformance-contract";

/**
 * 原始 Conformance Run 事实（DB 读取，缺失字段显式 null）。
 */
export interface RuntimeConformanceRunFact {
  /** Run ID。 */
  runId: string;
  /** 租户 ID。 */
  tenantId: string;
  /** RuntimeRevision ID。 */
  runtimeRevisionId: string;
  /** 整体结果。 */
  overallResult: "passed" | "failed" | "error" | "cancelled";
  /** Runtime Artifact Digest（缺失 = null）。 */
  runtimeArtifactDigest: string | null;
  /** Runtime Config Digest（缺失 = null）。 */
  runtimeConfigDigest: string | null;
  /** Protocol Contract Revision（缺失 = null）。 */
  protocolContractRevision: string | null;
  /** Suite Revision（缺失 = null）。 */
  suiteRevision: string | null;
  /** Conformance 格式（缺失 = null）。 */
  conformanceFormat: "standard_dsse" | null;
}

/**
 * 从当前 RuntimeRevision 真实读取的期望值（缺失显式 null）。
 */
export interface RuntimeConformanceExpectedValues {
  tenantId: string;
  runtimeRevisionId: string;
  runtimeArtifactDigest: string | null;
  runtimeConfigDigest: string | null;
  protocolContractRevision: string | null;
  /** 允许的 Conformance 格式。 */
  allowedFormats: "standard_dsse"[];
}

/**
 * 原始 Run/Case 事实（不含期望值）— 由低层 Reader 产出。
 */
export interface RuntimeConformanceFacts {
  run: RuntimeConformanceRunFact | null;
  caseResults: Array<{ caseId: string; passed: boolean }>;
}

/**
 * 规范化 Runtime Publication Conformance Evidence —
 * 原始 Run/Case 事实 + 从当前 RuntimeRevision 读取的期望值。
 */
export interface RuntimeConformanceEvidence {
  /** 原始 Run 事实（null = 无有效 ConformanceRun）。 */
  run: RuntimeConformanceRunFact | null;
  /** 原始 Case 结果。 */
  caseResults: Array<{ caseId: string; passed: boolean }>;
  /** 期望值。 */
  expected: RuntimeConformanceExpectedValues;
}

/**
 * Conformance 校验结果。
 */
export interface RuntimeConformanceResult {
  valid: boolean;
  errors: RuntimeConformanceError[];
}

/** Conformance 校验错误。 */
export interface RuntimeConformanceError {
  code: RuntimeConformanceErrorCode;
  message: string;
}

/** Conformance 校验错误码。 */
export type RuntimeConformanceErrorCode =
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
 * 单一纯函数 — 校验规范化 Runtime Publication Conformance Evidence。
 *
 * 缺失值（null）一律 fail-closed，不得用空字符串兜底。
 * 未知 Case ID 即使全部 passed 也必须失败。
 */
export function validateRuntimePublicationConformanceEvidence(
  evidence: RuntimeConformanceEvidence | null,
): RuntimeConformanceResult {
  if (!evidence || !evidence.run) {
    return {
      valid: false,
      errors: [{ code: "conformance_run_not_found", message: "ConformanceRun 不存在" }],
    };
  }

  const { run, caseResults, expected } = evidence;
  const errors: RuntimeConformanceError[] = [];

  // Tenant 一致
  if (run.tenantId !== expected.tenantId) {
    errors.push({
      code: "conformance_tenant_mismatch",
      message: `ConformanceRun 租户不一致（Run: ${run.tenantId}, 期望: ${expected.tenantId}）`,
    });
  }

  // Revision 绑定一致
  if (run.runtimeRevisionId !== expected.runtimeRevisionId) {
    errors.push({
      code: "conformance_revision_mismatch",
      message: `ConformanceRun 绑定其他 Revision（${run.runtimeRevisionId}）`,
    });
  }

  // Overall Passed
  if (run.overallResult !== "passed") {
    errors.push({
      code: "conformance_not_passed",
      message: `ConformanceRun 未通过（overallResult: ${run.overallResult}）`,
    });
  }

  // Artifact Digest 一致（期望缺失 → fail-closed）
  if (
    expected.runtimeArtifactDigest === null ||
    run.runtimeArtifactDigest !== expected.runtimeArtifactDigest
  ) {
    errors.push({
      code: "conformance_artifact_digest_mismatch",
      message: `Artifact Digest 不一致（Run: ${run.runtimeArtifactDigest}, 期望: ${expected.runtimeArtifactDigest}）`,
    });
  }

  // Config Digest 一致（期望缺失 → fail-closed）
  if (
    expected.runtimeConfigDigest === null ||
    run.runtimeConfigDigest !== expected.runtimeConfigDigest
  ) {
    errors.push({
      code: "conformance_config_digest_mismatch",
      message: `Config Digest 不一致（Run: ${run.runtimeConfigDigest}, 期望: ${expected.runtimeConfigDigest}）`,
    });
  }

  // Protocol Contract 一致（期望缺失 → fail-closed）
  if (
    expected.protocolContractRevision === null ||
    run.protocolContractRevision !== expected.protocolContractRevision
  ) {
    errors.push({
      code: "conformance_protocol_mismatch",
      message: `Protocol Contract 不一致（Run: ${run.protocolContractRevision}, 期望: ${expected.protocolContractRevision}）`,
    });
  }

  // Suite Revision 一致
  if (run.suiteRevision !== PUBLICATION_CONFORMANCE_SUITE_REVISION) {
    errors.push({
      code: "conformance_suite_revision_mismatch",
      message: `Suite Revision 不一致（Run: ${run.suiteRevision}, 期望: ${PUBLICATION_CONFORMANCE_SUITE_REVISION}）`,
    });
  }

  // 格式允许（缺失 → fail-closed）
  const allowedFormats = expected.allowedFormats ?? [];
  if (run.conformanceFormat === null || !allowedFormats.includes(run.conformanceFormat)) {
    errors.push({
      code: "conformance_format_not_allowed",
      message: `Conformance 格式 ${run.conformanceFormat} 在当前阶段不允许`,
    });
  }

  // Publication Case 集合精确
  if (caseResults.length !== PUBLICATION_CONFORMANCE_CASES.length) {
    errors.push({
      code: "conformance_cases_incomplete",
      message: `Conformance 结果不完整（期望 ${PUBLICATION_CONFORMANCE_CASES.length} 个 Case，实际 ${caseResults.length} 个）`,
    });
  }

  // Case 唯一
  const caseIdSet = new Set(caseResults.map((c) => c.caseId));
  if (caseIdSet.size !== caseResults.length) {
    errors.push({
      code: "conformance_cases_not_unique",
      message: "Conformance Case ID 存在重复",
    });
  }

  // 未知 Case ID — 即使全部 passed 也必须失败
  const knownCaseSet = new Set<string>(PUBLICATION_CONFORMANCE_CASES);
  const unknownCase = caseResults.find((c) => !knownCaseSet.has(c.caseId));
  if (unknownCase) {
    errors.push({
      code: "conformance_cases_incomplete",
      message: `Conformance 结果包含未知 Case: ${unknownCase.caseId}`,
    });
  }

  // 全部已知 Case 必须存在
  for (const caseId of PUBLICATION_CONFORMANCE_CASES) {
    if (!caseIdSet.has(caseId)) {
      errors.push({
        code: "conformance_cases_incomplete",
        message: `Conformance 结果缺少必要 Case: ${caseId}`,
      });
    }
  }

  // 全部 Passed
  const failedCases = caseResults.filter((c) => !c.passed);
  if (failedCases.length > 0) {
    errors.push({
      code: "conformance_case_failed",
      message: `Conformance Case 失败: ${failedCases.map((c) => c.caseId).join(", ")}`,
    });
  }

  return { valid: errors.length === 0, errors };
}
