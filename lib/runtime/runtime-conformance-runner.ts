/** Runtime publication conformance runner for the single RuntimeProtocol contract. */
import { randomUUID } from "node:crypto";
import type {
  CancelParams,
  ResumeParams,
  RuntimeAdapter,
  StartInvocationParams,
  SteerParams,
} from "@/lib/runtime/adapters/hosted-adapter";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import {
  PUBLICATION_CONFORMANCE_CASES,
  type PublicationConformanceCaseId,
  type PublicationConformanceCaseResult,
  computeCaseEvidenceDigest,
} from "@/lib/runtime/domain/runtime-conformance";
import { validateRuntimeProtocolCapabilities } from "@/lib/runtime/protocol-conformance";
import {
  type AuthorityIdentity,
  AuthorityIdentitySchema,
  PROTOCOL_VERSION,
  type RuntimeCapabilities,
  RuntimeCapabilitiesSchema,
  type WorkspaceMode,
  WorkspaceModeSchema,
} from "@/lib/runtime/runtime-protocol";

export interface RunPublicationConformanceSuiteParams {
  tenantId: string;
  runtimeRevisionId: string;
  runtimeAdapter: RuntimeAdapter;
}

interface CaseContext {
  tenantId: string;
  runtimeRevisionId: string;
  runtimeAdapter: RuntimeAdapter;
  capabilities: RuntimeCapabilities;
  /**
   * 接纳回执必须绑定的**发布能力摘要**（R02 §3）。
   *
   * 唯一权威来源是 `expectedCapabilityManifestDigest`（runtime-start / runtime-resume /
   * ingress-runtime-events / in-process-hosted-runtime 同源）。probe 响应里的
   * `contractDigest` 是**另一个概念**（候选 Runtime 自报的能力声明摘要，不含
   * runtimeRevisionId），拿它做比对源会与生产判定分歧。
   */
  expectedCapabilitiesDigest: string;
  authority: AuthorityIdentity;
}

/** Run the publication suite against a real adapter; every failure is fail-closed. */
export async function runPublicationConformanceSuite(
  params: RunPublicationConformanceSuiteParams,
): Promise<PublicationConformanceCaseResult[]> {
  let capabilities: RuntimeCapabilities;
  try {
    capabilities = await params.runtimeAdapter.probeCapabilities();
    validateCapabilitiesResponse(capabilities);
  } catch (error) {
    return PUBLICATION_CONFORMANCE_CASES.map((caseId) =>
      failClosed(caseId, `capability probe failed: ${errorMessage(error)}`),
    );
  }

  const context: CaseContext = {
    tenantId: params.tenantId,
    runtimeRevisionId: params.runtimeRevisionId,
    runtimeAdapter: params.runtimeAdapter,
    capabilities,
    expectedCapabilitiesDigest: expectedCapabilityManifestDigest({
      runtimeRevisionId: params.runtimeRevisionId,
      runtimeCapabilitiesJson: capabilities,
    }),
    authority: createConformanceAuthority(params.runtimeRevisionId),
  };
  const results: PublicationConformanceCaseResult[] = [];
  for (const caseId of PUBLICATION_CONFORMANCE_CASES) {
    results.push(await runCase(context, caseId));
  }
  return results;
}

async function runCase(
  context: CaseContext,
  caseId: PublicationConformanceCaseId,
): Promise<PublicationConformanceCaseResult> {
  switch (caseId) {
    case "capability-manifest-contract":
      return capabilityManifestCase(context);
    case "dispatch-acknowledgement":
      return dispatchCase(context);
    case "cancel-acknowledgement":
      return cancelCase(context);
    case "steer-capability-consistency":
      return steerCase(context);
    case "resume-capability-consistency":
      return resumeCase(context);
    case "session-recovery-declaration":
      return recoveryCase(context);
    // ── RuntimeProtocol 行为清单（R10 §3）：每条都必须真实调用 Adapter ──
    case "heartbeat-semantics":
      return heartbeatSemanticsCase(context);
    case "durable-start-idempotency":
      return durableStartIdempotencyCase(context);
    case "started-event-before-ack":
      return startedEventBeforeAckCase(context);
    case "exact-replay":
      return exactReplayCase(context);
    case "old-epoch-rejection":
      return oldEpochRejectionCase(context);
    case "workspace-profile":
      return workspaceProfileCase(context);
    case "filesystem-checkpoint":
      return filesystemCheckpointCase(context);
  }
}

