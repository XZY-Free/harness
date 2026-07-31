import { insertPolicyConfigHistory, replacePolicyConfigRows } from "@/lib/db/queries";
import { getPolicyConfigRows } from "@/lib/db/studio-queries";
import { jsonError, jsonOk } from "@/lib/http";
import { logger } from "@/lib/logger";
import { refreshPolicyConfigFromDB } from "@/lib/policy/config";
import { requirePermission } from "@/lib/rbac";
import { recordAdminAudit, summarizePolicyChange } from "@/lib/studio/admin-audit";
import {
  type NormalizedPolicyRow,
  PolicyValidationError,
  validatePolicyRows,
} from "@/lib/studio/policy-validation";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/policies → 当前 DB policy 配置（受 policy.read 守卫）。
 * 返回行数组（key + value 原始 JSON + updatedAt），前端只读展示。RegExp 已是 source string。
 */
export async function GET(req: NextRequest) {
  const r = await requirePermission(req, "policy.read");
  if (!r.ok) return r.response;
  const rows = await getPolicyConfigRows();
  return jsonOk({ rows });
}

/**
 * PUT /studio/api/policies → 整配置覆盖 policy（受 policy.write 守卫）。
 *
 * 流程：requirePermission(policy.write) → 解析 body → 读 before rows → validatePolicyRows
 * （白名单/shape/regex/timeout 服务端校验）→ replacePolicyConfigRows 事务覆盖 →
 * refreshPolicyConfigFromDB 立即刷新 → succeeded 审计。
 *
 * 审计（切片 C）：401/403/invalid_body 不审计。PolicyValidationError → failed 审计
 * (reasonCode=invalid_policy)，不写入不 refresh。成功 → succeeded 审计，metadata 只含
 * keys / changedKeys（不含命令全文 / secret）。审计写失败 → 500 audit_failed
 * （Known gap：policy 可能已 refresh，§4.3 / §12）。
 */
export async function PUT(req: NextRequest) {
  const r = await requirePermission(req, "policy.write");
  if (!r.ok) return r.response;
  const actorUserId = r.user.id;

  let body: { rows?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_body", "请求体不是合法 JSON");
  }

  const beforeRows = await getPolicyConfigRows();

  let normalized: NormalizedPolicyRow[];
  try {
    normalized = validatePolicyRows(body?.rows);
  } catch (error) {
    if (error instanceof PolicyValidationError) {
      try {
        await recordAdminAudit({
          actorUserId,
          action: "policies.updated",
          targetType: "policy",
          targetId: "policy",
          outcome: "failed",
          metadata: { reasonCode: "invalid_policy" },
        });
      } catch (auditError) {
        logger.error("admin audit write failed (policy invalid path)", {
          error: String(auditError),
        });
      }
      return jsonError(400, "invalid_policy", error.message);
    }
    throw error;
  }

  await replacePolicyConfigRows(normalized);
  // 当前进程立即生效；多实例缓存同步留后续切片（Known gap）
  await refreshPolicyConfigFromDB();

  const summary = summarizePolicyChange(beforeRows, normalized);

  // V6-M3-4（C5）：写入 policy 变更历史（before/after 快照 + changedKeys）
  try {
    await insertPolicyConfigHistory({
      changedBy: actorUserId,
      beforeSnapshot: JSON.stringify(beforeRows),
      afterSnapshot: JSON.stringify(normalized),
      changedKeys: summary.changedKeys.length > 0 ? JSON.stringify(summary.changedKeys) : null,
    });
  } catch (error) {
    logger.warn("[policy] history insert failed (non-blocking)", { error: String(error) });
  }

  try {
    // V6-M3-4（C5）：审计 metadata 含 changedKeys 的 before 值（供追溯）
    const beforeValues: Record<string, unknown> = {};
    if (summary.changedKeys.length > 0) {
      const beforeMap = new Map(beforeRows.map((r) => [r.key, r.value]));
      for (const key of summary.changedKeys) {
        beforeValues[key] = beforeMap.get(key) ?? null;
      }
    }
    await recordAdminAudit({
      actorUserId,
      action: "policies.updated",
      targetType: "policy",
      targetId: "policy",
      outcome: "succeeded",
      metadata: { keys: summary.keys, changedKeys: summary.changedKeys, beforeValues },
    });
  } catch (error) {
    logger.error("admin audit write failed (policy success path)", { error: String(error) });
    return jsonError(500, "audit_failed", "审计写入失败");
  }
  return jsonOk({ rows: normalized });
}
