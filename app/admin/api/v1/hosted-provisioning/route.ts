import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import { projectHostedProvisioningRequest } from "@/lib/runtime/application/hosted-provisioning-admin-projection";
import { mysqlHostedProvisioningRequestStore } from "@/lib/runtime/persistence/mysql-hosted-provisioning-request-store";
import { createRequestHostedProvisioning } from "@/lib/runtime/provisioning/request-hosted-provisioning";
import { createRevisionValidator } from "@/lib/runtime/provisioning/validate-hosted-provisioning-revision";

export const dynamic = "force-dynamic";

interface Body {
  agent_id: string;
  agent_revision_id: string;
  route_scope_key: string;
  desired_runtime_key?: string;
}

function validateBody(value: unknown): value is Body {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.agent_id === "string" &&
    body.agent_id.length > 0 &&
    typeof body.agent_revision_id === "string" &&
    body.agent_revision_id.length > 0 &&
    typeof body.route_scope_key === "string" &&
    body.route_scope_key.length > 0 &&
    (body.desired_runtime_key === undefined ||
      (typeof body.desired_runtime_key === "string" && body.desired_runtime_key.length > 0))
  );
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
  const scope = await requireAdminActionScope(
    principal,
    "route.update",
    { type: "agent", id: body.agent_id },
    requestId,
  );
  if (!scope.ok) return scope.response;
  const result = await createRequestHostedProvisioning({
    store: mysqlHostedProvisioningRequestStore,
    revisionValidator: createRevisionValidator(),
  })({
    tenantId: principal.tenantId,
    agentId: body.agent_id,
    agentRevisionId: body.agent_revision_id,
    routeScopeKey: body.route_scope_key,
    desiredRuntimeKey: body.desired_runtime_key,
  });
  if (!("requestId" in result)) {
    if (result.code === "REVISION_NOT_FOUND" || result.code === "AGENT_NOT_FOUND") {
      return resourceNotFound(requestId, result.reason);
    }
    if (result.code === "REVISION_ID_UNKNOWN") {
      return schemaInvalidTable(requestId, result.reason);
    }
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
