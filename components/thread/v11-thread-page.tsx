/**
 * V11 Thread 页面（S10-W02 + S10-W03 + S10-W04 + S10-W06）。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md
 *   S10-W02：「Thread 顶部固定展示主 Agent、可选 Goal、当前任务状态和默认执行位置」
 *   「时间线覆盖用户与 Agent Item、公开进度、ToolCall、Artifact、UserAction、Child Thread 与 Job 结果投影」
 *   S10-W03：「空闲时发送创建正式 UserMessage/Turn；运行中默认创建 PendingInput」
 *   「PendingInput 队列展示在时间线上方，Steer/Stop 控制条在 Header 与 Timeline 之间」
 *   S10-W04：「员工在发送消息前选择 Agent / Model / Skill / Environment」
 *   S10-W06：「Desktop 复用共同时间线，在右侧增加文件、页面和内部系统任务操作面板」
 *
 * 职责：
 * - 组合 ThreadHeader（顶部固定）+ ThreadTimeline（时间线）+ ThreadInput（输入框，内嵌运行控制与待办队列）。
 * - 加载 Thread 详情（useV11ThreadDetail）+ Item 投影（useV11Thread）。
 * - SSE 事件到达时刷新 Thread 详情（turn.accepted / turn.state_changed / thread.updated）。
 * - 错误展示（visibleError → ErrorCard）。
 * - W3-4：输入区集成 ＋菜单、助手选择器、模型选择器；CatalogSettingsBar 撤除。
 * - W4-1：顶部 Steer/Stop 横条与时间线上方的待办队列移入 ThreadInput 内部，
 *   停止按钮复用 codex 形态（输入框右下圆钮变 ■），待办队列复用紧凑单行条。
 * - Desktop：右侧渲染任务工作台，提供文件、审阅、浏览器和会话上下文入口。
 *
 * 使用：
 * ```tsx
 * // app/chat/[threadId]/page.tsx
 * export default function ChatPage({ params }: { params: { threadId: string } }) {
 *   return <ThreadPage threadId={params.threadId} />;
 * }
 *
 * // app/desktop/chat/[threadId]/page.tsx
 * export default function DesktopChatPage({ params }: { params: { threadId: string } }) {
 *   return <ThreadPage threadId={params.threadId} variant="desktop" />;
 * }
 * ```
 */
"use client";

