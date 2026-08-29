/**
 * POST /gateway/v1/agent-calls — AgentCall Gateway 创建并启动（专题01 Batch8 · Gateway 收口）。
 *
 * 语义（冻结架构 §十六 / 03 §11 / §16）：
 *   Harness Runtime（或外部 Harness Runtime）通过本 Gateway 调用 Agent Capability。
 *   Runtime 绝不直接拿 Agent endpoint secret / credential —— 只走 Gateway。
 *   Gateway 负责：policy / Agent Route resolution / AgentCall Binding / context
 *   enrichment / credential / AgentTransport(A2A)。
 *
 * 认证：
 *   Gateway Workload Token（audience=gateway）→ tenantId + invocationId（parent
 *   Harness Invocation 精确绑定）。Token 的 invocationId 是 parent Invocation 唯一来源。
 *
 * 流程：
 *   1. resolveRequiredAgentBinding（唯一 Route Authority：resolveRoute target=agent）
 *      → 冻结 exact AgentCallBinding（endpoint/identity/credential/network facts）。
 *   2. createAgentCall（sourceType=gateway，sourceRef=parentInvocationId，幂等
 *      logicalCallKey=gateway:<invocationId>:<agentId>）。
 *   3. startAgentCall（A2A，event 只走 AgentCallEventIngress）。
 *   4. 返回 callId + state（幂等：同 invocation+agent 重试返回同一 call）。
 *
 * 错误映射：
 *   - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 *   - 请求体非法 / input 空 → 400 REQUEST_SCHEMA_INVALID
 *   - Agent route 无法解析 / 跨租户 → 404 CAPABILITY_NOT_ALLOWED（隐藏式）
 *   - Contract/凭证证据缺失 → 422 BUSINESS_CONSTRAINT_VIOLATION（fail closed）
 *
 * Runtime 只拿到 callId/state/taskId/contextId，不透出 endpoint secret / credential。
 */
import { agentCallStore } from "@/lib/agents/calls/application/agent-call-events-common";
import { createCreateAgentCall } from "@/lib/agents/calls/application/create-agent-call";
import {
  RequiredAgentUnavailableError,
  resolveRequiredAgentBinding,
} from "@/lib/agents/calls/application/resolve-agent-call-binding";
import { startAgentCall } from "@/lib/agents/calls/application/start-agent-call";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewaySchemaInvalidTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";
import { REQUEST_ID_HEADER, apiError, apiSuccess, getRequestId } from "@/lib/http";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import { createConfiguredRouteResolver } from "@/lib/routes/infrastructure/configured-route-resolver";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { executionSubjectFromServiceIdentity } from "@/lib/runtime/transport/execution-subject";

export const dynamic = "force-dynamic";

/** AgentCall Gateway 创建入参。 */
export interface CreateAgentCallBody {
  agent_id: string;
  /** 用户输入文本（A2A start message；非空纯文本）。 */
  input: string;
  /** Agent Route scope key（缺省 "default"）。 */
  route_scope_key?: string;
}

export function validateAgentCallBody(body: unknown): body is CreateAgentCallBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.agent_id !== "string" || b.agent_id.length === 0) return false;
  if (typeof b.input !== "string" || b.input.trim().length === 0) return false;
  if (
    b.route_scope_key !== undefined &&
    b.route_scope_key !== null &&
    typeof b.route_scope_key !== "string"
  ) {
    return false;
  }
  return true;
}

const createAgentCall = createCreateAgentCall({ store: agentCallStore });

const configuredResolver = createConfiguredRouteResolver({
  projectionStore: mysqlRouteEligibilityResolutionStore,
});
const defaultResolveRoute: RouteResolver = async (input) => {
  const result = await configuredResolver({
    tenantId: input.tenantId,
    target: input.target,
    routeScopeKey: input.routeScopeKey,
    businessKey: input.businessKey,
    attributes: input.attributes,
    threadDefaultModelRef: input.threadDefaultModelRef,
  });
  return result.outcome;
};

/**
 * 核心创建编排（可注入 resolveRoute 供测试；生产用真实 resolver）。
 * 返回 { status, body }；route handler 据此映射 HTTP 响应。
 */
export async function createAgentCallViaGateway(params: {
  tenantId: string;
  parentInvocationId: string;
  body: CreateAgentCallBody;
  resolveRoute?: RouteResolver;
}): Promise<{
  status: "created" | "start_failed";
  payload: Record<string, unknown>;
}> {
  const { tenantId, parentInvocationId, body } = params;
  const resolveRoute = params.resolveRoute ?? defaultResolveRoute;

  // 1. 解析 Agent Route + 冻结 exact AgentCallBinding（唯一 Route Authority）。
  const resolved = await resolveRequiredAgentBinding({
    tenantId,
    agentId: body.agent_id,
    resolveRoute,
    routeScopeKey: body.route_scope_key ?? "default",
    businessKey: { invocationId: parentInvocationId },
  });

  // 2. createAgentCall（幂等 logicalCallKey：gateway:<invocationId>:<agentId>）。
  const logicalCallKey = `gateway:${parentInvocationId}:${body.agent_id}`;
  const { call } = await createAgentCall({
    tenantId,
    parentInvocationId,
    agentId: body.agent_id,
    agentRevisionId: resolved.agentRevisionId,
    sourceType: "gateway",
    sourceRef: parentInvocationId,
    logicalCallKey,
    binding: resolved.binding,
  });
  const callId = call.id;

  // 3. startAgentCall（A2A；event 只走 AgentCallEventIngress）。
  try {
    await startAgentCall({
      tenantId,
      callId,
      input: body.input,
      contextEnvironment: {
        tenantId,
        executionSubject: executionSubjectFromServiceIdentity(tenantId, "gateway"),
        now: new Date(),
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
      },
    });
  } catch {
    // 启动失败已归一化为子域 call.failed；返回 callId + 当前状态，parent 不变。
    return {
      status: "start_failed",
      payload: { call_id: callId, state: call.state, agent_id: body.agent_id },
    };
  }

  // 4. 返回 callId + state（Runtime 只拿到 call 身份，不透出 endpoint secret）。
  return {
    status: "created",
    payload: {
      call_id: callId,
      state: call.state,
      agent_id: body.agent_id,
      agent_revision_id: resolved.agentRevisionId,
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 Gateway 身份（audience=gateway）→ tenantId + parent invocationId。
  let claims: GatewayPrincipal;
  try {
    claims = await resolveGatewayPrincipal(request.headers);
  } catch (err) {
    const authResp = gatewayAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }
  const tenantId = claims.tenantId;
  const parentInvocationId = claims.invocationId;

  // 2. 解析请求体。
  const body = await request.json().catch(() => null);
  if (!validateAgentCallBody(body)) {
    return gatewaySchemaInvalidTable(
      requestId,
      "请求体非法：agent_id 必填；input 必填非空；route_scope_key 可选字符串",
    );
  }

  // 3. 核心编排（真实 resolver；Runtime 不直接拿 endpoint secret）。
  try {
    const { status, payload } = await createAgentCallViaGateway({
      tenantId,
      parentInvocationId,
      body,
      resolveRoute: defaultResolveRoute,
    });
    return apiSuccess(payload, { headers: { [REQUEST_ID_HEADER]: requestId } });
  } catch (err) {
    if (err instanceof RequiredAgentUnavailableError) {
      return apiError("CAPABILITY_NOT_ALLOWED", err.message, { requestId });
    }
    return apiError("BUSINESS_CONSTRAINT_VIOLATION", "AgentCall 创建失败", { requestId });
  }
}
