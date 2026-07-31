import { REQUEST_ID_HEADER, getRequestId, v11NotFound, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import { getJobCommands } from "@/lib/v11/job/job-command-queries";
import { getJobById } from "@/lib/v11/job/job-queries";
/**
 * GET /admin/api/v1/jobs/{job_id}/commands — 列出 Job 命令（S11-W04）。
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
  params: Promise<{ job_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { job_id: jobId } = await context.params;

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
    return v11NotFound(requestId, `Job 不存在或无权访问: ${jobId}`);
  }

  // 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  const commands = await getJobCommands(principal.tenantId, jobId, { limit });

  const projected = commands.map((c) => ({
    id: c.id,
    tenant_id: c.tenantId,
    job_id: c.jobId,
    command_type: c.commandType,
    command_state: c.commandState,
    idempotency_key: c.idempotencyKey,
    requested_by: c.requestedBy,
    reason_code: c.reasonCode,
    replacement_job_id: c.replacementJobId,
    error_code: c.errorCode,
    error_summary: c.errorSummary,
    command_payload_json: c.commandPayloadJson,
    created_at: c.createdAt.toISOString(),
    dispatched_at: c.dispatchedAt?.toISOString() ?? null,
    acknowledged_at: c.acknowledgedAt?.toISOString() ?? null,
  }));

  return v11Ok(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
