import { REQUEST_ID_HEADER, decodeCursor, getRequestId, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import { listJobsByTenant } from "@/lib/v11/job/job-queries";
/**
 * GET /admin/api/v1/jobs — 跨 agent 列出租户所有 Job（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 支持查询参数 job_state、limit、cursor。
 * - cursor 为不透明 base64url(JSON{ created_at, id })，由 listJobsByTenant 解析为 afterCreatedAt。
 * - 调用 listJobsByTenant（按 createdAt 降序）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - job_state 非法 → 400 REQUEST_SCHEMA_INVALID
 * - cursor 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

const VALID_JOB_STATES = new Set([
  "queued",
  "running",
  "waiting_external",
  "completed",
  "failed",
  "cancelled",
]);

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 admin 主体
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const jobStateParam = url.searchParams.get("job_state");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  let jobState:
    | "queued"
    | "running"
    | "waiting_external"
    | "completed"
    | "failed"
    | "cancelled"
    | undefined;
  if (jobStateParam) {
    if (!VALID_JOB_STATES.has(jobStateParam)) {
      return v11SchemaInvalid(requestId, `job_state 非法: ${jobStateParam}`);
    }
    jobState = jobStateParam as
      | "queued"
      | "running"
      | "waiting_external"
      | "completed"
      | "failed"
      | "cancelled";
  }

  let afterCreatedAt: Date | undefined;
  if (cursor) {
    try {
      const decoded = decodeCursor(cursor) as { created_at?: string };
      if (typeof decoded.created_at !== "string") {
        return v11SchemaInvalid(requestId, "cursor 缺少 created_at 字段");
      }
      afterCreatedAt = new Date(decoded.created_at);
      if (Number.isNaN(afterCreatedAt.getTime())) {
        return v11SchemaInvalid(requestId, "cursor.created_at 不是合法 ISO 时间");
      }
    } catch (err) {
      return v11SchemaInvalid(requestId, `cursor 解析失败: ${(err as Error).message}`);
    }
  }

  // 3. 查询 Job 列表
  const { items, nextCursor } = await listJobsByTenant(principal.tenantId, {
    jobState,
    limit,
    afterCreatedAt,
  });

  // 4. 投影并返回 200
  const projected = items.map((j) => ({
    id: j.id,
    tenant_id: j.tenantId,
    agent_id: j.agentId,
    job_type: j.jobType,
    trigger_ref: j.triggerRef,
    job_state: j.jobState,
    replaces_job_id: j.replacesJobId,
    thread_id: j.threadId,
    completion_policy_json: j.completionPolicyJson,
    input_ref: j.inputRef,
    input_hash: j.inputHash,
    last_event_sequence: j.lastEventSequence,
    result_ref: j.resultRef,
    result_hash: j.resultHash,
    error_code: j.errorCode,
    error_summary: j.errorSummary,
    created_by: j.createdBy,
    created_at: j.createdAt.toISOString(),
    started_at: j.startedAt?.toISOString() ?? null,
    finished_at: j.finishedAt?.toISOString() ?? null,
    updated_at: j.updatedAt.toISOString(),
    version_no: j.versionNo,
  }));

  return v11Ok(
    { items: projected, next_cursor: nextCursor, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
