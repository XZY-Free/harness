/**
 * GET / POST /admin/api/v1/exports — AdminExport 集合（S11-W08）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W08。
 *
 * 行为：
 * - GET：列出当前租户的导出任务（支持 status/export_kind/requested_by/limit/cursor 过滤）。
 * - POST：创建并同步执行导出任务（Idempotency-Key 必填，要求 action scope admin.export.create）。
 *   - 创建后立即调用 runAdminExport 完成，返回 201 + export 投影。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  etagHeader,
  getRequestId,
  apiSuccess,
} from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
import { createAdminExport, listAdminExportsByTenant } from "@/lib/v11/admin/export-queries";
import { runAdminExport } from "@/lib/v11/admin/export-runner";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import {
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromPrincipal,
  callerFromWorkloadPrincipal,
  completeRecord,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/identity/idempotency";
import {
  EXPORT_FORMATS,
  EXPORT_KINDS,
  EXPORT_PRINCIPAL_KINDS,
  EXPORT_STATUSES,
  type ExportKind,
  type ExportPrincipalKind,
  type ExportStatus,
} from "@/lib/v11/schema/admin-export";

export const dynamic = "force-dynamic";

const VALID_KINDS = new Set<string>(EXPORT_KINDS);
const VALID_STATUSES = new Set<string>(EXPORT_STATUSES);
const VALID_FORMATS = new Set<string>(EXPORT_FORMATS);
const VALID_PRINCIPAL_KINDS = new Set<string>(EXPORT_PRINCIPAL_KINDS);

interface CreateBody {
  export_kind: ExportKind;
  result_format?: "ndjson" | "csv";
  filter?: Record<string, unknown> | null;
}

function validateBody(body: unknown): body is CreateBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.export_kind !== "string" || !VALID_KINDS.has(b.export_kind)) return false;
  if (b.result_format !== undefined) {
    if (typeof b.result_format !== "string" || !VALID_FORMATS.has(b.result_format)) return false;
  }
  if (b.filter !== undefined && b.filter !== null) {
    if (typeof b.filter !== "object" || Array.isArray(b.filter)) return false;
  }
  return true;
}

function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

function requestedByFromAdminPrincipal(principal: AdminPrincipal): string {
  if ("userIdentityId" in principal) {
    return principal.userIdentityId;
  }
  return principal.serviceId ?? principal.claims.tenantId;
}

function principalKindFromAdminPrincipal(principal: AdminPrincipal): ExportPrincipalKind {
  if ("userIdentityId" in principal) {
    return "user";
  }
  return "service";
}

function projectExport(e: {
  id: string;
  tenantId: string;
  requestedBy: string;
  requestPrincipalKind: string;
  exportKind: string;
  filterJson: unknown;
  status: string;
  resultRef: string | null;
  resultFormat: string;
  recordCount: number;
  redactionSummary: string | null;
  failureReason: string | null;
  versionNo: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}): Record<string, unknown> {
  return {
    id: e.id,
    tenant_id: e.tenantId,
    requested_by: e.requestedBy,
    request_principal_kind: e.requestPrincipalKind,
    export_kind: e.exportKind,
    filter: e.filterJson,
    status: e.status,
    result_ref: e.resultRef,
    result_format: e.resultFormat,
    record_count: e.recordCount,
    redaction_summary: e.redactionSummary,
    failure_reason: e.failureReason,
    version_no: e.versionNo,
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
    completed_at: e.completedAt?.toISOString() ?? null,
    etag: `admin-export-${e.versionNo}`,
  };
}

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 列表读操作要求 admin.export.read action scope
  const scopeResult = await requireAdminActionScope(
    principal,
    "admin.export.read",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const statusParam = url.searchParams.get("status");
  const exportKindParam = url.searchParams.get("export_kind");
  const requestedBy = url.searchParams.get("requested_by") ?? undefined;

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  let status: ExportStatus | undefined;
  if (statusParam) {
    if (!VALID_STATUSES.has(statusParam)) {
      return v11SchemaInvalid(requestId, `status 非法: ${statusParam}`);
    }
    status = statusParam as ExportStatus;
  }

  let exportKind: ExportKind | undefined;
  if (exportKindParam) {
    if (!VALID_KINDS.has(exportKindParam)) {
      return v11SchemaInvalid(requestId, `export_kind 非法: ${exportKindParam}`);
    }
    exportKind = exportKindParam as ExportKind;
  }

  const { items, nextCursor } = await listAdminExportsByTenant(principal.tenantId, {
    status,
    exportKind,
    requestedBy,
    limit,
    cursor: cursor ?? null,
  });

  return apiSuccess(
    {
      items: items.map(projectExport),
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
      total: items.length,
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

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
    "admin.export.create",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return v11SchemaInvalid(requestId, "请求体非法：缺少 export_kind 或字段类型错误");
  }

  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = "admin.export.create";

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

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

  const actor = actorFromAdminPrincipal(principal);
  const requestedBy = requestedByFromAdminPrincipal(principal);
  const principalKind = principalKindFromAdminPrincipal(principal);

  try {
    // 1. 创建导出任务（status=pending + 审计 admin.export.requested）
    const exportRecord = await createAdminExport({
      tenantId: principal.tenantId,
      requestedBy,
      requestPrincipalKind: principalKind,
      exportKind: body.export_kind,
      filterJson: body.filter ?? null,
      resultFormat: body.result_format ?? "ndjson",
      actor,
      requestId,
    });

    // 2. 同步执行导出（status=running → completed/failed + 审计）
    const result = await runAdminExport({
      tenantId: principal.tenantId,
      exportId: exportRecord.id,
      actor,
      requestId,
    });

    const responseBody = projectExport(result.export);
    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 201,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`admin-export-${result.export.versionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);
    throw err;
  }
}
