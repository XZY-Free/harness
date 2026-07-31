/**
 * POST/GET /admin/api/v1/retention-policies — 保留策略管理（S12-W06）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-data-lifecycle.md §6
 *         （为 Thread/Event/Trace/Audit/Artifact/Memory/Knowledge/Job/安全记录定义独立保留策略）。
 *
 * 行为：
 * - POST：创建保留策略（按 tenantId+objectType 唯一）。
 * - GET：列出保留策略（cursor 分页，支持 data_class / object_type 过滤）。
 * - action scope: legal_hold.manage + resource { type: "tenant", id: tenantId }。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 缺少必填字段 → 400 REQUEST_SCHEMA_INVALID
 * - 策略已存在 → 409 BUSINESS_CONSTRAINT_VIOLATION
 */
import { REQUEST_ID_HEADER, getRequestId, v11Error, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/v11/identity/audit";
import {
  RetentionPolicyError,
  createRetentionPolicy,
  listRetentionPolicies,
} from "@/lib/v11/identity/retention-policy-queries";
import {
  RETENTION_OBJECT_TYPES,
  type RetentionObjectType,
} from "@/lib/v11/schema/retention-policy";

export const dynamic = "force-dynamic";

const VALID_OBJECT_TYPES = new Set<string>(RETENTION_OBJECT_TYPES);

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const body = (await request.json().catch(() => null)) as {
    object_type?: string;
    retention_days?: string;
    legal_hold_days?: string;
    data_class?: string;
    statutory_requirements?: string;
    description?: string;
  } | null;

  const objectType = body?.object_type?.trim();
  if (!objectType || !VALID_OBJECT_TYPES.has(objectType)) {
    return v11SchemaInvalid(
      requestId,
      "缺少或非法 object_type（期望 thread/event/trace/audit/artifact/memory/knowledge/job/security_log）",
    );
  }

  const retentionDays = body?.retention_days?.trim();
  if (!retentionDays) {
    return v11SchemaInvalid(requestId, "缺少必填字段 retention_days");
  }

  const dataClass = body?.data_class?.trim();
  if (!dataClass) {
    return v11SchemaInvalid(requestId, "缺少必填字段 data_class");
  }

  const statutoryRequirements = body?.statutory_requirements?.trim();
  if (!statutoryRequirements) {
    return v11SchemaInvalid(requestId, "缺少必填字段 statutory_requirements");
  }

  const description = body?.description?.trim();
  if (!description) {
    return v11SchemaInvalid(requestId, "缺少必填字段 description");
  }

  const legalHoldDays = body?.legal_hold_days?.trim() || undefined;

  // action scope 校验：按 tenant 维度授权
  const scopeResult = await requireAdminActionScope(
    principal,
    "legal_hold.manage",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  try {
    const policy = await createRetentionPolicy({
      tenantId: principal.tenantId,
      objectType: objectType as RetentionObjectType,
      retentionDays,
      legalHoldDays,
      dataClass,
      statutoryRequirements,
      description,
      createdBy:
        "userIdentityId" in principal
          ? principal.userIdentityId
          : (principal.serviceId ?? "unknown"),
      actor: actorFromAdminPrincipal(principal),
      requestId,
    });

    return v11Ok(
      {
        id: policy.id,
        object_type: policy.objectType,
        retention_days: policy.retentionDays,
        legal_hold_days: policy.legalHoldDays,
        data_class: policy.dataClass,
        statutory_requirements: policy.statutoryRequirements,
        description: policy.description,
        created_by: policy.createdBy,
        created_at: policy.createdAt.toISOString(),
        updated_by: policy.updatedBy,
        updated_at: policy.updatedAt.toISOString(),
      },
      { headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (err) {
    if (err instanceof RetentionPolicyError && err.code === "policy_already_exists") {
      return v11Error("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    if (err instanceof RetentionPolicyError && err.code === "invalid_retention_days") {
      return v11SchemaInvalid(requestId, err.message);
    }
    throw err;
  }
}

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const url = new URL(request.url);
  const dataClass = url.searchParams.get("data_class") ?? undefined;
  const objectTypeParam = url.searchParams.get("object_type") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor") ?? undefined;

  if (objectTypeParam && !VALID_OBJECT_TYPES.has(objectTypeParam)) {
    return v11SchemaInvalid(requestId, "非法 object_type 查询参数");
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    return v11SchemaInvalid(requestId, "非法 limit 查询参数");
  }

  // action scope 校验：按 tenant 维度授权
  const scopeResult = await requireAdminActionScope(
    principal,
    "legal_hold.manage",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const page = await listRetentionPolicies({
    tenantId: principal.tenantId,
    dataClass,
    objectType: objectTypeParam as RetentionObjectType | undefined,
    limit,
    cursor,
  });

  return v11Ok(
    {
      items: page.items.map((p) => ({
        id: p.id,
        object_type: p.objectType,
        retention_days: p.retentionDays,
        legal_hold_days: p.legalHoldDays,
        data_class: p.dataClass,
        statutory_requirements: p.statutoryRequirements,
        description: p.description,
        created_by: p.createdBy,
        created_at: p.createdAt.toISOString(),
        updated_by: p.updatedBy,
        updated_at: p.updatedAt.toISOString(),
      })),
      next_cursor: page.nextCursor,
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
