/**
 * Runtime Revision Publication Conformance 合同唯一入口。
 *
 * 职责：候选 RuntimeRevision 自身是否符合 SnowHarness Runtime Protocol /
 * Adapter Contract，是否具备成为正式 Runtime 资产的资格。
 *
 * 本套件只验证未发布候选 Runtime 自身的 Adapter / Protocol 行为：
 * - 不包含需要 Route、Projection、ExecutionBinding、Invocation、Tool、Memory、
 *   Child Thread、ExecutionOwnership 的平台不变量（这些属于 Platform Integration
 *   Conformance，见 lib/platform-conformance）。
 * - 每项必须通过真实 RuntimeAdapter 方法调用或严格返回结构校验得到；不得用
 *   passed=true、capability 声明替代实际可调用行为、固定原因视为通过。
 * - 可选能力为 false 时只能验证「不宣称支持」，不能调用后伪造成功。
 * - cancel 是发布基础能力，必须实际 ack。
 *
 * 所有消费者（PublicationPolicy、ConformanceRun、MySQL Store、Runner、测试）
 * 必须引用此合同，不得硬编码 Case ID、Case 数量或 Suite Revision。
 *
 * 事实源：docs/contracts/runtime-conformance.json
 */

/** Publication Conformance 套件修订号（Protocol/Adapter 合同语义，非研究编号）。 */
export const PUBLICATION_CONFORMANCE_SUITE_REVISION = "runtime-conformance@1";

/** Publication Conformance 的唯一 Case 全集（6 个，严格唯一、全部必过）。 */
export const PUBLICATION_CONFORMANCE_CASES = [
  "capability-manifest-contract",
  "dispatch-acknowledgement",
  "cancel-acknowledgement",
  "steer-capability-consistency",
  "resume-capability-consistency",
  "session-recovery-declaration",
] as const;

export type PublicationConformanceCaseId = (typeof PUBLICATION_CONFORMANCE_CASES)[number];

export interface PublicationConformanceCaseResult {
  caseId: PublicationConformanceCaseId;
  passed: boolean;
  reason?: string;
  /**
   * 结构化真实证据对象（RFC8785-canonical-digestable）。
   *
   * 至少绑定 caseId、passed 与该 case 真实调用返回的关键字段/失败错误；
   * 不得只绑定布尔值。
   */
  evidence: Record<string, unknown>;
  /** evidence 的 RFC8785 canonical digest（sha256:hex）。 */
  evidenceDigest: string;
}

export interface PublicationConformanceGateResult {
  passed: boolean;
  failedCases: PublicationConformanceCaseId[];
}

export function validatePublicationConformanceGate(
  results: PublicationConformanceCaseResult[],
): PublicationConformanceGateResult {
  const resultMap = new Map(results.map((result) => [result.caseId, result]));
  const failedCases = PUBLICATION_CONFORMANCE_CASES.filter(
    (caseId) => !resultMap.get(caseId)?.passed,
  );
  return { passed: failedCases.length === 0, failedCases };
}

/**
 * 校验完整的 Publication Conformance 结果：Case 集合严格且唯一、全部通过。
 *
 * 缺少、重复、多余 Case 一律视为不完整；绑定一致性（Artifact Digest、Config
 * Digest、Protocol Contract Revision）由 Store 层 FOR UPDATE 读取时校验。
 */
export function validateCompletePublicationConformanceResult(
  results: Array<{ caseId: string; passed: boolean }>,
): { valid: true } | { valid: false; reason: string } {
  if (results.length !== PUBLICATION_CONFORMANCE_CASES.length) {
    return {
      valid: false,
      reason: `Publication Conformance 结果不完整：期望 ${PUBLICATION_CONFORMANCE_CASES.length} 个 Case，实际 ${results.length} 个`,
    };
  }
  const caseIdSet = new Set(results.map((r) => r.caseId));
  if (caseIdSet.size !== results.length) {
    return {
      valid: false,
      reason: "Publication Conformance Case ID 存在重复",
    };
  }
  for (const caseId of PUBLICATION_CONFORMANCE_CASES) {
    if (!caseIdSet.has(caseId)) {
      return {
        valid: false,
        reason: `Publication Conformance 结果缺少必要 Case: ${caseId}`,
      };
    }
  }
  const failedCase = results.find((r) => !r.passed);
  if (failedCase) {
    return {
      valid: false,
      reason: `Publication Conformance Case 失败: ${failedCase.caseId}`,
    };
  }
  return { valid: true };
}
