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

import {
  RUNTIME_PROTOCOL_CONFORMANCE_CASES,
  RUNTIME_PROTOCOL_RECEIPT_KEYS,
  type RuntimeProtocolConformanceCase,
} from "@/lib/runtime/protocol-conformance";

/** Publication Conformance 套件修订号（Protocol/Adapter 合同语义，非研究编号）。 */
export const PUBLICATION_CONFORMANCE_SUITE_REVISION = "runtime-conformance@2";

/**
 * Adapter 边界上的声明式用例（原有 6 条）：能力清单合同、dispatch/cancel/steer/
 * resume ack、session 恢复声明。
 */
export const PUBLICATION_DECLARATION_CASE_IDS = [
  "capability-manifest-contract",
  "dispatch-acknowledgement",
  "cancel-acknowledgement",
  "steer-capability-consistency",
  "resume-capability-consistency",
  "session-recovery-declaration",
] as const;

export type PublicationDeclarationCaseId = (typeof PUBLICATION_DECLARATION_CASE_IDS)[number];

/**
 * Publication Conformance 的唯一 Case 全集（13 个，严格唯一、全部必过）。
 *
 * 由「声明式用例」与「RuntimeProtocol 行为清单」**组合**而成，不再各自维护一份
 * 平行 case 列表 —— R10 §3 的「旧 Publication case 全集与新协议 required behavior
 * 清单脱节」由此闭合：行为清单是唯一权威，发布准入必须逐条追溯到实际调用回执。
 */
export const PUBLICATION_CONFORMANCE_CASES = [
  ...PUBLICATION_DECLARATION_CASE_IDS,
  ...RUNTIME_PROTOCOL_CONFORMANCE_CASES,
] as const;

export type PublicationConformanceCaseId =
  | PublicationDeclarationCaseId
  | RuntimeProtocolConformanceCase;

/**
 * 每个行为 case 必须携带的真实调用回执字段。
 *
 * 声明式用例的回执要求（`response` / `declared` 等）由 Runner 的证据对象承载；
 * 行为 case 的要求直接复用 RuntimeProtocol 的机器清单，避免第二份定义。
 */
export const PUBLICATION_BEHAVIOR_RECEIPT_KEYS: Record<RuntimeProtocolConformanceCase, string[]> =
  RUNTIME_PROTOCOL_RECEIPT_KEYS;

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
