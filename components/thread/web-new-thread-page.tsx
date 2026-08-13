"use client";

import { clearStoredThreadDraft } from "@/components/hooks/use-thread-draft";
import { createNewThreadSession, loadThreadShell } from "@/lib/client/new-thread-session";
import type { ClientThreadShellResponse } from "@/lib/client/types";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NewThreadPage } from "./new-thread-page";

export function WebNewThreadPage() {
  const router = useRouter();
  const session = useRef(createNewThreadSession()).current;
  const [shell, setShell] = useState<ClientThreadShellResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadThreadShell()
      .then((result) => {
        if (active) setShell(result);
      })
      .catch((loadError) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "无法读取可用助手。");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (!shell && !error) {
    return (
      <output aria-label="会话创建页加载中" className="flex h-screen items-center justify-center">
        <span className="text-sm text-muted-foreground">正在加载可用助手…</span>
      </output>
    );
  }

  const agents =
    shell?.agents.map((agent) => ({
      id: agent.id,
      agentKey: agent.agent_key,
      displayName: agent.display_name,
    })) ?? [];
  if (agents.length === 0) {
    return (
      <main className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        {error ?? "当前没有可用助手，无法创建会话。"}
      </main>
    );
  }

  return (
    <NewThreadPage
      agents={agents}
      defaultAgentId={
        agents.find((agent) => agent.agentKey === "default")?.id ?? agents[0]?.id ?? ""
      }
      error={error}
      onSubmit={async (submission) => {
        setError(null);
        try {
          const thread = await session.submit(submission);
          clearStoredThreadDraft("new");
          router.replace(`/chat/${thread.id}`);
          return true;
        } catch (submitError) {
          setError(submitError instanceof Error ? submitError.message : "发送失败，请稍后重试。");
          return false;
        }
      }}
    />
  );
}