function capabilityManifestCase(context: CaseContext): PublicationConformanceCaseResult {
  const capabilities = context.capabilities;
  // 基础发布能力（协议要求恒为 true）；resume/steer 是声明式可选能力，
  // 由各自的 capability-consistency case 验证「宣称即可用」。
  const fixedFeatures = [
    "heartbeat",
    "durableStartIdempotency",
    "startedEvent",
    "exactReplay",
    "cancel",
  ] as const;
  const fixedFeaturesPresent = fixedFeatures.every(
    (feature) => capabilities.features[feature] === true,
  );
  let profileValid = true;
  try {
    validateRuntimeProtocolCapabilities(capabilities);
  } catch {
    profileValid = false;
  }
  const passed =
    capabilities.protocolVersion === PROTOCOL_VERSION && fixedFeaturesPresent && profileValid;
  const evidence = {
    caseId: "capability-manifest-contract",
    passed,
    protocolVersion: capabilities.protocolVersion,
    contractDigest: capabilities.contractDigest,
    runtimeTargetDigest: capabilities.runtimeTargetDigest,
    features: capabilities.features,
    limits: capabilities.limits,
  };
  return resultFromEvidence(
    "capability-manifest-contract",
    passed,
    passed
      ? `protocolVersion=${PROTOCOL_VERSION} capability manifest accepted`
      : "capability manifest violates the RuntimeProtocol contract",
    evidence,
  );
}

async function dispatchCase(context: CaseContext): Promise<PublicationConformanceCaseResult> {
  try {
    const response = await context.runtimeAdapter.startInvocation(buildStartParams(context));
    const authorityMatches = sameAuthority(response.response.authority, context.authority);
    const passed =
      response.response.accepted &&
      Boolean(response.response.remoteSessionRef) &&
      Boolean(response.response.remoteExecutionRef) &&
      response.response.protocolVersion === PROTOCOL_VERSION &&
      authorityMatches;
    const evidence = {
      caseId: "dispatch-acknowledgement",
      passed,
      response: response.response,
      authorityMatches,
    };
    return resultFromEvidence(
      "dispatch-acknowledgement",
      passed,
      passed ? "start acknowledgement accepted" : "start acknowledgement is incomplete or unbound",
      evidence,
    );
  } catch (error) {
    return failClosed("dispatch-acknowledgement", `startInvocation failed: ${errorMessage(error)}`);
  }
}

async function cancelCase(context: CaseContext): Promise<PublicationConformanceCaseResult> {
  const input: CancelParams = {
    invocationId: context.authority.invocationId,
    authority: context.authority,
    tenantId: context.tenantId,
    reason: "conformance-cancel",
    cancelledBy: "conformance-runner",
  };
  try {
    const response = await context.runtimeAdapter.handleCancel(input);
    const passed =
      response.response.accepted &&
      (response.response.stopState === "requested" || response.response.stopState === "stopped") &&
      sameAuthority(response.response.targetAuthority, context.authority);
    const evidence = { caseId: "cancel-acknowledgement", passed, response: response.response };
    return resultFromEvidence(
      "cancel-acknowledgement",
      passed,
      passed
        ? "cancel acknowledgement accepted"
        : "cancel acknowledgement is not bound to the current authority",
      evidence,
    );
  } catch (error) {
    return failClosed("cancel-acknowledgement", `handleCancel failed: ${errorMessage(error)}`);
  }
}

