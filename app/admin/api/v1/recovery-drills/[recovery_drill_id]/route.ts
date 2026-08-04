/**
 * POST/GET /admin/api/v1/recovery-drills/{recovery_drill_id} — 恢复演练详情与执行（S12-W08）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md §8
 *         （恢复演练验证一致性；演练在隔离环境使用真实组件，不以备份任务成功日志代替可恢复性）。
 *
 * 行为：
 * - GET：查询演练详情（含 checks 投影：check_type / check_state / evidence_ref）。
 * - POST：推进演练状态机（start/complete/fail/cancel）+ 执行一致性核对（start 时）。
 * - action scope: recovery.drill + resource { type: "tenant", id: tenantId }。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 演练不存在 → 404 RESOURCE_NOT_FOUND
 * - 非法状态转移 → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - 非法 action 参数 → 400 REQUEST_SCHEMA_INVALID
 */
import { REQUEST_ID_HEADER, getRequestId, v11Error, v11NotFound, v11Ok } from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import { runAllChecksForDrill } from "@/lib/v11/identity/recovery-consistency-checker";
import {
  RecoveryDrillError,
  cancelRecoveryDrill,
  completeRecoveryDrill,
  computeDrillSummary,
  failRecoveryDrill,
  getRecoveryDrillById,
  listRecoveryDrillChecks,
  startRecoveryDrill,
} from "@/lib/v11/identity/recovery-drill-queries";
import type { V11RecoveryDrill, V11RecoveryDrillCheck } from "@/lib/v11/schema/recovery-drill";

export const dynamic = "force-dynamic";

const VALID_ACTIONS = new Set(["start", "complete", "fail", "cancel"]);

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

function projectCheck(c: V11RecoveryDrillCheck): Record<string, unknown> {
  return {
    id: c.id,
    check_type: c.checkType,
    check_state: c.checkState,
    evidence_ref: c.evidenceRef,
    failure_reason: c.failureReason,
    duration_ms: c.durationMs,
    completed_at: c.completedAt?.toISOString() ?? null,
  };
}

