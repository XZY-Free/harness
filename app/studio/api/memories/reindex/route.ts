import { jsonError, jsonOk } from "@/lib/http";
import { resolveEmbeddingProvider } from "@/lib/memory/embedding";
import { reindexMemories } from "@/lib/memory/index";
import { requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * P1 修复（06 Memory P1-1）：POST /studio/api/memories/reindex
 *
 * 批量重建 embedding（provider 模型升级 / disabled→enabled 切换后,旧记忆无 embedding）。
 * 原 reindexMemories 函数无任何调用方（零匹配）,现暴露 Studio API。
 *
 * 权限：policy.write（admin 级操作,member 无权触发全量 reindex）。
 * 同步小批量执行（reindexMemories 内部逐个 indexMemory）,大记忆库会慢但可靠。
 * 后续可改后台任务异步执行（对齐 background-task-registry 模式）。
 */
export async function POST(req: NextRequest) {
  const r = await requirePermission(req, "policy.write");
  if (!r.ok) return r.response;

  let body: { scope?: string; scopeRef?: string; status?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // 空 body = reindex 全部 scope（reindexMemories 默认行为）
  }

  try {
    const provider = resolveEmbeddingProvider();
    const summary = await reindexMemories({
      scope: body.scope as never,
      scopeRef: body.scopeRef ?? null,
      status: (body.status as "stale" | "error" | "all") ?? "stale",
      provider,
    });
    return jsonOk({
      summary,
      provider: provider.name,
      status: provider.isReady() ? "ready" : "disabled",
    });
  } catch (error) {
    // P2-3:不回显 err.message,防泄露内部信息。
    return jsonError(500, "reindex_failed", "记忆重建失败");
  }
}
