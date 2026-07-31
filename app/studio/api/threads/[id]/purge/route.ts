import { deleteThreadRecursive, getThreadByIdIncludingDeleted } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { logger } from "@/lib/logger";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import type { NextRequest } from "next/server";

/**
 * S1（08-P1-2）：admin 彻底删除 thread(物理删主记录 + 全部子表)。
 *
 * 与 DELETE /api/threads/[id](软删,标记 deletedAt)不同——本路由调 deleteThreadRecursive
 * 事务化物理删除,不可恢复,仅 thread.write.all(admin)可调。
 *
 * 破坏性操作,需二次确认:body.confirm === true 才执行(对齐 07-P2-7 二次确认模式)。
 * 审计落 thread.purged(含 threadId/title 等摘要,不含消息内容)。
 *
 * 入口接通后,deleteThreadRecursive 从死代码变为可达;
 * retention 的物理删主记录阈值(hardDeleteRetentionDays,默认关)是另一条自动化入口。
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const r = await requirePermission(req, "thread.write.self");
    if (!r.ok) return r.response;
    const actorUserId = r.user.id;

    // 仅 admin(thread.write.all)可彻底删除——物理删除不可恢复,不向普通 member 开放
    const canAll = await hasPermission(actorUserId, "thread.write.all");
    if (!canAll) return jsonError(403, "forbidden", "彻底删除需要管理员权限");

    const { id: threadId } = await params;
    const target = await getThreadByIdIncludingDeleted(threadId);
    if (!target) return jsonError(404, "thread_not_found", "会话不存在");

    // 二次确认:body.confirm === true 才执行(防误触破坏性操作)
    const body = (await req.json().catch(() => ({}))) as { confirm?: boolean };
    if (body.confirm !== true) {
      return jsonError(400, "confirm_required", "彻底删除不可恢复,需传 confirm: true 二次确认");
    }

    const title = target.title ?? null;
    await deleteThreadRecursive(threadId);

    try {
      await recordAdminAudit({
        actorUserId,
        action: "thread.purged",
        targetType: "thread",
        targetId: threadId,
        outcome: "succeeded",
        metadata: { title, status: target.status },
      });
    } catch (auditError) {
      // 物理删除已生效,审计写失败不回滚——只记日志(数据已删,审计是事后追溯)
      logger.warn("thread purge 审计写入失败(数据已删除)", {
        threadId,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
    return jsonOk({ id: threadId, purged: true });
  } catch (err) {
    // P2-3:不回显 err.message,防泄露内部信息。
    return jsonError(500, "purge_failed", "彻底删除失败");
  }
}
