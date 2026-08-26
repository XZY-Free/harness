/**
 * POST /admin/api/v1/agents/{agent_id}/runtime-registrations — 主动黑盒 Runtime 注册验收。
 *
 * 行为：
 * - 解析 admin 主体；action scope: agent.runtime.register（resource = 具体 Agent）。
 * - 要求 Idempotency-Key（任何写库前）。
 * - 严格请求体（顶层恰为 contract_snapshot_id + runtime_endpoint + authentication +
 *   conformance；authentication 恰为 mode + credential_ref_id；conformance 为
 *   capability-driven probe 输入：basic 恒必填，input_required/resume/cancel 可选，
 *   presence 与快照声明严格匹配）。任何 schema 失败都在网络/写库前 400。
 * - 委托权威应用服务 registerAgentRuntime：引用/presence 校验（网络前）→ 真实
 *   HTTP/SSE capability-driven 一致性验收（AgentCard 协议证据 + basic/input-required/
 *   resume/cancel probe 按快照声明执行）→ 单事务持久化（external Runtime + draft
 *   RuntimeRevision，无发布/启用/路由）。
 * - 审计 agent.runtime.register（target=Runtime），载荷只含 id/digest 级事实。
 * - completeRecord + 201 结构化投影（无原始合同/prompts/transcript/secret/AgentCard 身份）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 请求体/引用/endpoint/凭证非法 → 400 REQUEST_SCHEMA_INVALID（零网络零写）
 * - 主动一致性验收失败（不可达/路径错误/协议不符/无 input-required/correlation 变化）→
 *   422 BUSINESS_CONSTRAINT_VIOLATION（fail closed，零 Runtime 行）
 * - 同 Idempotency-Key 不同 body / in-flight → 409 IDEMPOTENCY_CONFLICT
 */
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
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
import {
  AgentRuntimeRegistrationError,
  registerAgentRuntime,
} from "@/lib/runtime/application/register-agent-runtime";

export const dynamic = "force-dynamic";

/** 路径参数上下文（Next.js App Router 动态段）。 */
interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

/** 冻结 wire：顶层只接受 contract_snapshot_id + runtime_endpoint + authentication + conformance。 */
const BODY_KEYS = [
  "contract_snapshot_id",
  "runtime_endpoint",
  "authentication",
  "conformance",
] as const;
/** 冻结 wire：authentication 只接受 mode + credential_ref_id。 */
const AUTHENTICATION_KEYS = ["mode", "credential_ref_id"] as const;
/** 冻结 wire：conformance 顶层只接受 basic + 可选 input_required/resume/cancel（02 §2）。 */
const CONFORMANCE_KEYS = ["basic", "input_required", "resume", "cancel"] as const;
/** 冻结 wire：basic 只接受 input。 */
const BASIC_KEYS = ["input"] as const;
/** 冻结 wire：input_required 只接受 input。 */
const INPUT_REQUIRED_KEYS = ["input"] as const;
/** 冻结 wire：resume 只接受 start_input + resume_input。 */
const RESUME_KEYS = ["start_input", "resume_input"] as const;
/** 冻结 wire：cancel 只接受 input。 */
const CANCEL_KEYS = ["input"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const valueKeys = Object.keys(value);
  return valueKeys.length === keys.length && keys.every((k) => valueKeys.includes(k));
}

function nonblankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 严格解析请求体；非法返回 null（调用方映射 400，零网络零写）。 */
function parseRequestBody(body: unknown): {
  contractSnapshotId: string;
  runtimeEndpoint: string;
  authentication: { mode: "none" | "bearer"; credentialRefId: string | null };
  conformance: {
    basic: { input: string };
    input_required?: { input: string };
    resume?: { startInput: string; resumeInput: string };
    cancel?: { input: string };
  };
} | null {
  if (!isPlainObject(body) || !hasExactKeys(body, BODY_KEYS)) return null;
  if (!nonblankString(body.contract_snapshot_id)) return null;
  if (!nonblankString(body.runtime_endpoint)) return null;
  const authentication = body.authentication;
  if (!isPlainObject(authentication) || !hasExactKeys(authentication, AUTHENTICATION_KEYS)) {
    return null;
  }
  let mode: "none" | "bearer";
  if (authentication.mode === "none") {
    // none 模式必须显式 null credential_ref_id。
    if (authentication.credential_ref_id !== null) return null;
    mode = "none";
  } else if (authentication.mode === "bearer") {
    if (!nonblankString(authentication.credential_ref_id)) return null;
    mode = "bearer";
  } else {
    return null;
  }
  // 02 §2 capability-driven conformance：basic 恒必填；input_required/resume/cancel
  // 可选 probe（presence 与快照声明的匹配由权威应用服务在网络前校验）。
  const conformance = body.conformance;
  if (!isPlainObject(conformance)) return null;
  const conformanceKeys = Object.keys(conformance);
  if (conformanceKeys.some((k) => !CONFORMANCE_KEYS.includes(k as never))) return null;
  if (!isPlainObject(conformance.basic) || !hasExactKeys(conformance.basic, BASIC_KEYS)) {
    return null;
  }
  if (!nonblankString(conformance.basic.input)) return null;
  let input_required: { input: string } | undefined;
  if (conformance.input_required !== undefined) {
    if (
      !isPlainObject(conformance.input_required) ||
      !hasExactKeys(conformance.input_required, INPUT_REQUIRED_KEYS) ||
      !nonblankString(conformance.input_required.input)
    ) {
      return null;
    }
    input_required = { input: conformance.input_required.input };
  }
  let resume: { startInput: string; resumeInput: string } | undefined;
  if (conformance.resume !== undefined) {
    if (
      !isPlainObject(conformance.resume) ||
      !hasExactKeys(conformance.resume, RESUME_KEYS) ||
      !nonblankString(conformance.resume.start_input) ||
      !nonblankString(conformance.resume.resume_input)
    ) {
      return null;
    }
    resume = {
      startInput: conformance.resume.start_input,
      resumeInput: conformance.resume.resume_input,
    };
  }
  let cancel: { input: string } | undefined;
  if (conformance.cancel !== undefined) {
    if (
      !isPlainObject(conformance.cancel) ||
      !hasExactKeys(conformance.cancel, CANCEL_KEYS) ||
      !nonblankString(conformance.cancel.input)
    ) {
      return null;
    }
    cancel = { input: conformance.cancel.input };
  }
  return {
    contractSnapshotId: body.contract_snapshot_id,
    runtimeEndpoint: body.runtime_endpoint,
    authentication: {
      mode,
      credentialRefId: mode === "none" ? null : authentication.credential_ref_id,
    },
    conformance: {
      basic: { input: conformance.basic.input },
      ...(input_required ? { input_required } : {}),
      ...(resume ? { resume } : {}),
      ...(cancel ? { cancel } : {}),
    },
  };
}

