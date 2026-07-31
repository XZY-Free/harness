import { getCurrentUserFromRequest } from "@/lib/auth";
import { getRunDetail } from "@/lib/db/queries";
import { jsonError } from "@/lib/http";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

/**
 * V7 S4-1：获取单次 run 的完整证据链
 * GET /api/threads/[id]/runs/[runId]
 *
 * 返回：
 * - run: ThreadRun 详情
 * - messages: 本轮产生的消息
 * - events: 本轮事件
 * - toolRuns: 本轮工具调用
 * - contextSnapshots: 本轮上下文快照
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  try {
    const user = await getCurrentUserFromRequest(request);
    const { id: threadId, runId } = await params;

    const detail = await getRunDetail(threadId, runId, user.id);
    if (!detail) {
      return NextResponse.json({ error: "运行不存在或无权访问" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      ...detail,
    });
  } catch (err) {
    // P1-25: 不回显 err.message,完整错误落 logger
    logger.error("[/api/threads/[id]/runs/[runId]] 内部错误", { error: String(err) });
    return jsonError(500, "internal_error", "服务器内部错误");
  }
}
