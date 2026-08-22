import { WebThreadShell } from "@/components/thread/web-thread-shell";

export const dynamic = "force-dynamic";

// 专题01 §33.7：Web 产品入口 /chat = 新建空态（无 threadId）。
// 假 new 路由 /chat/new 已移除；新建入口统一走 /chat。
export default function ChatNewPage() {
  return <WebThreadShell threadId={null} />;
}
