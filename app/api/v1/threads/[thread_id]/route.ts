import { getActiveGoalByThread } from "@/lib/conversations/goal-queries";
/**
 * GET /api/v1/threads/{thread_id} — 查询 Thread 详情（S10-W02，§3.1）。
 *
 * 事实源：docs/architecture/api-and-events.md §3.1、
 *         docs/architecture/product-surfaces-and-admin.md S10-W02。
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 返回 Thread 基础字段 + active Goal + 最新 Turn（用于推导当前任务状态）。
 * - 不返回 Turn 列表（由 SSE 事件驱动）或 Item 列表（由 GET /items 返回）。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 */
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById, updateThreadLifecycle } from "@/lib/conversations/thread-queries";
import { getTurnsByThread } from "@/lib/conversations/turn-queries";
import { type TurnControls, resolveTurnControls } from "@/lib/runtime/capabilities/turn-controls";

/** fail-closed 默认 controls（解析失败/无 Binding → 全 false）。 */
const TERMINAL_TURN_CONTROLS: TurnControls = {
  cancel_supported: false,
  resume_supported: false,
  steer_supported: false,
};
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import type { Goal, Thread, Turn } from "@/lib/persistence/schema/conversation";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ thread_id: string }>;
}

/** 投影 Thread 为响应体（snake_case）。 */
function projectThread(thread: Thread): Record<string, unknown> {
  return {
    id: thread.id,
    title: thread.title,
    active_goal_id: thread.activeGoalId,
    default_workspace_id: thread.defaultWorkspaceId,
    default_model_ref: thread.defaultModelRef,
    default_environment_definition_id: thread.defaultEnvironmentDefinitionId,
    lifecycle_state: thread.lifecycleState,
    last_activity_at: thread.lastActivityAt.toISOString(),
    last_event_sequence: thread.lastEventSequence,
    pending_queue_version_no: thread.pendingQueueVersionNo,
    version_no: thread.versionNo,
    created_at: thread.createdAt.toISOString(),
  };
}

/** 投影 Goal 为响应体（snake_case）。 */
function projectGoal(goal: Goal): Record<string, unknown> {
  return {
    id: goal.id,
    thread_id: goal.threadId,
    objective: goal.objective,
    success_criteria: goal.successCriteriaJson,
    constraints: goal.constraintsJson,
    current_state: goal.currentStateJson,
    goal_state: goal.goalState,
    created_at: goal.createdAt.toISOString(),
    completed_at: goal.completedAt?.toISOString() ?? null,
  };
}

/**
 * 投影 Turn 为响应体（snake_case，仅最新 Turn 的摘要字段）。
 * controls（05 §9）由服务端按精确 Binding 派生；终态 Turn 恒 false。
 */
function projectTurnSummary(turn: Turn, controls: TurnControls): Record<string, unknown> {
  return {
    controls: {
      cancel_supported: controls.cancel_supported,
      resume_supported: controls.resume_supported,
      steer_supported: controls.steer_supported,
    },
    id: turn.id,
    turn_sequence: turn.turnSequence,
    trigger_type: turn.triggerType,
    turn_state: turn.turnState,
    active_invocation_id: turn.activeInvocationId,
    latest_invocation_id: turn.latestInvocationId,
    adopted_invocation_id: turn.adoptedInvocationId,
    final_item_id: turn.finalItemId,
    error_code: turn.errorCode,
    regeneration_no: turn.regenerationNo,
    accepted_at: turn.acceptedAt.toISOString(),
    started_at: turn.startedAt?.toISOString() ?? null,
    waiting_at: turn.waitingAt?.toISOString() ?? null,
    finished_at: turn.finishedAt?.toISOString() ?? null,
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
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
  if (
    !thread ||
    thread.ownerUserId !== principal.userIdentityId ||
    thread.lifecycleState === "deleted"
  ) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  // 3. 读取 active Goal + 最新 Turn（并行）
  const [activeGoal, turns] = await Promise.all([
    thread.activeGoalId ? getActiveGoalByThread(threadId) : Promise.resolve(null),
    getTurnsByThread(principal.tenantId, threadId),
  ]);

  // 最新 Turn = turnSequence 最大的（数组已按 turnSequence 升序）
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;

  // 4. 解析最新 Turn controls（服务端 Binding 派生，05 §9）并返回
  const controlsByTurn = latestTurn
    ? await resolveTurnControls(principal.tenantId, [latestTurn])
    : null;
  const responseBody = {
    thread: projectThread(thread),
    active_goal: activeGoal ? projectGoal(activeGoal) : null,
    latest_turn: latestTurn
      ? projectTurnSummary(latestTurn, controlsByTurn?.get(latestTurn.id) ?? TERMINAL_TURN_CONTROLS)
      : null,
  };

  return apiSuccess(responseBody, {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}

/**
 * DELETE /api/v1/threads/{thread_id} — 删除当前员工自己的会话。
 *
 * 仅将 Thread 标记为 deleted；列表、详情和后续 Turn 均不再可见或可写。
 */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { thread_id: threadId } = await context.params;

  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const thread = await getThreadById(principal.tenantId, threadId);
  if (
    !thread ||
    thread.ownerUserId !== principal.userIdentityId ||
    thread.lifecycleState === "deleted"
  ) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  const deleted = await updateThreadLifecycle(
    principal.tenantId,
    threadId,
    "deleted",
    thread.versionNo,
  );
  if (!deleted) {
    return resourceNotFound(requestId, `Thread 已被更新或删除: ${threadId}`);
  }

  return apiSuccess(
    { id: threadId, lifecycle_state: deleted.lifecycleState, deleted: true },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
