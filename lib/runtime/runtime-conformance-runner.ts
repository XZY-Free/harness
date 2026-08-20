/**
 * Runtime Revision Publication Conformance Runner。
 *
 * 事实源：docs/contracts/runtime-conformance.json（Runtime Publication 套件，1.0.0）。
 *
 * 职责：
 * - runPublicationConformanceSuite：对候选 RuntimeAdapter 真实执行 Publication
 *   套件的 6 个 case，返回 PublicationConformanceCaseResult[]。
 * - 只验证未发布候选 Runtime 自身的 Adapter / Protocol 行为，不需要 Route、
 *   Projection、ExecutionBinding、Invocation、Tool、Memory、Child Thread、
 *   ExecutionOwnership 等平台对象。
 * - 整个 suite 只 probeCapabilities 一次，并把同一能力快照传给各 case，
 *   避免一次 Run 中能力事实漂移。
 * - 每项都通过真实 RuntimeAdapter 方法调用或严格返回结构校验得到；不得用
 *   passed=true、capability 声明替代实际可调用行为、固定原因视为通过。
 * - 可选能力为 false 时只能验证「不宣称支持」，不能调用后伪造成功。
 * - cancel 是发布基础能力，必须实际 ack。
 * - probe / ack 调用抛错或响应结构非法 → fail-closed（passed=false），不产生
 *   权威 Passed Run。
 * - 每个 case 的证据对象（evidence）至少绑定 caseId、passed 与真实调用返回的
 *   关键字段/失败错误；evidenceDigest 用 computeCanonicalDigest（RFC8785）。
 *
 * 本 runner 不直接调用 publishRuntimeRevision，仅返回结果供调用方决策；
 * 不修改任何平台状态（纯 probe，不创建 Invocation/Item/Event）。
 */
import { rfc8785Canonicalize } from "@/lib/crypto/rfc-8785-canonicalize";
import type {
  CancelParams,
  CancelResult,
  ResumeParams,
  ResumeResult,
  RuntimeAdapter,
  StartInvocationParams,
  StartInvocationResult,
  SteerParams,
  SteerResult,
} from "@/lib/runtime/adapters/hosted-adapter";
import {
  PUBLICATION_CONFORMANCE_CASES,
  type PublicationConformanceCaseId,
  type PublicationConformanceCaseResult,
  computeCaseEvidenceDigest,
} from "@/lib/runtime/domain/runtime-conformance";
import type { RuntimeCapabilitiesResponse } from "@/lib/runtime/runtime-client";

// ─── 类型定义 ──────────────────────────────────────────────

/** runPublicationConformanceSuite 入参。 */
export interface RunPublicationConformanceSuiteParams {
  tenantId: string;
  runtimeRevisionId: string;
  /** 被测 RuntimeAdapter 实例。 */
  runtimeAdapter: RuntimeAdapter;
}

/** 单个 case 的判定上下文（携带唯一 probe 快照）。 */
interface CaseContext {
  tenantId: string;
  runtimeRevisionId: string;
  runtimeAdapter: RuntimeAdapter;
  /** 整个 suite 唯一的 probe 能力快照。 */
  capabilities: RuntimeCapabilitiesResponse;
}

// ─── 主入口：runPublicationConformanceSuite ──────────────

/**
 * 运行 Runtime Publication Conformance 套件（6 个 case）。
 *
 * 流程：
 * 1. probeCapabilities：真实探测 adapter 能力清单（唯一一次）。
 * 2. 同一能力快照传给每个 case，运行真实 Adapter 调用校验。
 * 3. 返回 PublicationConformanceCaseResult[]（按 PUBLICATION_CONFORMANCE_CASES 顺序）。
 *
 * probe 失败或响应结构非法 → 全部 case fail-closed（passed=false），
 * 绝不冒充 Passed，也不让后续 case 伪造成通过。
 */
