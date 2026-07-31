/**
 * GET /admin/api/v1/deletion-requests/{deletion_request_id} — 查询管理员删除进度（S12-W07）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-data-lifecycle.md §7
 *         （管理员可查询删除请求进度，含逐存储 step 状态与 evidence_ref；
 *           steps 不含 Secret，仅 store_type / step_state / evidence_ref）。
 *
 * 行为：
 * - 校验身份 + action scope deletion.request（resource: tenant）。
 * - 按 id 查询请求；不存在 → 404 RESOURCE_NOT_FOUND（不暴露"存在但无权"）。
 * - 列出全部 steps，派生 summary（planned/completed/failed/blocked）。
 * - include_steps=true 时返回逐存储 step 投影（store_type / step_state / evidence_ref）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 请求 id 不存在 → 404 RESOURCE_NOT_FOUND
 * - include_steps 非法 → 400 REQUEST_SCHEMA_INVALID
 */
import { REQUEST_ID_HEADER, getRequestId, v11NotFound, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import {
  computeRequestSummary,
  getDeletionRequestById,
  listDeletionSteps,
} from "@/lib/v11/identity/deletion-request-queries";
import type { V11DeletionStep } from "@/lib/v11/schema/deletion-request";

export const dynamic = "force-dynamic";

/** 构造 step 投影（不含 Secret，仅 store_type / step_state / evidence_ref）。 */
function projectStep(s: V11DeletionStep): Record<string, unknown> {
  return {
    store_type: s.storeType,
    step_state: s.stepState,
    evidence_ref: s.evidenceRef,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ deletion_request_id: string }> },
): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 身份解析
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. action scope 校验：deletion.request + resource { type: tenant, id: tenantId }
  const scopeResult = await requireAdminActionScope(
    principal,
    "deletion.request",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. 解析路径参数
  const { deletion_request_id: deletionRequestId } = await context.params;
  if (!deletionRequestId) {
    return v11SchemaInvalid(requestId, "缺少路径参数 deletion_request_id");
  }

  // 4. 解析 include_steps 查询参数
  const url = new URL(request.url);
  const includeStepsParam = url.searchParams.get("include_steps");
  let includeSteps = false;
  if (includeStepsParam !== null) {
    if (includeStepsParam !== "true" && includeStepsParam !== "false") {
      return v11SchemaInvalid(requestId, "include_steps 必须为 true 或 false");
    }
    includeSteps = includeStepsParam === "true";
  }

  // 5. 查询请求；不存在 → 404 RESOURCE_NOT_FOUND（跨租户隔离由 getDeletionRequestById 保证）
  const deletionRequest = await getDeletionRequestById(principal.tenantId, deletionRequestId);
  if (!deletionRequest) {
    return v11NotFound(requestId, "删除请求不存在或无权访问");
  }

  // 6. 列出全部 steps + 派生 summary
  const steps = await listDeletionSteps(principal.tenantId, deletionRequestId);
  const summary = computeRequestSummary(steps);

  // 7. 构造响应投影（与 OpenAPI 契约对齐）
  const responseBody: Record<string, unknown> = {
    id: deletionRequest.id,
    request_state: deletionRequest.requestState,
    summary: {
      planned_steps: summary.plannedSteps,
      completed_steps: summary.completedSteps,
      failed_steps: summary.failedSteps,
      blocked_steps: summary.blockedSteps,
    },
    steps: includeSteps ? steps.map(projectStep) : [],
    updated_at: deletionRequest.updatedAt.toISOString(),
  };

  return v11Ok(responseBody, {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
