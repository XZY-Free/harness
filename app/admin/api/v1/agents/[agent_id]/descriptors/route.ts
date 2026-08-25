import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  AgentDescriptorAgentNotFoundError,
  createCreateAgentDescriptorSnapshot,
} from "@/lib/agents/application/create-agent-descriptor-snapshot";
import type {
  AgentDescriptorError,
  OperatorContextSupplement,
  ProviderAgentCard,
} from "@/lib/agents/domain/agent-descriptor";
/**
 * POST /admin/api/v1/agents/{agent_id}/descriptors — 登记 Agent Descriptor，创建不可变
 * AgentDescriptorSnapshot。
 *
 * 事实源：docs/V12/01/agent补充/00 §6.2 / 01 §2。
 *
 * 行为：
 * - 解析 admin 主体（SSO 管理员或 CI/CD Service Identity）。
 * - 校验 action scope: agent.descriptor.create + resource { type: "agent", id: agent_id }。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（descriptor_kind + card + 可选 operator_context_supplement /
 *   provider_declared_revision_ref）。
 * - 调用 createAgentDescriptorSnapshot 规范化 Provider Agent Card，形成不可变 Snapshot
 *   （SnowHarness 对 Agent 一律按源码不可见处理，只接受 Provider 公开的外部合同）。
 * - 写 AuditEvent（agent.descriptor.create）。
 * - completeRecord + 返回 201 + Snapshot 摘要。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - Agent 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 请求体非法/能力被 Tool 化 → 400 REQUEST_SCHEMA_INVALID
 */
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import { mysqlAgentDescriptorStore } from "@/lib/agents/persistence/mysql-agent-descriptor-store";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
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

export const dynamic = "force-dynamic";

/** 路径参数上下文（Next.js App Router 动态段）。 */
interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

/** context 必要性合法值。 */
const CONTEXT_NECESSITIES = new Set(["required", "preferred", "accepted"]);

/**
 * 校验 Provider Agent Card（wire 输入）。
 * 禁止 per-capability 函数/operation 字段（能力只描述"会什么任务"）。
 */
function validateProviderCard(card: unknown): card is ProviderAgentCard {
  if (!card || typeof card !== "object" || Array.isArray(card)) return false;
  const c = card as Record<string, unknown>;
  // protocol
  if (!c.protocol || typeof c.protocol !== "object" || Array.isArray(c.protocol)) return false;
  const protocol = c.protocol as Record<string, unknown>;
  if (typeof protocol.type !== "string" || !protocol.type.trim()) return false;
  if (typeof protocol.contractRevision !== "string" || !protocol.contractRevision.trim())
    return false;
  // capabilities
  if (!Array.isArray(c.capabilities)) return false;
  for (const cap of c.capabilities) {
    if (!cap || typeof cap !== "object" || Array.isArray(cap)) return false;
    const k = cap as Record<string, unknown>;
    if (typeof k.capabilityKey !== "string" || !k.capabilityKey.trim()) return false;
    if (typeof k.name !== "string" || !k.name.trim()) return false;
    // 拒绝任何函数/operation/RPC 字段（防 Tool 化）
    const toolKeys = [
      "operation",
      "operationId",
      "function",
      "functionName",
      "rpc",
      "inputSchema",
      "outputSchema",
      "params",
      "arguments",
    ];
    if (toolKeys.some((tk) => tk in k)) return false;
  }
  // invocationContext
  if (c.invocationContext !== undefined) {
    if (!Array.isArray(c.invocationContext)) return false;
    for (const d of c.invocationContext) {
      if (!d || typeof d !== "object" || Array.isArray(d)) return false;
      const ctx = d as Record<string, unknown>;
      if (typeof ctx.contextKind !== "string" || !ctx.contextKind.trim()) return false;
      if (!CONTEXT_NECESSITIES.has(String(ctx.necessity))) return false;
    }
  }
  // identity（可选）
  if (c.identity !== undefined) {
    if (typeof c.identity !== "object" || Array.isArray(c.identity)) return false;
  }
  return true;
}

/** 校验 operator_context_supplement。 */
function validateOperatorSupplement(s: unknown): s is OperatorContextSupplement {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  const o = s as Record<string, unknown>;
  if (!Array.isArray(o.contexts)) return false;
  for (const d of o.contexts) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    const ctx = d as Record<string, unknown>;
    if (typeof ctx.contextKind !== "string" || !ctx.contextKind.trim()) return false;
    if (!CONTEXT_NECESSITIES.has(String(ctx.necessity))) return false;
  }
  return true;
}

/** 校验请求体。 */
function validateBody(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.descriptor_kind !== "string" || !b.descriptor_kind.trim()) return false;
  if (!validateProviderCard(b.card)) return false;
  if (b.operator_context_supplement !== undefined) {
    if (!validateOperatorSupplement(b.operator_context_supplement)) return false;
  }
  if (b.provider_declared_revision_ref !== undefined) {
    if (typeof b.provider_declared_revision_ref !== "string") return false;
  }
  return true;
}

