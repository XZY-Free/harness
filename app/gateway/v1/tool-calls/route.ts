import { ToolApplicationError, applyToolCall } from "@/lib/capability/application/apply-tool-call";
import { getEffectRecordByToolCall } from "@/lib/capability/effect-queries";
import { ToolCallConflictError } from "@/lib/capability/tool-call-queries";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewayCapabilityNotAllowedTable,
  gatewaySchemaInvalidTable,
  gatewayToolSchemaChangedTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";
import { REQUEST_ID_HEADER, apiError, apiSuccess, getRequestId } from "@/lib/http";
import { verifyCapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import { recoverTrustedExecutionSubject } from "@/lib/runtime/transport/execution-subject";

export const dynamic = "force-dynamic";

interface ToolCallBody {
  invocation_id: string;
  tool_id: string;
  schema_hash: string;
  operation_id: string;
  arguments: Record<string, unknown>;
}

function parseBody(raw: unknown): ToolCallBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.invocation_id !== "string" ||
    typeof value.tool_id !== "string" ||
    typeof value.schema_hash !== "string" ||
    typeof value.operation_id !== "string" ||
    !value.arguments ||
    typeof value.arguments !== "object" ||
    Array.isArray(value.arguments)
  ) {
    return null;
  }
  return value as unknown as ToolCallBody;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: GatewayPrincipal;
  try {
    principal = await resolveGatewayPrincipal(request.headers);
  } catch (error) {
    const response = gatewayAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return gatewaySchemaInvalidTable(requestId, "请求体必须是合法 JSON");
  }
  const body = parseBody(raw);
  if (!body || body.invocation_id !== principal.invocationId) {
    return gatewaySchemaInvalidTable(requestId, "请求体无效或 invocation_id 不一致");
  }
  const binding = await getExecutionBindingByInvocation(principal.tenantId, principal.invocationId);
  if (!binding) return gatewayCapabilityNotAllowedTable(requestId, "ExecutionBinding 不存在");
  let catalog: ReturnType<typeof verifyCapabilityCatalogSnapshot>;
  try {
    catalog = verifyCapabilityCatalogSnapshot(
      binding.capabilityCatalogJson,
      binding.capabilityCatalogDigest,
    );
  } catch {
    return apiError("CAPABILITY_CONTENT_BLOCKED", "冻结能力目录不可用", { requestId });
  }
  const exactTool = catalog.tools.find((tool) => tool.toolId === body.tool_id);
  if (!exactTool) return gatewayCapabilityNotAllowedTable(requestId, "Tool 不在冻结能力目录");
  if (exactTool.schemaHash !== body.schema_hash) {
    return gatewayToolSchemaChangedTable(requestId, "schema_hash 与冻结目录不一致", {
      schema_hash: exactTool.schemaHash,
    });
  }
  try {
    const outcome = await applyToolCall({
      tenantId: principal.tenantId,
      invocationId: principal.invocationId,
      executionSubject: recoverTrustedExecutionSubject(binding, principal.tenantId),
      toolId: body.tool_id,
      toolSchemaRevisionId: exactTool.schemaRevisionId,
      schemaHash: body.schema_hash,
      operationId: body.operation_id,
      arguments: body.arguments,
    });
    const effect = await getEffectRecordByToolCall(principal.tenantId, outcome.toolCall.id);
    if (outcome.toolCall.errorCode === "POLICY_BLOCKED") {
      return apiError("POLICY_BLOCKED", "Tool 调用被策略阻止", {
        requestId,
        details: { tool_call_id: outcome.toolCall.id },
      });
    }
    if (outcome.toolCall.errorCode === "POLICY_REQUIRES_PREAUTH") {
      return apiError("POLICY_REQUIRES_PREAUTH", "Job 未预授权", {
        requestId,
        details: { tool_call_id: outcome.toolCall.id },
      });
    }
    return apiSuccess(
      {
        tool_call_id: outcome.toolCall.id,
        call_state: outcome.toolCall.callState,
        decision: outcome.decision?.decision ?? null,
        decision_sequence: outcome.decision?.decisionSequence ?? null,
        schema_revision_id: outcome.toolCall.toolSchemaRevisionId,
        user_action_request_id: outcome.userActionRequestId,
        result: outcome.toolCall.resultSummaryJson,
        effect: effect ? { effect_state: effect.effectState } : null,
      },
      { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (error) {
    return mapApplicationError(error, requestId);
  }
}

function mapApplicationError(error: unknown, requestId: string): Response {
  if (error instanceof ToolCallConflictError) {
    return apiError("OPERATION_PAYLOAD_CONFLICT", "同 operation_id 已存在但 arguments 不同", {
      requestId,
      details: { operation_id: error.operationId },
    });
  }
  if (error instanceof ToolApplicationError) {
    if (
      error.code === "TOOL_SCHEMA_INTEGRITY_MISMATCH" ||
      error.code === "TOOL_EXECUTION_CONTRACT_MISMATCH"
    ) {
      return gatewayToolSchemaChangedTable(requestId, error.message, {});
    }
    if (
      error.code === "TOOL_ARGUMENTS_INVALID" ||
      error.code === "TOOL_ARGUMENTS_SENSITIVE" ||
      error.code === "TOOL_SCHEMA_INVALID"
    ) {
      return gatewaySchemaInvalidTable(requestId, error.message);
    }
    if (error.code === "POLICY_INTEGRITY_MISMATCH") {
      return apiError("POLICY_INTEGRITY_MISMATCH", error.message, { requestId });
    }
    if (
      error.code === "TOOL_NOT_IN_FROZEN_CATALOG" ||
      error.code === "TOOL_UNAVAILABLE" ||
      error.code === "PROVIDER_EXECUTOR_UNAVAILABLE" ||
      error.code === "PROVIDER_CONNECTION_UNAVAILABLE" ||
      error.code === "PROVIDER_AUTH_UNSUPPORTED" ||
      error.code === "CREDENTIAL_UNAVAILABLE"
    ) {
      return gatewayCapabilityNotAllowedTable(requestId, error.message);
    }
  }
  throw error;
}
