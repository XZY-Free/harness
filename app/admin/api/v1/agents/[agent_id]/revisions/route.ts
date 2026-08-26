import {
  AGENT_REVISION_ETAG_PREFIX,
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
/**
 * POST /admin/api/v1/agents/{agent_id}/revisions — 创建 AgentRevision（S03-C05）。
 *
 * 事实源：docs/contracts/openapi.json（post_admin_api_v1_agents_by_agent_id_revisions）、
 *         docs/architecture/api-and-events.md §6、
 *         docs/architecture/agent-control-plane.md S03-W05。
 *
 * 行为：
 * - 解析 admin 主体（SSO 管理员或 CI/CD Service Identity）。
 * - 校验 action scope: agent.revision.create + resource { type: "agent", id: agent_id }。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验 Agent 存在且属于当前租户（跨租户隐藏为 404）。
 * - 校验请求体（严格键集：agent_contract_snapshot_id/
 *   model_policy/permission_requirements/delegation_policy/agent_interface_requirements；
 *   旧 source 键（source/source_type/source_revision/artifact_ref/instruction_hash/artifact_id）
 *   一律 400）。
 * - 调用 createDraftRevision 创建 draft Revision。
 * - 写 AuditEvent（agent.revision.create）。
 * - completeRecord + 返回 201 + revision 投影 + ETag。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - Agent 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 */
import { mysqlAgentContractStore } from "@/lib/agents/persistence/agent-contract-store";
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import {
  createDraftRevision,
  getRevisionsByAgent,
} from "@/lib/agents/persistence/agent-revision-queries";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiSuccess,
  etagHeader,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
  recordAuditEvent,
} from "@/lib/identity/audit";
import {
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromPrincipal,
  callerFromWorkloadPrincipal,
  completeRecord,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/identity/idempotency";
import type { AgentRevision } from "@/lib/persistence/schema/agents";

export const dynamic = "force-dynamic";

/** 路径参数上下文（Next.js App Router 动态段）。 */
interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

/** 请求体 schema（与 OpenAPI requestBody 对齐）。 */
interface CreateRevisionBody {
  /** 绑定的不可变 AgentContractSnapshot id（发布权威；必填且非空白）。 */
  agent_contract_snapshot_id: string;
  model_policy: Record<string, unknown>;
  permission_requirements: Record<string, unknown>;
  delegation_policy: Record<string, unknown>;
  agent_interface_requirements: Record<string, unknown>;
}

/** 允许的顶层键集合（严格键集校验：多余键一律拒绝）。 */
const REVISION_BODY_KEYS = new Set([
  "agent_contract_snapshot_id",
  "model_policy",
  "permission_requirements",
  "delegation_policy",
  "agent_interface_requirements",
]);

/** 校验请求体。 */
function validateBody(body: unknown): body is CreateRevisionBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!REVISION_BODY_KEYS.has(key)) return false;
  }
  if (typeof b.agent_contract_snapshot_id !== "string" || !b.agent_contract_snapshot_id.trim())
    return false;
  if (!b.model_policy || typeof b.model_policy !== "object" || Array.isArray(b.model_policy))
    return false;
  if (
    !b.permission_requirements ||
    typeof b.permission_requirements !== "object" ||
    Array.isArray(b.permission_requirements)
  )
    return false;
  if (
    !b.delegation_policy ||
    typeof b.delegation_policy !== "object" ||
    Array.isArray(b.delegation_policy)
  )
    return false;
  if (
    !b.agent_interface_requirements ||
    typeof b.agent_interface_requirements !== "object" ||
    Array.isArray(b.agent_interface_requirements)
  )
    return false;
  return true;
}

/** 从主体提取幂等 caller。 */
function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}

/** 从主体提取审计 actor。 */
function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

/** 从主体提取 createdBy（userIdentityId 或 serviceId）。 */
function createdByFromAdminPrincipal(principal: AdminPrincipal): string {
  if ("userIdentityId" in principal) {
    return principal.userIdentityId;
  }
  return principal.serviceId ?? principal.claims.tenantId;
}

