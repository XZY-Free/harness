import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { projectRuntimeConformanceRun } from "@/lib/runtime/application/runtime-admin-projection";
import { getRuntimeById } from "@/lib/runtime/persistence/runtime-queries";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  getRuntimeConformanceRunById,
  listRuntimeConformanceCaseResults,
} from "@/lib/runtime/provisioning/runtime-conformance-runs";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ run_id: string }> },
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
  const { run_id: runId } = await params;
  const run = await getRuntimeConformanceRunById(principal.tenantId, runId);
  if (!run) return resourceNotFound(requestId, `ConformanceRun 不存在或无权访问: ${runId}`);
  const revision = await getRuntimeRevisionById(run.runtimeRevisionId);
  const runtime = revision ? await getRuntimeById(principal.tenantId, revision.runtimeId) : null;
  if (!revision || !runtime) {
    return resourceNotFound(requestId, `ConformanceRun 不存在或无权访问: ${runId}`);
  }
  const scope = await requireAdminActionScope(
    principal,
    "runtime.publish",
    { type: "runtime", id: runtime.id },
    requestId,
  );
  if (!scope.ok) return scope.response;
  const caseResults = await listRuntimeConformanceCaseResults(run.id);
  return apiSuccess(projectRuntimeConformanceRun(run, caseResults), {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