async function steerCase(context: CaseContext): Promise<PublicationConformanceCaseResult> {
  const input: SteerParams = {
    invocationId: context.authority.invocationId,
    authority: context.authority,
    tenantId: context.tenantId,
    steerPayload: { inputRef: "conformance-input", inputDigest: digest("conformance-input") },
  };
  if (!context.capabilities.features.steer) {
    return resultFromEvidence(
      "steer-capability-consistency",
      true,
      "steer is not declared and is not invoked",
      { caseId: "steer-capability-consistency", passed: true, declared: false },
    );
  }
  try {
    const response = await context.runtimeAdapter.handleSteer(input);
    const passed =
      response.response.accepted &&
      sameAuthority(response.response.targetAuthority, context.authority);
    const evidence = {
      caseId: "steer-capability-consistency",
      passed,
      response: response.response,
      declared: true,
    };
    return resultFromEvidence(
      "steer-capability-consistency",
      passed,
      passed
        ? "steer acknowledgement accepted"
        : "steer acknowledgement is not bound to the current authority",
      evidence,
    );
  } catch (error) {
    return failClosed("steer-capability-consistency", `handleSteer failed: ${errorMessage(error)}`);
  }
}

async function resumeCase(context: CaseContext): Promise<PublicationConformanceCaseResult> {
  const input: ResumeParams = {
    invocationId: context.authority.invocationId,
    authority: context.authority,
    tenantId: context.tenantId,
    resumePayload: { type: "conformance-resume" },
  };
  if (!context.capabilities.features.resume) {
    return resultFromEvidence(
      "resume-capability-consistency",
      true,
      "resume is not declared and is not invoked",
      { caseId: "resume-capability-consistency", passed: true, declared: false },
    );
  }
  try {
    const response = await context.runtimeAdapter.handleResume(input);
    const passed =
      response.response.accepted &&
      Boolean(response.response.remoteSessionRef) &&
      Boolean(response.response.remoteExecutionRef) &&
      sameAuthority(response.response.authority, context.authority);
    const evidence = {
      caseId: "resume-capability-consistency",
      passed,
      response: response.response,
      declared: true,
    };
    return resultFromEvidence(
      "resume-capability-consistency",
      passed,
      passed
        ? "resume acknowledgement accepted"
        : "resume acknowledgement is incomplete or unbound",
      evidence,
    );
  } catch (error) {
    return failClosed(
      "resume-capability-consistency",
      `handleResume failed: ${errorMessage(error)}`,
    );
  }
}

async function recoveryCase(context: CaseContext): Promise<PublicationConformanceCaseResult> {
  const declaresCheckpoint =
    context.capabilities.features.workspaceModes.includes("CHECKPOINT_RESTORABLE");
  if (!declaresCheckpoint) {
    return resultFromEvidence(
      "session-recovery-declaration",
      true,
      "checkpoint-restorable workspace is not declared",
      { caseId: "session-recovery-declaration", passed: true, declared: false },
    );
  }
  try {
    const response = await context.runtimeAdapter.handleResume({
      invocationId: context.authority.invocationId,
      authority: context.authority,
      tenantId: context.tenantId,
      resumePayload: { type: "conformance-checkpoint-resume" },
      checkpointRef: "conformance-checkpoint",
    });
    const passed = response.response.accepted && Boolean(response.response.remoteExecutionRef);
    const evidence = {
      caseId: "session-recovery-declaration",
      passed,
      declared: true,
      response: response.response,
      checkpointRef: "conformance-checkpoint",
    };
    return resultFromEvidence(
      "session-recovery-declaration",
      passed,
      passed
        ? "checkpoint resume acknowledgement accepted"
        : "checkpoint resume acknowledgement is incomplete",
      evidence,
    );
  } catch (error) {
    return failClosed(
      "session-recovery-declaration",
      `checkpoint resume failed: ${errorMessage(error)}`,
    );
  }
}

