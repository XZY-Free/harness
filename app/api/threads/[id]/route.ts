import {
  getThreadById,
  getThreadByIdForUser,
  softDeleteThread,
  updateThreadModel,
  updateThreadTitle,
} from "@/lib/db/queries";
import { jsonError } from "@/lib/http";
import { logger } from "@/lib/logger";
import { hasStudioAction, requireStudioAction } from "@/lib/identity/studio-access";
import { NextResponse } from "next/server";

/**
 * C-2/C-3: 会话重命名（PATCH）+ 软删除（DELETE）。
 * C-10: PATCH 扩展支持 model 字段（模型切换即时持久化）。
 * 校验归属：foreign → 404，不泄露。
 *
 * S1（07-P1-4）：RBAC thread 级写权限门。
 * - thread.write.self：member 拥有，owner 自动满足（owner guard 保证归属）
 * - thread.write.all：admin 拥有，可改他人 thread（绕过 owner guard）
 * owner guard（getThreadByIdForUser）保留作数据可见性；RBAC 作权限门。
 * - 无 thread.write.self（未登录 / 无角色）→ 401/403
 * - 有 thread.write.self 但非 owner、又无 thread.write.all → owner guard 返回 404（不泄露存在性）
 */

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const r = await requireStudioAction(request, "thread.write", { type: "self" });
    if (!r.ok) return NextResponse.json({ error: "无权限" }, { status: r.response.status });
    const principal = r.principal;
    const { id: threadId } = await params;

    // admin(thread.write.all) 可改他人 thread → getThreadById 绕过 owner guard；
    // 其余走 owner guard（foreign → 404，不泄露存在性）。
    const canAll = await hasStudioAction(principal, "thread.write");
    const thread = canAll
      ? await getThreadById(threadId)
      : await getThreadByIdForUser(threadId, principal.userIdentityId);
    if (!thread) {
      return NextResponse.json({ error: "会话不存在或无权访问" }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as { title?: string; model?: string };

    if (body.title !== undefined) {
      const title = body.title.trim();
      if (!title) {
        return NextResponse.json({ error: "标题不能为空" }, { status: 400 });
      }
      if (title.length > 100) {
        return NextResponse.json({ error: "标题最长 100 字符" }, { status: 400 });
      }
      await updateThreadTitle(threadId, title);
    }

    // C-10: model 即时持久化（前端 handleModelChange 切换即 PATCH）
    if (body.model !== undefined) {
      await updateThreadModel(threadId, body.model);
    }

    if (body.title === undefined && body.model === undefined) {
      return NextResponse.json({ error: "无待更新字段" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, data: { id: threadId } });
  } catch (err) {
    // P1-25: 不回显 err.message,完整错误落 logger
    logger.error("[/api/threads/[id] PATCH] 内部错误", { error: String(err) });
    return jsonError(500, "internal_error", "服务器内部错误");
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const r = await requireStudioAction(request, "thread.write", { type: "self" });
    if (!r.ok) return NextResponse.json({ error: "无权限" }, { status: r.response.status });
    const principal = r.principal;
    const { id: threadId } = await params;

    const canAll = await hasStudioAction(principal, "thread.write");
    const thread = canAll
      ? await getThreadById(threadId)
      : await getThreadByIdForUser(threadId, principal.userIdentityId);
    if (!thread) {
      return NextResponse.json({ error: "会话不存在或无权访问" }, { status: 404 });
    }
    // 旧本地执行体系已移除，无进程内 run 可取消；正式执行走 Invocation/Binding 路径。
    // V10 Phase 2：V9 browserGateway.closeSession 调用已移除（服务端浏览器链路删除）。
    await softDeleteThread(threadId);
    return NextResponse.json({ ok: true, data: { id: threadId, deleted: true } });
  } catch (err) {
    logger.error("[/api/threads/[id] DELETE] 内部错误", { error: String(err) });
    return jsonError(500, "internal_error", "服务器内部错误");
  }
}
