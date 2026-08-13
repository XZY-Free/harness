import { getEnvironmentStatus } from "@/lib/conversations/environment-status-queries";
import {
  NoActiveOwnershipError,
  TakeoverConditionsNotMetError,
  getTakeoverConditions,
  performTakeover,
} from "@/lib/conversations/environment-takeover-queries";
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getTurnsByThread } from "@/lib/conversations/turn-queries";
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
/**
 * POST /api/v1/threads/{thread_id}/environment:takeover — 员工请求接管 Desktop Environment（S10-W07）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W07：
 *   「接管前核对未完成 ToolCall/Effect；重复连接不能并发执行同一需要写锁的本地操作」
 *   「Web 发起的本地任务在指定 Desktop 离线时进入等待，不静默迁移到 Cloud」
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 读取 latest Turn.activeInvocationId + 聚合查询 Environment 状态。
 * - 必须存在 active ExecutionOwnership（否则 409 BUSINESS_CONSTRAINT_VIOLATION 无需接管）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 调用 getTakeoverConditions 校验 can_takeover=true（否则 422 BUSINESS_CONSTRAINT_VIOLATION）。
 * - 调用 performTakeover 事务内：
 *   - SELECT FOR UPDATE ownership → 校验仍 active
 *   - markLost ownership（active → lost）
 *   - revoke 残余活跃写锁（防御性）
 *   - markLost Lease（如提供）
 *   - 写 environment.takeover_executed Event
 * - completeRecord + 返回 200 + 接管结果投影。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 无 active ownership → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - TakeoverConditionsNotMetError → 422 BUSINESS_CONSTRAINT_VIOLATION（含 blocking_reasons）
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 *
 * 不变量：
 * - 不创建新 Lease/Ownership；新 Invocation 创建时由调度器 acquire。
 * - 不静默迁移到 Cloud：接管只释放旧 owner 资源，不改变 Thread.defaultEnvironmentDefinitionId。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */

export const dynamic = "force-dynamic";

/**
 * 路径参数上下文（含冒号 custom method 段）。
 *
 * Next.js 把 `[thread_id]` 段 + `environment:takeover` 静态段分开；
 * params key 为 "thread_id"，段值为该段实际值。
 */
interface RouteContext {
  params: Promise<{ thread_id: string }>;
}

/** 请求体 schema。 */
interface TakeoverBody {
  /** 接管原因代码（可选，默认 "user_takeover"）。 */
  reason_code?: string;
}

function validateBody(body: unknown): body is TakeoverBody {
  if (body === null || body === undefined) return true;
  if (typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.reason_code !== undefined && typeof b.reason_code !== "string") return false;
  return true;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { thread_id: threadId } = await context.params;

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

  // 4. 解析请求体（可选 reason_code）
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(requestId, "请求体非法：reason_code 必须是字符串（可选）");
  }
  const reasonCode = body?.reason_code ?? "user_takeover";

  // 5. 读取最新 Turn 取 activeInvocationId + 聚合查询 Environment 状态
  const turns = await getTurnsByThread(principal.tenantId, threadId);
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const activeInvocationId = latestTurn?.activeInvocationId ?? null;

  const status = await getEnvironmentStatus({
    tenantId: principal.tenantId,
    threadId,
    environmentDefinitionId: thread.defaultEnvironmentDefinitionId,
    activeInvocationId,
  });

  // 6. 校验存在 active ExecutionOwnership
  if (!status.activeOwnership) {
    return apiError(
      "BUSINESS_CONSTRAINT_VIOLATION",
      `Thread ${threadId} 当前无活跃 ExecutionOwnership，无需接管`,
      {
        requestId,
        details: { thread_id: threadId, active_invocation_id: activeInvocationId },
      },
    );
  }

  // 7. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body ?? {});
  const caller = callerFromPrincipal(principal);
  const commandScope = `thread.environment_takeover:${threadId}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 8. 处理幂等结果
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

  // 9. 校验接管条件
  const conditions = await getTakeoverConditions({
    tenantId: principal.tenantId,
    threadId,
    activeInvocationId,
    activeOwnership: status.activeOwnership,
    activeLease: status.activeLease,
  });

  if (!conditions.can_takeover) {
    await failRecord(recordId);
    return apiError(
      "BUSINESS_CONSTRAINT_VIOLATION",
      `接管条件不满足：${conditions.blocking_reasons.join("；") || "未知原因"}`,
      {
        requestId,
        details: {
          thread_id: threadId,
          ownership_id: conditions.ownership_id,
          can_takeover: false,
          blocking_reasons: conditions.blocking_reasons,
          pending_tool_calls: conditions.pending_tool_calls,
          unknown_effects: conditions.unknown_effects,
          active_write_locks: conditions.active_write_locks,
          owner_heartbeat_stale: conditions.owner_heartbeat_stale,
        },
      },
    );
  }

  // 10. 执行接管事务
  try {
    const result = await performTakeover({
      tenantId: principal.tenantId,
      threadId,
      activeInvocationId: activeInvocationId ?? "",
      activeOwnershipId: status.activeOwnership.id,
      actorUserId: principal.userIdentityId,
      idempotencyKey,
      activeLeaseId: status.activeLease?.id ?? null,
      reasonCode,
    });

    const responseBody = {
      thread_id: threadId,
      ownership_id: result.ownership_id,
      lease_id: result.lease_id,
      revoked_lock_ids: result.revoked_lock_ids,
      event_id: result.event_id,
      previous_lease_epoch: result.previous_lease_epoch,
      reason_code: reasonCode,
    };

    await completeRecord({
      recordId,
      httpStatus: 200,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);
    if (err instanceof NoActiveOwnershipError) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, {
        requestId,
        details: { thread_id: threadId },
      });
    }
    if (err instanceof TakeoverConditionsNotMetError) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, {
        requestId,
        details: {
          thread_id: threadId,
          blocking_reasons: err.conditions.blocking_reasons,
        },
      });
    }
    throw err;
  }
}