function buildStartParams(
  context: CaseContext,
  overrides: { continuityMode?: WorkspaceMode } = {},
): StartInvocationParams {
  return {
    invocationId: context.authority.invocationId,
    authority: context.authority,
    tenantId: context.tenantId,
    threadId: null,
    turnId: null,
    inputItems: [{ type: "user_message", content: { text: "conformance" } }],
    gatewayEndpoints: {
      events: "https://conformance.invalid/runtime/events",
      heartbeat: "https://conformance.invalid/runtime/heartbeat",
      context: "https://conformance.invalid/runtime/context",
      capabilityActions: "https://conformance.invalid/gateway/capability-actions",
      toolCalls: "https://conformance.invalid/gateway/tool-calls",
      userActions: "https://conformance.invalid/gateway/user-actions",
    },
    authToken: "conformance-token",
    workspace: overrides.continuityMode
      ? {
          mode: "BOUND",
          bindingId: CONFORMANCE_WORKSPACE_BINDING_ID,
          contractDigest: digest("conformance-workspace-contract"),
          continuityMode: overrides.continuityMode,
          activationEvidenceRef: "conformance-activation-evidence",
        }
      : { mode: "NONE" },
    executionLimits: {
      maxEventBytes: 262_144,
      maxBatchEvents: 100,
      maxBatchBytes: 1_048_576,
      dispatchDeadlineMs: 120_000,
      executionTimeoutMs: 60_000,
    },
    traceContext: { traceId: context.authority.invocationId, spanId: randomUUID() },
  };
}

/** Workspace profile 探针使用的固定绑定标识（不改业务事实，只是探针输入）。 */
const CONFORMANCE_WORKSPACE_BINDING_ID = "00000000-0000-4000-8000-0000000000aa";

/** 协议定义的 4 个正式 Workspace 业务模式（未声明模式必须 fail closed）。 */
const ALL_WORKSPACE_MODES = WorkspaceModeSchema.options;

// ─── RuntimeProtocol 行为清单（R10 §3） ─────────────────────

/**
 * §7.5：启动答复是 **Transport 接纳证据，不是运行事实**。
 *
 * 只允许出现协议定义的这 8 个字段；出现任何 `running` / `startedEventId` 一类
 * 运行态声明即视为 ACK 越过 Ingress 自称运行事实。
 */
const TRANSPORT_ACCEPTANCE_FIELDS = [
  "protocolVersion",
  "authority",
  "semanticRequestDigest",
  "accepted",
  "remoteSessionRef",
  "remoteExecutionRef",
  "capabilitiesDigest",
  "acceptedAt",
] as const;

/** §7.6：任务 Heartbeat 与过期停机的 Adapter 侧半边 —— 可被心跳追踪的接纳回执。 */
async function heartbeatSemanticsCase(
  context: CaseContext,
): Promise<PublicationConformanceCaseResult> {
  const declared = context.capabilities.features.heartbeat;
  const params = buildStartParams(context);
  const dispatchedAt = Date.now();
  try {
    const response = (await context.runtimeAdapter.startInvocation(params)).response;
    const ackObservedAt = Date.now();
    // 接纳时刻必须落在平台发出 Start 与收到 ACK 之间：平台据此建立租约到期时刻，
    // 才能在 Owner 过期时判定「Runtime 已被停机」。固定/伪造的时间戳 fail closed。
    const clocked =
      Number.isInteger(response.acceptedAt) &&
      response.acceptedAt >= dispatchedAt &&
      response.acceptedAt <= ackObservedAt;
    // 接纳必须绑定平台按发布事实算出的能力摘要（R02 §3 的唯一比对源）；否则平台
    // 无法用该快照续租，也无法在 `execution.started` 回调上三方对账。
    const capabilityBound = response.capabilitiesDigest === context.expectedCapabilitiesDigest;
    const accepted = response.accepted === true && response.remoteSessionRef.length > 0;
    const passed = declared && accepted && clocked && capabilityBound;
    const evidence = {
      caseId: "heartbeat-semantics",
      passed,
      call: "startInvocation",
      declaredHeartbeat: declared,
      accepted,
      clocked,
      capabilityBound,
      acceptedAt: response.acceptedAt,
      dispatchedAt,
      ackObservedAt,
      capabilitiesDigest: response.capabilitiesDigest,
      expectedCapabilitiesDigest: context.expectedCapabilitiesDigest,
      // 平台侧半边（只续未过期 Owner / 过期即受控停机）由 Platform Integration 证明。
      platformHalfProvenBy: "platform-integration-conformance",
    };
    return resultFromEvidence(
      "heartbeat-semantics",
      passed,
      passed
        ? "start acknowledgement carries a clocked, capability-bound acceptance receipt"
        : "start acknowledgement is not a heartbeat-trackable acceptance receipt",
      evidence,
    );
  } catch (error) {
    return failClosed("heartbeat-semantics", `startInvocation failed: ${errorMessage(error)}`);
  }
}

