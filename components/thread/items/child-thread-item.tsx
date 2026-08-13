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
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-lg border border-border bg-muted px-4 py-3">
        <div className="flex items-center gap-2">
          {/* 子任务图标 */}
          <div className="flex size-8 items-center justify-center rounded bg-primary/10 text-primary">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>

          <div className="flex-1">
            <div className="font-medium text-sm text-foreground">子任务</div>
            <div className="mt-0.5 text-2xs text-muted-foreground">
              Agent: {content.target_agent_id?.slice(0, 8) ?? "unknown"}
            </div>
          </div>

          <span className={stateClass}>{stateLabel}</span>
        </div>

        {/* 摘要 */}
        {content.summary && (
          <div className="mt-2 border-border border-t pt-2 text-xs text-muted-foreground">
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
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-border px-2.5 py-1 text-2xs text-muted-foreground transition hover:bg-card hover:text-foreground"
            >
              查看子任务
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M7 17L17 7" />
                <path d="M7 7h10v10" />
              </svg>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
