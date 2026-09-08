"use client";

import type { ClientNewThreadSubmission } from "@/lib/client/types";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useState } from "react";
import { DesktopWorkbench, WorkbenchToggle } from "../desktop/desktop-workbench";
import type { AgentOption } from "./input/input-popovers";
import { useOptionalSidebar } from "./sidebar/sidebar-context";
import { ThreadInput } from "./thread-input";
import { ThreadTimeline } from "./thread-timeline";

interface NewThreadPageProps {
  /** Agent 目录；缺省时 Selector 自行拉取同一 Employee Catalog（09 §12）。 */
  readonly agents?: readonly AgentOption[];
  /** 平台默认模型（shell.default_model_ref）；用于未显式选择时的即时展示。 */
  readonly defaultModelRef?: string;
  readonly error?: string | null;
  readonly onSubmit: (submission: ClientNewThreadSubmission) => Promise<boolean>;
  readonly surface?: "web" | "desktop";
  readonly viewerId?: string;
  readonly workbenchOpen?: boolean;
  readonly onWorkbenchOpenChange?: (open: boolean) => void;
}

export function NewThreadPage({
  agents,
  defaultModelRef,
  error,
  onSubmit,
  surface = "desktop",
  viewerId,
  workbenchOpen: controlledWorkbenchOpen,
  onWorkbenchOpenChange,
}: NewThreadPageProps) {
  const sidebar = useOptionalSidebar();
  const [agentId, setAgentId] = useState<string | null>(null);
  const [modelRef, setModelRef] = useState<string | null>(null);
  const [localWorkbenchOpen, setLocalWorkbenchOpen] = useState(false);
  const workbenchOpen = controlledWorkbenchOpen ?? localWorkbenchOpen;

  const setWorkbenchOpen = useCallback(
    (open: boolean) => {
      if (controlledWorkbenchOpen === undefined) setLocalWorkbenchOpen(open);
      onWorkbenchOpenChange?.(open);
    },
    [controlledWorkbenchOpen, onWorkbenchOpenChange],
  );

  useEffect(() => {
    if (agentId && agents && !agents.some((agent) => agent.id === agentId)) setAgentId(null);
  }, [agentId, agents]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        className={cn(
          "relative flex h-12 shrink-0 items-center border-b border-border bg-background transition-[padding] duration-200 ease-out",
          sidebar?.collapsed ? (surface === "desktop" ? "pl-48 pr-4" : "pl-32 pr-4") : "px-4",
        )}
      >
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 right-0 [-webkit-app-region:drag]",
            sidebar?.collapsed && surface === "desktop" ? "left-40" : "left-0",
          )}
        />
        <h1 className="relative truncate font-semibold text-sm text-foreground">新会话</h1>
        <WorkbenchToggle open={workbenchOpen} onOpenChange={setWorkbenchOpen} />
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {error && (
            <div className="composer-track">
              <div role="alert" className="mt-3 text-destructive text-xs">
                {error}
              </div>
            </div>
          )}
          <ThreadTimeline items={[]} streamStatus="idle" />
          <ThreadInput
            threadId={null}
            draftKey="new-thread"
            latestTurn={null}
            availableAgents={agents}
            currentAgentId={agentId}
            currentModelRef={modelRef}
            defaultModelRef={defaultModelRef}
            onAgentChange={setAgentId}
            onModelChange={setModelRef}
            onSubmitText={(text) => onSubmit({ text, modelRef, agentId })}
          />
        </div>
        <DesktopWorkbench
          threadId={null}
          isOpen={workbenchOpen}
          surface={surface}
          viewerId={viewerId}
          activeGoal={null}
          latestTurn={null}
          items={[]}
          onLocateItem={() => {}}
        />
      </div>
    </div>
  );
}
