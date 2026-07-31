import { getCurrentUserFromRequest } from "@/lib/auth";
import {
  getActiveThreadRun,
  getMessagesByThreadIdForUser,
  getThreadByIdForUser,
} from "@/lib/db/queries";
import { jsonError } from "@/lib/http";
import { logger } from "@/lib/logger";
import { getRunStatus } from "@/lib/runtime/thread-runner";
import { convertToUIMessages } from "@/lib/utils";
import { NextResponse } from "next/server";

/**
 * 获取指定会话的消息列表（按时间正序）
 * GET /api/threads/[id]/messages
 * C-10: 附带返回 thread.model，供前端切换会话时恢复模型选择器
 * A-5: 附带返回 thread.status + previewUrl，切到 ready_for_review 会话时恢复预览入口
 * V7 S3-1: 附带返回 activeRun（当前活跃 ThreadRun），供前端判断是否可重新订阅 SSE
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUserFromRequest(request);
    const { id: threadId } = await params;

    // 校验会话归属并获取消息
    const dbMessages = await getMessagesByThreadIdForUser(threadId, user.id);
    if (dbMessages === null) {
      return NextResponse.json({ error: "会话不存在或无权访问" }, { status: 404 });
    }

    // C-10 + A-5: 附带返回 thread 的 model / status / previewUrl
    const thread = await getThreadByIdForUser(threadId, user.id);

    // 转换为 AI SDK UIMessage 格式（只保留 id, role, parts）
    const messages = convertToUIMessages(dbMessages);

    // V7 S3-1：查询活跃 ThreadRun（DB 事实源 + 内存 liveRuns 交叉判断 canSubscribe）
    const dbActiveRun = await getActiveThreadRun(threadId);
    let activeRun: {
      id: string;
      status: string;
      startedAt: string | null;
      lastSeenAt: string | null;
      canSubscribe: boolean;
    } | null = null;

    if (dbActiveRun) {
      const memStatus = getRunStatus(dbActiveRun.id);
      activeRun = {
        id: dbActiveRun.id,
        // DB 状态为准（内存可能尚未同步或已失联）
        status: dbActiveRun.status,
        startedAt: dbActiveRun.startedAt?.toISOString() ?? null,
        lastSeenAt: dbActiveRun.lastSeenAt?.toISOString() ?? null,
        // canSubscribe：DB 活跃 + 内存也在 = 可直接 SSE 订阅
        canSubscribe: memStatus !== null,
      };
    }

    return NextResponse.json({
      ok: true,
      data: messages,
      model: thread?.model ?? null,
      status: thread?.status ?? null,
      previewUrl: thread?.previewUrl ?? null,
      // E-7: token 用量（从 Thread 冗余累加列读，header 展示免 SUM 事件流）
      tokenStats: {
        promptTokens: thread?.promptTokens ?? 0,
        completionTokens: thread?.completionTokens ?? 0,
        totalTokens: thread?.totalTokens ?? 0,
      },
      // V7 S3-1: 活跃 run 信息（null 表示无活跃执行）
      activeRun,
    });
  } catch (err) {
    // P1-25: 不回显 err.message,完整错误落 logger
    logger.error("[/api/threads/[id]/messages] 内部错误", { error: String(err) });
    return jsonError(500, "internal_error", "服务器内部错误");
  }
}
