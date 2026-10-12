import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiError, apiSuccess, getRequestId } from "@/lib/http";
import { projectHostedProvisioningRequest } from "@/lib/runtime/application/hosted-provisioning-admin-projection";
import { mysqlHostedProvisioningRequestStore } from "@/lib/runtime/persistence/mysql-hosted-provisioning-request-store";
import { createRequestHostedProvisioning } from "@/lib/runtime/provisioning/request-hosted-provisioning";

export const dynamic = "force-dynamic";

interface Body {
  route_scope_key: string;
}

/** 请求体必须恰好一个 key `{route_scope_key: string}`，trim 后非空；拒绝未知/额外 key。 */
function validateBody(value: unknown): value is Body {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "route_scope_key") return false;
  return typeof body.route_scope_key === "string" && body.route_scope_key.trim().length > 0;
}

/**
 * 从认证主体派生 requesterId。
 * - SSO Principal：非空 userIdentityId。
 * - WorkloadPrincipal：仅 callerType==='service' 且 serviceId 非空。
 * - 其它/为空/空白 → null（fail closed，无 fallback）。
 */
function resolveRequesterId(principal: AdminPrincipal): string | null {
  if ("userIdentityId" in principal) {
    const id = principal.userIdentityId.trim();
    return id.length > 0 ? id : null;
  }
  if (principal.callerType === "service") {
    const serviceId = principal.serviceId;
    if (typeof serviceId === "string") {
      const trimmed = serviceId.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (error) {
    const response = adminAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) return schemaInvalidTable(requestId, "Hosted Provisioning 请求体非法");
  const routeScopeKey = body.route_scope_key.trim();

  // requesterId 必须由认证主体派生；无有效身份在 provisioning 前 fail closed。
  const requesterId = resolveRequesterId(principal);
  if (requesterId === null) {
    return apiError("AUTHENTICATION_REQUIRED", "无法从主体派生 requesterId", { requestId });
  }

  const scope = await requireAdminActionScope(
    principal,
    "route.update",
    { type: "environment", id: routeScopeKey },
    requestId,
  );
  if (!scope.ok) return scope.response;

  const factory = createRequestHostedProvisioning({
    store: mysqlHostedProvisioningRequestStore,
  });
  const result = await factory({
    tenantId: principal.tenantId,
    requesterId,
    routeScopeKey,
  });
  if (!("requestId" in result)) {
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", result.reason, { requestId });
  }
  const row = await mysqlHostedProvisioningRequestStore.getById({
    tenantId: principal.tenantId,
    requestId: result.requestId,
  });
  if (!row) throw new Error(`HostedProvisioningRequest 创建后不可见: ${result.requestId}`);
  return apiSuccess(projectHostedProvisioningRequest(row), {
    status: 202,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
