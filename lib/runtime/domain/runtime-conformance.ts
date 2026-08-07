/**
 * Runtime Conformance 门禁。
 *
 * 事实源：../v11-agentkit-platform/contracts/runtime-conformance.json（16 个 required_cases）、
 * ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md 。
 *
 * 职责：
 * - MANDATORY_GATE_CASES：发布 RuntimeRevision 前必须通过的 4 个基础用例
 * （基础身份/调度、事件幂等、取消、Credential 隔离）。
 * - validateConformanceGate：校验门禁结果，任一 mandatory case 失败则 Revision 不可路由。
 * - isCapabilitySubset：路由发布时校验 Agent required capabilities ⊆ Runtime capabilities。
 *
 * 约束：
 * - capabilities 必须来自探测和一致性测试，管理员不能手工勾选未支持能力。
 * - 基础身份、事件幂等、取消和 Credential 隔离用例失败时，Revision 不得可路由。
 */

export {
 ALL_CONFORMANCE_CASES,
 MANDATORY_GATE_CASES,
 RuntimeConformanceCaseFailedError,
 type ConformanceCaseId,
 type ConformanceCaseResult,
 type ConformanceGateResult,
 validateConformanceGate,
} from "@/lib/runtime/domain/runtime-revision-publication-policy";

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
