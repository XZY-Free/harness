import { REQUEST_ID_HEADER, getRequestId, resourceNotFound, apiSuccess } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getJobById } from "@/lib/v11/job/job-queries";
/**
 * GET /admin/api/v1/jobs/{job_id} — Job 单资源详情（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 调用 getJobById（按 tenantId 过滤实现跨租户隔离）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Job 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
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

  const job = await getJobById(principal.tenantId, jobId);
  if (!job) {
    return resourceNotFound(requestId, `Job 不存在或无权访问: ${jobId}`);
  }

  const body = {
    id: job.id,
    tenant_id: job.tenantId,
    agent_id: job.agentId,
    job_type: job.jobType,
    trigger_ref: job.triggerRef,
    job_state: job.jobState,
    replaces_job_id: job.replacesJobId,
    thread_id: job.threadId,
    completion_policy_json: job.completionPolicyJson,
    input_ref: job.inputRef,
    input_hash: job.inputHash,
    last_event_sequence: job.lastEventSequence,
    result_ref: job.resultRef,
    result_hash: job.resultHash,
    error_code: job.errorCode,
    error_summary: job.errorSummary,
    created_by: job.createdBy,
    created_at: job.createdAt.toISOString(),
    started_at: job.startedAt?.toISOString() ?? null,
    finished_at: job.finishedAt?.toISOString() ?? null,
    updated_at: job.updatedAt.toISOString(),
    version_no: job.versionNo,
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
