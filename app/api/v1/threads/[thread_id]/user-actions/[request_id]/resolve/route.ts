import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
/**
 * POST /api/v1/threads/{thread_id}/user-actions/{request_id}/resolve — 员工解析通用 UserAction 请求（S10-W05，§3.18）。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md §3.18（解析 UserActionRequest）、
 *   §3.19（auth callback）、§7.2（user_action.resolved Event）
 * - docs/architecture/persistence.md §6.8（user_action_request 表）
 * - docs/architecture/product-surfaces-and-admin.md S10-W05
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（resolution: approve/deny/submit/cancel；input+submit 时 response_redacted 必填）。
 * - 校验 UserActionRequest 属于该 Thread + state=pending（否则 404 隐藏式）。
 * - 通用 resolve 处理 confirmation/auth/grant/input 类型（专题01 废弃 handoff 类型，purpose=handoff 不再有专用路径）。
 * - 调用 resolveGenericUserAction 事务内：
 *   - 原子 UPDATE UserActionRequest: pending → resolved
 *   - grant+approve 时创建 Grant + 回填 grant_id
 *   - input+submit 时写入 responseRedactedJson
 *   - UPDATE Invocation: waiting_user → running
 *   - 写 user_action.resolved Event
 *   - 入队 resume InvocationCommand
 * - completeRecord + 返回 200 + UserAction 解析结果投影。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - UserActionRequest 不存在/非该 Thread → 404 RESOURCE_NOT_FOUND
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - UserActionAlreadyResolvedError → 409 OPERATION_PAYLOAD_CONFLICT
 * - UserActionValidationError / UserActionResolutionMismatchError / UserActionStateError
 *   → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import { resolveGenericUserAction } from "@/lib/conversations/user-action-resolve-queries";
import { db } from "@/lib/db/client";
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
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import type { UserActionResolution } from "@/lib/persistence/schema/user-action-request";
import { dispatchResumeCommandToRuntime } from "@/lib/runtime/command-dispatch-gateway";
import { InvocationAlreadyTerminalError } from "@/lib/runtime/errors";
import { markInvocationLost } from "@/lib/runtime/recovery-queries";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
/**
 * 路径参数上下文（Next.js App Router 原生动态段）。
 * 命令作为资源子路径（`/{id}/command`），动态参数直接从 params 解构。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 请求体 schema。 */
interface ResolveUserActionBody {
  resolution: UserActionResolution;
  /** input 类型 submit 时必填：已脱敏的响应 JSON。 */
  response_redacted?: unknown;
}

