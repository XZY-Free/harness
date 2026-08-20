/**
 * Runtime Revision Publication Conformance 门禁。
 *
 * 事实源：docs/contracts/runtime-conformance.json（Runtime Publication 套件）。
 *
 * 职责：
 * - PUBLICATION_CONFORMANCE_CASES：候选 RuntimeRevision 自身发布前必须通过的
 *   Adapter/Protocol 行为用例（能力清单合同、dispatch/cancel/steer/resume ack、
 *   session 恢复声明），全部真实调用 RuntimeAdapter 得到。
 * - validatePublicationConformanceGate：校验门禁结果，任一 case 失败则 Revision 不可发布。
 * - isCapabilitySubset：路由发布时校验 Agent required capabilities ⊆ Runtime capabilities。
 *
 * 约束：
 * - capabilities 必须来自探测和一致性测试，管理员不能手工勾选未支持能力。
 * - 可选能力（steer/resume）为 false 时只验证「不宣称支持」，不伪造成功。
 * - cancel 是发布基础能力，必须实际 ack。
 */

export {
  PUBLICATION_CONFORMANCE_CASES,
  PUBLICATION_CONFORMANCE_SUITE_REVISION,
  type PublicationConformanceCaseId,
  type PublicationConformanceCaseResult,
  type PublicationConformanceGateResult,
  validateCompletePublicationConformanceResult,
  validatePublicationConformanceGate,
} from "@/lib/runtime/domain/runtime-conformance-contract";

export { RuntimeConformanceCaseFailedError } from "@/lib/runtime/domain/runtime-revision-publication-policy";

export {
  computeCaseEvidenceDigest,
  computeEvidenceManifestDigest,
} from "@/lib/runtime/domain/runtime-conformance-run";

/**
 * 校验 Agent required capabilities 是否为 Runtime capabilities 的子集。
 *
 * 路由发布要求 Agent 的 required capabilities 是 Runtime capabilities 的子集；
 * optional 能力只影响功能可用性，不阻断发布。
 *
 * @param agentRequiredCapabilities Agent Revision 声明的 required capabilities。
 * @param runtimeCapabilities Runtime Revision 探测到的实际 capabilities。
 * @returns missing=空数组表示子集满足；非空表示缺失的 required capabilities。
 */
export function isCapabilitySubset(
  agentRequiredCapabilities: string[],
  runtimeCapabilities: string[],
): { satisfied: boolean; missing: string[] } {
  const runtimeSet = new Set(runtimeCapabilities);
  const missing = agentRequiredCapabilities.filter((cap) => !runtimeSet.has(cap));
  return {
    satisfied: missing.length === 0,
    missing,
  };
}