function isAdminUserPrincipal(
  principal: AdminPrincipal,
): principal is Extract<AdminPrincipal, { userIdentityId: string }> {
  return "userIdentityId" in principal;
}

function auditActorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  return isAdminUserPrincipal(principal)
    ? actorFromPrincipal(principal)
    : actorFromWorkloadPrincipal(principal);
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

  // 2. action scope：agent.runtime.register（scoped 到具体 Agent）
  const scopeResult = await requireAdminActionScope(
    principal,
    "agent.runtime.register",
    { type: "agent", id: agentId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. Idempotency-Key 必填（任何写库之前）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. Agent 必须存在且属于当前租户（跨租户隐藏为 404）
  const agent = await getAgentById(principal.tenantId, agentId);
  if (!agent) {
    return resourceNotFound(requestId, `Agent 不存在或无权访问: ${agentId}`);
  }

  // 5. 严格请求体解析（fail-closed，零网络零写）
  const rawBody = await request.json().catch(() => null);
  const parsed = parseRequestBody(rawBody);
  if (!parsed) {
    return schemaInvalidTable(
      requestId,
      "请求体非法：顶层键必须恰为 contract_snapshot_id+runtime_endpoint+authentication+conformance，" +
        "不接受 protocol/capabilities/report/passed/agent_card_url 或任何凭证原值字段",
    );
  }

  // 6. 幂等守卫（hash 基于校验后的原始 body）
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, rawBody);
  const caller = isAdminUserPrincipal(principal)
    ? callerFromPrincipal(principal)
    : callerFromWorkloadPrincipal(principal);
  const commandScope = `agent.runtime.register:${agentId}`;

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

  // 7. 主动黑盒注册验收（引用校验网络前 → 真实 HTTP/SSE → 单事务持久化）
  const createdBy = isAdminUserPrincipal(principal)
    ? principal.userIdentityId
    : (principal.serviceId ?? "service");
  try {
    const result = await registerAgentRuntime({
      tenantId: principal.tenantId,
      agentId,
      contractSnapshotId: parsed.contractSnapshotId,
      runtimeEndpoint: parsed.runtimeEndpoint,
      authentication: parsed.authentication,
      conformance: parsed.conformance,
      createdBy,
    });

    // 8. 结构化投影（只含 id/状态/measured digest/endpoint；无合同/transcript/secret）
    const responseBody = {
      agent_id: agentId,
      agent_contract_snapshot_id: result.snapshot.id,
      runtime_id: result.runtime.id,
      runtime_revision_id: result.revision.id,
      runtime_key: result.runtime.runtimeKey,
      runtime_endpoint: result.runtimeEndpoint,
      protocol: {
        type: result.snapshot.protocolType,
        contract_revision: result.snapshot.protocolContractRevision,
      },
      verification_state: "verified",
      // 精确序列化持久化的验收时间；服务层保证 verifiedAt 非空（缺失 fail loudly）。
      verified_at: (result.revision.verifiedAt as Date).toISOString(),
      runtime_target_digest: result.revision.runtimeTargetDigest,
      evidence_digest: result.revision.evidenceDigest,
      config_hash: result.revision.configHash,
      measured: result.measured,
    };

    // 9. 审计（载荷只含 id/digest 级事实）
    await recordAuditEvent({
      actor: auditActorFromAdminPrincipal(principal),
      actionType: "agent.runtime.register",
      targetType: "runtime",
      targetId: result.runtime.id,
      after: {
        agent_id: agentId,
        runtime_id: result.runtime.id,
        runtime_revision_id: result.revision.id,
        agent_contract_snapshot_id: result.snapshot.id,
        runtime_target_digest: result.revision.runtimeTargetDigest,
        evidence_digest: result.revision.evidenceDigest,
        verification_state: "verified",
      },
      reason: `注册外部 Runtime（agent=${agent.agentKey}，snapshot=${result.snapshot.id}）`,
      requestId,
    });

    // 10. completeRecord + 201
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
    if (err instanceof AgentRuntimeRegistrationError) {
      if (err.kind === "conformance_failed" || err.kind === "runtime_conflict") {
        // 验收失败/稳定身份冲突：fail closed（无新行），不回显远端响应内容。
        return apiError("BUSINESS_CONSTRAINT_VIOLATION", "Runtime 一致性验收失败，注册被拒绝", {
          requestId,
        });
      }
      return schemaInvalidTable(requestId, `注册引用非法：${err.message}`);
    }
    throw err;
  }
}