/** §7.5：相同启动重试语义摘要稳定，业务内容变更必须产生不同摘要（冲突可被平台识别）。 */
async function durableStartIdempotencyCase(
  context: CaseContext,
): Promise<PublicationConformanceCaseResult> {
  const params = buildStartParams(context);
  try {
    const first = (await context.runtimeAdapter.startInvocation(params)).response;
    const retry = (await context.runtimeAdapter.startInvocation(params)).response;
    const conflict = (
      await context.runtimeAdapter.startInvocation({
        ...params,
        inputItems: [{ type: "user_message", content: { text: "conformance-conflict" } }],
      })
    ).response;
    const retryDigestStable = first.semanticRequestDigest === retry.semanticRequestDigest;
    const retryRefsStable =
      first.remoteSessionRef === retry.remoteSessionRef &&
      first.remoteExecutionRef === retry.remoteExecutionRef;
    const conflictDigestDiffers = conflict.semanticRequestDigest !== first.semanticRequestDigest;
    const passed =
      first.accepted &&
      retry.accepted &&
      conflict.accepted &&
      retryDigestStable &&
      conflictDigestDiffers;
    const evidence = {
      caseId: "durable-start-idempotency",
      passed,
      call: "startInvocation",
      retryDigestStable,
      retryRefsStable,
      conflictDigestDiffers,
      semanticRequestDigest: first.semanticRequestDigest,
      retrySemanticRequestDigest: retry.semanticRequestDigest,
      conflictSemanticRequestDigest: conflict.semanticRequestDigest,
      remoteSessionRef: first.remoteSessionRef,
      remoteExecutionRef: first.remoteExecutionRef,
      // 平台侧半边（Idempotency-Key=start:{ownershipId} 的冻结与 StartIntentConflict）
      // 由 Platform Integration 证明。
      platformHalfProvenBy: "platform-integration-conformance",
    };
    return resultFromEvidence(
      "durable-start-idempotency",
      passed,
      passed
        ? "durable start identity is stable across retries and detects content conflicts"
        : "durable start identity is unstable or cannot detect conflicts",
      evidence,
    );
  } catch (error) {
    return failClosed(
      "durable-start-idempotency",
      `startInvocation failed: ${errorMessage(error)}`,
    );
  }
}

/**
 * §7.5：`execution.started` 回调**可以先于** Start 的 HTTP 响应，但 ACK 不得反过来说
 * 自己已经是运行事实。Adapter 侧可观察的一半是：同一启动意图在重试下返回**同一**语义
 * 摘要（平台才能把早到的回调关联到同一次启动），且 ACK 只含 Transport 接纳字段。
 */
