import { randomUUID } from "node:crypto";
import { getCurrentUserFromRequest } from "@/lib/auth";
import { getLatestThreadForUser } from "@/lib/db/queries";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * B-7: 根路径 / 重定向到 /chat/[threadId]。
 *
 * 取该用户最近 thread；无历史时生成候选 id（首条消息发送时落库）。
 * 这样浏览器地址栏始终有当前会话 URL，刷新停留在当前会话。
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const currentUser = await getCurrentUserFromRequest({ headers: await headers() });
  const thread = await getLatestThreadForUser(currentUser.id);
  const threadId = thread?.id ?? randomUUID();
  redirect(`/chat/${threadId}`);
}
