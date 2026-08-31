/**
 * 子 Thread Item（child_thread）。
 *
 * content 结构：{ relation_id, child_thread_id, target_agent_id, task_payload_ref, state, summary?, artifact_ids?, budget_used?, completed_at?, error_code?, error_summary? }
 *
 * 职责：
 * - 展示子 Thread 摘要（不复制子会话全文）。
 * - 展示子 Thread 状态（creating / active / completed / failed / cancelled）。
 * - 提供跳转链接（点击跳转到子 Thread）。
 *
 * 样式：子任务卡片（带图标 + 状态 + 摘要 + 跳转按钮）。
 */
"use client";

import type { ClientItem } from "@/lib/client/types";
import { cn } from "@/lib/utils";
import { ArrowUpRight, UsersRound } from "lucide-react";

interface ChildThreadItemProps {
  readonly item: ClientItem;
}

export function ChildThreadItem({ item }: ChildThreadItemProps) {
  const content = item.content as {
    relation_id?: string;
    child_thread_id?: string;
    target_agent_id?: string;
    state?: string;
    summary?: string;
    artifact_ids?: string[];
    budget_used?: number;
    completed_at?: string;
    error_code?: string;
    error_summary?: string;
  };

  const stateLabel =
    content.state === "creating"
      ? "创建中"
      : content.state === "active"
        ? "进行中"
        : content.state === "completed"
          ? "已完成"
          : content.state === "failed"
            ? "失败"
            : content.state === "cancelled"
              ? "已取消"
              : "未知";

  const stateClass = cn(
    "rounded px-2 py-0.5 text-3xs",
    content.state === "creating" && "bg-primary/10 text-primary",
    content.state === "active" && "bg-primary/10 text-primary",
    content.state === "completed" && "bg-success/10 text-success",
    content.state === "failed" && "bg-destructive/10 text-destructive",
    content.state === "cancelled" && "bg-foreground-subtle/10 text-foreground-subtle",
  );

  return (
    <div className="flex justify-start py-1">
      <div className="w-full max-w-xl rounded-xl border border-border bg-card px-3.5 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          {/* 子任务图标 */}
          <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <UsersRound aria-hidden="true" className="size-4" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="font-medium text-foreground text-sm">协作任务</div>
            <div className="mt-0.5 text-muted-foreground text-xs">由协作助手处理</div>
          </div>

          <span className={stateClass}>{stateLabel}</span>
        </div>

        {/* 摘要 */}
        {content.summary && (
          <div className="mt-3 border-border border-t pt-3 text-muted-foreground text-sm">
            {content.summary}
          </div>
        )}

        {/* 错误信息 */}
        {content.error_summary && (
          <div className="mt-2 rounded bg-destructive/10 p-2 text-2xs text-destructive">
            {content.error_summary}
          </div>
        )}

        {/* 跳转按钮 */}
        {content.child_thread_id && (
          <div className="mt-3">
            <a
              href={`/chat/${content.child_thread_id}`}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
            >
              查看协作任务
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