async function startedEventBeforeAckCase(
  context: CaseContext,
): Promise<PublicationConformanceCaseResult> {
  const params = buildStartParams(context);
  try {
    const first = (await context.runtimeAdapter.startInvocation(params)).response;
    const retry = (await context.runtimeAdapter.startInvocation(params)).response;
    const transportAcceptanceOnly = Object.keys(first).every((key) =>
      (TRANSPORT_ACCEPTANCE_FIELDS as readonly string[]).includes(key),
    );
    const retryDigestStable = first.semanticRequestDigest === retry.semanticRequestDigest;
    const passed = transportAcceptanceOnly && retryDigestStable && first.accepted;
    const evidence = {
      caseId: "started-event-before-ack",
      passed,
      call: "startInvocation",
      transportAcceptanceOnly,
      retryDigestStable,
      semanticRequestDigest: first.semanticRequestDigest,
      acceptedFields: Object.keys(first).sort(),
      // 平台侧半边（Session 预登记必须先于任何回调受理）由 Platform Integration 证明。
      platformHalfProvenBy: "platform-integration-conformance",
    };
    return resultFromEvidence(
      "started-event-before-ack",
      passed,
      passed
        ? "start acknowledgement stays a transport acceptance correlatable with early callbacks"
        : "start acknowledgement claims a run fact or cannot correlate an early callback",
      evidence,
    );
  } catch (error) {
    return failClosed("started-event-before-ack", `startInvocation failed: ${errorMessage(error)}`);
  }
}

/** §7.7：精确 Replay 的前提是同一启动意图给出同一语义摘要与同一能力快照绑定。 */
async function exactReplayCase(context: CaseContext): Promise<PublicationConformanceCaseResult> {
  const params = buildStartParams(context);
  try {
    const first = (await context.runtimeAdapter.startInvocation(params)).response;
    const replay = (await context.runtimeAdapter.startInvocation(params)).response;
    const semanticRequestDigest = first.semanticRequestDigest;
    const digestStable = first.semanticRequestDigest === replay.semanticRequestDigest;
    // 能力快照不得在重放中被重新协商；否则「原回执」对应的能力声明会漂移，
    // 精确 Replay 就失去与发布事实的绑定（R02 §3 的同一摘要）。
    const capabilitiesStable =
      first.capabilitiesDigest === replay.capabilitiesDigest &&
      first.capabilitiesDigest === context.expectedCapabilitiesDigest;
    const passed = digestStable && capabilitiesStable;
    const evidence = {
      caseId: "exact-replay",
      passed,
      call: "startInvocation",
      semanticRequestDigest,
      capabilitiesDigest: first.capabilitiesDigest,
      replayedSemanticRequestDigest: replay.semanticRequestDigest,
      replayedCapabilitiesDigest: replay.capabilitiesDigest,
      expectedCapabilitiesDigest: context.expectedCapabilitiesDigest,
      // 平台侧半边（原 eventId/sequence/payloadHash/Epoch 精确回执、旧 Owner 新事件拒绝）
      // 由 Platform Integration 证明。
      platformHalfProvenBy: "platform-integration-conformance",
    };
    return resultFromEvidence(
      "exact-replay",
      passed,
      passed
        ? "identical start intent replays with a stable digest and capability snapshot"
        : "replay re-negotiates the intent digest or capability snapshot",
      evidence,
    );
  } catch (error) {
    return failClosed("exact-replay", `startInvocation failed: ${errorMessage(error)}`);
  }
}

/**
 * §7.8/§7.9：控制命令必须精确针对指定 generation —— 错代际不得被应用，也**不得**被
 * 自行改派给「当前 Owner」。Adapter 侧可观察的那一半是：给一个旧代际 Authority，
 * 运行时要么按权威判定拒绝，要么原样回显同一个目标代际；绝不能回显成另一个代际
 * 而让旧远端的命令悄悄落到新一代执行上。
 */
