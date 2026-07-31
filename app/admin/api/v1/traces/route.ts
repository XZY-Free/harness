import { REQUEST_ID_HEADER, getRequestId, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import { listTracesByTenant } from "@/lib/v11/observability/trace-queries";
import {
  TRACE_CONTENT_MODES,
  TRACE_ROOT_TYPES,
  TRACE_STATES,
  type TraceContentMode,
  type TraceRootType,
  type TraceState,
} from "@/lib/v11/schema/trace";
/**
 * GET /admin/api/v1/traces — 列出租户内所有 Trace（S11-W05）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W05。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 支持查询参数 root_type、trace_state、content_mode、limit、cursor。
 * - cursor 为不透明 base64url(JSON{ started_at, id })，由 listTracesByTenant 解析。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - root_type/trace_state/content_mode/limit/cursor 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

const VALID_ROOT_TYPES = new Set<string>(TRACE_ROOT_TYPES);
const VALID_TRACE_STATES = new Set<string>(TRACE_STATES);
const VALID_CONTENT_MODES = new Set<string>(TRACE_CONTENT_MODES);

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
  const rootTypeParam = url.searchParams.get("root_type");
  const traceStateParam = url.searchParams.get("trace_state");
  const contentModeParam = url.searchParams.get("content_mode");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  let rootType: TraceRootType | undefined;
  if (rootTypeParam) {
    if (!VALID_ROOT_TYPES.has(rootTypeParam)) {
      return v11SchemaInvalid(requestId, `root_type 非法: ${rootTypeParam}`);
    }
    rootType = rootTypeParam as TraceRootType;
  }

  let traceState: TraceState | undefined;
  if (traceStateParam) {
    if (!VALID_TRACE_STATES.has(traceStateParam)) {
      return v11SchemaInvalid(requestId, `trace_state 非法: ${traceStateParam}`);
    }
    traceState = traceStateParam as TraceState;
  }

  let contentMode: TraceContentMode | undefined;
  if (contentModeParam) {
    if (!VALID_CONTENT_MODES.has(contentModeParam)) {
      return v11SchemaInvalid(requestId, `content_mode 非法: ${contentModeParam}`);
    }
    contentMode = contentModeParam as TraceContentMode;
  }

  // 3. 查询 Trace
  const { items, nextCursor } = await listTracesByTenant(principal.tenantId, {
    rootType,
    traceState,
    contentMode,
    limit,
    cursor: cursor ?? null,
  });

  // 4. 投影为 snake_case
  const projected = items.map((t) => ({
    id: t.id,
    tenant_id: t.tenantId,
    root_type: t.rootType,
    root_id: t.rootId,
    trace_key: t.traceKey,
    root_span_id: t.rootSpanId,
    content_mode: t.contentMode,
    sampling_policy: t.samplingPolicy,
    sampling_rate: t.samplingRate,
    trace_state: t.traceState,
    started_at: t.startedAt.toISOString(),
    finished_at: t.finishedAt?.toISOString() ?? null,
    attributes: t.attributesJson,
    version_no: t.versionNo,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
  }));

  return v11Ok(
    { items: projected, next_cursor: nextCursor, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