export async function runPublicationConformanceSuite(
  params: RunPublicationConformanceSuiteParams,
): Promise<PublicationConformanceCaseResult[]> {
  let capabilities: RuntimeCapabilitiesResponse;
  try {
    capabilities = await params.runtimeAdapter.probeCapabilities();
    validateCapabilitiesResponse(capabilities);
  } catch (err) {
    const reason = `capability probe 失败：${err instanceof Error ? err.message : String(err)}`;
    return PUBLICATION_CONFORMANCE_CASES.map((caseId) => failClosed(caseId, reason));
  }

  const ctx: CaseContext = {
    tenantId: params.tenantId,
    runtimeRevisionId: params.runtimeRevisionId,
    runtimeAdapter: params.runtimeAdapter,
    capabilities,
  };

  const results: PublicationConformanceCaseResult[] = [];
  for (const caseId of PUBLICATION_CONFORMANCE_CASES) {
    results.push(await runSingleCase(ctx, caseId));
  }
  return results;
}

// ─── 单个 case 调度 ────────────────────────────────────────

async function runSingleCase(
  ctx: CaseContext,
  caseId: PublicationConformanceCaseId,
): Promise<PublicationConformanceCaseResult> {
  switch (caseId) {
    case "capability-manifest-contract":
      return testCapabilityManifestContract(ctx);
    case "dispatch-acknowledgement":
      return testDispatchAcknowledgement(ctx);
    case "cancel-acknowledgement":
      return testCancelAcknowledgement(ctx);
    case "steer-capability-consistency":
      return testSteerCapabilityConsistency(ctx);
    case "resume-capability-consistency":
      return testResumeCapabilityConsistency(ctx);
    case "session-recovery-declaration":
      return testSessionRecoveryDeclaration(ctx);
    default:
      return failClosed(caseId, `unknown_publication_case_id: ${caseId}`);
  }
}

/** 构造一个 fail-closed 的 case 结果（evidence 绑定错误）。 */
function failClosed(
  caseId: PublicationConformanceCaseId,
  reason: string,
): PublicationConformanceCaseResult {
  const evidence = { caseId, passed: false, error: reason };
  return { caseId, passed: false, reason, evidence, evidenceDigest: digestOf(evidence) };
}

/** 计算证据的权威 RFC8785 canonical digest（复用 domain 唯一事实源）。 */
function digestOf(evidence: Record<string, unknown>): string {
  return computeCaseEvidenceDigest(evidence);
}

// ─── 6 个 Publication case 实现 ───────────────────────────

/**
 * case: capability-manifest-contract
 *
 * 校验 probeCapabilities 返回的能力清单结构合法。probe 已在 suite 入口完成；
 * 此处仅校验结构，并把真实能力清单作为证据。
 */
function testCapabilityManifestContract(ctx: CaseContext): PublicationConformanceCaseResult {
  const evidence = {
    caseId: "capability-manifest-contract",
    passed: true,
    protocol_versions: ctx.capabilities.protocol_versions,
    features: ctx.capabilities.features,
    limits: ctx.capabilities.limits,
  };
  return {
    caseId: "capability-manifest-contract",
    passed: true,
    reason: `probeCapabilities 返回合法能力清单（协议 ${ctx.capabilities.protocol_versions.join(",")}）`,
    evidence,
    evidenceDigest: digestOf(evidence),
  };
}

/**
 * case: dispatch-acknowledgement
 *
 * 只做一次真实 dispatch。验证 accepted=true、refs 非空，且返回的 capabilities
 * 与本次唯一 probe 快照一致。不制造多余的第二个调用。
 */
