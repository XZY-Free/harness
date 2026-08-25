/**
 * validateRuntimePublicationConformanceEvidence 纯逻辑单元测试。
 *
 * 覆盖统一 Runtime Publication Conformance 验证的完整语义：
 * - null evidence / null run fail-closed
 * - 完整精确 6 Case + 全部 digest/tenant/revision/protocol/suite/format 一致 → valid
 * - overall failed
 * - tenant/revision/artifact/config/protocol/suite/format 每一类漂移
 * - 缺 Case、重复 Case、某 Case failed
 * - 保持数量 6 且全部 passed 但用 unknown case 替换正式 Case → 必须 invalid
 *   （同时能识别缺少正式 Case）
 * - expected digest/protocol 为 null 时 fail-closed
 *
 * 错误可能多条，不依赖顺序，断言 code 集合/包含。
 * fixtures 全部为真实类型，禁止 as any、禁止 placeholder sha256:000。
 */

import {
  PUBLICATION_CONFORMANCE_CASES,
  PUBLICATION_CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  type RuntimeConformanceEvidence,
  type RuntimeConformanceExpectedValues,
  type RuntimeConformanceResult,
  type RuntimeConformanceRunFact,
  validateRuntimePublicationConformanceEvidence,
} from "@/lib/runtime/domain/runtime-conformance-eligibility";
import { describe, expect, it } from "vitest";

