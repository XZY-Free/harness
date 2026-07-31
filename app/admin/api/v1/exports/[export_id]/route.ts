/**
 * GET /admin/api/v1/exports/{export_id} — AdminExport 单资源详情（S11-W08）。
 *
 * 行为：
 * - 解析 admin 主体（要求 action scope admin.export.read）。
 * - 校验 export 存在且属于当前租户（跨租户隐藏为 404）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Export 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */
import { REQUEST_ID_HEADER, etagHeader, getRequestId, v11NotFound, v11Ok } from "@/lib/http";
import { getAdminExportById } from "@/lib/v11/admin/export-queries";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ export_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { export_id: exportId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const scopeResult = await requireAdminActionScope(
    principal,
    "admin.export.read",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const exportRecord = await getAdminExportById(principal.tenantId, exportId);
  if (!exportRecord) {
    return v11NotFound(requestId, `Export 不存在或无权访问: ${exportId}`);
  }

  const body = {
    id: exportRecord.id,
    tenant_id: exportRecord.tenantId,
    requested_by: exportRecord.requestedBy,
    request_principal_kind: exportRecord.requestPrincipalKind,
    export_kind: exportRecord.exportKind,
    filter: exportRecord.filterJson,
    status: exportRecord.status,
    result_ref: exportRecord.resultRef,
    result_format: exportRecord.resultFormat,
    record_count: exportRecord.recordCount,
    redaction_summary: exportRecord.redactionSummary,
    failure_reason: exportRecord.failureReason,
    version_no: exportRecord.versionNo,
    created_at: exportRecord.createdAt.toISOString(),
    updated_at: exportRecord.updatedAt.toISOString(),
    completed_at: exportRecord.completedAt?.toISOString() ?? null,
    etag: `admin-export-${exportRecord.versionNo}`,
  };

  return v11Ok(body, {
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`admin-export-${exportRecord.versionNo}`),
    },
  });
}
