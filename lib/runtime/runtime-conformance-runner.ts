/** Runtime publication conformance runner for the single RuntimeProtocol contract. */
import { randomUUID } from "node:crypto";
import type {
  CancelParams,
  ResumeParams,
  RuntimeAdapter,
  StartInvocationParams,
  SteerParams,
} from "@/lib/runtime/adapters/hosted-adapter";
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
    authority: createConformanceAuthority(),
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

function buildStartParams(context: CaseContext): StartInvocationParams {
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
    workspace: { mode: "NONE" },
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

function createConformanceAuthority(): AuthorityIdentity {
  return AuthorityIdentitySchema.parse({
    invocationId: "00000000-0000-4000-8000-000000000001",
    runtimeRevisionId: "00000000-0000-4000-8000-000000000002",
    attemptId: "00000000-0000-4000-8000-000000000003",
    ownershipId: "00000000-0000-4000-8000-000000000004",
    leaseEpoch: "1",
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