/** 把 wire snake_case 转换为领域 camelCase ProviderAgentCard。 */
function toProviderCard(card: Record<string, unknown>): ProviderAgentCard {
  const protocol = card.protocol as Record<string, unknown>;
  const capabilities = (card.capabilities as Record<string, unknown>[]).map((k) => ({
    capabilityKey: String(k.capabilityKey),
    name: String(k.name),
    description: k.description !== undefined ? String(k.description) : undefined,
    tags: Array.isArray(k.tags) ? (k.tags as string[]) : undefined,
    examples: Array.isArray(k.examples) ? (k.examples as string[]) : undefined,
    inputModes: Array.isArray(k.input_modes) ? (k.input_modes as string[]) : undefined,
    outputModes: Array.isArray(k.output_modes) ? (k.output_modes as string[]) : undefined,
  }));
  const invocationContext = Array.isArray(card.invocation_context)
    ? (card.invocation_context as Record<string, unknown>[]).map((d) => ({
        contextKind: String(d.context_kind),
        necessity: d.necessity as "required" | "preferred" | "accepted",
        purpose: d.purpose !== undefined ? String(d.purpose) : undefined,
      }))
    : undefined;
  const identity = card.identity
    ? ({
        name:
          (card.identity as Record<string, unknown>).name !== undefined
            ? String((card.identity as Record<string, unknown>).name)
            : undefined,
        description:
          (card.identity as Record<string, unknown>).description !== undefined
            ? String((card.identity as Record<string, unknown>).description)
            : undefined,
        providerRevisionRef:
          (card.identity as Record<string, unknown>).provider_revision_ref !== undefined
            ? String((card.identity as Record<string, unknown>).provider_revision_ref)
            : undefined,
      } as ProviderAgentCard["identity"])
    : undefined;
  return {
    protocol: {
      type: String(protocol.type),
      contractRevision: String(protocol.contractRevision),
    },
    identity,
    capabilities,
    invocationContext,
  };
}

/** 转换 operator_context_supplement 为领域类型。 */
function toOperatorSupplement(s: Record<string, unknown>): OperatorContextSupplement {
  return {
    contexts: (s.contexts as Record<string, unknown>[]).map((d) => ({
      contextKind: String(d.context_kind),
      necessity: d.necessity as "required" | "preferred" | "accepted",
      purpose: d.purpose !== undefined ? String(d.purpose) : undefined,
    })),
  };
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

/** 投影登记结果为响应体（snake_case）。 */
function projectResult(result: {
  snapshotId: string;
  providerDescriptorDigest: string;
  capabilityManifestDigest: string;
  invocationContextContractDigest: string;
  descriptorKind: string;
  protocolType: string;
  protocolContractRevision: string;
  capturedAt: Date;
}): Record<string, unknown> {
  return {
    snapshot_id: result.snapshotId,
    provider_descriptor_digest: result.providerDescriptorDigest,
    capability_manifest_digest: result.capabilityManifestDigest,
    invocation_context_contract_digest: result.invocationContextContractDigest,
    descriptor_kind: result.descriptorKind,
    protocol_type: result.protocolType,
    protocol_contract_revision: result.protocolContractRevision,
    captured_at: result.capturedAt.toISOString(),
  };
}

/** 是否 AgentDescriptorError（规范化/校验失败 → 400）。 */
function isDescriptorError(err: unknown): err is AgentDescriptorError {
  return err instanceof Error && err.name === "AgentDescriptorError";
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
    "agent.descriptor.create",
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

  // 6. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `agent.descriptor.create:${agentId}`;

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

  // 8. 执行业务：登记 Agent Descriptor → 创建不可变 AgentDescriptorSnapshot
  const createAgentDescriptorSnapshot = createCreateAgentDescriptorSnapshot({
    store: mysqlAgentDescriptorStore,
  });
  try {
    const result = await createAgentDescriptorSnapshot({
      tenantId: principal.tenantId,
      agentId,
      descriptorKind: body.descriptor_kind,
      card: toProviderCard(body.card as Record<string, unknown>),
      operatorContextSupplement: body.operator_context_supplement
        ? toOperatorSupplement(body.operator_context_supplement as Record<string, unknown>)
        : undefined,
      providerDeclaredRevisionRef: body.provider_declared_revision_ref ?? null,
      createdBy: createdByFromAdminPrincipal(principal),
    });

    // 9. 写 AuditEvent（agent.descriptor.create）
    await recordAuditEvent({
      actor: actorFromAdminPrincipal(principal),
      actionType: "agent.descriptor.create",
      targetType: "agent_descriptor_snapshot",
      targetId: result.snapshotId,
      after: {
        agent_id: agentId,
        descriptor_kind: result.descriptorKind,
        protocol_type: result.protocolType,
        provider_descriptor_digest: result.providerDescriptorDigest,
        capability_manifest_digest: result.capabilityManifestDigest,
      },
      reason: `登记 Agent Descriptor 快照 (descriptorKind=${result.descriptorKind})`,
      requestId,
    });

    // 10. completeRecord + 返回 201
    const responseBody = projectResult(result);
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
    if (err instanceof AgentDescriptorAgentNotFoundError) {
      return resourceNotFound(requestId, err.message);
    }
    if (isDescriptorError(err)) {
      return schemaInvalidTable(requestId, err.message);
    }
    throw err;
  }
}

/**
 * GET /admin/api/v1/agents/{agent_id}/descriptors — 列出 Agent 的所有 AgentDescriptorSnapshot。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Agent 存在且属于当前租户（跨租户 404）。
 * - 调用 store.listSnapshotsByAgent 返回 Snapshot 列表（按 capturedAt 降序）。
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

  const snapshots = await mysqlAgentDescriptorStore.transaction((session) =>
    session.listSnapshotsByAgent(principal.tenantId, agentId),
  );
  const projected = snapshots.map((s) => ({
    id: s.id,
    agent_id: s.agentId,
    descriptor_kind: s.descriptorKind,
    protocol_type: s.protocolType,
    protocol_contract_revision: s.protocolContractRevision,
    provider_descriptor_digest: s.providerDescriptorDigest,
    capability_manifest_digest: s.capabilityManifestDigest,
    invocation_context_contract_digest: s.invocationContextContractDigest,
    provider_declared_revision_ref: s.providerDeclaredRevisionRef,
    captured_at: s.capturedAt.toISOString(),
    created_by: s.createdBy,
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
