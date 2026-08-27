/**
 * Thread 页面。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W02：「Thread 顶部固定展示主 Agent、可选 Goal、当前任务状态和默认执行位置」
 *   「时间线覆盖用户与 Agent Item、公开进度、ToolCall、Artifact、UserAction、Child Thread 与 Job 结果投影」
 *   S10-W03：「空闲时发送创建正式 UserMessage/Turn；运行中默认创建 PendingInput」
 *   「PendingInput 队列展示在时间线上方，Steer/Stop 控制条在 Header 与 Timeline 之间」
 *   S10-W04：「员工在发送消息前选择 Agent / Model / Skill / Environment」
 *   S10-W06：「Desktop 复用共同时间线，在右侧增加文件、页面和内部系统任务操作面板」
 *
 * 职责：
 * - 组合 ThreadHeader（顶部固定）+ ThreadTimeline（时间线）+ ThreadInput（输入框，内嵌运行控制与待办队列）。
 * - 加载 Thread 详情（useThreadDetail）+ Item 投影（useThread）。
 * - SSE 事件到达时刷新 Thread 详情（turn.accepted / turn.state_changed / thread.updated）。
 * - 错误展示（visibleError → ErrorCard）。
 * - 输入区集成助手单次调用选择、模型选择；不绑定主 Agent，不做 handoff。
 * - 专题01 §35：不再绑定主 Agent（primary_agent_id 已移除），无 Agent 时输入区照常可用。
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

import { useThread } from "@/components/hooks/use-thread";
import { useThreadDetail } from "@/components/hooks/use-thread-detail";
import { useThreadSettings } from "@/components/hooks/use-thread-settings";
import { cn } from "@/lib/utils";
import { PanelRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DesktopWorkbench } from "../desktop/desktop-workbench";
import { useOptionalSidebar } from "./sidebar/sidebar-context";
import { ThreadHeader, deriveTaskStatus } from "./thread-header";
import { ThreadInput } from "./thread-input";
import { ThreadTimeline } from "./thread-timeline";
import { TurnFailureNotice } from "./turn-failure-notice";

interface ThreadPageProps {
  readonly threadId: string;
  /** 渲染变体：web（默认）= 仅时间线；desktop = 时间线 + 右侧工作台。 */
  readonly variant?: "web" | "desktop";
  /** 当前登录员工的内部 id，仅 Desktop Browser 使用。 */
  readonly viewerId?: string;
  /** 平台默认模型（shell.default_model_ref）；用于既有 Thread 未配模型时的即时展示。 */
  readonly defaultModelRef?: string;
}

