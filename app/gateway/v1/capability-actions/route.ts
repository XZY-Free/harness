import { getTurnById } from "@/lib/conversations/turn-queries";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/error-codes";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewaySchemaInvalidTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";
import { loadFrozenGovernanceConfig } from "@/lib/governance/governance-repository";
import { apiError, apiSuccess, getRequestId } from "@/lib/http";
import { recordAuditEvent } from "@/lib/identity/audit";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import { createConfiguredRouteResolver } from "@/lib/routes/infrastructure/configured-route-resolver";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { type RuntimeCandidateEvent, ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { HARNESS_NEXT_ACTION_SCHEMA } from "@/lib/runtime/harness-loop/action-schema";
import {
  CapabilityActionValidationError,
  type CapabilityCatalogSnapshot,
  validateHarnessActionAgainstCatalog,
  verifyCapabilityCatalogSnapshot,
} from "@/lib/runtime/harness-loop/capability-catalog";
import {
  DEFAULT_HARNESS_LOOP_LIMITS,
  type HarnessActionExecutionContext,
  type HarnessActionExecutionResult,
} from "@/lib/runtime/harness-loop/loop";
import { createMySqlHarnessLoopRecoveryPort } from "@/lib/runtime/harness-loop/mysql-recovery-port";
import { createPlatformHarnessActionExecutors } from "@/lib/runtime/harness-loop/platform-action-executors";
import type { HarnessNextAction } from "@/lib/runtime/harness-loop/types";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import {
  type ExecutionSubject,
  recoverTrustedExecutionSubject,
} from "@/lib/runtime/transport/execution-subject";

export const dynamic = "force-dynamic";

const BODY_KEYS = new Set(["invocation_id", "producer_sequence_start", "action"]);
const configuredResolver = createConfiguredRouteResolver({
  projectionStore: mysqlRouteEligibilityResolutionStore,
});
const resolveRoute: RouteResolver = async (input) =>
  (
    await configuredResolver({
      tenantId: input.tenantId,
      target: input.target,
      routeScopeKey: input.routeScopeKey,
      businessKey: input.businessKey,
      attributes: input.attributes,
      threadDefaultModelRef: input.threadDefaultModelRef,
    })
  ).outcome;

function parseBody(raw: unknown): {
  invocationId: string;
  producerSequenceStart: number;
  action: Exclude<HarnessNextAction, { actionType: "respond" }>;
} | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => !BODY_KEYS.has(key))) return null;
  if (typeof body.invocation_id !== "string" || !body.invocation_id) return null;
  if (
    !Number.isInteger(body.producer_sequence_start) ||
    (body.producer_sequence_start as number) < 1
  ) {
    return null;
  }
  const action = HARNESS_NEXT_ACTION_SCHEMA.safeParse(body.action);
  if (!action.success || action.data.actionType === "respond") return null;
  return {
    invocationId: body.invocation_id,
    producerSequenceStart: body.producer_sequence_start as number,
    action: action.data as Exclude<HarnessNextAction, { actionType: "respond" }>,
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: GatewayPrincipal;
  try {
    principal = await resolveGatewayPrincipal(request.headers);
  } catch (error) {
    const response = gatewayAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }
  const body = parseBody(await request.json().catch(() => null));
  if (!body || body.invocationId !== principal.invocationId) {
    return gatewaySchemaInvalidTable(
      requestId,
      "请求体必须包含匹配 Token 的 invocation_id、producer_sequence_start 与严格 action",
    );
  }
  if (request.headers.get("idempotency-key") !== `${body.invocationId}:${body.action.actionId}`) {
    return gatewaySchemaInvalidTable(
      requestId,
      "Idempotency-Key 必须由 invocation_id 与 actionId 稳定组成",
    );
  }

  const invocation = await getInvocationById(principal.tenantId, principal.invocationId);
  if (!invocation || invocation.executionState !== "running" || !invocation.turnId) {
    return apiError("HARNESS_LOOP_STATE_RECOVERY_FAILED", "Invocation 不可执行 action", {
      requestId,
    });
  }
  const turn = await getTurnById(principal.tenantId, invocation.turnId);
  if (!turn) {
    return apiError("HARNESS_LOOP_STATE_RECOVERY_FAILED", "Turn 不存在", { requestId });
  }
  const binding = await getExecutionBindingByInvocation(principal.tenantId, principal.invocationId);
  if (!binding) {
    return apiError("HARNESS_LOOP_STATE_RECOVERY_FAILED", "ExecutionBinding 不存在", {
      requestId,
    });
  }
  let executionSubject: ExecutionSubject;
  try {
    executionSubject = recoverTrustedExecutionSubject(binding, principal.tenantId);
  } catch {
    return apiError("HARNESS_LOOP_STATE_RECOVERY_FAILED", "可信执行主体不可恢复", {
      requestId,
    });
  }
  if (!principal.runtimeRevisionId || principal.runtimeRevisionId !== binding.runtimeRevisionId) {
    await auditCapabilityAction({
      principal,
      executionSubject,
      action: body.action,
      requestId,
      outcome: "failed",
      reason: "RUNTIME_TARGET_MISMATCH",
    });
    return apiError("AUTHENTICATION_REQUIRED", "Gateway Token 与 Runtime Target 不一致", {
      requestId,
    });
  }
  if (
    body.action.actionType === "agent.call" &&
    (turn.agentUseMode !== "preferred" || turn.preferredAgentId !== body.action.payload.agentId)
  ) {
    await auditCapabilityAction({
      principal,
      executionSubject,
      action: body.action,
      requestId,
      outcome: "failed",
      reason: "AGENT_ACTION_NOT_ALLOWED",
    });
    return apiError("AGENT_ACTION_NOT_ALLOWED", "agent.call 目标不属于本 Turn preferred Agent", {
      requestId,
    });
  }
  let capabilityCatalog: CapabilityCatalogSnapshot;
  try {
    capabilityCatalog = verifyCapabilityCatalogSnapshot(
      binding.capabilityCatalogJson,
      binding.capabilityCatalogDigest,
    );
    validateHarnessActionAgainstCatalog(body.action, capabilityCatalog);
  } catch (error) {
    if (error instanceof CapabilityActionValidationError) {
      const code: ApiErrorCode =
        error.code === "ACTION_SCOPE_DENIED"
          ? "ACTION_SCOPE_DENIED"
          : error.code === "TOOL_ARGUMENTS_INVALID"
            ? "REQUEST_SCHEMA_INVALID"
            : error.code === "AGENT_ACTION_NOT_ALLOWED"
              ? "AGENT_ACTION_NOT_ALLOWED"
              : "CAPABILITY_NOT_ALLOWED";
      await auditCapabilityAction({
        principal,
        executionSubject,
        action: body.action,
        requestId,
        outcome: "failed",
        reason: code,
      });
      return apiError(code, error.message, { requestId });
    }
    await auditCapabilityAction({
      principal,
      executionSubject,
      action: body.action,
      requestId,
      outcome: "failed",
      reason: "HARNESS_LOOP_STATE_RECOVERY_FAILED",
    });
    return apiError("HARNESS_LOOP_STATE_RECOVERY_FAILED", "冻结能力目录不可验证", { requestId });
  }
  let frozenGovernance: Awaited<ReturnType<typeof loadFrozenGovernanceConfig>>;
  try {
    frozenGovernance = await loadFrozenGovernanceConfig(
      principal.tenantId,
      binding.governanceConfigRevisionId,
    );
  } catch {
    await auditCapabilityAction({
      principal,
      executionSubject,
      action: body.action,
      requestId,
      outcome: "failed",
      reason: "GOVERNANCE_CONFIG_UNAVAILABLE",
    });
    return apiError("HARNESS_LOOP_STATE_RECOVERY_FAILED", "冻结 Governance 配置不可用", {
      requestId,
    });
  }
  if (frozenGovernance.configDigest !== binding.governanceConfigDigest) {
    await auditCapabilityAction({
      principal,
      executionSubject,
      action: body.action,
      requestId,
      outcome: "failed",
      reason: "GOVERNANCE_DIGEST_MISMATCH",
    });
    return apiError("HARNESS_LOOP_STATE_RECOVERY_FAILED", "冻结 Governance digest 不一致", {
      requestId,
    });
  }
  const limits = {
    ...DEFAULT_HARNESS_LOOP_LIMITS,
    ...(frozenGovernance.config.harnessLoopLimits ?? {}),
  };

  const recoveryPort = createMySqlHarnessLoopRecoveryPort(principal.tenantId);
  const snapshot = await recoveryPort.load(principal.invocationId);
  const existing = snapshot.actionHistory.find((entry) => entry.actionId === body.action.actionId);
  const digest = computeCanonicalDigest({
    actionType: body.action.actionType,
    payload: body.action.payload,
  });
  if (existing) {
    if (existing.actionDigest !== digest) {
      return apiError("HARNESS_ACTION_SCHEMA_INVALID", "actionId 已绑定不同 payload", {
        requestId,
      });
    }
    if (existing.state === "completed" && existing.observation) {
      await auditCapabilityAction({
        principal,
        executionSubject,
        action: body.action,
        requestId,
        outcome: "succeeded",
        reason: "idempotent_replay",
      });
      return apiSuccess({
        action_id: existing.actionId,
        state: "completed",
        observation: existing.observation,
        authority_ref: existing.authorityRef ?? null,
        next_producer_sequence: snapshot.nextProducerSequence,
      });
    }
    if (existing.state === "failed") {
      await auditCapabilityAction({
        principal,
        executionSubject,
        action: body.action,
        requestId,
        outcome: "failed",
        reason: "ACTION_ALREADY_FAILED",
      });
      return apiError("HARNESS_LOOP_STATE_RECOVERY_FAILED", "已失败 action 不可自动重放", {
        requestId,
      });
    }
  } else if (body.action.stepNo !== snapshot.actionHistory.length + 1) {
    await auditCapabilityAction({
      principal,
      executionSubject,
      action: body.action,
      requestId,
      outcome: "failed",
      reason: "ACTION_STEP_DISCONTINUITY",
    });
    return apiError("HARNESS_ACTION_SCHEMA_INVALID", "action.stepNo 与持久行动历史不连续", {
      requestId,
    });
  }
  if (!existing && body.producerSequenceStart !== snapshot.nextProducerSequence) {
    await auditCapabilityAction({
      principal,
      executionSubject,
      action: body.action,
      requestId,
      outcome: "failed",
      reason: "EVENT_SEQUENCE_GAP",
    });
    return apiError("EVENT_SEQUENCE_GAP", "producer_sequence_start 与持久账本不连续", {
      requestId,
    });
  }
  if (body.action.stepNo > limits.maxLoopSteps) {
    await auditCapabilityAction({
      principal,
      executionSubject,
      action: body.action,
      requestId,
      outcome: "failed",
      reason: "HARNESS_LOOP_STEP_LIMIT_EXCEEDED",
    });
    return apiError("HARNESS_LOOP_STEP_LIMIT_EXCEEDED", "Harness Loop 步骤预算耗尽", {
      requestId,
    });
  }
  const actionTypeCount = snapshot.actionHistory.filter(
    (entry) => entry.actionType === body.action.actionType,
  ).length;
  const typeLimit =
    body.action.actionType === "agent.call"
      ? limits.maxAgentCalls
      : body.action.actionType === "tool.call"
        ? limits.maxToolCalls
        : body.action.actionType === "knowledge.search"
          ? limits.maxKnowledgeSearches
          : null;
  if (!existing && typeLimit !== null && actionTypeCount >= typeLimit) {
    await auditCapabilityAction({
      principal,
      executionSubject,
      action: body.action,
      requestId,
      outcome: "failed",
      reason: "HARNESS_LOOP_STEP_LIMIT_EXCEEDED",
    });
    return apiError("HARNESS_LOOP_STEP_LIMIT_EXCEEDED", `${body.action.actionType} 预算耗尽`, {
      requestId,
    });
  }
  if (!existing) {
    let consecutive = 0;
    const target = targetRef(body.action);
    for (let index = snapshot.actionHistory.length - 1; index >= 0; index -= 1) {
      const entry = snapshot.actionHistory[index];
      if (
        !entry ||
        entry.actionType !== body.action.actionType ||
        entry.targetRef !== target ||
        entry.actionDigest !== digest
      ) {
        break;
      }
      consecutive += 1;
    }
    if (consecutive >= limits.maxConsecutiveSameAction) {
      await auditCapabilityAction({
        principal,
        executionSubject,
        action: body.action,
        requestId,
        outcome: "failed",
        reason: "HARNESS_LOOP_REPEATED_ACTION",
      });
      return apiError("HARNESS_LOOP_REPEATED_ACTION", "连续相同行动超过预算", { requestId });
    }
  }

  const executors = createPlatformHarnessActionExecutors({
    tenantId: principal.tenantId,
    executionSubject,
    resolveRoute,
    capabilityCatalog,
    transportChannel: "gateway",
  });
  const executor = executors[body.action.actionType] as
    | ((
        action: never,
        context: HarnessActionExecutionContext,
      ) => Promise<HarnessActionExecutionResult>)
    | undefined;
  const start = existing ? snapshot.nextProducerSequence : body.producerSequenceStart;
  if (!existing) {
    await ingressEventBatch({
      tenantId: principal.tenantId,
      invocationId: principal.invocationId,
      producerSequenceStart: start,
      correlationId: requestId,
      events: [actionEvent(body.action, digest, "proposed", start)],
    });
  }
  if (!executor) {
    const errorCode =
      body.action.actionType === "agent.call"
        ? "AGENT_CALL_EXECUTOR_UNAVAILABLE"
        : "HARNESS_ACTION_EXECUTOR_UNAVAILABLE";
    const failedSequence = existing ? snapshot.nextProducerSequence : start + 1;
    await ingressEventBatch({
      tenantId: principal.tenantId,
      invocationId: principal.invocationId,
      producerSequenceStart: failedSequence,
      correlationId: requestId,
      events: [
        actionEvent(body.action, digest, "failed", failedSequence, { error_code: errorCode }),
      ],
    });
    await auditCapabilityAction({
      principal,
      executionSubject,
      action: body.action,
      requestId,
      outcome: "failed",
      reason: errorCode,
    });
    return apiError(errorCode, `${body.action.actionType} 执行器未注册`, { requestId });
  }

  const startedSequence = existing ? snapshot.nextProducerSequence : start + 1;
  if (existing?.state !== "started") {
    await ingressEventBatch({
      tenantId: principal.tenantId,
      invocationId: principal.invocationId,
      producerSequenceStart: startedSequence,
      correlationId: requestId,
      events: [actionEvent(body.action, digest, "started", startedSequence)],
    });
  }
  let execution: HarnessActionExecutionResult;
  try {
    execution = await executor(body.action as never, {
      invocationId: principal.invocationId,
      tenantId: principal.tenantId,
      threadId: invocation.threadId ?? "",
      turnId: invocation.turnId,
      actionDigest: digest,
    });
  } catch (error) {
    const reportedCode = getErrorCode(error);
    const errorCode: ApiErrorCode =
      body.action.actionType === "knowledge.search"
        ? "KNOWLEDGE_ACTION_FAILED"
        : body.action.actionType === "tool.call"
          ? "TOOL_ACTION_FAILED"
          : reportedCode && reportedCode in API_ERROR_CODES
            ? (reportedCode as ApiErrorCode)
            : "AGENT_CALL_FAILED";
    const failedSequence = startedSequence + (existing?.state === "started" ? 0 : 1);
    await ingressEventBatch({
      tenantId: principal.tenantId,
      invocationId: principal.invocationId,
      producerSequenceStart: failedSequence,
      correlationId: requestId,
      events: [
        actionEvent(body.action, digest, "failed", failedSequence, {
          error_code: errorCode,
        }),
      ],
    });
    await auditCapabilityAction({
      principal,
      executionSubject,
      action: body.action,
      requestId,
      outcome: "failed",
      reason: errorCode,
    });
    return apiError(errorCode, error instanceof Error ? error.message : String(error), {
      requestId,
    });
  }
  if (execution.pending) {
    await auditCapabilityAction({
      principal,
      executionSubject,
      action: body.action,
      requestId,
      outcome: "succeeded",
      reason: "pending",
    });
    return apiSuccess({
      action_id: body.action.actionId,
      state: "started",
      disposition: "pending",
      pending: execution.pending,
      authority_ref: execution.authorityRef ?? null,
      next_producer_sequence: startedSequence + (existing?.state === "started" ? 0 : 1),
    });
  }
  const completedSequence = startedSequence + (existing?.state === "started" ? 0 : 1);
  await ingressEventBatch({
    tenantId: principal.tenantId,
    invocationId: principal.invocationId,
    producerSequenceStart: completedSequence,
    correlationId: requestId,
    events: [
      actionEvent(body.action, digest, "completed", completedSequence, {
        ...(execution.authorityRef ? { authority_ref: execution.authorityRef } : {}),
        observation: execution.observation,
      }),
    ],
  });
  await auditCapabilityAction({
    principal,
    executionSubject,
    action: body.action,
    requestId,
    outcome: "succeeded",
  });
  return apiSuccess({
    action_id: body.action.actionId,
    state: "completed",
    observation: execution.observation,
    authority_ref: execution.authorityRef ?? null,
    waiting_for_user: execution.waitingForUser ?? null,
    next_producer_sequence: completedSequence + 1,
  });
}

