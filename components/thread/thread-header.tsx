/**
 * Thread 顶部固定头部（S10-W02）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W02：「Thread 顶部固定展示主 Agent、可选 Goal、当前任务状态和默认执行位置」
 *
 * 职责：
 * - 展示 Thread title（或 "新会话"）。
 * - 展示主 Agent（primary_agent_id → 显示名，W04 接入 Agent 目录后替换）。
 * - 展示 active Goal（objective + goal_state）。
 * - 展示当前任务状态（从 latest_turn.turn_state 推导）。
 * - 展示默认执行位置（default_environment_definition_id → "Cloud" / "Desktop"，W04 接入 Environment 目录后替换）。
 *
 * 当前任务状态推导：
 * - latest_turn.turn_state = accepted/queued → "排队中"
 * - running → "执行中"
 * - waiting_user → "等待确认"
 * - regenerating → "重新生成中"
 * - completed → "已完成"
 * - interrupted → "已停止"
 * - failed → "失败"
 * - cancelled → "已取消"
 * - 无 Turn → "空闲"
 *
 * 样式：与 workspace.tsx header 一致（border-b + bg-surface + px-4 py-3.5）。
 */
"use client";

import { CatalogDisplayName } from "@/components/thread/catalog/catalog-display-name";
import type { ClientGoal, ClientThread, ClientTurn } from "@/lib/client/types";
import { cn } from "@/lib/utils";
import { useOptionalSidebar } from "./sidebar/sidebar-context";

interface ThreadHeaderProps {
  readonly thread: ClientThread;
  readonly activeGoal: ClientGoal | null;
  readonly latestTurn: ClientTurn | null;
  /** 渲染变体：web（默认）= 完整 header；desktop = 仅次级信息行（Agent / Goal / 位置）。 */
  readonly variant?: "web" | "desktop";
  readonly primaryAgentName?: string;
}

/** 从 Turn 状态推导当前任务状态（中文）。
 * 导出供 ThreadPage desktop 标题栏复用（W2-2）。
 */
export function deriveTaskStatus(turn: ClientTurn | null): {
  readonly label: string;
  readonly tone: "idle" | "running" | "waiting" | "success" | "error" | "stopped";
} {
  if (!turn) return { label: "空闲", tone: "idle" };
  switch (turn.turn_state) {
    case "accepted":
    case "queued":
      return { label: "排队中", tone: "running" };
    case "running":
      return { label: "执行中", tone: "running" };
    case "waiting_user":
      return { label: "等待确认", tone: "waiting" };
    case "regenerating":
      return { label: "重新生成中", tone: "running" };
    case "completed":
      return { label: "已完成", tone: "success" };
    case "interrupted":
      return { label: "已停止", tone: "stopped" };
    case "failed":
      return { label: "失败", tone: "error" };
    case "cancelled":
      return { label: "已取消", tone: "stopped" };
    default:
      return { label: "未知", tone: "idle" };
  }
}

/** Goal 状态中文。 */
function goalStateLabel(state: ClientGoal["goal_state"]): string {
  switch (state) {
    case "active":
      return "进行中";
    case "blocked":
      return "已阻塞";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
  }
}

