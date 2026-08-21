import { getThreadById, requireThreadForUser } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { getMemory, revokeMemory, updateConfidence, updateMemoryText } from "@/lib/memory/store";
import { hasStudioAction, requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

/**
 * POST /studio/api/threads/[id]/memories/[memoryId]/resolve → revoke / update confidence / updateText。
 *
 * V3.3b Stage E：memory curate 写入。body: { action: "revoke"|"update"|"updateText", confidence?, text?, reason? }。
 * - owner/admin 可操作（foreign → 404，不泄露存在性）。
 * - memory 不存在 → 404。
 * - 已 revoked 再 revoke → 409。
 * revoke 是 soft delete（保留审计行）；update 只改 confidence；updateText 改 text 并 reindex embedding。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memoryId: string }> },
) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const { id, memoryId } = await params;

  const canAll = await hasStudioAction(r.principal, "thread.read");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.principal.userIdentityId);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  const body = (await req.json().catch(() => ({}))) as {
    action?: "revoke" | "update" | "updateText";
    confidence?: "low" | "medium" | "high";
    text?: string;
    reason?: string;
  };

  const mem = await getMemory(memoryId);
  if (!mem) return jsonError(404, "memory_not_found", "记忆不存在");

  // P1-4 IDOR 修复:校验 memory 归属当前 thread 上下文。
  // thread scope → scopeRef 必须 = 当前 thread;user scope → scopeRef 必须 = 当前用户;
  // project scope → scopeRef 必须 = 当前 thread.projectId;skill scope → 不经 thread 端点操作。
  // 与 list 路由可见范围严格对齐,防止用 thread A 归属操作 thread B / 他人 user 记忆。
  const allowed =
    (mem.scope === "thread" && mem.scopeRef === id) ||
    (mem.scope === "user" && mem.scopeRef === r.principal.userIdentityId) ||
    (mem.scope === "project" && thread.projectId != null && mem.scopeRef === thread.projectId);
  if (!allowed) {
    return jsonError(404, "memory_not_found", "记忆不存在或无权操作");
  }

  if (body.action === "revoke") {
    if (mem.status === "revoked") {
      return jsonError(409, "already_revoked", "记忆已撤销");
    }
    const updated = await revokeMemory(memoryId, { reason: body.reason, revokedBy: r.principal.userIdentityId });
    return jsonOk({ memory: updated });
  }

  if (body.action === "update") {
    if (!body.confidence) return jsonError(400, "bad_confidence", "缺少 confidence");
    const updated = await updateConfidence(memoryId, body.confidence);
    if (!updated) return jsonError(404, "memory_not_found", "记忆不存在");
    return jsonOk({ memory: updated });
  }

  // V6-M2-7：updateText — 修改记忆文本并 reindex embedding（保留 provenance 链）
  if (body.action === "updateText") {
    if (!body.text || body.text.trim().length === 0) {
      return jsonError(400, "bad_text", "缺少 text");
    }
    const result = await updateMemoryText(memoryId, body.text);
    if (!result.memory) return jsonError(404, "memory_not_found", "记忆不存在");
    return jsonOk({ memory: result.memory, semanticStatus: result.semanticStatus });
  }

  return jsonError(400, "bad_action", "action 必须是 revoke、update 或 updateText");
}