async function oldEpochRejectionCase(
  context: CaseContext,
): Promise<PublicationConformanceCaseResult> {
  const currentEpoch = BigInt(context.authority.leaseEpoch);
  const staleAuthority: AuthorityIdentity = {
    ...context.authority,
    leaseEpoch: String(currentEpoch > 1n ? currentEpoch - 1n : 1n),
  };
  const staleInput: SteerParams = {
    invocationId: context.authority.invocationId,
    authority: staleAuthority,
    tenantId: context.tenantId,
    steerPayload: { inputRef: "conformance-stale-epoch", inputDigest: digest("stale-epoch") },
  };
  let outcome: string;
  let targetAuthorityEcho = false;
  let rejection: string | null = null;
  try {
    const response = await context.runtimeAdapter.handleSteer(staleInput);
    outcome = response.response.accepted ? "accepted" : "refused";
    targetAuthorityEcho =
      !response.response.accepted ||
      sameAuthority(response.response.targetAuthority, staleAuthority);
  } catch (error) {
    rejection = errorMessage(error);
    // 拒绝必须是**权威判定**；「控制服务没接线」不是通过。
    outcome =
      /NotCurrentExecutor|OwnershipExpired|RuntimeSessionMismatch|AttemptMismatch|RUNTIME_AUTHORITY/.test(
        rejection,
      )
        ? "authority-rejected"
        : "inconclusive";
  }
  const passed =
    (outcome === "accepted" && targetAuthorityEcho) || outcome === "authority-rejected";
  const evidence = {
    caseId: "old-epoch-rejection",
    passed,
    call: "handleSteer",
    outcome,
    targetAuthorityEcho,
    staleLeaseEpoch: staleAuthority.leaseEpoch,
    currentLeaseEpoch: context.authority.leaseEpoch,
    rejection,
    // 平台侧半边（requireCurrentExecutionAuthority 的换代 Fence）由 Platform Integration 证明。
    platformHalfProvenBy: "platform-integration-conformance",
  };
  return resultFromEvidence(
    "old-epoch-rejection",
    passed,
    passed
      ? "stale-generation command is authority-rejected or bound to its exact target generation"
      : "stale-generation command was re-targeted to another generation or rejected inconclusively",
    evidence,
  );
}

/** §7.4：Runtime 只能接受自己声明的 Workspace 连续性 profile，未声明模式必须 fail closed。 */
async function workspaceProfileCase(
  context: CaseContext,
): Promise<PublicationConformanceCaseResult> {
  const declaredModes = [...context.capabilities.features.workspaceModes];
  const acceptedModes: string[] = [];
  const rejectedModes: string[] = [];
  const undeclaredMode = ALL_WORKSPACE_MODES.find((mode) => !declaredModes.includes(mode));
  try {
    for (const mode of declaredModes) {
      const response = (
        await context.runtimeAdapter.startInvocation(
          buildStartParams(context, { continuityMode: mode }),
        )
      ).response;
      if (response.accepted) acceptedModes.push(mode);
    }
    if (undeclaredMode) {
      try {
        await context.runtimeAdapter.startInvocation(
          buildStartParams(context, { continuityMode: undeclaredMode }),
        );
      } catch {
        rejectedModes.push(undeclaredMode);
      }
    }
    const passed =
      acceptedModes.length === declaredModes.length &&
      (undeclaredMode === undefined || rejectedModes.includes(undeclaredMode));
    const evidence = {
      caseId: "workspace-profile",
      passed,
      call: "startInvocation",
      declaredModes,
      acceptedModes,
      rejectedModes,
      undeclaredMode: undeclaredMode ?? null,
      // 平台侧半边（WorkspaceBinding/Writer 事务与 Fence）由 Platform Integration 证明。
      platformHalfProvenBy: "platform-integration-conformance",
    };
    return resultFromEvidence(
      "workspace-profile",
      passed,
      passed
        ? "declared workspace profiles are accepted and undeclared profiles fail closed"
        : "workspace profile declaration and actual acceptance disagree",
      evidence,
    );
  } catch (error) {
    return failClosed("workspace-profile", `startInvocation failed: ${errorMessage(error)}`);
  }
}

