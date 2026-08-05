import { clearStoredThreadDraft } from "@/components/hooks/use-thread-draft";
import { DesktopSidebar } from "@/components/v11/sidebar/desktop-sidebar";
import { SidebarProvider } from "@/components/v11/sidebar/sidebar-context";
import { NewThreadPage, type NewThreadSubmission } from "@/components/v11/v11-new-thread-page";
import { ThreadPage } from "@/components/v11/v11-thread-page";
import { apiFetch } from "@/lib/api-fetch";
import { getDesktopCapabilities } from "@/lib/desktop/capabilities";
import { fallbackTitleFromUserText } from "@/lib/thread-title";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { parseDesktopRoute } from "../desktop-route";
import { navigateDesktop, usePathname } from "../next-navigation";

interface DesktopThreadSummary {
  readonly id: string;
  readonly title: string | null;
  readonly primary_agent_id: string;
}

interface DesktopAgentSummary {
  readonly id: string;
  readonly agent_key: string;
  readonly display_name: string;
}

interface DesktopShellResponse {
  readonly viewer_id: string;
  readonly threads: readonly DesktopThreadSummary[];
  readonly agents: readonly DesktopAgentSummary[];
}

interface PendingNewThread {
  readonly thread: DesktopThreadSummary;
  readonly turnIdempotencyKey: string;
}

function createIdempotencyKey(): string {
  return crypto.randomUUID();
}

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
  const [shell, setShell] = useState<DesktopShellResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newThreadError, setNewThreadError] = useState<string | null>(null);
  const pendingNewThread = useRef<PendingNewThread | null>(null);

  useEffect(() => {
    let active = true;
    void apiFetch("/api/v1/threads", { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取会话列表");
        return (await response.json()) as DesktopShellResponse;
      })
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
  }: NewThreadSubmission): Promise<boolean> => {
    setNewThreadError(null);
    try {
      let pending = pendingNewThread.current;
      if (!pending) {
        const title = fallbackTitleFromUserText(text) || "新会话";
        const response = await apiFetch("/api/v1/threads", {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "idempotency-key": createIdempotencyKey(),
          },
          body: JSON.stringify({ agent_id: agentId, title }),
        });
        if (!response.ok) throw new Error("创建会话失败，请稍后重试。");
        const created = (await response.json()) as { id: string; title?: string | null };
        pending = {
          thread: {
            id: created.id,
            title: created.title ?? title,
            primary_agent_id: agentId,
          },
          turnIdempotencyKey: createIdempotencyKey(),
        };
        pendingNewThread.current = pending;
      }

      const turnResponse = await apiFetch(`/api/v1/threads/${pending.thread.id}/turns`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "idempotency-key": pending.turnIdempotencyKey,
        },
        body: JSON.stringify({
          input: { type: "message", text },
          ...(modelRef ? { selected_model: modelRef } : {}),
        }),
      });
      if (!turnResponse.ok) throw new Error("消息发送失败，请稍后重试。");

      setShell((current) =>
        current
          ? {
              ...current,
              threads: [
                pending.thread,
                ...current.threads.filter((item) => item.id !== pending.thread.id),
              ],
            }
          : current,
      );
      pendingNewThread.current = null;
      clearStoredThreadDraft("new");
      navigateDesktop(`/desktop/chat/${pending.thread.id}`, true);
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
