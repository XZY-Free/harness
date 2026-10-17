import { runWithCapmAuth } from "@/lib/capability-market/auth";
import { capabilityMarketConfig } from "@/lib/config";
import { apiError, apiSuccess, getRequestId } from "@/lib/http";
import { readSessionToken } from "@/lib/identity-client";
import { requireStudioAction } from "@/lib/identity/studio-access";
import { logger } from "@/lib/logger";
import { type ToolSyncResult, runToolSync } from "@/lib/skill/sync/tool-sync-service";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import type { NextRequest } from "next/server";

/**
 * POST /studio/api/tools/sync → 手动同步 capability-market 的 tool / mcp 到本地。
 *
 * 落地形态是**本地定义行**（Provider + Tool + SchemaRevision），执行归 capm；
 * 与 skill 同步（runSync）平行。仅 admin（tool.write）可触发。
 * 返回分组结果（imported/updated/uptodate/conflict/blocked/failed）。
 */
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req);
  const r = await requireStudioAction(req, "tool.write");
  if (!r.ok) return r.response;
  const { tenantId, userIdentityId: actorUserId } = r.principal;

  if (!capabilityMarketConfig.endpoint) {
    return apiError(
      "SKILL_SYNC_NOT_CONFIGURED",
      "capability-market endpoint 未配置（NEX_CAPABILITY_MARKET_ENDPOINT），无法同步",
      { requestId },
    );
  }

  let result: ToolSyncResult;
  try {
    // 把用户登录 token 注入 capm 调用作用域（主路径）；无则落 env 兜底。
    result = await runWithCapmAuth(readSessionToken(req.headers), () =>
      runToolSync({ tenantId, actorUserId }),
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn("[/studio/api/tools/sync] 同步失败", { error: msg });
    try {
      await recordAdminAudit({
        actorUserId,
        action: "tools.synced",
        targetType: "tool",
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
      action: "tools.synced",
      targetType: "tool",
      targetId: "capability-market",
      outcome: "succeeded",
      metadata: {
        imported: result.imported.length,
        updated: result.updated.length,
        uptodate: result.uptodate.length,
        conflict: result.conflict.length,
        blocked: result.blocked.length,
        failed: result.failed.length,
      },
    });
  } catch {
    /* 审计非关键 */
  }
  return apiSuccess(result);
}