import { useV11Thread } from "@/components/hooks/use-thread";
import { useV11ThreadDetail } from "@/components/hooks/use-thread-detail";
import { useV11ThreadSettings } from "@/components/hooks/use-thread-settings";
import { apiFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import { PanelRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DesktopWorkbench } from "../desktop/desktop-workbench";
import type { AgentOption } from "./input/input-popovers";
import { useOptionalSidebar } from "./sidebar/sidebar-context";
import { ThreadHeader, deriveTaskStatus } from "./thread-header";
import { ThreadInput } from "./thread-input";
import { ThreadTimeline } from "./thread-timeline";

interface ThreadPageProps {
  readonly threadId: string;
  /** 渲染变体：web（默认）= 仅时间线；desktop = 时间线 + 右侧工作台。 */
  readonly variant?: "web" | "desktop";
  /** 当前登录员工的内部 id，仅 Desktop Browser 使用。 */
  readonly viewerId?: string;
  /** Desktop Shell 已加载的真实助手列表。 */
  readonly availableAgents?: readonly AgentOption[];
}

export function ThreadPage({
  threadId,
  variant = "web",
  viewerId,
  availableAgents,
}: ThreadPageProps) {
  const sidebar = useOptionalSidebar();
  const {
    items,
    streamStatus,
    reconnectAttempt,
    reconnectMax,
    snapshotStatus,
    visibleError,
    lastAppliedEventSequence,
    resnapshot,
  } = useV11Thread(threadId);

  const { thread, activeGoal, latestTurn, loading, error, refresh } = useV11ThreadDetail(threadId);

  // W04：Thread 默认设置 PATCH（Model / Environment）
  const { patchSettings, busy: settingsBusy } = useV11ThreadSettings({ threadId });
  const [locateItem, setLocateItem] = useState<{ itemId: string; requestId: number } | null>(null);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);

  // SSE 事件到达时刷新 Thread 详情（turn.accepted / turn.state_changed / thread.updated）
  useEffect(() => {
    if (lastAppliedEventSequence > 0) {
      void refresh();
    }
  }, [lastAppliedEventSequence, refresh]);

  // W04：Model 变更 → PATCH settings.default_model_ref
  const handleModelChange = useCallback(
    (modelRef: string) => {
      if (!thread) return;
      void patchSettings({
        expectedVersionNo: thread.version_no,
        updates: { default_model_ref: modelRef },
      }).then((ok) => {
        if (ok) void refresh();
      });
    },
    [thread, patchSettings, refresh],
  );

  // W3-4：主 Agent 变更 → 调用 :request-handoff 触发 Handoff 确认流程。
  const handleAgentChange = useCallback(
    async (agentId: string) => {
      if (!thread || !latestTurn) return;
      const invocationId = latestTurn.active_invocation_id ?? latestTurn.latest_invocation_id ?? "";
      try {
        const resp = await apiFetch(`/api/v1/threads/${threadId}:request-handoff`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            invocation_id: invocationId,
            turn_id: latestTurn.id,
            target_agent_id: agentId,
            reason: "员工切换助手",
          }),
        });
        if (!resp.ok) {
          // 错误静默处理，由 thread 刷新后展示 user-action
          console.error("Handoff request failed", await resp.text());
          return;
        }
        void refresh();
      } catch (err) {
        console.error("Handoff request error", err);
      }
    },
    [threadId, thread, latestTurn, refresh],
  );

  const handleLocateItem = useCallback((itemId: string) => {
    setLocateItem((current) => ({ itemId, requestId: (current?.requestId ?? 0) + 1 }));
  }, []);

  // W3-2：44px 主区标题行（Thread 标题 + 状态点）。
  // - 拖拽区是独立绝对定位层，避免覆盖左侧窗口控件和右侧工作台按钮。
  // - 侧栏收起后从 160px 开始拖拽，为搜索与展开按钮保留真实鼠标命中区。
  // - 无条件渲染：thread 未加载时标题显示"新会话"占位、状态点隐藏。
  const taskStatus = deriveTaskStatus(latestTurn);
  const desktopTitlebar = variant === "desktop" && (
    <div
      className={cn(
        "relative flex h-11 shrink-0 items-center gap-3 border-b border-border bg-background transition-[padding] duration-200 ease-out",
        sidebar?.collapsed ? "pl-48 pr-4" : "px-4",
      )}
    >
      <div
        data-testid="desktop-thread-titlebar-drag-zone"
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 right-14 [-webkit-app-region:drag]",
          sidebar?.collapsed ? "left-40" : "left-0",
        )}
      />
      <h1 className="truncate font-semibold text-sm text-foreground">
        {thread?.title ?? "新会话"}
      </h1>
      {thread && (
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 rounded-full",
              taskStatus.tone === "running" && "animate-gentle-pulse bg-primary",
              taskStatus.tone === "waiting" && "bg-warning",
              taskStatus.tone === "success" && "bg-success",
              taskStatus.tone === "error" && "bg-destructive",
              taskStatus.tone === "stopped" && "bg-muted-foreground",
              taskStatus.tone === "idle" && "bg-muted-foreground",
            )}
          />
          <span className="text-2xs text-muted-foreground">{taskStatus.label}</span>
        </div>
      )}
      <button
        type="button"
        aria-label={workbenchOpen ? "收起任务工作台" : "展开任务工作台"}
        title={workbenchOpen ? "收起任务工作台" : "展开任务工作台"}
        onClick={() => setWorkbenchOpen((open) => !open)}
        className="ml-auto flex size-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [-webkit-app-region:no-drag]"
      >
        <PanelRight className="size-4" strokeWidth={1.5} />
      </button>
    </div>
  );

  // 错误状态
  if (visibleError || error) {
    const displayError = visibleError ?? error;
    const errorCard = (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-6 py-4 text-center"
        >
          <h2 className="font-semibold text-base text-destructive">
            {displayError?.title ?? "加载失败"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {displayError?.description ?? "无法加载会话"}
          </p>
          {displayError?.retryable && (
            <button
              type="button"
              onClick={() => void resnapshot()}
              aria-label="重新加载会话"
              className="mt-4 rounded-sm bg-primary px-4 py-2 text-sm text-primary-foreground transition hover:bg-[var(--accent-hover)]"
            >
              重试
            </button>
          )}
        </div>
      </div>
    );
    if (variant === "desktop") {
      return (
        <div className="flex h-full flex-col">
          {desktopTitlebar}
          <div className="min-h-0 flex-1">{errorCard}</div>
        </div>
      );
    }
    return errorCard;
  }

  // 加载状态。
  // W4-1：仅「首次加载」（无任何已渲染内容）才显示全屏 spinner；
  // 已有 items 或 thread 时的 resnapshot（如 item.created/item.updated 触发的后台刷新）
  // 必须保留已渲染内容，避免每次发送消息/AI 回复结束都把会话替换成 loading。
  // resnapshot 期间 snapshotStatus 会变 "loading"，但 items 保留在 store 中，
  // 所以只要 items.length > 0 或 thread 已加载，就不显示全屏 spinner。
  const hasRenderedContent = items.length > 0 || thread !== null;
  const isFirstLoad = !hasRenderedContent && (snapshotStatus === "loading" || loading);
  if (isFirstLoad) {
    const loadingBody = (
      <output aria-label="会话加载中" className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <div
            aria-hidden="true"
            className="size-8 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent"
          />
          <p className="text-sm text-muted-foreground">加载会话中…</p>
        </div>
      </output>
    );
    if (variant === "desktop") {
      return (
        <div className="flex h-full flex-col">
          {desktopTitlebar}
          <div className="min-h-0 flex-1">{loadingBody}</div>
        </div>
      );
    }
    return loadingBody;
  }

  // 正常状态
  const mainContent = (
    <div className="flex h-full flex-col">
      {thread && <ThreadHeader thread={thread} activeGoal={activeGoal} latestTurn={latestTurn} />}
      <ThreadTimeline
        items={items}
        streamStatus={streamStatus}
        reconnectAttempt={reconnectAttempt}
        reconnectMax={reconnectMax}
        threadId={threadId}
      />
      {thread && (
        <ThreadInput
          threadId={threadId}
          latestTurn={latestTurn}
          thread={thread}
          availableAgents={availableAgents}
          onAgentChange={handleAgentChange}
          onModelChange={handleModelChange}
          settingsBusy={settingsBusy}
        />
      )}
    </div>
  );

  // W3-2：Desktop 三段式布局（侧栏 + 主区 + 工作台）。
  // - 标题行横贯主区顶部，下方左右分栏。
  // - 次级信息（Agent / Goal / 位置）不再常驻一行（W3-2 规格：移入输入区选择器或标题行 tooltip）。
  // - 工作台可由员工调整宽度或收起，默认展示固定的任务页签。
  if (variant === "desktop") {
    return (
      <div className="flex h-full flex-col">
        {desktopTitlebar}
        <div className="flex min-h-0 flex-1">
          {/* 左侧：时间线 + 输入区（输入区内嵌运行控制与待办队列） */}
          <div className="min-w-0 flex-1 flex flex-col">
            <ThreadTimeline
              items={items}
              streamStatus={streamStatus}
              reconnectAttempt={reconnectAttempt}
              reconnectMax={reconnectMax}
              threadId={threadId}
              showMessageLocator
              locateItem={locateItem}
            />
            {thread && (
              <ThreadInput
                threadId={threadId}
                latestTurn={latestTurn}
                thread={thread}
                availableAgents={availableAgents}
                onAgentChange={handleAgentChange}
                onModelChange={handleModelChange}
                settingsBusy={settingsBusy}
              />
            )}
          </div>
          <DesktopWorkbench
            threadId={threadId}
            isOpen={workbenchOpen}
            viewerId={viewerId}
            threadTitle={thread?.title}
            activeGoal={activeGoal}
            latestTurn={latestTurn}
            items={items}
            onLocateItem={handleLocateItem}
          />
        </div>
      </div>
    );
  }

  return mainContent;
}
