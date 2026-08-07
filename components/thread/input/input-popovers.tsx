"use client";

import { useAvailableModels } from "@/components/hooks/use-available-models";
import { useV11Catalog } from "@/components/hooks/use-catalog";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  Bot,
  Box,
  Check,
  ChevronDown,
  Database,
  FilePlus,
  Plus,
  Search,
  Target,
  Wrench,
  Zap,
} from "lucide-react";
import { useState } from "react";

/* ─── ＋ 菜单 ─── */

export function PlusMenuPopover({ threadId }: { readonly threadId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger aria-label="添加">
        <span className="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-full border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground">
          <Plus className="size-4" />
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-[272px] p-2" align="start" side="top" sideOffset={8}>
        <div className="space-y-0.5">
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">添加</div>
          <PlusMenuItem
            icon={<FilePlus className="size-4" />}
            label="文件和文件夹"
            shortcut="⌘O"
            onClick={() => {
              /* W3-5 后接入文件选择 */
              setOpen(false);
            }}
          />
          <PlusMenuItem
            icon={<Target className="size-4 text-warning" />}
            label="目标"
            subtitle="设置要持续追求的目标"
            onClick={() => {
              /* W3-5 后接入 Goal */
              setOpen(false);
            }}
          />

          <div className="my-1 h-px bg-border" />

          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">能力</div>
          <PlusMenuItem
            icon={<Wrench className="size-4 text-purple-500" />}
            label="技能"
            subtitle="调用已授权技能"
            onClick={() => {
              setOpen(false);
            }}
          />
          <PlusMenuItem
            icon={<Zap className="size-4 text-blue-500" />}
            label="工具"
            subtitle="使用外部工具"
            onClick={() => {
              setOpen(false);
            }}
          />
          <PlusMenuItem
            icon={<Database className="size-4 text-green-500" />}
            label="知识库"
            subtitle="引用知识库内容"
            onClick={() => {
              setOpen(false);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PlusMenuItem({
  icon,
  label,
  subtitle,
  shortcut,
  onClick,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly subtitle?: string;
  readonly shortcut?: string;
  readonly onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-muted"
    >
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{label}</div>
        {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {shortcut && <span className="text-xs text-muted-foreground">{shortcut}</span>}
    </button>
  );
}

function SelectorPopoverHeader({
  title,
  query,
  onQueryChange,
}: {
  readonly title: "助手" | "模型";
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}) {
  return (
    <div className="px-2.5 pt-2.5">
      <div className="flex h-10 items-center gap-2.5 rounded-[12px] bg-muted/55 px-3 shadow-[inset_0_1px_2px_rgba(15,23,42,0.045),inset_0_0_0_1px_rgba(15,23,42,0.055),0_1px_0_rgba(255,255,255,0.8)] transition-[background-color,box-shadow] duration-150 ease-out focus-within:bg-muted/65 focus-within:shadow-[inset_0_0_0_1px_rgba(15,23,42,0.10),0_0_0_3px_rgba(15,23,42,0.025),0_1px_0_rgba(255,255,255,0.85)]">
        <Search
          className="size-[15px] shrink-0 stroke-[1.7] text-muted-foreground/90"
          aria-hidden="true"
        />
        <input
          // biome-ignore lint/a11y/noAutofocus: 选择器打开后应直接进入搜索
          autoFocus
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          aria-label={`搜索${title}`}
          placeholder={`搜索${title}…`}
          className="min-w-0 flex-1 bg-transparent text-[13px] leading-none text-foreground outline-none placeholder:text-muted-foreground/80"
        />
      </div>
      <PopoverTitle className="px-1.5 pb-1.5 pt-3 text-[11px] font-semibold tracking-[0.055em] text-muted-foreground">
        {title}
      </PopoverTitle>
    </div>
  );
}

function SelectorMessage({
  children,
  destructive = false,
}: {
  readonly children: React.ReactNode;
  readonly destructive?: boolean;
}) {
  return (
    <div
      className={cn(
        "mx-1 mb-1 rounded-[12px] bg-muted/30 px-3 py-8 text-center text-xs ring-1 ring-inset ring-foreground/[0.035]",
        destructive ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

function TriggerPill({
  children,
  marker,
}: {
  readonly children: React.ReactNode;
  readonly marker?: string;
}) {
  return (
    <span
      data-variant={marker}
      className={cn(
        "inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full border border-foreground/[0.055] bg-foreground/[0.018] px-2.5 text-[13px] text-muted-foreground shadow-none outline-none transition-[background-color,border-color,transform,color] duration-150 ease-out",
        "group-focus-visible:ring-2 group-focus-visible:ring-foreground/10 group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background",
        "group-data-[popup-open]:border-foreground/[0.08] group-data-[popup-open]:bg-foreground/[0.035] group-data-[popup-open]:text-foreground/82",
        "hover:border-foreground/[0.08] hover:bg-foreground/[0.03] hover:text-foreground/82 active:scale-[0.985]",
      )}
    >
      {children}
    </span>
  );
}

/* ─── 助手选择器 ─── */

export interface AgentOption {
  readonly id: string;
  readonly displayName: string;
}

export function AgentSelectorPopover({
  currentAgentId,
  onChange,
  agentOptions,
}: {
  readonly currentAgentId: string | null;
  readonly onChange?: (agentId: string) => void;
  /** Desktop 已加载的会话助手；提供后不再等待独立目录接口。 */
  readonly agentOptions?: readonly AgentOption[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const hasAgentOptions = agentOptions !== undefined;
  const catalog = useV11Catalog({
    resourceTypes: ["agent"],
    autoFetch: !hasAgentOptions,
  });
  const agents =
    agentOptions ??
    catalog.items.map(({ resource_id, display_name }) => ({
      id: resource_id,
      displayName: display_name,
    }));
  const loading = hasAgentOptions ? false : catalog.loading;
  const error = hasAgentOptions ? null : catalog.error;

  const currentAgent = agents.find((agent) => agent.id === currentAgentId);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredAgents = normalizedQuery
    ? agents.filter((agent) =>
        `${agent.displayName} ${agent.id}`.toLocaleLowerCase().includes(normalizedQuery),
      )
    : agents;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger
        aria-label={currentAgent?.displayName ?? "助手"}
        className="group rounded-full outline-none"
      >
        <TriggerPill marker="agent-pill">
          <Bot
            data-slot="agent-mark"
            className="size-[15px] shrink-0 stroke-[1.7]"
            aria-hidden="true"
          />
          <span
            data-slot="agent-label"
            className="max-w-[104px] truncate font-medium leading-none tracking-[-0.005em]"
          >
            {currentAgent?.displayName ?? "助手"}
          </span>
          <ChevronDown
            className="size-[13px] shrink-0 stroke-[1.75] transition-transform duration-150 group-data-[popup-open]:rotate-180"
            aria-hidden="true"
          />
        </TriggerPill>
      </PopoverTrigger>
      <PopoverContent
        className="w-[288px] gap-0 overflow-hidden rounded-[18px] border border-foreground/[0.08] bg-popover/95 p-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_24px_60px_-24px_rgba(15,23,42,0.30),0_8px_20px_-12px_rgba(15,23,42,0.20)] ring-1 ring-inset ring-white/65 backdrop-blur-xl dark:ring-white/10"
        align="start"
        side="top"
        sideOffset={10}
      >
        <SelectorPopoverHeader title="助手" query={query} onQueryChange={setQuery} />
        <div className="max-h-72 overflow-y-auto px-2 pb-2">
          {loading && <SelectorMessage>加载中…</SelectorMessage>}
          {error && <SelectorMessage destructive>{error.description}</SelectorMessage>}
          {!loading && !error && agents.length === 0 && (
            <SelectorMessage>暂无可用助手</SelectorMessage>
          )}
          {!loading && !error && agents.length > 0 && filteredAgents.length === 0 && (
            <SelectorMessage>无匹配助手</SelectorMessage>
          )}
          {filteredAgents.map((agent) => {
            const active = agent.id === currentAgentId;
            return (
              <button
                key={agent.id}
                type="button"
                aria-current={active ? "true" : undefined}
                aria-label={agent.displayName}
                onClick={() => {
                  onChange?.(agent.id);
                  setOpen(false);
                  setQuery("");
                }}
                className={cn(
                  "flex min-h-10 w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left text-[13px] transition-[background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.985]",
                  active
                    ? "bg-foreground/[0.045] font-medium text-foreground shadow-[inset_0_0_0_1px_rgba(15,23,42,0.06),0_1px_1px_rgba(15,23,42,0.025)]"
                    : "text-foreground hover:bg-foreground/[0.03] hover:shadow-[inset_0_0_0_1px_rgba(15,23,42,0.035)]",
                )}
              >
                <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground shadow-[0_1px_2px_rgba(15,23,42,0.12)]">
                  {agent.displayName.charAt(0)}
                </span>
                <span className="flex-1 truncate">{agent.displayName}</span>
                {active && (
                  <Check
                    className="size-3.5 stroke-[1.8] text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ─── 模型选择器 ─── */

export function ModelSelectorPopover({
  currentModelRef,
  onChange,
}: {
  readonly currentModelRef: string | null;
  readonly onChange?: (modelRef: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { models, defaultModel, loading, error } = useAvailableModels();
  const selectedModelRef = currentModelRef ?? defaultModel;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredModels = normalizedQuery
    ? models.filter((model) => model.id.toLocaleLowerCase().includes(normalizedQuery))
    : models;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger
        aria-label={selectedModelRef ?? "模型"}
        className="group rounded-full outline-none"
      >
        <TriggerPill marker="model-pill">
          <Box
            data-slot="model-mark"
            className="size-[15px] shrink-0 stroke-[1.65]"
            aria-hidden="true"
          />
          <span className="max-w-[120px] truncate font-medium leading-none tracking-[-0.01em]">
            {selectedModelRef ?? "模型"}
          </span>
          <ChevronDown
            className="size-[13px] shrink-0 stroke-[1.75] transition-transform duration-150 group-data-[popup-open]:rotate-180"
            aria-hidden="true"
          />
        </TriggerPill>
      </PopoverTrigger>
      <PopoverContent
        data-testid="model-selector-popover"
        className="w-[288px] gap-0 overflow-hidden rounded-[18px] border border-foreground/[0.08] bg-popover/95 p-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_24px_60px_-24px_rgba(15,23,42,0.30),0_8px_20px_-12px_rgba(15,23,42,0.20)] ring-1 ring-inset ring-white/65 backdrop-blur-xl dark:ring-white/10"
        align="start"
        side="top"
        sideOffset={10}
      >
        <SelectorPopoverHeader title="模型" query={query} onQueryChange={setQuery} />
        <div className="max-h-72 overflow-y-auto px-2 pb-2">
          {loading && <SelectorMessage>加载中…</SelectorMessage>}
          {error && <SelectorMessage destructive>{error}</SelectorMessage>}
          {!loading && !error && models.length === 0 && (
            <SelectorMessage>暂无可用模型</SelectorMessage>
          )}
          {!loading && !error && models.length > 0 && filteredModels.length === 0 && (
            <SelectorMessage>无匹配模型</SelectorMessage>
          )}
          {filteredModels.map((model) => {
            const active = model.id === selectedModelRef;
            return (
              <button
                key={model.id}
                type="button"
                aria-current={active ? "true" : undefined}
                aria-label={model.id}
                onClick={() => {
                  onChange?.(model.id);
                  setOpen(false);
                  setQuery("");
                }}
                className={cn(
                  "flex min-h-10 w-full items-center gap-2 rounded-[11px] px-3 py-2 text-left text-[13px] transition-[background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.985]",
                  active
                    ? "bg-foreground/[0.045] font-medium text-foreground shadow-[inset_0_0_0_1px_rgba(15,23,42,0.06),0_1px_1px_rgba(15,23,42,0.025)]"
                    : "text-foreground hover:bg-foreground/[0.03] hover:shadow-[inset_0_0_0_1px_rgba(15,23,42,0.035)]",
                )}
              >
                <span className="flex-1 truncate">{model.id}</span>
                {active && (
                  <Check
                    className="size-3.5 stroke-[1.8] text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
