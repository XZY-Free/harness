/**
 * POST/GET /admin/api/v1/recovery-drills — 备份恢复演练管理（S12-W08）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md §8
 *         （数据库备份、对象版本/复制、配置和密钥恢复分别定义 RPO/RTO 与责任边界；
 *           恢复演练验证 Event sequence、投影 checkpoint、Artifact 引用、Legal Hold 和删除证据的一致性；
 *           演练在隔离环境使用真实组件，不连接生产数据库，不以备份任务成功日志代替可恢复性）。
 *
 * 行为：
 * - POST：创建恢复演练（scheduled 状态）+ 按 drillType 预填 check 项。
 * - GET：列出恢复演练（cursor 分页，支持 drill_type/state/executed_by 过滤）。
 * - action scope: recovery.drill + resource { type: "tenant", id: tenantId }。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 缺少必填字段 → 400 REQUEST_SCHEMA_INVALID
 * - 同租户已有未完成同类型演练 → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - environment_tag 为空 → 400 REQUEST_SCHEMA_INVALID
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
  RecoveryDrillError,
  createRecoveryDrill,
  listRecoveryDrills,
} from "@/lib/v11/identity/recovery-drill-queries";
import {
  RECOVERY_DRILL_STATES,
  RECOVERY_DRILL_TYPES,
  type RecoveryDrillState,
  type RecoveryDrillType,
} from "@/lib/v11/schema/recovery-drill";

export const dynamic = "force-dynamic";

const VALID_DRILL_TYPES = new Set<string>(RECOVERY_DRILL_TYPES);
const VALID_DRILL_STATES = new Set<string>(RECOVERY_DRILL_STATES);

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

function principalKindFromAdminPrincipal(principal: AdminPrincipal): "user" | "service" {
  return "userIdentityId" in principal ? "user" : "service";
}

function executedByFromAdminPrincipal(principal: AdminPrincipal): string {
  return "userIdentityId" in principal
    ? principal.userIdentityId
    : (principal.serviceId ?? "unknown");
}

function projectDrill(drill: {
  id: string;
  drillType: RecoveryDrillType;
  drillState: RecoveryDrillState;
  rpoTargetSeconds: number;
  rtoTargetSeconds: number;
  rpoActualSeconds: number | null;
  rtoActualSeconds: number | null;
  environmentTag: string;
  executedBy: string;
  scheduledAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: drill.id,
    drill_type: drill.drillType,
    drill_state: drill.drillState,
    rpo_target_seconds: drill.rpoTargetSeconds,
    rto_target_seconds: drill.rtoTargetSeconds,
    rpo_actual_seconds: drill.rpoActualSeconds,
    rto_actual_seconds: drill.rtoActualSeconds,
    environment_tag: drill.environmentTag,
    executed_by: drill.executedBy,
    scheduled_at: drill.scheduledAt.toISOString(),
    started_at: drill.startedAt?.toISOString() ?? null,
    completed_at: drill.completedAt?.toISOString() ?? null,
    updated_at: drill.updatedAt.toISOString(),
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 身份解析
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 请求体解析与校验
  const body = (await request.json().catch(() => null)) as {
    drill_type?: string;
    environment_tag?: string;
    reason?: string;
    rpo_target_seconds?: number;
    rto_target_seconds?: number;
  } | null;

  const drillType = body?.drill_type?.trim();
  if (!drillType || !VALID_DRILL_TYPES.has(drillType)) {
    return v11SchemaInvalid(
      requestId,
      "缺少或非法 drill_type（期望 db_restore/object_version/secret_restore/runtime_failover/queue_failover）",
    );
  }

  const environmentTag = body?.environment_tag?.trim();
  if (!environmentTag) {
    return v11SchemaInvalid(requestId, "缺少必填字段 environment_tag（演练必须在隔离环境执行）");
  }

  const reason = body?.reason?.trim() || undefined;
  const rpoTargetSeconds = body?.rpo_target_seconds;
  const rtoTargetSeconds = body?.rto_target_seconds;
  if (
    rpoTargetSeconds !== undefined &&
    (!Number.isInteger(rpoTargetSeconds) || rpoTargetSeconds < 0)
  ) {
    return v11SchemaInvalid(requestId, "rpo_target_seconds 必须为非负整数");
  }
  if (
    rtoTargetSeconds !== undefined &&
    (!Number.isInteger(rtoTargetSeconds) || rtoTargetSeconds < 0)
  ) {
    return v11SchemaInvalid(requestId, "rto_target_seconds 必须为非负整数");
  }

  // 3. action scope 校验：按 tenant 维度授权
  const scopeResult = await requireAdminActionScope(
    principal,
    "recovery.drill",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 4. 创建演练
  try {
    const drill = await createRecoveryDrill({
      tenantId: principal.tenantId,
      drillType: drillType as RecoveryDrillType,
      environmentTag,
      reason,
      executedBy: executedByFromAdminPrincipal(principal),
      executedByKind: principalKindFromAdminPrincipal(principal),
      rpoTargetSeconds,
      rtoTargetSeconds,
      actor: actorFromAdminPrincipal(principal),
      requestId,
    });

    return v11Ok(projectDrill(drill), {
      status: 201,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    if (err instanceof RecoveryDrillError && err.code === "duplicate_active_drill") {
      return v11Error("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    if (
      err instanceof RecoveryDrillError &&
      (err.code === "invalid_environment" || err.code === "illegal_transition")
    ) {
      return v11SchemaInvalid(requestId, err.message);
    }
    throw err;
  }
}

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 身份解析
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 查询参数解析
  const url = new URL(request.url);
  const drillTypeParam = url.searchParams.get("drill_type") ?? undefined;
  const drillStateParam = url.searchParams.get("drill_state") ?? undefined;
  const executedByParam = url.searchParams.get("executed_by") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor") ?? undefined;

  if (drillTypeParam && !VALID_DRILL_TYPES.has(drillTypeParam)) {
    return v11SchemaInvalid(requestId, "非法 drill_type 查询参数");
  }
  if (drillStateParam && !VALID_DRILL_STATES.has(drillStateParam)) {
    return v11SchemaInvalid(requestId, "非法 drill_state 查询参数");
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    return v11SchemaInvalid(requestId, "非法 limit 查询参数");
  }

  // 3. action scope 校验：按 tenant 维度授权
  const scopeResult = await requireAdminActionScope(
    principal,
    "recovery.drill",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 4. 列出演练
  const page = await listRecoveryDrills({
    tenantId: principal.tenantId,
    drillType: drillTypeParam as RecoveryDrillType | undefined,
    drillState: drillStateParam as RecoveryDrillState | undefined,
    executedBy: executedByParam,
    limit,
    cursor,
  });

  return v11Ok(
    {
      items: page.items.map(projectDrill),
      next_cursor: page.nextCursor,
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