async function auditCapabilityAction(params: {
  principal: GatewayPrincipal;
  executionSubject: ExecutionSubject;
  action: Exclude<HarnessNextAction, { actionType: "respond" }>;
  requestId: string;
  outcome: "succeeded" | "failed";
  reason?: string;
}): Promise<void> {
  await recordAuditEvent({
    actor: {
      tenantId: params.principal.tenantId,
      actorType: "workload",
      actorId: `gateway:${params.principal.invocationId}`,
    },
    actionType: "capability.action.execute",
    targetType: params.action.actionType,
    targetId: targetRef(params.action),
    outcome: params.outcome,
    reason: params.reason ?? null,
    requestId: params.requestId,
    metadataRedacted: {
      parent_invocation_id: params.principal.invocationId,
      caller_workload: {
        type: params.principal.type,
        audience: params.principal.audience,
        runtime_revision_id: params.principal.runtimeRevisionId ?? null,
      },
      effective_subject: {
        type: params.executionSubject.subjectType,
        id: params.executionSubject.subjectId,
      },
      capability: {
        kind: params.action.actionType,
        id: targetRef(params.action),
        action_id: params.action.actionId,
      },
    },
  });
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" && error.code ? error.code : null;
}

function actionEvent(
  action: HarnessNextAction,
  digest: string,
  state: "proposed" | "started" | "completed" | "failed",
  sequence: number,
  extra: Record<string, unknown> = {},
): RuntimeCandidateEvent {
  return {
    producer_event_id: `gateway-action-${action.actionId}-${state}`,
    producer_sequence: sequence,
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    type: `harness.action.${state}`,
    payload: {
      action_id: action.actionId,
      step_no: action.stepNo,
      action_type: action.actionType,
      action_digest: digest,
      purpose_code: action.purposeCode,
      short_purpose: action.shortPurpose,
      target_ref: targetRef(action),
      state,
      action_payload: action.payload,
      ...extra,
    },
  };
}

function targetRef(action: HarnessNextAction): string | null {
  switch (action.actionType) {
    case "knowledge.search":
      return action.payload.preferredSourceRefs?.join(",") ?? null;
    case "tool.call":
      return `${action.payload.toolId}:${action.payload.operationId}`;
    case "agent.call":
      return action.payload.agentId;
    case "request_user_input":
      return action.payload.purpose;
    case "respond":
      return null;
  }
}
