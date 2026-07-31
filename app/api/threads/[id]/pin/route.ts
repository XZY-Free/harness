import { getCurrentUserFromRequest } from "@/lib/auth";
import { getThreadByIdForUser, togglePinThread } from "@/lib/db/queries";
import { NextResponse } from "next/server";

/**
 * E-5: 切换会话置顶状态。
 * PUT /api/threads/[id]/pin → toggle（有 pinnedAt 清除，无则设置）
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUserFromRequest(request);
    const { id: threadId } = await params;
    const thread = await getThreadByIdForUser(threadId, user.id);
    if (!thread) {
      return NextResponse.json({ error: "会话不存在或无权访问" }, { status: 404 });
    }
    const pinned = await togglePinThread(threadId);
    return NextResponse.json({ ok: true, data: { id: threadId, pinned } });
  } catch (err) {
    // P2-3:不回显 err.message,防泄露 DB/路径信息。
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}
