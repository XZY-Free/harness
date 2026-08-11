import { DesktopSidebar } from "@/components/desktop/sidebar/desktop-sidebar";
import { SidebarProvider } from "@/components/desktop/sidebar/sidebar-context";
import { clearStoredThreadDraft } from "@/components/hooks/use-thread-draft";
import { NewThreadPage } from "@/components/thread/v11-new-thread-page";
import { ThreadPage } from "@/components/thread/v11-thread-page";
import { createNewThreadSession, loadThreadShell } from "@/lib/client/new-thread-session";
import type {
  ClientNewThreadSubmission,
  ClientThreadShellResponse,
} from "@/lib/client/types";
import { getDesktopCapabilities } from "@/lib/desktop/capabilities";
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

  useEffect(() => {
    if (!shell || route.kind !== "home") return;
    const latest = shell.threads[0];
    navigateDesktop(latest ? `/desktop/chat/${latest.id}` : "/desktop/new", true);
  }, [route, shell]);

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
              threads: [
                thread,
                ...current.threads.filter((item) => item.id !== thread.id),
              ],
            }
          : current,
      );
      clearStoredThreadDraft("new");
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
  if (route.kind === "home") {
    return <DesktopError>正在打开会话…</DesktopError>;
  }

  const threads = shell.threads.map((thread) => ({
    id: thread.id,
    title: thread.title,
    primaryAgentId: thread.primary_agent_id,
  }));
  const agents = shell.agents.map((agent) => ({
    id: agent.id,
    agentKey: agent.agent_key,
    displayName: agent.display_name,
  }));
  if (agents.length === 0) return <DesktopError>当前没有可用助手，无法创建会话。</DesktopError>;
  return (
    <SidebarProvider>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <DesktopSidebar
          threads={threads}
          agents={agents}
          currentThreadId={route.kind === "chat" ? route.threadId : ""}
          userName={shell.viewer_id.slice(0, 8)}
          hasNativeTitlebar
        />
        <main className="flex min-w-0 flex-1 flex-col">
          {route.kind === "new" ? (
            <NewThreadPage
              agents={agents}
              defaultAgentId={
                agents.find((agent) => agent.agentKey === "default")?.id ?? agents[0]?.id ?? ""
              }
              error={newThreadError}
              onSubmit={submitNewThread}
            />
          ) : (
            <ThreadPage
              key={route.threadId}
              threadId={route.threadId}
              variant="desktop"
              viewerId={shell.viewer_id}
              availableAgents={agents}
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