function validateBody(body: unknown): body is ResolveUserActionBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const resolution = b.resolution;
  if (
    resolution !== "approve" &&
    resolution !== "deny" &&
    resolution !== "submit" &&
    resolution !== "cancel"
  ) {
    return false;
  }
  // response_redacted 必须是对象或数组（submit 时必填，其他类型忽略）
  if (
    b.response_redacted !== undefined &&
    b.response_redacted !== null &&
    typeof b.response_redacted !== "object" &&
    !Array.isArray(b.response_redacted)
  ) {
    return false;
  }
  return true;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const params = await context.params;
  const threadId = typeof params.thread_id === "string" ? params.thread_id : "";
  const userActionRequestId = typeof params.request_id === "string" ? params.request_id : "";

  // 1. 解析员工身份
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Thread 属于当前员工（非 owner → 404 隐藏式）
  const thread = await getThreadById(principal.tenantId, threadId);
  if (!thread || thread.ownerUserId !== principal.userIdentityId) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  // 3. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(
      requestId,
      "请求体非法：resolution 仅接受 approve/deny/submit/cancel；response_redacted 必须是对象",
    );
  }

  // 5. 计算请求 hash + 幂等守卫（先于 UAR pending 校验：同 key 同 body 重放必须
  //    返回与第一次相同的 200/202/422 结果，即使 UAR 已 resolved —— 03 §8）。
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromPrincipal(principal);
  const commandScope = `thread.resolve_user_action:${userActionRequestId}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 6. 处理幂等结果
  if (outcome.kind === "replay") {
    return buildReplayResponse(outcome.record, requestId);
  }
  if (outcome.kind === "in_flight" || outcome.kind === "conflict") {
    return buildIdempotencyErrorResponse({
      record: outcome.kind === "conflict" ? outcome.existingRecord : outcome.record,
      reason: outcome.kind === "conflict" ? "conflict" : "in_flight",
      requestId,
    });
  }

  let recordId = outcome.record.id;
  if (outcome.kind === "retry_allowed") {
    const reset = await prepareRetryForFailedRecord({
      record: outcome.record,
      requestHash,
    });
    if (!reset) {
      return buildIdempotencyErrorResponse({
        record: outcome.record,
        reason: "conflict",
        requestId,
      });
    }
    recordId = reset.id;
  }

  // 7. 校验 UserActionRequest 属于该 Thread + state=pending（非 replay 请求；
  //    非 pending → 404 隐藏式，不泄露存在）
  const [requestRow] = await db
    .select()
    .from(userActionRequestTable)
    .where(
      and(
        eq(userActionRequestTable.tenantId, principal.tenantId),
        eq(userActionRequestTable.id, userActionRequestId),
      ),
    )
    .limit(1);
  if (!requestRow || requestRow.threadId !== threadId || requestRow.requestState !== "pending") {
    await failRecord(recordId);
    return resourceNotFound(requestId, `UserAction 请求不存在或无权访问: ${userActionRequestId}`);
  }

  // 8. 执行业务：事务内解析 UserAction
  try {
    const result = await resolveGenericUserAction({
      tenantId: principal.tenantId,
      requestId: userActionRequestId,
      resolution: body.resolution,
      resolvedBy: principal.userIdentityId,
      actorType: "user",
      actorId: principal.userIdentityId,
      idempotencyKey,
      ...(body.response_redacted !== undefined && body.response_redacted !== null
        ? { responseRedactedJson: body.response_redacted }
        : {}),
    });

    // 08 §5 + 03 专项：A2A 协议下真实调用远端 resume（继续原 Invocation/taskId/
    // contextId）；hosted 协议由既有状态机吸收。网关返回真实命令结果，
    // 本路由绝不吞掉远端 failed/dispatched 而虚报成功。
    const gatewayResult = await dispatchResumeCommandToRuntime({
      tenantId: principal.tenantId,
      commandId: result.resumeCommand.id,
      actorId: principal.userIdentityId,
      correlationId: requestId,
    });

    // 03 §4：Hosted / protocol_not_remote / command_not_found / unsupported —
    // 沿用 in-process 状态机语义；返回 200 但明确 mode=local_runtime，
    // 不伪造 A2A ack。
    const resumeDispatch =
      gatewayResult.dispatched && gatewayResult.command.commandState === "acknowledged"
        ? { mode: "remote" as const, command_state: "acknowledged" as const }
        : gatewayResult.dispatched && gatewayResult.command.commandState === "dispatched"
          ? {
              mode: "remote" as const,
              command_state: "dispatched" as const,
              pending_retry: true as const,
            }
          : gatewayResult.dispatched && gatewayResult.command.commandState === "failed"
            ? { mode: "remote" as const, command_state: "failed" as const }
            : {
                mode: "local_runtime" as const,
                command_state: result.resumeCommand.commandState as string,
              };

    const responseBody = {
      thread_id: result.thread.id,
      request_id: result.request.id,
      request_type: result.request.requestType,
      purpose: result.request.purpose,
      resolution: body.resolution,
      request_state: result.request.requestState,
      invocation_id: result.invocation.id,
      invocation_state: result.invocation.executionState,
      resume_command_id: result.resumeCommand.id,
      // 03 §9：唯一 Authority 是真实 Gateway/Command 结果（resume_dispatch）。
      resume_dispatch: resumeDispatch,
      ...(result.grantId ? { grant_id: result.grantId } : {}),
      event_ids: result.events.map((e) => e.id),
    };

    // 03 §4 A2A failed：远端明确拒绝的不可重试终态 → 422；UAR 已提交事实不回滚
    //（UserAction remains resolved / responseRedactedJson remains stored）。
    if (resumeDispatch.command_state === "failed") {
      // 03 §6：terminal failed 后 Invocation 不得永久 running —— 转入平台已有
      // lost 终态（不伪造成 execution.failed）；transport 已推进终态则保留真实终态。
      try {
        await markInvocationLost({
          tenantId: principal.tenantId,
          invocationId: result.invocation.id,
          reasonCode: "resume_dispatch_failed",
          errorSummary: "Resume 命令未被运行服务接受",
          actorType: "system",
          actorId: principal.userIdentityId,
          correlationId: requestId,
          idempotencyKey: `resume-dispatch-failed:${result.resumeCommand.id}`,
        });
      } catch (lostErr) {
        if (!(lostErr instanceof InvocationAlreadyTerminalError)) {
          throw lostErr;
        }
      }
      const failureDetails = {
        request_id: result.request.id,
        invocation_id: result.invocation.id,
        resume_command_id: result.resumeCommand.id,
        resume_command_state: "failed",
        safe_error_code: (gatewayResult.dispatched && gatewayResult.command.errorCode) || "UNKNOWN",
      };
      // 03 §8：幂等记录完成成 422 响应（同 key 重放返回同一失败结果，
      // 不允许第二次 resolve UAR / 第二次远端调用）。存储体与 apiError wire 完全一致。
      await completeRecord({
        recordId,
        httpStatus: 422,
        responseRedactedJson: JSON.stringify({
          error: {
            code: "BUSINESS_CONSTRAINT_VIOLATION",
            message: "补充信息已保存，但运行服务未能恢复执行。",
            request_id: requestId,
            retryable: false,
            details: failureDetails,
          },
        }),
      });
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", "补充信息已保存，但运行服务未能恢复执行。", {
        requestId,
        details: failureDetails,
      });
    }

    // 03 §4 A2A dispatched：网络不可达/503，命令进入 retryable dispatched 状态 →
    // 202（补充信息已正式接受，远端恢复尚未确认，等待平台重试；不虚报完成）。
    const httpStatus =
      resumeDispatch.mode === "remote" && resumeDispatch.command_state === "dispatched" ? 202 : 200;

    await completeRecord({
      recordId,
      httpStatus,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: httpStatus,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);
    const errorResp = conversationErrorToResponse(err, requestId);
    if (errorResp) return errorResp;
    throw err;
  }
}
