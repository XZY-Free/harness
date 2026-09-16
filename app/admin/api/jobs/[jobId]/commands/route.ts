import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { getJobCommands } from "@/lib/job/job-command-queries";
import { getJobById } from "@/lib/job/job-queries";
/**
 * GET /admin/api/jobs/{jobId}/commands — 列出 Job 命令（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Job 存在且属于当前租户（跨租户隐藏为 404）。
 * - 支持查询参数 limit。
 * - 调用 getJobCommands（按 created_at 降序，跨租户隔离）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Job 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - limit 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { jobId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 校验 Job 存在且属于当前租户
  const job = await getJobById(principal.tenantId, jobId);
  if (!job) {
    return resourceNotFound(requestId, `Job 不存在或无权访问: ${jobId}`);
  }

  // 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  const commands = await getJobCommands(principal.tenantId, jobId, { limit });

  const projected = commands.map((c) => ({
    id: c.id,
    tenant_id: c.tenantId,
    jobId: c.jobId,
    command_type: c.commandType,
    command_state: c.commandState,
    idempotency_key: c.idempotencyKey,
    requested_by_type: c.requestedByType,
    requested_by_id: c.requestedById,
    payload_json: c.payloadJson,
    payload_hash: c.payloadHash,
    last_error_code: c.lastErrorCode,
    result_json: c.resultJson,
    created_at: c.createdAt.toISOString(),
    next_attempt_at: c.nextAttemptAt.toISOString(),
    completed_at: c.completedAt?.toISOString() ?? null,
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
