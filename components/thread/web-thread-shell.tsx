"use client";

import { clearStoredThreadDraft } from "@/components/hooks/use-thread-draft";
import type { AgentOption } from "@/components/thread/input/input-popovers";
import { NewThreadPage } from "@/components/thread/new-thread-page";
import { DesktopSidebar } from "@/components/thread/sidebar/desktop-sidebar";
import { SidebarProvider } from "@/components/thread/sidebar/sidebar-context";
import { ThreadPage } from "@/components/thread/thread-page";
import { createNewThreadSession, loadThreadShell } from "@/lib/client/new-thread-session";
import type { ClientNewThreadSubmission, ClientThreadShellResponse } from "@/lib/client/types";
import { useEffect, useRef, useState } from "react";

export function WebThreadShell({ threadId }: { readonly threadId: string | null }) {
  const session = useRef(createNewThreadSession()).current;
  const [shell, setShell] = useState<ClientThreadShellResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 内部持有的当前 Thread id：新建页提交成功后原地切到 ThreadPage，
  // 避免经 App Router 导航卸载/重挂 shell（否则再次进入 shell loading 控件闪没）。
  const [activeThreadId, setActiveThreadId] = useState<string | null>(threadId);

  // prop threadId（App Router 真实导航 / 浏览器前进后退）变化时同步内部状态。
  useEffect(() => {
    setActiveThreadId(threadId);
  }, [threadId]);

  useEffect(() => {
    let active = true;
    void loadThreadShell()
      .then((result) => {
        if (active) setShell(result);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "无法读取会话列表。");
      });
    return () => {
      active = false;
    };
  }, []);

  if (!shell && !error) {
    return (
      <output aria-label="会话页面加载中" className="flex h-dvh items-center justify-center">
        <span className="text-sm text-muted-foreground">正在加载会话…</span>
      </output>
    );
  }
  if (!shell) {
    return (
      <main className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
        {error}
      </main>
    );
  }

  const threads = shell.threads.map((thread) => ({
    id: thread.id,
    title: thread.title,
  }));
  // : 线程不再绑定 Agent（G 阶段移除），shell 不再返回 agents。
  const agents: AgentOption[] = [];

  const submitNewThread = async (submission: ClientNewThreadSubmission): Promise<boolean> => {
    setError(null);
    try {
      const created = await session.submit(submission);
      setShell((current) =>
        current
          ? {
              ...current,
              threads: [created, ...current.threads.filter((item) => item.id !== created.id)],
            }
          : current,
      );
      clearStoredThreadDraft("new");
      // 用原生 history.replaceState 更新地址，不触发会卸载 shell 的 App Router 导航；
      // activeThreadId 原地切换到新 Thread，同一组件树直接渲染 ThreadPage。
      window.history.replaceState(null, "", `/chat/${created.id}`);
      setActiveThreadId(created.id);
      return true;
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "发送失败，请稍后重试。");
      return false;
    }
  };

  return (
    <SidebarProvider>
      <div className="flex h-dvh overflow-hidden bg-background text-foreground">
        <DesktopSidebar threads={threads} currentThreadId={activeThreadId ?? ""} surface="web" />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {activeThreadId === null ? (
            <NewThreadPage
              agents={agents}
              defaultAgentId=""
              defaultModelRef={shell.default_model_ref}
              error={error}
              onSubmit={submitNewThread}
              surface="web"
            />
          ) : (
            <ThreadPage
              key={activeThreadId}
              threadId={activeThreadId}
              defaultModelRef={shell.default_model_ref}
            />
          )}
        </main>
      </div>
    </SidebarProvider>
  );
}
