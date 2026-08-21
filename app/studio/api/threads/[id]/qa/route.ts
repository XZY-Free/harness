import { getThreadById, listQaEventsByThread, requireThreadForUser } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { computeQaStats, readQaArtifact } from "@/lib/qa/artifact";
import { hasStudioAction, requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

/**
 * V3.6 Stage E：QA 证据 API。
 *
 * GET /studio/api/threads/[id]/qa
 *   → 列最近 QA 检查事件（qa.check_passed / qa.check_failed），按 sequence 降序。
 *
 * GET /studio/api/threads/[id]/qa?artifact={fileName}
 *   → 代理读 QA 证据文件（截图 PNG / 报告 JSON），不暴露文件系统路径。
 *     权限同 list：owner / admin（thread.read.all）；foreign → 404。
 *
 * 截图经 API 代理访问（plan §9 / §1 决策），不直接暴露文件系统路径。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasStudioAction(r.principal, "thread.read");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.principal.userIdentityId);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  // 证据文件代理：?artifact={fileName}
  const artifactName = req.nextUrl.searchParams.get("artifact");
  if (artifactName) {
    const buf = await readQaArtifact(id, artifactName);
    if (!buf) return jsonError(404, "artifact_not_found", "证据文件不存在");
    const isPng = artifactName.endsWith(".png");
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": isPng ? "image/png" : "application/json",
        // S1（05-P2-7）：缓存 60→5s，agent 重新截图后 Studio 更快刷新；加 ETag 供条件请求
        "Cache-Control": "private, max-age=5",
        ETag: `"${artifactName}"`,
      },
    });
  }

  // S1（05-P2-9）：?stats=1 → 返回 QA 趋势/历史聚合统计
  const events = await listQaEventsByThread(id);
  if (req.nextUrl.searchParams.get("stats") === "1") {
    return jsonOk({ threadId: id, stats: computeQaStats(events) });
  }
  return jsonOk({ threadId: id, events });
}
