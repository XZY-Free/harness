import { requestPausedTurnResume } from "@/lib/conversations/pause-resume-queries";
import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getTurnById } from "@/lib/conversations/turn-queries";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import {
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromPrincipal,
  completeRecord,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/identity/idempotency";
import { resolveEffectiveInvocationCapabilities } from "@/lib/runtime/capabilities/effective-invocation-capabilities";
import { dispatchResumeCommandToRuntime } from "@/lib/runtime/command-dispatch-gateway";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ turn_id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { turn_id: turnId } = await context.params;
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (error) {
    const response = employeeAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }

  const turn = await getTurnById(principal.tenantId, turnId);
  if (!turn) return resourceNotFound(requestId, `Turn 不存在或无权访问: ${turnId}`);
  const thread = await getThreadById(principal.tenantId, turn.threadId);
  if (!thread || thread.ownerUserId !== principal.userIdentityId) {
    return resourceNotFound(requestId, `Turn 不存在或无权访问: ${turnId}`);
  }
  if (!turn.activeInvocationId) {
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", "当前任务不可继续", { requestId });
  }
  const binding = await getExecutionBindingByInvocation(
    principal.tenantId,
    turn.activeInvocationId,
  );
  if (!binding) {
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", "当前任务缺少执行绑定", { requestId });
  }
  const capabilities = await resolveEffectiveInvocationCapabilities({
    tenantId: principal.tenantId,
    binding,
  });
  if (!capabilities.resume) {
    return apiError("UNSUPPORTED_CAPABILITY", "当前运行方式不支持继续", {
      requestId,
      details: { turn_id: turnId, capability: "resume" },
    });
  }

  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  const body = {};
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const outcome = await enforceIdempotency({
    caller: callerFromPrincipal(principal),
    commandScope: `turn.resume:${turnId}`,
    idempotencyKey,
    requestHash,
  });
  if (outcome.kind === "replay") return buildReplayResponse(outcome.record, requestId);
  if (outcome.kind === "in_flight" || outcome.kind === "conflict") {
    return buildIdempotencyErrorResponse({
      record: outcome.kind === "conflict" ? outcome.existingRecord : outcome.record,
      reason: outcome.kind === "conflict" ? "conflict" : "in_flight",
      requestId,
    });
  }
  let recordId = outcome.record.id;
  if (outcome.kind === "retry_allowed") {
    const reset = await prepareRetryForFailedRecord({ record: outcome.record, requestHash });
    if (!reset) {
      return buildIdempotencyErrorResponse({
        record: outcome.record,
        reason: "conflict",
        requestId,
      });
    }
    recordId = reset.id;
  }

  try {
    const result = await requestPausedTurnResume({
      tenantId: principal.tenantId,
      ownerUserId: principal.userIdentityId,
      turnId,
      idempotencyKey,
      correlationId: requestId,
    });
    const dispatched = await dispatchResumeCommandToRuntime({
      tenantId: principal.tenantId,
      commandId: result.command.id,
      actorId: principal.userIdentityId,
      correlationId: requestId,
    });
    if (!dispatched.dispatched) {
      throw new Error(`Resume 命令未能调度: ${dispatched.reason}`);
    }
    if (dispatched.command.commandState === "failed") {
      throw new Error(
        `Resume 命令失败: ${dispatched.command.errorCode ?? "RESUME_DISPATCH_FAILED"}`,
      );
    }
    const responseBody = {
      turn_id: result.turnId,
      turn_state:
        dispatched.command.commandState === "acknowledged"
          ? ("running" as const)
          : result.turnState,
      resume_state: result.resumeState,
      command: {
        id: result.command.id,
        command_state: dispatched.command.commandState,
      },
      event_id: result.eventId,
    };
    await completeRecord({
      recordId,
      httpStatus: 202,
      responseRedactedJson: JSON.stringify(responseBody),
    });
    return apiSuccess(responseBody, {
      status: 202,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (error) {
    await failRecord(recordId);
    const response = conversationErrorToResponse(error, requestId);
    if (response) return response;
    throw error;
  }
}
