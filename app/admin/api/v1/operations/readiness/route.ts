/**
 * GET /admin/api/v1/operations/readiness — 查询系统就绪状态（S12-W03）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/14-production-operations-security-and-retention.md §7.1
 * - ../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md S12-W03
 *
 * 行为：
 * - 解析 admin 主体。
 * - 校验 action scope: admin.operations.read + resource { type: "tenant", id: tenantId }。
 * - 支持 scope 查询参数：employee_api、runtime_dispatch、gateway、event_projection、job_scheduler、deletion。
 * - 返回 overall_state + checked_at + components[]，只返回结构化健康结果。
 * - 不返回 Secret、内部拓扑或敏感 payload。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - scope 非法 → 400 REQUEST_SCHEMA_INVALID
 */
import { REQUEST_ID_HEADER, getRequestId, apiSuccess } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import {
  type ReadinessScope,
  checkReadiness,
  isKnownReadinessScope,
} from "@/lib/v11/operations/readiness";

export const dynamic = "force-dynamic";

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

  // 2. 校验 action scope: admin.operations.read + tenant 资源
  const scopeResult = await requireAdminActionScope(
    principal,
    "admin.operations.read",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. 解析 scope 查询参数
  const url = new URL(request.url);
  const scopeParam = url.searchParams.get("scope");
  let scope: ReadinessScope | undefined;
  if (scopeParam) {
    if (!isKnownReadinessScope(scopeParam)) {
      return v11SchemaInvalid(
        requestId,
        `scope 非法: ${scopeParam}，合法值: employee_api, runtime_dispatch, gateway, event_projection, job_scheduler, deletion`,
      );
    }
    scope = scopeParam;
  }

  // 4. 执行 readiness 检查
  const result = await checkReadiness(principal.tenantId, scope);

  // 5. 返回 200 + 结构化结果
  return apiSuccess(result, {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
