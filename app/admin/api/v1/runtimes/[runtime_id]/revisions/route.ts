import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { loadRuntimeRevisionAdminProjection } from "@/lib/runtime/application/runtime-admin-projection";
import { getRuntimeById } from "@/lib/runtime/persistence/runtime-queries";
import { getRevisionsByRuntime } from "@/lib/runtime/persistence/runtime-revision-queries";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runtime_id: string }> },
): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (error) {
    const response = adminAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }
  const { runtime_id: runtimeId } = await params;
  const runtime = await getRuntimeById(principal.tenantId, runtimeId);
  if (!runtime) return resourceNotFound(requestId, `Runtime 不存在或无权访问: ${runtimeId}`);
  const revisions = await getRevisionsByRuntime(runtimeId);
  const projected = await Promise.all(
    revisions.map((revision) =>
      loadRuntimeRevisionAdminProjection(principal.tenantId, revision.id),
    ),
  );
  const items = projected.filter((item) => item !== null);
  return apiSuccess(
    { items, total: items.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
