import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { getToolCallById } from "@/lib/capability/tool-call-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
/**
 * GET /admin/api/v1/tool-calls/{tool_call_id} — ToolCall 单资源详情（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 调用 getToolCallById（对象参数 { tenantId, toolCallId }）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - ToolCall 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ tool_call_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { tool_call_id: toolCallId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const toolCall = await getToolCallById({
    tenantId: principal.tenantId,
    toolCallId,
  });
  if (!toolCall) {
    return resourceNotFound(requestId, `ToolCall 不存在或无权访问: ${toolCallId}`);
  }

  const body = {
    id: toolCall.id,
    tenant_id: toolCall.tenantId,
    invocation_id: toolCall.invocationId,
    thread_id: toolCall.threadId,
    turn_id: toolCall.turnId,
    job_id: toolCall.jobId,
    call_sequence: toolCall.callSequence,
    tool_id: toolCall.toolId,
    tool_schema_revision_id: toolCall.toolSchemaRevisionId,
    schema_hash: toolCall.schemaHash,
    call_state: toolCall.callState,
    operation_id: toolCall.operationId,
    arguments_redacted_json: toolCall.argumentsRedactedJson,
    arguments_hash: toolCall.argumentsHash,
    environment_lease_id: toolCall.environmentLeaseId,
    result_summary_json: toolCall.resultSummaryJson,
    result_artifact_id: toolCall.resultArtifactId,
    item_id: toolCall.itemId,
    error_code: toolCall.errorCode,
    error_summary: toolCall.errorSummary,
    started_at: toolCall.startedAt?.toISOString() ?? null,
    finished_at: toolCall.finishedAt?.toISOString() ?? null,
    created_at: toolCall.createdAt.toISOString(),
    updated_at: toolCall.updatedAt.toISOString(),
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
