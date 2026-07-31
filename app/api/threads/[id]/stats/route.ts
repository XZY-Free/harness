import { getCurrentUserFromRequest } from "@/lib/auth";
import { getThreadByIdForUser } from "@/lib/db/queries";
import { jsonError } from "@/lib/http";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

/**
 * 获取指定会话的 token 用量统计（轻量，run 完成后前端刷新用）。
 * GET /api/threads/[id]/stats
 * E-7: 从 Thread 冗余累加列读，免 SUM 事件流。软删/无权访问返 404。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUserFromRequest(request);
    const { id: threadId } = await params;
    const thread = await getThreadByIdForUser(threadId, user.id);
    if (!thread) {
      return NextResponse.json({ error: "会话不存在或无权访问" }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      tokenStats: {
        promptTokens: thread.promptTokens ?? 0,
        completionTokens: thread.completionTokens ?? 0,
        totalTokens: thread.totalTokens ?? 0,
      },
    });
  } catch (err) {
    // P1-25: 不回显 err.message(可能含 SQL/路径/连接串),完整错误落 logger
    logger.error("[/api/threads/[id]/stats] 内部错误", { error: String(err) });
    return jsonError(500, "internal_error", "服务器内部错误");
  }
}