export function ThreadPage({
  threadId,
  variant = "web",
  viewerId,
  defaultModelRef,
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
  } = useThread(threadId);

  const { thread, activeGoal, latestTurn, loading, error, refresh } = useThreadDetail(threadId);

  // W04：Thread 默认设置 PATCH（Model / Environment）
  const { patchSettings, busy: settingsBusy } = useThreadSettings({ threadId });
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

  const handleLocateItem = useCallback((itemId: string) => {
    setLocateItem((current) => ({ itemId, requestId: (current?.requestId ?? 0) + 1 }));
  }, []);

  // W3-2：44px 主区标题行（Thread 标题 + 状态点）。
  // - 拖拽区是独立绝对定位层，避免覆盖左侧窗口控件和右侧工作台按钮。
  // - 侧栏收起后从 160px 开始拖拽，为搜索与展开按钮保留真实鼠标命中区。
  // - 无条件渲染：thread 未加载时标题显示"新会话"占位、状态点隐藏。
  const taskStatus = deriveTaskStatus(latestTurn);
  // : 专题01 §15：Thread 不再绑定主 Agent（primary_agent_id 已移除，§35）。
  // 移除 default-agent fallback 展示（"助手"兜底）；Agent 目录为空时不再伪装主 Agent。
  const desktopTitlebar = variant === "desktop" && (
    <div
      data-testid="desktop-thread-titlebar"
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

  // 加载状态（W4-1）。
  // 仅「首次加载」（无任何已渲染内容）进入稳定骨架：与正常页面同高的顶部标题区、
  // 消息区局部加载反馈、底部 ThreadInput（"助手"与平台默认模型仍可见）。
  // 骨架只复用 ThreadInput 与现有设计 tokens，不复制第二套业务状态机、
  // 不构造假 Thread/Turn/Item、不改 API；数据就绪后原位切换，不出现整页 spinner。
  // 已有 items 或 thread 时的 resnapshot（如 item.created/item.updated 触发的后台刷新）
  // 必须保留已渲染内容，不走骨架。
  const hasRenderedContent = items.length > 0 || thread !== null;
  const isFirstLoad = !hasRenderedContent && (snapshotStatus === "loading" || loading);

  // 首次加载时消息区的局部加载反馈（仅占消息区，不替换整页）。
  const messageAreaLoading = (
    <output
      data-testid="message-area-loading"
      className="flex min-h-0 flex-1 items-center justify-center px-4 py-10"
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <div
          aria-hidden="true"
          className="size-4 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent"
        />
        <span>加载会话中…</span>
      </div>
    </output>
  );

  // Web 顶部标题区：已加载用真实 ThreadHeader；首次加载用同高稳定占位（不构造假 Thread）。
  const webHeader = thread ? (
    <ThreadHeader thread={thread} activeGoal={activeGoal} latestTurn={latestTurn} />
  ) : (
    <header
      data-testid="web-thread-header-placeholder"
      className={cn(
        "flex items-center justify-between border-b border-border bg-card py-3.5 pr-4 lg:pr-6",
        sidebar?.collapsed ? "pl-32" : "pl-4 lg:pl-6",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="min-w-0 flex-1 truncate font-semibold text-base text-foreground">新会话</h1>
      </div>
    </header>
  );

  // 输入区：首次加载用 disabled fieldset 使其不可交互（不做假提交），数据就绪后原位启用。
  // fieldset 的 disabled 语义在 DOM 层作用于全部后代控件，不依赖渲染/布局。
  const inputArea = (isFirstLoad || thread) && (
    <fieldset disabled={isFirstLoad} data-testid="thread-input-frame" className="contents">
      <ThreadInput
        key={threadId}
        threadId={threadId}
        latestTurn={latestTurn}
        thread={thread}
        defaultModelRef={defaultModelRef}
        onModelChange={handleModelChange}
        settingsBusy={settingsBusy}
      />
    </fieldset>
  );

  // 正常状态 / 首次加载骨架（Web）
  const mainContent = (
    <div
      data-testid="thread-page-frame"
      aria-busy={isFirstLoad}
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      {webHeader}
      {isFirstLoad ? (
        messageAreaLoading
      ) : (
        <>
          <ThreadTimeline
            items={items}
            streamStatus={streamStatus}
            reconnectAttempt={reconnectAttempt}
            reconnectMax={reconnectMax}
            threadId={threadId}
            activeTurn={latestTurn}
          />
          <TurnFailureNotice
            turnState={latestTurn?.turn_state}
            errorCode={latestTurn?.error_code}
          />
        </>
      )}
      {inputArea}
    </div>
  );

  // W3-2：Desktop 三段式布局（侧栏 + 主区 + 工作台）。
  // - 标题行横贯主区顶部，下方左右分栏。
  // - 次级信息（Agent / Goal / 位置）不再常驻一行（W3-2 规格：移入输入区选择器或标题行 tooltip）。
  // - 工作台可由员工调整宽度或收起，默认展示固定的任务页签。
  if (variant === "desktop") {
    return (
      <div
        data-testid="thread-page-frame"
        aria-busy={isFirstLoad}
        className="flex h-full min-h-0 flex-col overflow-hidden"
      >
        {desktopTitlebar}
        <div className="flex min-h-0 flex-1">
          {/* 左侧：时间线 + 输入区（输入区内嵌运行控制与待办队列） */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {isFirstLoad ? (
              messageAreaLoading
            ) : (
              <>
                <ThreadTimeline
                  items={items}
                  streamStatus={streamStatus}
                  reconnectAttempt={reconnectAttempt}
                  reconnectMax={reconnectMax}
                  threadId={threadId}
                  showMessageLocator
                  locateItem={locateItem}
                  activeTurn={latestTurn}
                />
                <TurnFailureNotice
                  turnState={latestTurn?.turn_state}
                  errorCode={latestTurn?.error_code}
                />
              </>
            )}
            {inputArea}
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
