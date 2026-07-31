/**
 * V11 Runtime Conformance 门禁。
 *
 * 事实源：../v11-agentkit-platform/contracts/runtime-conformance.json（16 个 required_cases）、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W02。
 *
 * 职责：
 * - MANDATORY_GATE_CASES：发布 RuntimeRevision 前必须通过的 4 个基础用例
 *   （基础身份/调度、事件幂等、取消、Credential 隔离）。
 * - validateConformanceGate：校验门禁结果，任一 mandatory case 失败则 Revision 不可路由。
 * - isCapabilitySubset：路由发布时校验 Agent required capabilities ⊆ Runtime capabilities。
 *
 * S03-W02 约束：
 * - capabilities 必须来自探测和一致性测试，管理员不能手工勾选未支持能力。
 * - 基础身份、事件幂等、取消和 Credential 隔离用例失败时，Revision 不得可路由。
 */

/** 16 个 conformance case id（来自 runtime-conformance.json）。 */
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

/**
 * 发布门禁必须通过的 4 个基础用例。
 *
 * 对应 S03-W02："基础身份、事件幂等、取消和 Credential 隔离用例失败时，Revision 不得可路由"。
 * - dispatch-binds-immutable-config：基础身份/调度（ExecutionBinding 不可变）。
 * - event-batch-idempotent：事件幂等。
 * - cancel-request-not-terminal：取消语义（cancel 非终态，需 Runtime ack）。
 * - credential-never-in-model-data：Credential 隔离（密文不进入模型数据）。
 */
export const MANDATORY_GATE_CASES: readonly ConformanceCaseId[] = [
  "dispatch-binds-immutable-config",
  "event-batch-idempotent",
  "cancel-request-not-terminal",
  "credential-never-in-model-data",
];

/** 单个 conformance case 的结果。 */
export interface ConformanceCaseResult {
  caseId: ConformanceCaseId;
  passed: boolean;
  /** 失败原因（passed=false 时必填）。 */
  reason?: string;
}

/** Conformance 门禁校验结果。 */
export interface ConformanceGateResult {
  passed: boolean;
  /** 失败的 mandatory case id 列表。 */
  failedCases: ConformanceCaseId[];
}

/**
 * 校验 conformance 门禁：所有 mandatory case 必须通过。
 *
 * @param results 探测/一致性测试结果列表。
 * @returns passed=true 表示门禁通过，Revision 可发布；passed=false 表示门禁失败。
 */
export function validateConformanceGate(results: ConformanceCaseResult[]): ConformanceGateResult {
  const resultMap = new Map<ConformanceCaseId, ConformanceCaseResult>();
  for (const r of results) {
    resultMap.set(r.caseId, r);
  }

  const failedCases: ConformanceCaseId[] = [];
  for (const mandatoryCase of MANDATORY_GATE_CASES) {
    const result = resultMap.get(mandatoryCase);
    if (!result || !result.passed) {
      failedCases.push(mandatoryCase);
    }
  }

  return {
    passed: failedCases.length === 0,
    failedCases,
  };
}

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

/** Conformance 门禁失败错误。 */
export class ConformanceGateError extends Error {
  constructor(public readonly failedCases: ConformanceCaseId[]) {
    super(`Conformance 门禁失败，缺失/失败的 mandatory case：${failedCases.join(", ")}`);
    this.name = "ConformanceGateError";
  }
}
