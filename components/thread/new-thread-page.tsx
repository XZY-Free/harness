"use client";

import type { ClientNewThreadSubmission } from "@/lib/client/types";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import type { AgentOption } from "./input/input-popovers";
import { useOptionalSidebar } from "./sidebar/sidebar-context";
import { ThreadInput } from "./thread-input";
import { ThreadTimeline } from "./thread-timeline";

interface NewThreadPageProps {
  readonly agents: readonly AgentOption[];
  readonly defaultAgentId: string;
  readonly error?: string | null;
  readonly onSubmit: (submission: ClientNewThreadSubmission) => Promise<boolean>;
}

export function NewThreadPage({ agents, defaultAgentId, error, onSubmit }: NewThreadPageProps) {
  const sidebar = useOptionalSidebar();
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [modelRef, setModelRef] = useState<string | null>(null);

  useEffect(() => {
    if (!agents.some((agent) => agent.id === agentId)) setAgentId(defaultAgentId);
  }, [agentId, agents, defaultAgentId]);

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "relative flex h-11 shrink-0 items-center border-b border-border bg-background transition-[padding] duration-200 ease-out",
          sidebar?.collapsed ? "pl-48 pr-4" : "px-4",
        )}
      >
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 right-0 [-webkit-app-region:drag]",
            sidebar?.collapsed ? "left-40" : "left-0",
          )}
        />
        <h1 className="relative truncate font-semibold text-sm text-foreground">新会话</h1>
      </div>
      {error && (
        <div
          role="alert"
          className="mx-auto mt-3 w-full max-w-[720px] px-8 text-destructive text-xs"
        >
          {error}
        </div>
      )}
      <ThreadTimeline items={[]} streamStatus="idle" />
      <ThreadInput
        threadId="new"
        draftKey="new"
        latestTurn={null}
        availableAgents={agents}
        currentAgentId={agentId}
        currentModelRef={modelRef}
        onAgentChange={setAgentId}
        onModelChange={setModelRef}
        onSubmitText={(text) => onSubmit({ text, agentId, modelRef })}
      />
    </div>
  );
}
