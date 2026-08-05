import type {
  CancelParams,
  ResumeParams,
  RuntimeAdapter,
  StartInvocationParams,
  SteerParams,
} from "@/lib/runtime/adapters/hosted-adapter";
import type { RuntimeCapabilitiesResponse } from "@/lib/runtime/runtime-client";
/**
 * V11 Runtime Conformance 测试 runner（S05-C06）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/contracts/runtime-conformance.json（16 个 required_cases）
 * - ../v11-agentkit-platform/15-machine-contracts.md §5 L94-110（conformance 门禁协议）
 * - ../v11-agentkit-platform-development-plan/05-runtime-protocol-dispatch-and-agent-loop.md S05-C06
 *
 * 职责：
 * - runConformanceSuite：对 RuntimeAdapter 运行 16 个 conformance case 的基础场景，
 *   返回 ConformanceCaseResult[]。
 * - 基础场景：仅通过 RuntimeAdapter 接口可验证的 case（不需要完整平台基础设施）。
 * - 无法在本地 Adapter probe 中实测的场景一律 fail-closed；本 runner 不产生权威 Passed Run。
 *
 * 16 个 case 分类：
 * - 9 个基础场景（adapter probe 可验证）：
 *   1. dispatch-binds-immutable-config：startInvocation 返回唯一 runtime_execution_ref
 *   2. event-batch-idempotent：probeCapabilities 声明 event_stream=true
 *   3. event-payload-hash-conflict：probeCapabilities 声明 event_stream=true（hash 冲突由平台 ingress 强制）
 *   4. attempt-sequence-continuity：startInvocation 每次返回新 runtime_execution_ref
 *   5. steer-requires-ack：handleSteer 返回 accepted + applies_at=next_safe_point
 *   6. unsupported-steer：probeCapabilities features.steer 反映 steer 能力
 *   7. cancel-request-not-terminal：handleCancel 返回 cancel_state=accepted（非终态）
 *   15. execution-ownership-epoch：adapter 设计保证（hosted 单 epoch）
 *   16. session-does-not-claim-filesystem-recovery：probeCapabilities filesystem_checkpoint=false + handleResume requires_redispatch 字段
 * - 6 个 not_applicable_this_stage：
 *   8. tool-schema-refresh / 9. unknown-effect-no-replay / 10. capability-search-not-use
 *   11. memory-proposal-only / 12. child-thread-isolation / 13. child-cancel-requires-ack
 * - 1 个简化（mandatory）：
 *   14. credential-never-in-model-data：adapter 设计保证（passed=true + reason=adapter_design_guarantee）
 *
 * 关键约束：
 * - mandatory case 失败 → publishRuntimeRevision 抛 RuntimeConformanceCaseFailedError，Revision 不可路由。
 * - 本 runner 不直接调用 publishRuntimeRevision，仅返回结果供调用方决策。
 * - 测试不修改任何平台状态（纯 probe，不创建 Invocation/Item/Event）。
 */
import {
  ALL_CONFORMANCE_CASES,
  type ConformanceCaseId,
  type ConformanceCaseResult,
} from "@/lib/runtimes/domain/runtime-conformance";

// ─── 类型定义 ──────────────────────────────────────────────

/** Conformance 测试 setup（可选，用于未来扩展完整基础设施场景）。 */
export interface ConformanceTestSetup {
  /** 测试环境标识（如 "testcontainers-mysql-8"）。 */
  testEnvironment?: string;
  /** Adapter 制品 digest（关联制品证明）。 */
  adapterDigest?: string;
  /** 证据引用（日志/trace 链接）。 */
  evidenceRef?: string;
  /** 可选：预创建 Invocation id（高级场景用，本阶段不使用）。 */
  invocationId?: string;
  /** 可选：预创建 Turn id（高级场景用，本阶段不使用）。 */
  turnId?: string;
}

/** runConformanceSuite 入参。 */
export interface RunConformanceSuiteParams {
  tenantId: string;
  runtimeRevisionId: string;
  /** 被测 RuntimeAdapter 实例。 */
  runtimeAdapter: RuntimeAdapter;
  /** 测试 setup（可选）。 */
  testSetup?: ConformanceTestSetup;
}

// ─── not_applicable_this_stage case 集合 ──────────────────