function projectDrillDetail(drill: {
  id: string;
  drillType: string;
  drillState: string;
  rpoTargetSeconds: number;
  rtoTargetSeconds: number;
  rpoActualSeconds: number | null;
  rtoActualSeconds: number | null;
  environmentTag: string;
  executedBy: string;
  consistencySummaryJson: string | null;
  failureReason: string | null;
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
    consistency_summary: drill.consistencySummaryJson
      ? JSON.parse(drill.consistencySummaryJson)
      : null,
    failure_reason: drill.failureReason,
    scheduled_at: drill.scheduledAt.toISOString(),
    started_at: drill.startedAt?.toISOString() ?? null,
    completed_at: drill.completedAt?.toISOString() ?? null,
    updated_at: drill.updatedAt.toISOString(),
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ recovery_drill_id: string }> },
): Promise<Response> {
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

  // 2. action scope 校验
  const scopeResult = await requireAdminActionScope(
    principal,
    "recovery.drill",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. 解析路径参数
  const { recovery_drill_id: drillId } = await context.params;
  if (!drillId) {
    return v11SchemaInvalid(requestId, "缺少路径参数 recovery_drill_id");
  }

  // 4. 查询演练；不存在 → 404 RESOURCE_NOT_FOUND
  const drill = await getRecoveryDrillById(principal.tenantId, drillId);
  if (!drill) {
    return v11NotFound(requestId, "恢复演练不存在或无权访问");
  }

  // 5. 列出 checks + 派生 summary
  const checks = await listRecoveryDrillChecks(principal.tenantId, drillId);
  const summary = computeDrillSummary(checks);

  // 6. 构造响应投影
  const responseBody: Record<string, unknown> = {
    ...projectDrillDetail(drill),
    summary: {
      check_count: summary.checkCount,
      passed_count: summary.passedCount,
      failed_count: summary.failedCount,
      skipped_count: summary.skippedCount,
      pending_count: summary.pendingCount,
      running_count: summary.runningCount,
    },
    checks: checks.map(projectCheck),
  };

  return v11Ok(responseBody, {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ recovery_drill_id: string }> },
): Promise<Response> {
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

  // 2. action scope 校验
  const scopeResult = await requireAdminActionScope(
    principal,
    "recovery.drill",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. 解析路径参数 + 请求体
  const { recovery_drill_id: drillId } = await context.params;
  if (!drillId) {
    return v11SchemaInvalid(requestId, "缺少路径参数 recovery_drill_id");
  }

  const body = (await request.json().catch(() => null)) as {
    action?: string;
    failure_reason?: string;
    cancel_reason?: string;
    rpo_actual_seconds?: number;
    rto_actual_seconds?: number;
  } | null;

  const action = body?.action?.trim();
  if (!action || !VALID_ACTIONS.has(action)) {
    return v11SchemaInvalid(requestId, "缺少或非法 action（期望 start/complete/fail/cancel）");
  }

  const actor = actorFromAdminPrincipal(principal);

  try {
    let updatedDrill: V11RecoveryDrill;

    if (action === "start") {
      // start：scheduled → running + 执行一致性核对
      updatedDrill = await startRecoveryDrill({
        tenantId: principal.tenantId,
        id: drillId,
        actor,
        requestId,
      });

      // 执行所有 pending check 的核对
      const checks = await listRecoveryDrillChecks(principal.tenantId, drillId);
      await runAllChecksForDrill({
        tenantId: principal.tenantId,
        drillId,
        checks,
      });

      // 核对完成后尝试自动派生终态
      const refreshedChecks = await listRecoveryDrillChecks(principal.tenantId, drillId);
      const terminal = deriveTerminalFromChecks(refreshedChecks);
      if (terminal === "completed") {
        updatedDrill = await completeRecoveryDrill({
          tenantId: principal.tenantId,
          id: drillId,
          actor,
          requestId,
          rpoActualSeconds: body?.rpo_actual_seconds,
          rtoActualSeconds: body?.rto_actual_seconds,
        });
      } else if (terminal === "failed") {
        updatedDrill = await failRecoveryDrill({
          tenantId: principal.tenantId,
          id: drillId,
          actor,
          failureReason: body?.failure_reason ?? "一致性核对未通过",
          requestId,
          rpoActualSeconds: body?.rpo_actual_seconds,
          rtoActualSeconds: body?.rto_actual_seconds,
        });
      }
    } else if (action === "complete") {
      updatedDrill = await completeRecoveryDrill({
        tenantId: principal.tenantId,
        id: drillId,
        actor,
        requestId,
        rpoActualSeconds: body?.rpo_actual_seconds,
        rtoActualSeconds: body?.rto_actual_seconds,
      });
    } else if (action === "fail") {
      const failureReason = body?.failure_reason?.trim();
      if (!failureReason) {
        return v11SchemaInvalid(requestId, "fail 操作缺少 failure_reason");
      }
      updatedDrill = await failRecoveryDrill({
        tenantId: principal.tenantId,
        id: drillId,
        actor,
        failureReason,
        requestId,
        rpoActualSeconds: body?.rpo_actual_seconds,
        rtoActualSeconds: body?.rto_actual_seconds,
      });
    } else {
      // cancel
      const cancelReason = body?.cancel_reason?.trim() ?? "人工取消";
      updatedDrill = await cancelRecoveryDrill({
        tenantId: principal.tenantId,
        id: drillId,
        actor,
        reason: cancelReason,
        requestId,
      });
    }

    // 返回更新后的演练详情 + checks
    const checks = await listRecoveryDrillChecks(principal.tenantId, drillId);
    const summary = computeDrillSummary(checks);
    const responseBody: Record<string, unknown> = {
      ...projectDrillDetail(updatedDrill),
      summary: {
        check_count: summary.checkCount,
        passed_count: summary.passedCount,
        failed_count: summary.failedCount,
        skipped_count: summary.skippedCount,
        pending_count: summary.pendingCount,
        running_count: summary.runningCount,
      },
      checks: checks.map(projectCheck),
    };

    return v11Ok(responseBody, {
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    if (err instanceof RecoveryDrillError) {
      if (err.code === "drill_not_found") {
        return v11NotFound(requestId, "恢复演练不存在或无权访问");
      }
      if (err.code === "illegal_transition") {
        return v11Error("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
      }
      if (err.code === "missing_evidence") {
        return v11SchemaInvalid(requestId, err.message);
      }
    }
    throw err;
  }
}

/** 从 checks 派生终态（简化版，避免循环依赖）。 */
function deriveTerminalFromChecks(checks: V11RecoveryDrillCheck[]): "completed" | "failed" | null {
  if (checks.length === 0) return "completed";
  const hasPendingOrRunning = checks.some(
    (c) => c.checkState === "pending" || c.checkState === "running",
  );
  if (hasPendingOrRunning) return null;
  const hasFailed = checks.some((c) => c.checkState === "failed");
  if (hasFailed) return "failed";
  return "completed";
}
