import { AuthGate } from "@/components/auth/auth-gate";
import { WebThreadShell } from "@/components/thread/web-thread-shell";

// /chat 是 Web 产品的空 Thread 输入态入口：无 threadId，
// 由 WebThreadShell 承载首次输入并在提交后创建 Thread 资源。
// 不存在 /chat/new 路由；新建 Thread 由 POST /api/threads 表达。
// 登录门禁：AuthGate（客户端校验 /api/user/current，未登录跳 /login）。
export default function ChatComposerPage() {
  return (
    <AuthGate returnTo="/chat">
      <WebThreadShell threadId={null} />
    </AuthGate>
  );
}