export function ThreadHeader({
  thread,
  activeGoal,
  latestTurn,
  variant = "web",
  primaryAgentName,
}: ThreadHeaderProps) {
  const taskStatus = deriveTaskStatus(latestTurn);
  const sidebar = useOptionalSidebar();

  // Desktop 形态：标题信息上移至 ThreadPage 的 38px 标题栏（W2-2），
  // 此处仅保留次级信息行（Agent / Goal / 位置）。
  if (variant === "desktop") {
    return (
      <div className="flex items-center gap-3 px-4 py-2 text-xs text-muted-foreground">
        {/* 主 Agent（W04 接入 Agent 目录显示名） */}
        <span className="flex items-center gap-1">
          <span className="text-foreground-subtle">Agent</span>
          {primaryAgentName ?? (
            <CatalogDisplayName resourceId={thread.primary_agent_id} resourceType="agent" />
          )}
        </span>

        {/* Goal */}
        {activeGoal && (
          <span className="flex items-center gap-1">
            <span className="text-foreground-subtle">目标</span>
            <span className="max-w-[300px] truncate">{activeGoal.objective}</span>
            <span
              className={cn(
                "rounded px-1 py-0.5 text-2xs",
                activeGoal.goal_state === "active" && "bg-primary/10 text-primary",
                activeGoal.goal_state === "blocked" && "bg-warning/10 text-warning",
                activeGoal.goal_state === "completed" && "bg-success/10 text-success",
                activeGoal.goal_state === "cancelled" &&
                  "bg-foreground-subtle/10 text-foreground-subtle",
              )}
            >
              {goalStateLabel(activeGoal.goal_state)}
            </span>
          </span>
        )}

        {/* 默认执行位置（W04 接入 Environment 目录显示名） */}
        <span className="flex items-center gap-1">
          <span className="text-foreground-subtle">位置</span>
          {thread.default_environment_definition_id ? (
            <CatalogDisplayName
              resourceId={thread.default_environment_definition_id}
              resourceType="runtime"
            />
          ) : (
            <span className="text-xs text-foreground">Cloud</span>
          )}
        </span>
      </div>
    );
  }

  // Web 形态：完整 header（border-b + bg-surface + px-4 py-3.5）。
  // 侧栏收起时左上角有固定的搜索/展开/新建控件，标题区需要预留安全左内边距避免重叠。
  return (
    <header
      data-testid="web-thread-header"
      className={cn(
        "flex items-center justify-between border-b border-border bg-card py-3.5 pr-4 lg:pr-6",
        sidebar?.collapsed ? "pl-32" : "pl-4 lg:pl-6",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* 第一行：Thread title + 任务状态 */}
        <div className="flex items-center gap-3">
          <h1 className="min-w-0 flex-1 truncate font-semibold text-base text-foreground">
            {thread.title ?? "新会话"}
          </h1>
          <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
            <span
              className={cn(
                "size-1.5 rounded-full",
                taskStatus.tone === "running" && "animate-gentle-pulse bg-primary",
                taskStatus.tone === "waiting" && "bg-warning",
                taskStatus.tone === "success" && "bg-success",
                taskStatus.tone === "error" && "bg-destructive",
                taskStatus.tone === "stopped" && "bg-foreground-subtle",
                taskStatus.tone === "idle" && "bg-foreground-subtle",
              )}
            />
            <span className="text-2xs text-muted-foreground">{taskStatus.label}</span>
          </div>
        </div>

        {/* 第二行：主 Agent + Goal + 执行位置（窄屏可换行，不得水平溢出） */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {/* 主 Agent（W04 接入 Agent 目录显示名） */}
          <span className="flex items-center gap-1">
            <span className="text-foreground-subtle">Agent</span>
            {primaryAgentName ?? (
              <CatalogDisplayName resourceId={thread.primary_agent_id} resourceType="agent" />
            )}
          </span>

          {/* Goal */}
          {activeGoal && (
            <span className="flex items-center gap-1">
              <span className="text-foreground-subtle">目标</span>
              <span className="max-w-[300px] truncate">{activeGoal.objective}</span>
              <span
                className={cn(
                  "rounded px-1 py-0.5 text-3xs",
                  activeGoal.goal_state === "active" && "bg-primary/10 text-primary",
                  activeGoal.goal_state === "blocked" && "bg-warning/10 text-warning",
                  activeGoal.goal_state === "completed" && "bg-success/10 text-success",
                  activeGoal.goal_state === "cancelled" &&
                    "bg-foreground-subtle/10 text-foreground-subtle",
                )}
              >
                {goalStateLabel(activeGoal.goal_state)}
              </span>
            </span>
          )}

          {/* 默认执行位置（W04 接入 Environment 目录显示名） */}
          <span className="flex items-center gap-1">
            <span className="text-foreground-subtle">位置</span>
            {thread.default_environment_definition_id ? (
              <CatalogDisplayName
                resourceId={thread.default_environment_definition_id}
                resourceType="runtime"
              />
            ) : (
              <span className="text-xs text-foreground">Cloud</span>
            )}
          </span>
        </div>
      </div>
    </header>
  );
}
