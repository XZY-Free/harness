/**
 * POST /admin/api/v1/agent-registrations — 登记 Public Agent Contract（本切片冻结端点）。
 *
 * 行为：
 * - 解析 admin 主体（SSO 管理员或 CI/CD Service Identity）。
 * - 校验 action scope: agent.contract.register + resource { type: "agent", id: null }
 *   （DB Agent id 在登记前不存在，资源以类型表达；不做 legacy descriptor.create）。
 * - 要求 Idempotency-Key（在任何写库前）。
 * - 严格请求体：顶层键恰为 protocol + contract；protocol 键恰为 type + contract_revision；
 *   合同由 parsePublicAgentContract fail-closed（未知键/URL/secret/员工身份字段一律拒绝）。
 * - 单事务 find-or-create Agent（身份 = 合同 agent.id）+ 不可变快照；子行失败整体回滚。
 * - 审计 agent.contract.register（target=创建/复用的 Agent），审计载荷只含 id/digest，无原始合同。
 * - completeRecord + 201 结构化投影（无原始合同回显）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 请求体/合同/protocol 非法 → 400 REQUEST_SCHEMA_INVALID
 * - 同 Idempotency-Key 不同 body → 409 IDEMPOTENCY_CONFLICT
 * - 业务拒绝（service 首建 / retired / deleted）→ 422 BUSINESS_CONSTRAINT_VIOLATION
 */
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  type AgentContractRegistrationActor,
  AgentContractRegistrationRejectedError,
  createSubmitAgentContractRegistration,
  loadAgentContractSnapshotsByAgent,
  projectAgentContractWire,
} from "@/lib/agents/application/submit-agent-contract-registration";
import { PublicAgentContractError } from "@/lib/agents/domain/public-agent-contract";
import { mysqlAgentContractStore } from "@/lib/agents/persistence/agent-contract-store";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
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

export const dynamic = "force-dynamic";

/** 冻结 wire：请求体顶层只接受 protocol + contract（无 URL/凭证/来源路径/身份覆盖字段）。 */
const BODY_KEYS = ["protocol", "contract"] as const;
/** 冻结 wire：protocol 只接受 type + contract_revision。 */
const PROTOCOL_KEYS = ["type", "contract_revision"] as const;

/** 严格解析请求体；非法返回 null（调用方映射 400）。 */
function parseRequestBody(
  body: unknown,
): { protocol: { type: string; contractRevision: string }; contract: unknown } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const root = body as Record<string, unknown>;
  const rootKeys = Object.keys(root);
  if (rootKeys.length !== BODY_KEYS.length || !BODY_KEYS.every((k) => rootKeys.includes(k))) {
    return null;
  }
  const protocol = root.protocol;
  if (!protocol || typeof protocol !== "object" || Array.isArray(protocol)) return null;
  const protocolKeys = Object.keys(protocol as Record<string, unknown>);
  if (
    protocolKeys.length !== PROTOCOL_KEYS.length ||
    !PROTOCOL_KEYS.every((k) => protocolKeys.includes(k))
  ) {
    return null;
  }
  const p = protocol as Record<string, unknown>;
  if (typeof p.type !== "string" || p.type.trim() === "") return null;
  if (typeof p.contract_revision !== "string" || p.contract_revision.trim() === "") return null;
  if (!root.contract || typeof root.contract !== "object" || Array.isArray(root.contract)) {
    return null;
  }
  return {
    protocol: { type: p.type, contractRevision: p.contract_revision },
    contract: root.contract,
  };
}

function isAdminUserPrincipal(
  principal: AdminPrincipal,
): principal is Extract<AdminPrincipal, { userIdentityId: string }> {
  return "userIdentityId" in principal;
}

function actorFromAdminPrincipal(principal: AdminPrincipal): AgentContractRegistrationActor {
  if (isAdminUserPrincipal(principal)) {
    return { kind: "user", userId: principal.userIdentityId };
  }
  if (principal.callerType === "service") {
    return { kind: "service", serviceId: principal.serviceId ?? "" };
  }
  throw new Error("不支持的 admin 主体形态");
}

function auditActorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if (isAdminUserPrincipal(principal)) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. action scope：agent.contract.register（DB Agent id 登记前不存在 → resource id=null）
  const scopeResult = await requireAdminActionScope(
    principal,
    "agent.contract.register",
    { type: "agent", id: null },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. Idempotency-Key 必填（任何写库之前）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 严格请求体解析（fail-closed，不触碰幂等记录/DB）
  const rawBody = await request.json().catch(() => null);
  const parsed = parseRequestBody(rawBody);
  if (!parsed) {
    return schemaInvalidTable(
      requestId,
      "请求体非法：顶层键必须恰为 protocol+contract，protocol 键必须恰为 type+contract_revision，且不接受任何 URL/凭证/身份覆盖字段",
    );
  }

  // 5. 幂等守卫（hash 基于校验后的原始 body）
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, rawBody);
  const caller = isAdminUserPrincipal(principal)
    ? callerFromPrincipal(principal)
    : callerFromWorkloadPrincipal(principal);
  const commandScope = "agent.contract.register";

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

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

  let recordId = outcome.record.id;
  if (outcome.kind === "retry_allowed") {
    const reset = await prepareRetryForFailedRecord({ record: outcome.record, requestHash });
    if (!reset) {
      return buildIdempotencyErrorResponse({
        record: outcome.record,
        reason: "conflict",
        requestId,
      });
    }
    recordId = reset.id;
  }

  // 6. 执行登记事务
  const submit = createSubmitAgentContractRegistration({ store: mysqlAgentContractStore });
  try {
    const result = await submit({
      tenantId: principal.tenantId,
      protocol: parsed.protocol,
      contract: parsed.contract,
      actor: actorFromAdminPrincipal(principal),
    });

    // 7. 读回持久化聚合并构建共享 wire 投影（保证与 GET 列表逐字段一致）
    const [aggregate] = await loadAgentContractSnapshotsByAgent(
      mysqlAgentContractStore,
      principal.tenantId,
      result.agent.id,
    );
    if (!aggregate) {
      throw new Error("登记后快照读回失败（租户或 Agent 不一致）");
    }
    const responseBody = {
      agent: {
        id: result.agent.id,
        agent_key: result.agent.agentKey,
        display_name: result.agent.displayName,
        lifecycle_state: result.agent.lifecycleState,
      },
      contract: projectAgentContractWire(aggregate),
    };

    // 8. 审计（成功路径；载荷只含 id/digest，无原始合同/secret）
    await recordAuditEvent({
      actor: auditActorFromAdminPrincipal(principal),
      actionType: "agent.contract.register",
      targetType: "agent",
      targetId: result.agent.id,
      after: {
        agent_id: result.agent.id,
        agent_key: result.agent.agentKey,
        snapshot_id: result.contract.snapshotId,
        contract_digest: result.contract.contractDigest,
        protocol_type: result.contract.protocolType,
        protocol_contract_revision: result.contract.protocolContractRevision,
        created_agent: result.agent.created,
      },
      reason: `登记 Public Agent Contract（agentKey=${result.agent.agentKey}，snapshot=${result.contract.snapshotId}）`,
      requestId,
    });

    // 9. completeRecord + 201
    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 201,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);
    if (err instanceof PublicAgentContractError) {
      // 合同解析 fail-closed：不暴露原始输入内容
      return schemaInvalidTable(requestId, "Public Agent Contract 无效：结构化校验失败");
    }
    if (err instanceof AgentContractRegistrationRejectedError) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    throw err;
  }
}
