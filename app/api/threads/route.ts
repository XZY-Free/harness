import { listThreadsForUser, saveThread } from "@/lib/db/queries";
import { requireStudioAction, resolveStudioPrincipal } from "@/lib/identity/studio-access";
import { authErrorResponse } from "@/lib/identity/resolver";
import { isValidThreadId } from "@/lib/workspace";

export async function GET(request: Request) {
  try {
    const principal = await resolveStudioPrincipal(request.headers);
    // C-9: 游标分页（cursor=JSON {updatedAt,id}，limit+1 探测下一页）；E-2: search 后端模糊搜索
    const url = new URL(request.url);
    const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    const pageSize = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    const cursorRaw = url.searchParams.get("cursor");
    let before: { updatedAt: Date; id: string } | undefined;
    if (cursorRaw) {
      try {
        const parsed = JSON.parse(cursorRaw) as { updatedAt?: string; id?: string };
        if (parsed.updatedAt && parsed.id) {
          before = { updatedAt: new Date(parsed.updatedAt), id: parsed.id };
        }
      } catch {
        // 无效 cursor 忽略，返回首页（不静默吃游标，避免漏数据）
      }
    }
    const search = url.searchParams.get("search") ?? undefined;
    const rows = await listThreadsForUser(principal.userIdentityId, { limit: pageSize + 1, before, search });
    // C-9: limit+1 探测——多取 1 条判断有无下一页，避免满页边界多一次空点击
    const hasMore = rows.length > pageSize;
    const data = hasMore ? rows.slice(0, pageSize) : rows;
    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last
        ? JSON.stringify({ updatedAt: last.updatedAt.toISOString(), id: last.id })
        : null;
    return Response.json({ ok: true, data, nextCursor });
  } catch (error) {
    // P2-3:AuthError → 401 固定文案,其他 → 500 固定文案(不回显 err.message,防泄露 DB/路径信息)。
    const authErr = authErrorResponse(error);
    if (authErr) return authErr;
    return Response.json({ error: "服务器内部错误" }, { status: 500 });
  }
}

/**
 * C-6: 新建空会话（立即落库）。
 * title="新会话"，status="idle"，model 取请求体或 null。
 * 返回创建的 thread id。前端新建会话时调用，确保侧栏立即可见 + 刷新不丢。
 *
 * S1（07-P1-4）：RBAC 权限门——thread.write.self（member 拥有，可创建自己的 thread）。
 */
export async function POST(request: Request) {
  try {
    const r = await requireStudioAction(request, "thread.write", { type: "self" });
    if (!r.ok) return Response.json({ error: "无权限" }, { status: r.response.status });
    const principal = r.principal;
    const body = (await request.json().catch(() => ({}))) as {
      id?: string;
      title?: string;
      model?: string | null;
    };
    const threadId = body.id ?? crypto.randomUUID();
    if (!isValidThreadId(threadId)) {
      return Response.json({ error: "非法会话 ID" }, { status: 400 });
    }
    const title = body.title?.trim() || "新会话";
    await saveThread({ id: threadId, userId: principal.userIdentityId, title, model: body.model ?? null });
    return Response.json({ ok: true, data: { id: threadId, title, status: "idle" } });
  } catch (error) {
    return Response.json({ error: "服务器内部错误" }, { status: 500 });
  }
}
