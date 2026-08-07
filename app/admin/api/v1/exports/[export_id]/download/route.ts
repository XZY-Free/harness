/**
 * GET /admin/api/v1/exports/{export_id}/download — AdminExport 下载（S11-W08）。
 *
 * 行为：
 * - 解析 admin 主体（要求 action scope admin.export.read）。
 * - 校验 export 存在且属于当前租户（跨租户隐藏为 404）。
 * - 校验 status=completed（其他状态返回 409 EXPORT_STATE_INVALID）。
 * - 重新渲染 NDJSON（resultRef 为下载 URL，未持久化内容；强制 redacted 模式脱敏）。
 * - 写审计 admin.export.downloaded。
 * - 返回 application/x-ndjson 流。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Export 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - status 非 completed → 409 OPERATION_PAYLOAD_CONFLICT
 */
import { REQUEST_ID_HEADER, apiError, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
import { getAdminExportById } from "@/lib/admin/export-queries";
import { recordExportDownloadedAudit, renderExportNdjson } from "@/lib/admin/export-runner";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ export_id: string }>;
}

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
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

  // download 复用 admin.export.read scope（与 detail 一致）
  const scopeResult = await requireAdminActionScope(
    principal,
    "admin.export.read",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const exportRecord = await getAdminExportById(principal.tenantId, exportId);
  if (!exportRecord) {
    return resourceNotFound(requestId, `Export 不存在或无权访问: ${exportId}`);
  }

  if (exportRecord.status !== "completed") {
    return apiError(
      "OPERATION_PAYLOAD_CONFLICT",
      `导出任务 ${exportId} 状态非 completed（当前 ${exportRecord.status}），拒绝下载`,
      { requestId },
    );
  }

  // 重新渲染 NDJSON（resultRef 是 URL 引用，未持久化内容）
  const rendered = await renderExportNdjson({
    tenantId: exportRecord.tenantId,
    exportKind: exportRecord.exportKind,
    filterJson: exportRecord.filterJson,
  });

  // 写审计 admin.export.downloaded
  const actor = actorFromAdminPrincipal(principal);
  await recordExportDownloadedAudit({
    actor,
    tenantId: principal.tenantId,
    exportId,
    requestId,
  });

  return new Response(rendered.ndjson, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="export-${exportId}.ndjson"`,
      [REQUEST_ID_HEADER]: requestId,
    },
  });
}