const TENANT_ID = "tenant-1";
const RUNTIME_REVISION_ID = "runtime-revision-1";
const RUN_ID = "conformance-run-1";
const ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}`;
const CONFIG_DIGEST = `sha256:${"b".repeat(64)}`;
const PROTOCOL = "agent-runtime-protocol@1";

function makeCaseResults(
  caseIds: readonly string[],
  passed = true,
): Array<{ caseId: string; passed: boolean }> {
  return caseIds.map((caseId) => ({ caseId, passed }));
}

function makeExpected(
  overrides: Partial<RuntimeConformanceExpectedValues> = {},
): RuntimeConformanceExpectedValues {
  return {
    tenantId: TENANT_ID,
    runtimeRevisionId: RUNTIME_REVISION_ID,
    runtimeTargetDigest: ARTIFACT_DIGEST,
    runtimeConfigDigest: CONFIG_DIGEST,
    protocolContractRevision: PROTOCOL,
    allowedFormats: ["standard_dsse"],
    ...overrides,
  };
}

function makeEvidence(
  overrides: {
    runNull?: boolean;
    run?: Partial<RuntimeConformanceRunFact>;
    caseResults?: Array<{ caseId: string; passed: boolean }>;
    expected?: Partial<RuntimeConformanceExpectedValues>;
  } = {},
): RuntimeConformanceEvidence {
  if (overrides.runNull) {
    return { run: null, caseResults: [], expected: makeExpected(overrides.expected) };
  }
  return {
    run: {
      runId: RUN_ID,
      tenantId: TENANT_ID,
      runtimeRevisionId: RUNTIME_REVISION_ID,
      overallResult: "passed",
      runtimeTargetDigest: ARTIFACT_DIGEST,
      runtimeConfigDigest: CONFIG_DIGEST,
      protocolContractRevision: PROTOCOL,
      suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
      conformanceFormat: "standard_dsse",
      ...overrides.run,
    },
    caseResults: overrides.caseResults ?? makeCaseResults(PUBLICATION_CONFORMANCE_CASES),
    expected: makeExpected(overrides.expected),
  };
}

function codes(result: RuntimeConformanceResult): string[] {
  return result.errors.map((error) => error.code);
}

describe("validateRuntimePublicationConformanceEvidence", () => {
  it("null evidence fail-closed → conformance_run_not_found", () => {
    const result = validateRuntimePublicationConformanceEvidence(null);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_run_not_found");
  });

  it("run=null fail-closed → conformance_run_not_found", () => {
    const result = validateRuntimePublicationConformanceEvidence(makeEvidence({ runNull: true }));
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_run_not_found");
  });

  it("完整精确 6 Case 且全部 digest/tenant/revision/protocol/suite/format 一致 → valid", () => {
    const result = validateRuntimePublicationConformanceEvidence(makeEvidence());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("overallResult 非 passed → conformance_not_passed", () => {
    const result = validateRuntimePublicationConformanceEvidence(
      makeEvidence({ run: { overallResult: "failed" } }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_not_passed");
  });

  it("tenant 漂移 → conformance_tenant_mismatch", () => {
    const result = validateRuntimePublicationConformanceEvidence(
      makeEvidence({ run: { tenantId: "other-tenant" } }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_tenant_mismatch");
  });

  it("revision 漂移 → conformance_revision_mismatch", () => {
    const result = validateRuntimePublicationConformanceEvidence(
      makeEvidence({ run: { runtimeRevisionId: "other-revision" } }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_revision_mismatch");
  });

  it("runtime target digest 漂移 → conformance_target_digest_mismatch", () => {
    const result = validateRuntimePublicationConformanceEvidence(
      makeEvidence({ run: { runtimeTargetDigest: `sha256:${"c".repeat(64)}` } }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_target_digest_mismatch");
  });

  it("config digest 漂移 → conformance_config_digest_mismatch", () => {
    const result = validateRuntimePublicationConformanceEvidence(
      makeEvidence({ run: { runtimeConfigDigest: `sha256:${"d".repeat(64)}` } }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_config_digest_mismatch");
  });

  it("protocol contract 漂移 → conformance_protocol_mismatch", () => {
    const result = validateRuntimePublicationConformanceEvidence(
      makeEvidence({ run: { protocolContractRevision: "agent-runtime-protocol@2" } }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_protocol_mismatch");
  });

  it("suite revision 漂移 → conformance_suite_revision_mismatch", () => {
    const result = validateRuntimePublicationConformanceEvidence(
      makeEvidence({ run: { suiteRevision: "runtime-conformance@2" } }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_suite_revision_mismatch");
  });

  it("format 不在 allowedFormats → conformance_format_not_allowed", () => {
    const result = validateRuntimePublicationConformanceEvidence(
      makeEvidence({ expected: { allowedFormats: [] } }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_format_not_allowed");
  });

  it("缺 Case → conformance_cases_incomplete", () => {
    const result = validateRuntimePublicationConformanceEvidence(
      makeEvidence({ caseResults: makeCaseResults(PUBLICATION_CONFORMANCE_CASES.slice(1)) }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_cases_incomplete");
  });

  it("重复 Case → conformance_cases_not_unique", () => {
    const caseResults = makeCaseResults(PUBLICATION_CONFORMANCE_CASES);
    // 用第一个 Case 覆盖第二个 → 数量保持 6，但出现重复且缺少被覆盖的正式 Case。
    caseResults[1] = { caseId: PUBLICATION_CONFORMANCE_CASES[0], passed: true };
    const result = validateRuntimePublicationConformanceEvidence(makeEvidence({ caseResults }));
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_cases_not_unique");
  });

  it("某 Case failed → conformance_case_failed", () => {
    const caseResults = makeCaseResults(PUBLICATION_CONFORMANCE_CASES);
    caseResults[0] = { caseId: PUBLICATION_CONFORMANCE_CASES[0], passed: false };
    const result = validateRuntimePublicationConformanceEvidence(makeEvidence({ caseResults }));
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_case_failed");
  });

  it("数量 6 且全部 passed，但用 unknown case 替换正式 Case → 必须 invalid 且识别缺正式 Case", () => {
    const caseResults = makeCaseResults(PUBLICATION_CONFORMANCE_CASES.slice(0, -1));
    caseResults.push({ caseId: "unknown-case", passed: true });
    expect(caseResults).toHaveLength(PUBLICATION_CONFORMANCE_CASES.length);
    expect(caseResults.every((c) => c.passed)).toBe(true);

    const result = validateRuntimePublicationConformanceEvidence(makeEvidence({ caseResults }));
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_cases_incomplete");

    // 必须识别被替换掉的正式 Case。
    const missingCase = PUBLICATION_CONFORMANCE_CASES[
      PUBLICATION_CONFORMANCE_CASES.length - 1
    ] as string;
    const messages = result.errors.map((error) => error.message);
    expect(messages.some((message) => message.includes(missingCase))).toBe(true);
  });

  it("expected runtime target digest 为 null → fail closed → conformance_target_digest_mismatch", () => {
    const result = validateRuntimePublicationConformanceEvidence(
      makeEvidence({ expected: { runtimeTargetDigest: null } }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_target_digest_mismatch");
  });

  it("expected config digest 为 null → fail closed → conformance_config_digest_mismatch", () => {
    const result = validateRuntimePublicationConformanceEvidence(
      makeEvidence({ expected: { runtimeConfigDigest: null } }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_config_digest_mismatch");
  });

  it("expected protocol contract revision 为 null → fail closed → conformance_protocol_mismatch", () => {
    const result = validateRuntimePublicationConformanceEvidence(
      makeEvidence({ expected: { protocolContractRevision: null } }),
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain("conformance_protocol_mismatch");
  });
});