/** 6 个本阶段标记为 not_applicable_this_stage 的 case。 */
const NOT_APPLICABLE_CASES: readonly ConformanceCaseId[] = [
  "tool-schema-refresh",
  "unknown-effect-no-replay",
  "capability-search-not-use",
  "memory-proposal-only",
  "child-thread-isolation",
  "child-cancel-requires-ack",
];

// ─── 主入口：runConformanceSuite ──────────────────────────

/**
 * 运行 conformance 测试套件（16 个 case）。
 *
 * 流程：
 * 1. probeCapabilities：探测 adapter 能力声明。
 * 2. 对每个 case 运行基础场景验证：
 *    - 基础场景：实际 probe adapter 接口，返回真实 passed 值。
 *    - not_applicable_this_stage：返回 passed=true + reason。
 *    - adapter_design_guarantee：返回 passed=true + reason。
 * 3. 返回 ConformanceCaseResult[]（按 ALL_CONFORMANCE_CASES 顺序）。
 *
 * @throws ConformanceRunnerError probe 失败或 adapter 响应非法
 */
export async function runConformanceSuite(
  params: RunConformanceSuiteParams,
): Promise<ConformanceCaseResult[]> {
  // probe 失败统一包装为 ConformanceRunnerError（区分 adapter 抛错与响应结构非法）
  let capabilities: RuntimeCapabilitiesResponse;
  try {
    capabilities = await params.runtimeAdapter.probeCapabilities();
  } catch (err) {
    throw new ConformanceRunnerError(
      `probeCapabilities 调用失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  validateCapabilitiesResponse(capabilities);

  const results: ConformanceCaseResult[] = [];
  for (const caseId of ALL_CONFORMANCE_CASES) {
    const result = await runSingleCase(params, caseId, capabilities);
    results.push(result);
  }
  return results;
}

// ─── 单个 case 调度 ────────────────────────────────────────

/** 按 caseId 调度到具体测试函数。 */
async function runSingleCase(
  params: RunConformanceSuiteParams,
  caseId: ConformanceCaseId,
  capabilities: RuntimeCapabilitiesResponse,
): Promise<ConformanceCaseResult> {
  switch (caseId) {
    case "dispatch-binds-immutable-config":
      return testDispatchBindsImmutableConfig(params);
    case "event-batch-idempotent":
      return testEventBatchIdempotent(capabilities);
    case "event-payload-hash-conflict":
      return testEventPayloadHashConflict(capabilities);
    case "attempt-sequence-continuity":
      return testAttemptSequenceContinuity(params);
    case "steer-requires-ack":
      return testSteerRequiresAck(params);
    case "unsupported-steer":
      return testUnsupportedSteer(params, capabilities);
    case "cancel-request-not-terminal":
      return testCancelRequestNotTerminal(params);
    case "credential-never-in-model-data":
      return testCredentialNeverInModelData(capabilities);
    case "execution-ownership-epoch":
      return testExecutionOwnershipEpoch(capabilities);
    case "session-does-not-claim-filesystem-recovery":
      return testSessionDoesNotClaimFilesystemRecovery(params, capabilities);
    default:
      if (NOT_APPLICABLE_CASES.includes(caseId)) {
        return { caseId, passed: false, reason: "case_requires_isolated_runner" };
      }
      // 未识别的 case：fail-closed
      return {
        caseId,
        passed: false,
        reason: `unknown_case_id: ${caseId}`,
      };
  }
}

// ─── 9 个基础场景实现 ──────────────────────────────────────

/**
 * Case 1: dispatch-binds-immutable-config（mandatory）
 *
 * 验证：startInvocation 每次返回唯一的 runtime_execution_ref。
 * 每个 Invocation 恰有一条不可变 ExecutionBinding（1:1），runtime_execution_ref 是绑定标识。
 *
 * 实现调用 adapter.startInvocation 两次（mock sink，无副作用），验证：
 * - 两次返回的 runtime_execution_ref 不同
 * - 两次返回的 runtime_session_ref 不同
 * - accepted=true
 */
async function testDispatchBindsImmutableConfig(
  params: RunConformanceSuiteParams,
): Promise<ConformanceCaseResult> {
  try {
    const startParams = buildStartInvocationParams(params.tenantId, params.runtimeRevisionId);
    const result1 = await params.runtimeAdapter.startInvocation(startParams);
    const result2 = await params.runtimeAdapter.startInvocation(startParams);

    if (!result1.accepted || !result2.accepted) {
      return {
        caseId: "dispatch-binds-immutable-config",
        passed: false,
        reason: `startInvocation 未被接受：r1.accepted=${result1.accepted}, r2.accepted=${result2.accepted}`,
      };
    }

    if (result1.runtime_execution_ref === result2.runtime_execution_ref) {
      return {
        caseId: "dispatch-binds-immutable-config",
        passed: false,
        reason: `两次 startInvocation 返回相同 runtime_execution_ref=${result1.runtime_execution_ref}，违反不可变 1:1 绑定`,
      };
    }

    if (result1.runtime_session_ref === result2.runtime_session_ref) {
      return {
        caseId: "dispatch-binds-immutable-config",
        passed: false,
        reason: `两次 startInvocation 返回相同 runtime_session_ref=${result1.runtime_session_ref}，违反唯一性`,
      };
    }

    return {
      caseId: "dispatch-binds-immutable-config",
      passed: true,
      reason:
        "startInvocation 每次返回唯一 runtime_execution_ref/runtime_session_ref，符合不可变 1:1 绑定",
    };
  } catch (err) {
    return {
      caseId: "dispatch-binds-immutable-config",
      passed: false,
      reason: `probe 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Case 2: event-batch-idempotent（mandatory）
 *
 * 验证：adapter 声明 event_stream=true 能力。
 * 事件幂等由平台 ingress 强制（UNIQUE(invocationId, producerEventId) + UNIQUE(invocationId, producerSequence)），
 * adapter 只需声明支持 event_stream。
 */
function testEventBatchIdempotent(
  capabilities: RuntimeCapabilitiesResponse,
): ConformanceCaseResult {
  if (!capabilities.features.event_stream) {
    return {
      caseId: "event-batch-idempotent",
      passed: false,
      reason: "adapter 声明 features.event_stream=false，不支持事件流",
    };
  }
  return {
    caseId: "event-batch-idempotent",
    passed: true,
    reason: "adapter 声明 event_stream=true；幂等由平台 ingress UNIQUE 约束强制",
  };
}

/**
 * Case 3: event-payload-hash-conflict
 *
 * 验证：adapter 声明 event_stream=true 能力。
 * hash 冲突检测由平台 ingress 强制（payloadHash 不匹配 → EventPayloadHashConflictError），
 * adapter 只需声明支持 event_stream。
 */
function testEventPayloadHashConflict(
  capabilities: RuntimeCapabilitiesResponse,
): ConformanceCaseResult {
  if (!capabilities.features.event_stream) {
    return {
      caseId: "event-payload-hash-conflict",
      passed: false,
      reason: "adapter 声明 features.event_stream=false，不支持事件流",
    };
  }
  return {
    caseId: "event-payload-hash-conflict",
    passed: true,
    reason: "adapter 声明 event_stream=true；hash 冲突由平台 ingress payloadHash 校验强制",
  };
}

/**
 * Case 4: attempt-sequence-continuity
 *
 * 验证：startInvocation 每次返回新 runtime_execution_ref。
 * Attempt 重调度使用新 runtime_execution_ref，不覆盖初始 ref（§6.4）。
 * 与 Case 1 类似，但聚焦于 attempt 序列连续性：每个 attempt 应有唯一 execution_ref。
 */
async function testAttemptSequenceContinuity(
  params: RunConformanceSuiteParams,
): Promise<ConformanceCaseResult> {
  try {
    const startParams = buildStartInvocationParams(params.tenantId, params.runtimeRevisionId);
    const r1 = await params.runtimeAdapter.startInvocation(startParams);
    const r2 = await params.runtimeAdapter.startInvocation(startParams);

    if (r1.runtime_execution_ref === r2.runtime_execution_ref) {
      return {
        caseId: "attempt-sequence-continuity",
        passed: false,
        reason: "两次 startInvocation 返回相同 runtime_execution_ref，违反 Attempt 序列唯一性",
      };
    }

    return {
      caseId: "attempt-sequence-continuity",
      passed: true,
      reason: "每次 startInvocation 返回新 runtime_execution_ref，符合 Attempt 序列连续性",
    };
  } catch (err) {
    return {
      caseId: "attempt-sequence-continuity",
      passed: false,
      reason: `probe 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Case 5: steer-requires-ack
 *
 * 验证：handleSteer 返回 steer_state="accepted" + applies_at="next_safe_point"。
 * Steer 请求需要 Runtime ack（不立即生效），在下一个安全点应用。
 * generation_interrupted 字段必须存在（boolean）。
 */
async function testSteerRequiresAck(
  params: RunConformanceSuiteParams,
): Promise<ConformanceCaseResult> {
  try {
    const steerParams = buildSteerParams();
    const result = await params.runtimeAdapter.handleSteer(steerParams);

    if (result.steer_state !== "accepted") {
      return {
        caseId: "steer-requires-ack",
        passed: false,
        reason: `handleSteer 返回 steer_state=${result.steer_state}，期望 "accepted"`,
      };
    }

    if (result.applies_at !== "next_safe_point") {
      return {
        caseId: "steer-requires-ack",
        passed: false,
        reason: `handleSteer 返回 applies_at=${result.applies_at}，期望 "next_safe_point"`,
      };
    }

    // generation_interrupted 字段必须为 boolean
    if (typeof result.generation_interrupted !== "boolean") {
      return {
        caseId: "steer-requires-ack",
        passed: false,
        reason: `handleSteer generation_interrupted 类型非法：${typeof result.generation_interrupted}`,
      };
    }

    return {
      caseId: "steer-requires-ack",
      passed: true,
      reason: `handleSteer 返回 accepted + next_safe_point + generation_interrupted=${result.generation_interrupted}`,
    };
  } catch (err) {
    return {
      caseId: "steer-requires-ack",
      passed: false,
      reason: `probe 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Case 6: unsupported-steer
 *
 * 验证：probeCapabilities features.steer 反映 steer 能力。
 * 当 adapter 声明 steer=false 时，handleSteer 应不可用（路由层不调用）。
 * 当 adapter 声明 steer=true 时，handleSteer 应正常返回 accepted。
 *
 * 本测试验证：features.steer=true 时 handleSteer 正常工作（与 Case 5 互补）。
 */
async function testUnsupportedSteer(
  params: RunConformanceSuiteParams,
  capabilities: RuntimeCapabilitiesResponse,
): Promise<ConformanceCaseResult> {
  // 能力声明为 false：adapter 不应被调用 handleSteer（路由层责任）
  if (!capabilities.features.steer) {
    return {
      caseId: "unsupported-steer",
      passed: true,
      reason: "adapter 声明 features.steer=false；路由层不调用 handleSteer，符合 unsupported 语义",
    };
  }

  // 能力声明为 true：handleSteer 应正常返回 accepted
  try {
    const steerParams = buildSteerParams();
    const result = await params.runtimeAdapter.handleSteer(steerParams);
    if (result.steer_state !== "accepted") {
      return {
        caseId: "unsupported-steer",
        passed: false,
        reason: `adapter 声明 steer=true 但 handleSteer 返回 steer_state=${result.steer_state}，期望 "accepted"`,
      };
    }
    return {
      caseId: "unsupported-steer",
      passed: true,
      reason: "adapter 声明 steer=true 且 handleSteer 返回 accepted，符合支持 steer 语义",
    };
  } catch (err) {
    return {
      caseId: "unsupported-steer",
      passed: false,
      reason: `adapter 声明 steer=true 但 handleSteer 抛错：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Case 7: cancel-request-not-terminal（mandatory）
 *
 * 验证：handleCancel 返回 cancel_state="accepted"（非终态）。
 * cancel 请求只是 ack（Runtime 确认收到），不是终态——Invocation 仍 running，
 * 直到 Runtime 回传 execution.cancelled 候选事件，平台 ingress 映射后才转入 cancelled 终态。
 *
 * already_completed_effects_preserved 字段必须为 boolean（已完成的副作用保留）。
 */
async function testCancelRequestNotTerminal(
  params: RunConformanceSuiteParams,
): Promise<ConformanceCaseResult> {
  try {
    const cancelParams = buildCancelParams();
    const result = await params.runtimeAdapter.handleCancel(cancelParams);

    if (result.cancel_state !== "accepted") {
      return {
        caseId: "cancel-request-not-terminal",
        passed: false,
        reason: `handleCancel 返回 cancel_state=${result.cancel_state}，期望 "accepted"（非终态）`,
      };
    }

    if (typeof result.already_completed_effects_preserved !== "boolean") {
      return {
        caseId: "cancel-request-not-terminal",
        passed: false,
        reason: `handleCancel already_completed_effects_preserved 类型非法：${typeof result.already_completed_effects_preserved}`,
      };
    }

    return {
      caseId: "cancel-request-not-terminal",
      passed: true,
      reason: `handleCancel 返回 accepted（非终态）+ already_completed_effects_preserved=${result.already_completed_effects_preserved}`,
    };
  } catch (err) {
    return {
      caseId: "cancel-request-not-terminal",
      passed: false,
      reason: `probe 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Case 14: credential-never-in-model-data（mandatory，简化）
 *
 * 简化验证：adapter 设计保证——RuntimeAdapter 接口不暴露 model data 字段，
 * model data 只通过 startInvocation.input_items 传入，adapter 不应在 response 中回传 credential。
 *
 * 真实验证需要检查 input_items/response 字段是否包含 credential 字段，
 * 本阶段标记为 adapter_design_guarantee（passed=true），后续阶段补完整 schema 校验。
 */
function testCredentialNeverInModelData(
  capabilities: RuntimeCapabilitiesResponse,
): ConformanceCaseResult {
  // 基础验证：capabilities 不应包含 credential 字段（schema 由 RuntimeCapabilitiesResponse 类型强制）
  // 真实验证需要扫描 input_items/response.completed payload，本阶段简化为 adapter 设计保证。
  void capabilities; // capabilities schema 已由类型系统保证无 credential 字段
  return {
    caseId: "credential-never-in-model-data",
    passed: false,
    reason: "case_requires_isolated_runner",
  };
}

/**
 * Case 15: execution-ownership-epoch
 *
 * 简化验证：adapter 设计保证——Hosted Runtime 使用单 leaseEpoch（平台托管，无多设备竞争）。
 * External Runtime 需在后续阶段补完整 ExecutionOwnership 切换测试。
 *
 * 本阶段标记为 adapter_design_guarantee（passed=true）。
 */
function testExecutionOwnershipEpoch(
  capabilities: RuntimeCapabilitiesResponse,
): ConformanceCaseResult {
  void capabilities;
  return {
    caseId: "execution-ownership-epoch",
    passed: false,
    reason: "case_requires_isolated_runner",
  };
}

/**
 * Case 16: session-does-not-claim-filesystem-recovery
 *
 * 验证：
 * 1. probeCapabilities features.filesystem_checkpoint=false（不声明 filesystem 恢复能力）
 * 2. handleResume 返回 requires_redispatch 字段（boolean，不声明 filesystem 恢复）
 */
async function testSessionDoesNotClaimFilesystemRecovery(
  params: RunConformanceSuiteParams,
  capabilities: RuntimeCapabilitiesResponse,
): Promise<ConformanceCaseResult> {
  // 1. filesystem_checkpoint 应为 false（不声明 filesystem 恢复）
  if (capabilities.features.filesystem_checkpoint) {
    return {
      caseId: "session-does-not-claim-filesystem-recovery",
      passed: false,
      reason:
        "adapter 声明 features.filesystem_checkpoint=true，违反 session 不声明 filesystem 恢复约束",
    };
  }

  // 2. handleResume 返回 requires_redispatch 字段
  try {
    const resumeParams = buildResumeParams();
    const result = await params.runtimeAdapter.handleResume(resumeParams);

    if (typeof result.requires_redispatch !== "boolean") {
      return {
        caseId: "session-does-not-claim-filesystem-recovery",
        passed: false,
        reason: `handleResume requires_redispatch 类型非法：${typeof result.requires_redispatch}`,
      };
    }

    if (result.resume_state !== "accepted") {
      return {
        caseId: "session-does-not-claim-filesystem-recovery",
        passed: false,
        reason: `handleResume resume_state=${result.resume_state}，期望 "accepted"`,
      };
    }

    return {
      caseId: "session-does-not-claim-filesystem-recovery",
      passed: true,
      reason: `filesystem_checkpoint=false + handleResume accepted + requires_redispatch=${result.requires_redispatch}`,
    };
  } catch (err) {
    return {
      caseId: "session-does-not-claim-filesystem-recovery",
      passed: false,
      reason: `probe 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── 辅助：构造测试参数 ────────────────────────────────────

/** 构造 startInvocation 测试参数（无副作用，不创建真实 Invocation）。 */
function buildStartInvocationParams(
  tenantId: string,
  runtimeRevisionId: string,
): StartInvocationParams {
  return {
    invocationId: `conformance-test-invocation-${tenantId}-${runtimeRevisionId}`,
    threadId: `conformance-test-thread-${tenantId}`,
    turnId: `conformance-test-turn-${tenantId}`,
    agentRevisionId: "conformance-test-agent-revision",
    inputItems: [
      {
        type: "user_message",
        content: { text: "conformance test message" },
      },
    ],
    gatewayEndpoints: {
      events: "https://conformance-test.platform.internal",
      cancel: "https://conformance-test.platform.internal/cancel",
      resume: "https://conformance-test.platform.internal/resume",
      steer: "https://conformance-test.platform.internal/steer",
    },
    authToken: "conformance-test-token",
    correlationId: "conformance-test-correlation",
  };
}

/** 构造 handleCancel 测试参数。 */
function buildCancelParams(): CancelParams {
  return {
    invocationId: "conformance-test-cancel-invocation",
    reason: "conformance-test-cancel",
    cancelledBy: "conformance-test-user",
  };
}

/** 构造 handleResume 测试参数。 */
function buildResumeParams(): ResumeParams {
  return {
    invocationId: "conformance-test-resume-invocation",
    resumePayload: { type: "conformance-test-resume" },
  };
}

/** 构造 handleSteer 测试参数。 */
function buildSteerParams(): SteerParams {
  return {
    invocationId: "conformance-test-steer-invocation",
    steerPayload: { type: "conformance-test-steer" },
  };
}

// ─── 辅助：capabilities 响应校验 ──────────────────────────

/**
 * 校验 probeCapabilities 响应结构。
 *
 * @throws ConformanceRunnerError 响应结构非法
 */
function validateCapabilitiesResponse(capabilities: RuntimeCapabilitiesResponse): void {
  if (!Array.isArray(capabilities.protocol_versions)) {
    throw new ConformanceRunnerError("probeCapabilities 响应 protocol_versions 必须是数组");
  }
  if (!capabilities.features || typeof capabilities.features !== "object") {
    throw new ConformanceRunnerError("probeCapabilities 响应 features 必须是对象");
  }
  const features = capabilities.features;
  if (typeof features.event_stream !== "boolean") {
    throw new ConformanceRunnerError("features.event_stream 必须是 boolean");
  }
  if (typeof features.cancel !== "boolean") {
    throw new ConformanceRunnerError("features.cancel 必须是 boolean");
  }
  if (typeof features.resume !== "boolean") {
    throw new ConformanceRunnerError("features.resume 必须是 boolean");
  }
  if (typeof features.steer !== "boolean") {
    throw new ConformanceRunnerError("features.steer 必须是 boolean");
  }
  if (typeof features.filesystem_checkpoint !== "boolean") {
    throw new ConformanceRunnerError("features.filesystem_checkpoint 必须是 boolean");
  }
  if (!Array.isArray(features.workspace_types)) {
    throw new ConformanceRunnerError("features.workspace_types 必须是数组");
  }
  if (!capabilities.limits || typeof capabilities.limits !== "object") {
    throw new ConformanceRunnerError("probeCapabilities 响应 limits 必须是对象");
  }
  if (typeof capabilities.limits.max_invocation_seconds !== "number") {
    throw new ConformanceRunnerError("limits.max_invocation_seconds 必须是 number");
  }
  if (typeof capabilities.limits.max_event_bytes !== "number") {
    throw new ConformanceRunnerError("limits.max_event_bytes 必须是 number");
  }
}

// ─── 错误类型 ──────────────────────────────────────────────

/** Conformance runner 错误（probe 失败或响应非法）。 */
export class ConformanceRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceRunnerError";
  }
}
