import { clearStoredThreadDraft } from "@/components/hooks/use-thread-draft";
import { NewThreadPage } from "@/components/thread/new-thread-page";
import { DesktopSidebar } from "@/components/thread/sidebar/desktop-sidebar";
import { SidebarProvider } from "@/components/thread/sidebar/sidebar-context";
import { ThreadPage } from "@/components/thread/thread-page";
import { createNewThreadSession, loadThreadShell } from "@/lib/client/new-thread-session";
import type { ClientNewThreadSubmission, ClientThreadShellResponse } from "@/lib/client/types";
import { getDesktopBridge, getDesktopCapabilities } from "@/lib/desktop/capabilities";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { parseDesktopRoute } from "../desktop-route";
import { navigateDesktop, usePathname } from "../next-navigation";

function DesktopError({ children }: { readonly children: ReactNode }) {
  return (
    <main className="flex h-screen items-center justify-center text-sm text-muted-foreground">
      {children}
    </main>
  );
}

function DesktopShell() {
  const pathname = usePathname();
  const route = parseDesktopRoute(pathname);
  const [shell, setShell] = useState<ClientThreadShellResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newThreadError, setNewThreadError] = useState<string | null>(null);
  const newThreadSession = useRef(createNewThreadSession()).current;

  useEffect(() => {
    let active = true;
    void loadThreadShell()
      .then((data) => {
        if (active) setShell(data);
      })
      .catch(() => {
        if (active) setError("无法连接服务器，请检查网络后重试。");
      });
    return () => {
      active = false;
    };
  }, []);

  // /desktop 恒为新建空态页，不自动跳转最近会话；
  // 假 new 路由 /desktop/new 已移除。进入已有会话由 sidebar 导航到 /desktop/chat/{id}。

  // 设备注册闭环：shell 真实加载成功后发起注册（幂等，无视觉噪音）。
  // main 用本机 Session fetch 同源注册端点；已注册则复用现有租户并确保 Bridge 连接。
  // 注册失败静默保持 disconnected，不打扰用户，后续可重试。
  useEffect(() => {
    if (!shell) return;
    const bridge = getDesktopBridge();
    if (!bridge) return;
    let active = true;
    void (async () => {
      const result = await bridge.device.register();
      if (!active) return;
      if (result.ok) {
        void bridge.bridge.connect();
      }
    })();
    return () => {
      active = false;
    };
  }, [shell]);

  const submitNewThread = async ({
    text,
    agentId,
    modelRef,
  }: ClientNewThreadSubmission): Promise<boolean> => {
    setNewThreadError(null);
    try {
      const thread = await newThreadSession.submit({ text, agentId, modelRef });

      setShell((current) =>
        current
          ? {
              ...current,
              threads: [thread, ...current.threads.filter((item) => item.id !== thread.id)],
            }
          : current,
      );
      clearStoredThreadDraft("new-thread");
      navigateDesktop(`/desktop/chat/${thread.id}`, true);
      return true;
    } catch (submitError) {
      setNewThreadError(
        submitError instanceof Error ? submitError.message : "发送失败，请稍后重试。",
      );
      return false;
    }
  };

  if (error) return <DesktopError>{error}</DesktopError>;
  if (!shell) return <DesktopError>正在连接服务器…</DesktopError>;
  if (route.kind === "not-found") return <DesktopError>页面不存在。</DesktopError>;
  // /desktop（home）恒为新建空态页，fall through 渲染 NewThreadPage。

  const threads = shell.threads.map((thread) => ({
    id: thread.id,
    title: thread.title,
  }));
  // Agent 目录为空是合法状态；无 Agent 时不阻断会话创建，也不 fallback 第一个 Agent。
  return (
    <SidebarProvider>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <DesktopSidebar
          threads={threads}
          agents={[]}
          currentThreadId={route.kind === "thread" ? route.threadId : ""}
          userName={shell.viewer_id.slice(0, 8)}
          hasNativeTitlebar
        />
        <main className="flex min-w-0 flex-1 flex-col">
          {route.kind === "home" ? (
            <NewThreadPage
              defaultModelRef={shell.default_model_ref}
              error={newThreadError}
              onSubmit={submitNewThread}
            />
          ) : (
            <ThreadPage
              key={route.threadId}
              threadId={route.threadId}
              variant="desktop"
              viewerId={shell.viewer_id}
              defaultModelRef={shell.default_model_ref}
            />
          )}
        </main>
      </div>
    </SidebarProvider>
  );
}

export function DesktopRendererApp() {
  return getDesktopCapabilities() ? (
    <DesktopShell />
  ) : (
    <DesktopError>需要 SnowHarness Desktop。</DesktopError>
  );
}