/** §7.4/§7.5：只有声明 CHECKPOINT_RESTORABLE 才要求特定 Snapshot 恢复行为。 */
async function filesystemCheckpointCase(
  context: CaseContext,
): Promise<PublicationConformanceCaseResult> {
  const declaredModes = [...context.capabilities.features.workspaceModes];
  const declared = declaredModes.includes("CHECKPOINT_RESTORABLE");
  if (!declared) {
    const evidence = {
      caseId: "filesystem-checkpoint",
      passed: true,
      call: "probeCapabilities",
      declared: false,
      declaredModes,
    };
    return resultFromEvidence(
      "filesystem-checkpoint",
      true,
      "checkpoint-restorable workspace is not declared and is not invoked",
      evidence,
    );
  }
  try {
    const response = (
      await context.runtimeAdapter.handleResume({
        invocationId: context.authority.invocationId,
        authority: context.authority,
        tenantId: context.tenantId,
        resumePayload: { type: "conformance-checkpoint-resume" },
        checkpointRef: "conformance-checkpoint",
      })
    ).response;
    const passed =
      response.accepted &&
      Boolean(response.remoteSessionRef) &&
      Boolean(response.remoteExecutionRef);
    const evidence = {
      caseId: "filesystem-checkpoint",
      passed,
      call: "handleResume",
      declared: true,
      declaredModes,
      response,
    };
    return resultFromEvidence(
      "filesystem-checkpoint",
      passed,
      passed
        ? "checkpoint resume acknowledgement accepted"
        : "checkpoint resume acknowledgement is incomplete",
      evidence,
    );
  } catch (error) {
    return failClosed("filesystem-checkpoint", `checkpoint resume failed: ${errorMessage(error)}`);
  }
}

/**
 * 探针 Authority。
 *
 * `runtimeRevisionId` 必须是被测候选的**真实** revision 身份：接纳回执的能力摘要由
 * `expectedCapabilityManifestDigest({runtimeRevisionId, capability manifest})` 计算，
 * 用固定占位 revision 会让探针算出的期望摘要与 Runtime 按发布事实算出的摘要不一致，
 * 从而把「合格 Runtime」误判为未绑定发布事实。
 */
function createConformanceAuthority(runtimeRevisionId: string): AuthorityIdentity {
  return AuthorityIdentitySchema.parse({
    invocationId: "00000000-0000-4000-8000-000000000001",
    runtimeRevisionId,
    attemptId: "00000000-0000-4000-8000-000000000003",
    ownershipId: "00000000-0000-4000-8000-000000000004",
    // 探针使用一个 >1 的代际，这样 old-epoch-rejection 才能构造出真正更旧的代际
    // （协议 CHECK 规定 leaseEpoch ≥ 1，代际 1 没有更旧值）。
    leaseEpoch: "7",
    sessionBindingId: "00000000-0000-4000-8000-000000000005",
  });
}

function sameAuthority(left: AuthorityIdentity, right: AuthorityIdentity): boolean {
  return (
    left.invocationId === right.invocationId &&
    left.runtimeRevisionId === right.runtimeRevisionId &&
    left.attemptId === right.attemptId &&
    left.ownershipId === right.ownershipId &&
    left.leaseEpoch === right.leaseEpoch &&
    left.sessionBindingId === right.sessionBindingId
  );
}

function resultFromEvidence(
  caseId: PublicationConformanceCaseId,
  passed: boolean,
  reason: string,
  evidence: Record<string, unknown>,
): PublicationConformanceCaseResult {
  return { caseId, passed, reason, evidence, evidenceDigest: computeCaseEvidenceDigest(evidence) };
}

function failClosed(
  caseId: PublicationConformanceCaseId,
  reason: string,
): PublicationConformanceCaseResult {
  return resultFromEvidence(caseId, false, reason, { caseId, passed: false, error: reason });
}

export function validateCapabilitiesResponse(capabilities: RuntimeCapabilities): void {
  const parsed = RuntimeCapabilitiesSchema.safeParse(capabilities);
  if (!parsed.success) throw new ConformanceRunnerError(parsed.error.message);
}

function digest(value: string): string {
  return `sha256:${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ConformanceRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceRunnerError";
  }
}
