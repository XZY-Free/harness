import { WebThreadShell } from "@/components/thread/web-thread-shell";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

// 专题01 §33.7：/chat/{threadId} 只接受真实会话 UUID；新建空态统一走 /chat
// （假 new 路由 /chat/new 已移除，threadId 恒为真实会话 id）。
export default async function ChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  if (!isValidUUID(threadId)) notFound();
  return <WebThreadShell threadId={threadId} />;
}

function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
