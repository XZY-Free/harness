import { REQUEST_ID_HEADER, getRequestId, resourceNotFound, apiSuccess } from "@/lib/http";
import { getEnvironmentStatus } from "@/lib/v11/conversation/environment-status-queries";
import {
  EMPTY_CONDITIONS,
  type TakeoverConditions,
  getTakeoverConditions,
} from "@/lib/v11/conversation/environment-takeover-queries";
/**
 * GET /api/v1/threads/{thread_id}/environment — 查询 Thread 当前 Environment 状态（S10-W06 / S10-W07）。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md
 *   S10-W06：「Desktop 复用共同时间线，在右侧增加文件、页面和内部系统任务操作面板」
 *   「本地 Shell、Git、测试、构建、浏览器和应用操作显示实际执行设备、目录、权限和结果」
 *   S10-W07：「页面显示当前 Environment owner、在线状态、租约和接管条件」
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 读取 Thread.defaultEnvironmentDefinitionId + latest Turn.activeInvocationId。
 * - 调用 getEnvironmentStatus 聚合查询 EnvironmentDefinition + active Lease + ExecutionOwnership。
 * - 推导 availability（no_environment/cloud/online_desktop/pending_device/offline_desktop）。
 * - S10-W07：调用 getTakeoverConditions 聚合接管条件（未完成 ToolCall/Effect/写锁/owner 心跳）。
 * - 返回 200 + 投影响应体（snake_case，含 takeover_conditions）。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 *
 * 不变量：
 * - 只读取，不修改任何状态。
 * - 跨租户隔离：Thread 必须属于 principal.tenantId。
 * - 不暴露内部堆栈或跨租户数据。
 */
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/v11/conversation/route-helpers";
import { getThreadById } from "@/lib/v11/conversation/thread-queries";
import { getTurnsByThread } from "@/lib/v11/conversation/turn-queries";
import type { V11EnvironmentLease } from "@/lib/v11/schema/environment";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ thread_id: string }>;
}

/** 投影 EnvironmentDefinition 为响应体（snake_case）。 */
function projectEnvironmentDefinition(def: {
  id: string;
  environmentKey: string;
  displayName: string;
  description: string | null;
  environmentType: string;
  lifecycleState: string;
}): Record<string, unknown> {
  return {
    id: def.id,
    environment_key: def.environmentKey,
    display_name: def.displayName,
    description: def.description,
    environment_type: def.environmentType,
    lifecycle_state: def.lifecycleState,
  };
}

/** 投影 EnvironmentLease 为响应体（snake_case）。 */
function projectLease(lease: V11EnvironmentLease): Record<string, unknown> {
  return {
    id: lease.id,
    environment_definition_id: lease.environmentDefinitionId,
    invocation_id: lease.invocationId,
    attempt_id: lease.attemptId,
    device_id: lease.deviceId,
    lease_state: lease.leaseState,
    allocated_at: lease.allocatedAt.toISOString(),
    last_heartbeat_at: lease.lastHeartbeatAt?.toISOString() ?? null,
    expires_at: lease.expiresAt?.toISOString() ?? null,
    released_at: lease.releasedAt?.toISOString() ?? null,
  };
}

/** 投影 ExecutionOwnership 为响应体（snake_case）。 */
function projectOwnership(ownership: {
  id: string;
  invocationId: string;
  deviceId: string | null;
  environmentLeaseId: string | null;
  ownershipState: string;
  leaseEpoch: number;
  acquiredAt: Date;
  lastHeartbeatAt: Date | null;
  releasedAt: Date | null;
}): Record<string, unknown> {
  return {
    id: ownership.id,
    invocation_id: ownership.invocationId,
    device_id: ownership.deviceId,
    environment_lease_id: ownership.environmentLeaseId,
    ownership_state: ownership.ownershipState,
    lease_epoch: ownership.leaseEpoch,
    acquired_at: ownership.acquiredAt.toISOString(),
    last_heartbeat_at: ownership.lastHeartbeatAt?.toISOString() ?? null,
    released_at: ownership.releasedAt?.toISOString() ?? null,
  };
}

/** 投影 TakeoverConditions 为响应体（snake_case）。 */
function projectTakeoverConditions(conditions: TakeoverConditions): Record<string, unknown> {
  return {
    can_takeover: conditions.can_takeover,
    blocking_reasons: conditions.blocking_reasons,
    pending_tool_calls: conditions.pending_tool_calls,
    unknown_effects: conditions.unknown_effects,
    active_write_locks: conditions.active_write_locks,
    owner_heartbeat_stale: conditions.owner_heartbeat_stale,
    owner_device_id: conditions.owner_device_id,
    ownership_id: conditions.ownership_id,
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
  if (!thread || thread.ownerUserId !== principal.userIdentityId) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  // 3. 读取最新 Turn 取 activeInvocationId
  const turns = await getTurnsByThread(principal.tenantId, threadId);
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const activeInvocationId = latestTurn?.activeInvocationId ?? null;

  // 4. 聚合查询 Environment 状态
  const status = await getEnvironmentStatus({
    tenantId: principal.tenantId,
    threadId,
    environmentDefinitionId: thread.defaultEnvironmentDefinitionId,
    activeInvocationId,
  });

  // 5. S10-W07：聚合查询接管条件（仅当有 active ownership 时才有意义）
  let takeoverConditions: TakeoverConditions = EMPTY_CONDITIONS;
  if (status.activeOwnership) {
    takeoverConditions = await getTakeoverConditions({
      tenantId: principal.tenantId,
      threadId,
      activeInvocationId,
      activeOwnership: status.activeOwnership,
      activeLease: status.activeLease,
    });
  }

  // 6. 返回 200 + 投影响应体
  const responseBody = {
    thread_id: threadId,
    environment_definition: status.environmentDefinition
      ? projectEnvironmentDefinition(status.environmentDefinition)
      : null,
    active_lease: status.activeLease ? projectLease(status.activeLease) : null,
    active_ownership: status.activeOwnership ? projectOwnership(status.activeOwnership) : null,
    availability: status.availability,
    active_invocation_id: activeInvocationId,
    takeover_conditions: projectTakeoverConditions(takeoverConditions),
  };

  return apiSuccess(responseBody, {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
