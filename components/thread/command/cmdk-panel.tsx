"use client";

import { Dialog, DialogContent, DialogOverlay } from "@/components/ui/dialog";
import { Command } from "cmdk";
import { FileSearch, FolderOpen, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

interface CmdkPanelProps {
  readonly threads: readonly {
    id: string;
    title: string | null;
    /** G 阶段已移除 Agent 绑定，字段保留为可选以兼容旧布局。 */
    primaryAgentId?: string;
  }[];
  readonly agents: readonly {
    id: string;
    agentKey: string;
    displayName: string;
  }[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly surface?: "web" | "desktop";
}

export function CmdkPanel({
  threads,
  agents,
  open,
  onOpenChange,
  surface = "desktop",
}: CmdkPanelProps) {
  const [query, setQuery] = useState("");
  const router = useRouter();

  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const filteredThreads = useMemo(() => {
    if (!query.trim()) return threads;
    const q = query.toLowerCase();
    return threads.filter((t) => (t.title ?? "新会话").toLowerCase().includes(q));
  }, [threads, query]);

  const hasQuery = query.trim().length > 0;

  const handleSelectThread = useCallback(
    (threadId: string) => {
      onOpenChange(false);
      router.push(surface === "desktop" ? `/desktop/chat/${threadId}` : `/chat/${threadId}`);
    },
    [onOpenChange, router, surface],
  );

  const handleNewThread = useCallback(() => {
    onOpenChange(false);
    router.push(surface === "desktop" ? "/desktop/new" : "/chat/new");
  }, [onOpenChange, router, surface]);

  // ⌘1~9 快捷键打开对应会话
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const index = Number.parseInt(e.key, 10) - 1;
        const thread = filteredThreads[index];
        if (thread) {
          handleSelectThread(thread.id);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, filteredThreads, handleSelectThread]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogOverlay className="bg-black/[0.22] backdrop-blur-[2px]" />
      <DialogContent className="max-w-[560px] overflow-hidden p-0" showCloseButton={false}>
        <Command className="bg-popover" shouldFilter={false}>
          <div className="border-b border-border px-4 py-3">
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="搜索会话"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Command.List className="max-h-[450px] overflow-y-auto p-2">
            {!hasQuery && (
              <Command.Group heading="推荐">
                <Command.Item
                  value="new-thread"
                  onSelect={() => handleNewThread()}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted data-[selected=true]:bg-muted"
                >
                  <Plus className="size-4 text-muted-foreground" />
                  <span>新建会话</span>
                  <span className="ml-auto text-xs tracking-widest text-muted-foreground">⌘N</span>
                </Command.Item>
                {surface === "desktop" && (
                  <>
                    <Command.Item
                      value="files"
                      onSelect={() => onOpenChange(false)}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted data-[selected=true]:bg-muted"
                    >
                      <FolderOpen className="size-4 text-muted-foreground" />
                      <span>文件和文件夹</span>
                      <span className="ml-auto text-xs tracking-widest text-muted-foreground">
                        ⌘O
                      </span>
                    </Command.Item>
                    <Command.Item
                      value="search-files"
                      onSelect={() => onOpenChange(false)}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted data-[selected=true]:bg-muted"
                    >
                      <FileSearch className="size-4 text-muted-foreground" />
                      <span>搜索文件</span>
                      <span className="ml-auto text-xs tracking-widest text-muted-foreground">
                        ⌘P
                      </span>
                    </Command.Item>
                  </>
                )}
              </Command.Group>
            )}
            <Command.Group heading="会话">
              {filteredThreads.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">没有匹配的会话</div>
              ) : (
                filteredThreads.slice(0, 9).map((thread, index) => {
                  const agent = agentMap.get(thread.primaryAgentId ?? "");
                  const agentName = agent?.displayName ?? agent?.agentKey ?? "助手";
                  return (
                    <Command.Item
                      key={thread.id}
                      value={thread.id}
                      onSelect={() => handleSelectThread(thread.id)}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted data-[selected=true]:bg-muted"
                    >
                      <span className="flex-1 truncate">{thread.title ?? "新会话"}</span>
                      <span className="text-xs text-muted-foreground">{agentName}</span>
                      <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        ⌘{index + 1}
                      </span>
                    </Command.Item>
                  );
                })
              )}
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