async function testDispatchAcknowledgement(
  ctx: CaseContext,
): Promise<PublicationConformanceCaseResult> {
  const startParams = buildStartInvocationParams(ctx.tenantId, ctx.runtimeRevisionId);
  let result: StartInvocationResult;
  try {
    result = await ctx.runtimeAdapter.startInvocation(startParams);
  } catch (err) {
    return failClosed(
      "dispatch-acknowledgement",
      `startInvocation 调用失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!result.accepted) {
    const evidence = {
      caseId: "dispatch-acknowledgement",
      passed: false,
      accepted: result.accepted,
      runtime_execution_ref: result.runtime_execution_ref,
      runtime_session_ref: result.runtime_session_ref,
    };
    return {
      ...failClosed(
        "dispatch-acknowledgement",
        `startInvocation 未被接受：accepted=${result.accepted}`,
      ),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }
  if (!result.runtime_execution_ref || !result.runtime_session_ref) {
    const evidence = {
      caseId: "dispatch-acknowledgement",
      passed: false,
      accepted: result.accepted,
      runtime_execution_ref: result.runtime_execution_ref,
      runtime_session_ref: result.runtime_session_ref,
    };
    return {
      ...failClosed(
        "dispatch-acknowledgement",
        "startInvocation 返回空 runtime_execution_ref/runtime_session_ref",
      ),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }

  // RFC8785 canonical 比较：键序无关，避免 JSON.stringify 顺序敏感误判。
  const capabilitiesMatch =
    rfc8785Canonicalize(result.capabilities) === rfc8785Canonicalize(ctx.capabilities);
  const evidence = {
    caseId: "dispatch-acknowledgement",
    passed: true,
    accepted: result.accepted,
    runtime_execution_ref: result.runtime_execution_ref,
    runtime_session_ref: result.runtime_session_ref,
    capabilities_match_probe_snapshot: capabilitiesMatch,
  };

  if (!capabilitiesMatch) {
    return {
      ...failClosed(
        "dispatch-acknowledgement",
        "startInvocation 返回 capabilities 与本次唯一 probe 快照不一致",
      ),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }

  return {
    caseId: "dispatch-acknowledgement",
    passed: true,
    reason:
      "startInvocation 返回 accepted + 非空 execution/session ref + capabilities 与 probe 快照一致",
    evidence,
    evidenceDigest: digestOf(evidence),
  };
}

/**
 * case: cancel-acknowledgement
 *
 * cancel 是发布基础能力，必须实际 ack。真实调用 handleCancel，要求
 * cancel_state=accepted（非终态）+ already_completed_effects_preserved 为 boolean。
 * adapter 抛错 → fail-closed。
 */
async function testCancelAcknowledgement(
  ctx: CaseContext,
): Promise<PublicationConformanceCaseResult> {
  const cancelParams = buildCancelParams();
  let result: CancelResult;
  try {
    result = await ctx.runtimeAdapter.handleCancel(cancelParams);
  } catch (err) {
    return failClosed(
      "cancel-acknowledgement",
      `handleCancel 调用失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const evidence = {
    caseId: "cancel-acknowledgement",
    passed: false,
    cancel_state: result.cancel_state,
    already_completed_effects_preserved: result.already_completed_effects_preserved,
  };
  if (result.cancel_state !== "accepted") {
    return {
      ...failClosed(
        "cancel-acknowledgement",
        `handleCancel 返回 cancel_state=${result.cancel_state}，期望 "accepted"`,
      ),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }
  if (typeof result.already_completed_effects_preserved !== "boolean") {
    return {
      ...failClosed(
        "cancel-acknowledgement",
        `handleCancel already_completed_effects_preserved 类型非法：${typeof result.already_completed_effects_preserved}`,
      ),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }

  evidence.passed = true;
  return {
    caseId: "cancel-acknowledgement",
    passed: true,
    reason: `handleCancel 返回 accepted + already_completed_effects_preserved=${result.already_completed_effects_preserved}`,
    evidence,
    evidenceDigest: digestOf(evidence),
  };
}

/**
 * case: steer-capability-consistency
 *
 * 使用唯一 probe 快照。若 features.steer=true 则调用 handleSteer 并验证
 * accepted + next_safe_point + generation_interrupted boolean；若 features.steer=false
 * 只验证「不宣称支持」，不调用 handleSteer、不伪造成功。
 */
async function testSteerCapabilityConsistency(
  ctx: CaseContext,
): Promise<PublicationConformanceCaseResult> {
  const steerDeclared = ctx.capabilities.features.steer === true;

  if (!steerDeclared) {
    const evidence = {
      caseId: "steer-capability-consistency",
      passed: true,
      steer_declared: false,
      note: "adapter 未宣称 steer 能力，符合 unsupported 语义（不调用 handleSteer）",
    };
    return {
      caseId: "steer-capability-consistency",
      passed: true,
      reason: "adapter 未宣称 steer 能力，符合 unsupported 语义（不调用 handleSteer）",
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }

  const steerParams = buildSteerParams();
  let result: SteerResult;
  try {
    result = await ctx.runtimeAdapter.handleSteer(steerParams);
  } catch (err) {
    return failClosed(
      "steer-capability-consistency",
      `adapter 宣称 steer=true 但 handleSteer 抛错：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const evidence = {
    caseId: "steer-capability-consistency",
    passed: false,
    steer_declared: true,
    steer_state: result.steer_state,
    applies_at: result.applies_at,
    generation_interrupted: result.generation_interrupted,
  };
  if (result.steer_state !== "accepted") {
    return {
      ...failClosed(
        "steer-capability-consistency",
        `adapter 宣称 steer=true 但 handleSteer 返回 steer_state=${result.steer_state}`,
      ),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }
  if (result.applies_at !== "next_safe_point") {
    return {
      ...failClosed(
        "steer-capability-consistency",
        `handleSteer applies_at=${result.applies_at}，期望 "next_safe_point"`,
      ),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }
  if (typeof result.generation_interrupted !== "boolean") {
    return {
      ...failClosed(
        "steer-capability-consistency",
        `handleSteer generation_interrupted 类型非法：${typeof result.generation_interrupted}`,
      ),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }

  evidence.passed = true;
  return {
    caseId: "steer-capability-consistency",
    passed: true,
    reason: `adapter 宣称 steer=true 且 handleSteer 返回 accepted + next_safe_point + generation_interrupted=${result.generation_interrupted}`,
    evidence,
    evidenceDigest: digestOf(evidence),
  };
}

/**
 * case: resume-capability-consistency
 *
 * 使用唯一 probe 快照。若 features.resume=true 则调用 handleResume 并验证
 * accepted + runtime_execution_ref 非空；若 features.resume=false 只验证
 * 「不宣称支持」，不调用 handleResume、不伪造成功。
 */
async function testResumeCapabilityConsistency(
  ctx: CaseContext,
): Promise<PublicationConformanceCaseResult> {
  const resumeDeclared = ctx.capabilities.features.resume === true;

  if (!resumeDeclared) {
    const evidence = {
      caseId: "resume-capability-consistency",
      passed: true,
      resume_declared: false,
      note: "adapter 未宣称 resume 能力，符合 unsupported 语义（不调用 handleResume）",
    };
    return {
      caseId: "resume-capability-consistency",
      passed: true,
      reason: "adapter 未宣称 resume 能力，符合 unsupported 语义（不调用 handleResume）",
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }

  const resumeParams = buildResumeParams();
  let result: ResumeResult;
  try {
    result = await ctx.runtimeAdapter.handleResume(resumeParams);
  } catch (err) {
    return failClosed(
      "resume-capability-consistency",
      `adapter 宣称 resume=true 但 handleResume 抛错：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const evidence = {
    caseId: "resume-capability-consistency",
    passed: false,
    resume_declared: true,
    resume_state: result.resume_state,
    runtime_execution_ref: result.runtime_execution_ref,
  };
  if (result.resume_state !== "accepted") {
    return {
      ...failClosed(
        "resume-capability-consistency",
        `adapter 宣称 resume=true 但 handleResume 返回 resume_state=${result.resume_state}`,
      ),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }
  if (!result.runtime_execution_ref) {
    return {
      ...failClosed("resume-capability-consistency", "handleResume 返回空 runtime_execution_ref"),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }

  evidence.passed = true;
  return {
    caseId: "resume-capability-consistency",
    passed: true,
    reason: `adapter 宣称 resume=true 且 handleResume 返回 accepted + runtime_execution_ref=${result.runtime_execution_ref}`,
    evidence,
    evidenceDigest: digestOf(evidence),
  };
}

/**
 * case: session-recovery-declaration
 *
 * 一致语义：
 * - filesystem_checkpoint=false → 证明未宣称该能力（通过）。
 * - filesystem_checkpoint=true → 必须同时 resume=true，并携带 checkpointRef 做真实
 *   resume probe，且 requires_redispatch=false，否则 fail-closed。
 */
async function testSessionRecoveryDeclaration(
  ctx: CaseContext,
): Promise<PublicationConformanceCaseResult> {
  const filesystemCheckpoint = ctx.capabilities.features.filesystem_checkpoint === true;

  if (!filesystemCheckpoint) {
    const evidence = {
      caseId: "session-recovery-declaration",
      passed: true,
      filesystem_checkpoint: false,
      note: "adapter 未宣称 filesystem 级恢复能力",
    };
    return {
      caseId: "session-recovery-declaration",
      passed: true,
      reason: "filesystem_checkpoint=false，未宣称 filesystem 级恢复能力",
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }

  if (ctx.capabilities.features.resume !== true) {
    const evidence = {
      caseId: "session-recovery-declaration",
      passed: false,
      filesystem_checkpoint: true,
      resume_declared: false,
      error: "filesystem_checkpoint=true 但未宣称 resume 能力，无法证明 checkpoint 恢复",
    };
    return {
      ...failClosed(
        "session-recovery-declaration",
        "filesystem_checkpoint=true 但未宣称 resume 能力，无法证明 checkpoint 恢复",
      ),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }

  const resumeParams: ResumeParams = {
    invocationId: "conformance-test-checkpoint-resume-invocation",
    resumePayload: { type: "conformance-test-checkpoint-resume", from_checkpoint: true },
    checkpointRef: "conformance-test-checkpoint",
  };
  let result: ResumeResult;
  try {
    result = await ctx.runtimeAdapter.handleResume(resumeParams);
  } catch (err) {
    return failClosed(
      "session-recovery-declaration",
      `filesystem_checkpoint=true 时 checkpoint resume probe 抛错：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const evidence = {
    caseId: "session-recovery-declaration",
    passed: false,
    filesystem_checkpoint: true,
    resume_declared: true,
    checkpointRef: resumeParams.checkpointRef,
    resume_state: result.resume_state,
    requires_redispatch: result.requires_redispatch,
  };
  if (result.resume_state !== "accepted") {
    return {
      ...failClosed(
        "session-recovery-declaration",
        `checkpoint resume 返回 resume_state=${result.resume_state}`,
      ),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }
  if (result.requires_redispatch !== false) {
    return {
      ...failClosed(
        "session-recovery-declaration",
        `filesystem_checkpoint=true 要求 requires_redispatch=false，实际=${result.requires_redispatch}`,
      ),
      evidence,
      evidenceDigest: digestOf(evidence),
    };
  }

  evidence.passed = true;
  return {
    caseId: "session-recovery-declaration",
    passed: true,
    reason:
      "filesystem_checkpoint=true + resume=true + checkpoint resume requires_redispatch=false",
    evidence,
    evidenceDigest: digestOf(evidence),
  };
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

/** 构造 handleResume 测试参数（非 checkpoint 恢复）。 */
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
 * 校验 probeCapabilities 响应结构（capability-manifest-contract）。
 *
 * @throws ConformanceRunnerError 响应结构非法
 */
export function validateCapabilitiesResponse(capabilities: RuntimeCapabilitiesResponse): void {
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

/** Publication Conformance runner 错误（probe 失败或响应非法）。 */
export class ConformanceRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceRunnerError";
  }
}
