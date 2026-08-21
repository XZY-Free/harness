import { getThreadById, listSummariesByThread, requireThreadForUser } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { hasStudioAction, requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/threads/[id]/context/summaries → thread 最近 ContextSummary（压缩版本历史）。
 * V3.3a Stage E：observability 入口，沿用既有 Studio thread 权限：
 * - member：requireThreadForUser（foreign → 404，不泄露存在性）。
 * - admin（thread.read.all）：getThreadById（不存在 → 404）。
 * - 未登录 → requirePermission 401；无 studio.access → 403。
 *
 * 默认返回最近 50 条，含 supersede 链（includeSuperseded=true，供面板展示版本历史）。
 * 每条带压缩比（originalTokenEstimate → tokenEstimate）。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasStudioAction(r.principal, "thread.read");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.principal.userIdentityId);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  const summaries = await listSummariesByThread(id, {
    limit: 50,
    includeSuperseded: true,
  });

  const rows = summaries.map((s) => ({
    id: s.id,
    type: s.type,
    scope: s.scope,
    summaryText: s.summaryText,
    tokenEstimate: s.tokenEstimate,
    originalTokenEstimate: s.originalTokenEstimate,
    /** 压缩比：摘要 token / 原始 token（越小压缩越多）。 */
    compressionRatio:
      s.originalTokenEstimate > 0
        ? Number((s.tokenEstimate / s.originalTokenEstimate).toFixed(3))
        : null,
    supersededById: s.supersededById,
    isSuperseded: s.supersededById !== null,
    createdAt: s.createdAt,
  }));

  return jsonOk({ threadId: id, summaries: rows });
}
