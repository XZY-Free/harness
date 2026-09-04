import { agentCallStore } from "@/lib/agents/calls/application/agent-call-events-common";
/**
 * POST /gateway/v1/agent-calls/{call_id}/resume — 恢复 AgentCall（A2A message/send）
 * 仅恢复既有 durable AgentCall，不创建新的逻辑调用。
 *
 * 语义：
 *   waiting_user → running；复用 SAME AgentCall / SAME exact AgentRevision / SAME
 *   binding / SAME external contextId；不新建顶层 Invocation，不重新解析成别的 AgentRevision。
 *
 * 认证：
 *   Gateway Workload Token（audience=gateway）→ tenantId + invocationId。
 *   call.parentInvocationId 必须等于 Token invocationId（跨 Invocation 隐藏式 404）。
 *
 * 错误映射：
 *   - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 *   - call_id 缺失 / 不存在 / 跨 Invocation → 404 RESOURCE_NOT_FOUND
 *   - text 缺失/空 → 400 REQUEST_SCHEMA_INVALID
 *   - 状态不可 resume / transport 失败 → 409 AGENT_CALL_RESUME_CONFLICT
 */
import {
  AgentCallResumeError,
  resumeAgentCall,
} from "@/lib/agents/calls/application/resume-agent-call";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewaySchemaInvalidTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";
import {
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import {
  type ExecutionSubject,
  recoverTrustedExecutionSubject,
} from "@/lib/runtime/transport/execution-subject";

export const dynamic = "force-dynamic";

interface ResumeBody {
  text: string;
}

function validateBody(body: unknown): body is ResumeBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.text === "string" && b.text.trim().length > 0;
}

function extractCallId(url: string): string | null {
  // 路径形如 /gateway/v1/agent-calls/{call_id}/resume
  const match = url.match(/\/gateway\/v1\/agent-calls\/([^/?#]+)\/resume/);
  const id = match?.[1];
  return id ? decodeURIComponent(id) : null;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 Gateway 身份（audience=gateway）→ tenantId + invocationId。
  let claims: GatewayPrincipal;
  try {
    claims = await resolveGatewayPrincipal(request.headers);
  } catch (err) {
    const authResp = gatewayAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 提取 call_id + 跨 Invocation 校验。
  const callId = extractCallId(request.url);
  if (!callId) {
    return resourceNotFound(requestId, "call_id 缺失");
  }
  const existing = await agentCallStore.getById({ callId, tenantId: claims.tenantId });
  if (!existing || existing.parentInvocationId !== claims.invocationId) {
    return resourceNotFound(requestId, "AgentCall 不存在或无权访问");
  }

  // 3. 解析请求体。
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return gatewaySchemaInvalidTable(requestId, "请求体非法：text 必填非空");
  }

  const binding = await getExecutionBindingByInvocation(claims.tenantId, claims.invocationId);
  if (!binding) {
    return apiError("HARNESS_LOOP_STATE_RECOVERY_FAILED", "ExecutionBinding 不存在", {
      requestId,
    });
  }
  let executionSubject: ExecutionSubject;
  try {
    executionSubject = recoverTrustedExecutionSubject(binding, claims.tenantId);
  } catch {
    return apiError("HARNESS_LOOP_STATE_RECOVERY_FAILED", "可信执行主体不可恢复", {
      requestId,
    });
  }

  // 4. resume（复用 SAME AgentCall / context）。
  try {
    const updated = await resumeAgentCall({
      tenantId: claims.tenantId,
      callId,
      text: body.text,
      contextEnvironment: {
        tenantId: claims.tenantId,
        executionSubject,
        now: new Date(),
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
      },
    });
    return apiSuccess(
      { call_id: callId, state: updated.state },
      { headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (err) {
    if (err instanceof AgentCallResumeError) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    throw err;
  }
}