/** 投影 Revision 为响应体（snake_case + etag）。 */
function projectRevision(revision: AgentRevision): Record<string, unknown> {
  return {
    id: revision.id,
    agent_id: revision.agentId,
    revision_no: revision.revisionNo,
    revision_state: revision.revisionState,
    agent_contract_snapshot_id: revision.agentContractSnapshotId,
    etag: `${AGENT_REVISION_ETAG_PREFIX}${revision.revisionNo}`,
  };
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { agent_id: agentId } = await context.params;

  // 1. 解析身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 action scope
  const scopeResult = await requireAdminActionScope(
    principal,
    "agent.revision.create",
    { type: "agent", id: agentId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. 校验 Agent 存在且属于当前租户（跨租户隐藏为 404）
  const agent = await getAgentById(principal.tenantId, agentId);
  if (!agent) {
    return resourceNotFound(requestId, `Agent 不存在或无权访问: ${agentId}`);
  }

  // 4. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 5. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(requestId, "请求体非法：缺少必填字段或字段类型错误");
  }

  // 5.5 校验绑定的 AgentContractSnapshot 存在、属于当前租户且属于同一 Agent
  // （跨租户/跨 Agent/缺失引用 → 400，且在 Revision 插入前拒绝）
  const boundSnapshot = await mysqlAgentContractStore.transaction((session) =>
    session.findContractSnapshotById(principal.tenantId, body.agent_contract_snapshot_id),
  );
  if (!boundSnapshot || boundSnapshot.agentId !== agentId) {
    return schemaInvalidTable(
      requestId,
      `AgentContractSnapshot 不存在或不属于该 Agent: ${body.agent_contract_snapshot_id}`,
    );
  }

  // 6. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `agent.revision.create:${agentId}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 7. 处理幂等结果
  if (outcome.kind === "replay") {
    return buildReplayResponse(outcome.record, requestId);
  }
  if (outcome.kind === "in_flight" || outcome.kind === "conflict") {
    return buildIdempotencyErrorResponse({
      record: outcome.kind === "conflict" ? outcome.existingRecord : outcome.record,
      reason: outcome.kind === "conflict" ? "conflict" : "in_flight",
      requestId,
    });
  }

  // retry_allowed：重置 failed 记录后重新执行
  let recordId = outcome.record.id;
  if (outcome.kind === "retry_allowed") {
    const reset = await prepareRetryForFailedRecord({
      record: outcome.record,
      requestHash,
    });
    if (!reset) {
      return buildIdempotencyErrorResponse({
        record: outcome.record,
        reason: "conflict",
        requestId,
      });
    }
    recordId = reset.id;
  }

  // 8. 执行业务：创建 draft Revision
  try {
    const revision = await createDraftRevision({
      tenantId: principal.tenantId,
      agentId,
      agentContractSnapshotId: body.agent_contract_snapshot_id,
      modelPolicyJson: body.model_policy,
      permissionRequirementsJson: body.permission_requirements,
      delegationPolicyJson: body.delegation_policy,
      agentInterfaceRequirementsJson: body.agent_interface_requirements,
      createdBy: createdByFromAdminPrincipal(principal),
    });

    // 9. 写 AuditEvent（agent.revision.create）
    await recordAuditEvent({
      actor: actorFromAdminPrincipal(principal),
      actionType: "agent.revision.create",
      targetType: "agent_revision",
      targetId: revision.id,
      after: {
        agent_id: agentId,
        revision_no: revision.revisionNo,
        revision_state: revision.revisionState,
        agent_contract_snapshot_id: revision.agentContractSnapshotId,
      },
      reason: `创建 AgentRevision (draft, revisionNo=${revision.revisionNo})`,
      requestId,
    });

    // 10. completeRecord + 返回 201
    const responseBody = projectRevision(revision);
    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 201,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`${AGENT_REVISION_ETAG_PREFIX}${revision.revisionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);
    throw err;
  }
}

/**
 * GET /admin/api/v1/agents/{agent_id}/revisions — 列出 Agent 的所有 Revision（S11-W02）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Agent 存在且属于当前租户（跨租户 404）。
 * - 调用 getRevisionsByAgent 返回 Revision 列表（按 revisionNo 降序）。
 * - 支持查询参数 state 过滤（draft / published / withdrawn）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Agent 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { agent_id: agentId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    return authResp ?? resourceNotFound(requestId);
  }

  // 校验 Agent 存在且属于当前租户
  const agent = await getAgentById(principal.tenantId, agentId);
  if (!agent) {
    return resourceNotFound(requestId, `Agent 不存在或无权访问: ${agentId}`);
  }

  // 解析查询参数 state
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
  const validStates = new Set(["draft", "published", "withdrawn"]);
  const revisionState =
    stateParam && validStates.has(stateParam)
      ? (stateParam as "draft" | "published" | "withdrawn")
      : undefined;

  const revisions = await getRevisionsByAgent(
    agentId,
    revisionState ? { revisionState } : undefined,
  );
  const projected = revisions.map(projectRevision);

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
