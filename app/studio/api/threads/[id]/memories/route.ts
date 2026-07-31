import { getThreadById, requireThreadForUser } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { listMemories } from "@/lib/memory/store";
import { hasPermission, requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/threads/[id]/memories → 列当前 thread 可见长期记忆（只读）。
 *
 * V3.3b Stage E：memory curate 入口。沿用 Studio thread 权限：
 * - owner：requireThreadForUser（foreign → 404，不泄露存在性）。
 * - admin（thread.read.all）：getThreadById（不存在 → 404）。
 * 可见记忆：user scope（本人）+ thread scope（当前 thread）+ project scope（thread.projectId 关联时）。
 * 含 provenance/confidence/status/expiresAt，供面板展示来源与治理。
 *
 * P0 修复：thread.projectId 非空时增加 project scope 记忆检索。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasPermission(r.user.id, "thread.read.all");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.user.id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  // P0：thread.projectId 非空时并行拉取 project scope 记忆
  const listTasks: Array<Promise<Awaited<ReturnType<typeof listMemories>>>> = [
    listMemories({ scope: "user", scopeRef: r.user.id }),
    listMemories({ scope: "thread", scopeRef: id }),
  ];
  if (thread.projectId) {
    listTasks.push(listMemories({ scope: "project", scopeRef: thread.projectId }));
  }
  const lists = await Promise.all(listTasks);
  // S1（06-P2-8）：分页。按 updatedAt desc 排序后切片，?limit（默认 50，上限 200）+ ?cursor（offset）。
  const allMemories = lists
    .flat()
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map((m) => ({
      id: m.id,
      scope: m.scope,
      scopeRef: m.scopeRef,
      kind: m.kind,
      text: m.text,
      confidence: m.confidence,
      status: m.status,
      expiresAt: m.expiresAt,
      provenance: m.provenance,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") ?? "50"), 1), 200);
  const cursor = Math.max(Number(req.nextUrl.searchParams.get("cursor") ?? "0"), 0);
  const page = allMemories.slice(cursor, cursor + limit);
  return jsonOk({
    threadId: id,
    memories: page,
    total: allMemories.length,
    cursor,
    limit,
    nextCursor: cursor + page.length < allMemories.length ? cursor + page.length : null,
  });
}
