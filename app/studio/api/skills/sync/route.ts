import { runWithCapmAuth } from "@/lib/capability-market/auth";
import { capabilityMarketConfig } from "@/lib/config";
import { apiError, apiSuccess, getRequestId } from "@/lib/http";
import { readSessionToken } from "@/lib/identity-client";
import { requireStudioAction } from "@/lib/identity/studio-access";
import { logger } from "@/lib/logger";
import { type SyncResult, runSync } from "@/lib/skill/sync/sync-service";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import type { NextRequest } from "next/server";

/**
 * POST /studio/api/skills/sync → 手动同步 capability-market Skill 到本地（02 文档 §5.1、§7.3）。
 *
 * 仅 admin（skill.write.all）可触发。配置缺失 → 400 明确失败。
 * 返回分组结果（imported/updated/uptodate/conflict/blocked/failed/missing）,前端直接展示。
 * conflict 项单独分组,提示用户改映射名或取消同步。
 */
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req);
  const r = await requireStudioAction(req, "skill.write");
  if (!r.ok) return r.response;
  const { tenantId, userIdentityId: actorUserId } = r.principal;

  if (!capabilityMarketConfig.endpoint) {
    return apiError(
      "SKILL_SYNC_NOT_CONFIGURED",
      "capability-market endpoint 未配置（NEX_CAPABILITY_MARKET_ENDPOINT）,无法同步",
      { requestId },
    );
  }

  let result: SyncResult;
  try {
    // 把用户登录 token 注入 capm 调用作用域（主路径）；无则落 env 兜底。
    result = await runWithCapmAuth(readSessionToken(req.headers), () =>
      runSync({ tenantId, actorUserId }),
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn("[/studio/api/skills/sync] 同步失败", { error: msg });
    try {
      await recordAdminAudit({
        actorUserId,
        action: "skills.synced",
        targetType: "skill",
        targetId: "capability-market",
        outcome: "failed",
        metadata: { error: msg.slice(0, 200) },
      });
    } catch {
      /* 审计非关键 */
    }
    return apiError("SKILL_SYNC_FAILED", msg, { requestId });
  }

  try {
    await recordAdminAudit({
      actorUserId,
      action: "skills.synced",
      targetType: "skill",
      targetId: "capability-market",
      outcome: "succeeded",
      metadata: {
        imported: result.imported.length,
        updated: result.updated.length,
        uptodate: result.uptodate.length,
        conflict: result.conflict.length,
        blocked: result.blocked.length,
        failed: result.failed.length,
        missing: result.missing.length,
      },
    });
  } catch {
    /* 审计非关键 */
  }
  return apiSuccess(result);
}
