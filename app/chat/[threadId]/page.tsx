import { randomUUID } from "node:crypto";
import { Workspace } from "@/components/workspace";
import { getCurrentUserFromRequest } from "@/lib/auth";
import { getMessagesByThreadId, getThreadByIdForUser } from "@/lib/db/queries";
import type { ThreadStatus } from "@/lib/db/schema";
import { convertToUIMessages } from "@/lib/utils";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

/**
 * B-7: 会话深链路由 /chat/[threadId]。
 *
 * - threadId 存在且属于当前用户 → 加载该会话
 * - threadId 存在但不属于当前用户 → 404（不泄露）
 * - threadId 不存在（新建候选）→ 仍渲染 Workspace（首条消息发送时落库）
 *
 * 这样刷新页面会停留在当前会话，浏览器前进后退可切换。
 * 根路径 / 仍跳转到最近会话（见 app/page.tsx）。
 */
export const dynamic = "force-dynamic";

export default async function ChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  const currentUser = await getCurrentUserFromRequest({ headers: await headers() });

  // 校验 thread 归属（foreign → 404，不泄露）
  const thread = await getThreadByIdForUser(threadId, currentUser.id);
  if (threadId !== thread?.id && thread === null) {
    // 如果是合法 UUID 但 DB 没有，视为新建候选（与 app/page.tsx 语义一致）
    // 只有明确属于别人或格式非法才 404
    if (!isValidUUID(threadId)) {
      notFound();
    }
  }

  const messages = thread ? await getMessagesByThreadId(thread.id) : [];

  return (
    <Workspace
      threadId={thread?.id ?? threadId}
      initialMessages={convertToUIMessages(messages)}
      initialStatus={(thread?.status ?? "idle") as ThreadStatus}
      initialModel={thread?.model ?? undefined}
      initialPreviewUrl={thread?.previewUrl ?? undefined}
      initialTitle={thread?.title ?? undefined}
    />
  );
}

function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
