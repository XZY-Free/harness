/**
 * Runtime Conformance 合同唯一入口。
 *
 * 所有消费者（PublicationPolicy、ConformanceRun、MySQL Store、Runner、测试）
 * 必须引用此合同，不得硬编码 Case ID、Case 数量或 Suite Revision。
 *
 * 事实源：../v11-agentkit-platform/contracts/runtime-conformance.json
 */

export const CONFORMANCE_SUITE_REVISION = "runtime-conformance@1";

export const ALL_CONFORMANCE_CASES = [
  "dispatch-binds-immutable-config",
  "event-batch-idempotent",
  "event-payload-hash-conflict",
  "attempt-sequence-continuity",
  "steer-requires-ack",
  "unsupported-steer",
  "cancel-request-not-terminal",
  "tool-schema-refresh",
  "unknown-effect-no-replay",
  "capability-search-not-use",
  "memory-proposal-only",
  "child-thread-isolation",
  "child-cancel-requires-ack",
  "credential-never-in-model-data",
  "execution-ownership-epoch",
  "session-does-not-claim-filesystem-recovery",
] as const;

export type ConformanceCaseId = (typeof ALL_CONFORMANCE_CASES)[number];

export const MANDATORY_GATE_CASES: readonly ConformanceCaseId[] = ALL_CONFORMANCE_CASES;

export interface ConformanceCaseResult {
  caseId: ConformanceCaseId;
  passed: boolean;
  reason?: string;
}

export interface ConformanceGateResult {
  passed: boolean;
  failedCases: ConformanceCaseId[];
}

export function validateConformanceGate(results: ConformanceCaseResult[]): ConformanceGateResult {
  const resultMap = new Map(results.map((result) => [result.caseId, result]));
  const failedCases = MANDATORY_GATE_CASES.filter((caseId) => !resultMap.get(caseId)?.passed);
  return { passed: failedCases.length === 0, failedCases };
}

/**
 * 校验完整的 Conformance 结果与 RuntimeRevision 绑定一致。
 *
 * 包括：Case 完整性（恰好 ALL_CONFORMANCE_CASES 个）、全部通过。
 * 绑定一致性（Artifact Digest、Config Digest、Protocol Contract Revision）
 * 由 Store 层 FOR UPDATE 读取时校验，此处只校验结果完整性。
 */
export function validateCompleteConformanceResult(
  results: Array<{ caseId: string; passed: boolean }>,
): { valid: true } | { valid: false; reason: string } {
  if (results.length !== ALL_CONFORMANCE_CASES.length) {
    return {
      valid: false,
      reason: `Conformance 结果不完整：期望 ${ALL_CONFORMANCE_CASES.length} 个 Case，实际 ${results.length} 个`,
    };
  }
  const caseIdSet = new Set(results.map((r) => r.caseId));
  for (const caseId of ALL_CONFORMANCE_CASES) {
    if (!caseIdSet.has(caseId)) {
      return {
        valid: false,
        reason: `Conformance 结果缺少必要 Case: ${caseId}`,
      };
    }
  }
  const failedCase = results.find((r) => !r.passed);
  if (failedCase) {
    return {
      valid: false,
      reason: `Conformance Case 失败: ${failedCase.caseId}`,
    };
  }
  return { valid: true };
}
