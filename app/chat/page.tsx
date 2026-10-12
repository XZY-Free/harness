import { WebThreadShell } from "@/components/thread/web-thread-shell";
import { requireAuthenticatedPage } from "@/lib/identity/page-session";

export const dynamic = "force-dynamic";

// /chat 是 Web 产品的空 Thread 输入态入口：无 threadId，
// 由 WebThreadShell 承载首次输入并在提交后创建 Thread 资源。
// 不存在 /chat/new 路由；新建 Thread 由 POST /api/threads 表达。
export default async function ChatComposerPage() {
  await requireAuthenticatedPage("/chat");
  return <WebThreadShell threadId={null} />;
}
