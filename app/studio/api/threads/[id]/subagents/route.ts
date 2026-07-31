import { getThreadById, listSubagentRunsByThread, requireThreadForUser } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { hasPermission, requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/threads/[id]/subagents → thread 子代理 run 列表（只读，V3.5 Stage E）。
 * 权限沿用既有 Studio thread 守卫：
 * - member：requireThreadForUser（foreign → 404，不泄露存在性）。
 * - admin（thread.read.all）：getThreadById（不存在 → 404）。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasPermission(r.user.id, "thread.read.all");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.user.id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  const runs = await listSubagentRunsByThread(id);
  return jsonOk({
    threadId: id,
    subagents: runs.map((s) => ({
      id: s.id,
      definitionId: s.definitionId,
      goal: s.goal,
      status: s.status,
      writeScope: s.writeScope,
      resultSummary: s.resultSummary,
      outputArtifactId: s.outputArtifactId,
      transcriptPath: s.transcriptPath,
      errorMessage: s.errorMessage,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      createdAt: s.createdAt,
    })),
  });
}
