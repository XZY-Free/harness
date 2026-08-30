/**
 * Job 结果 Item（job_result）。
 *
 * content 结构：{ job_id, job_type, status, result?, error?, progress? }
 * （W06 接入 Job 表后替换为完整结构）
 *
 * 样式：任务卡片（带图标 + 状态 + 进度条 + 结果摘要）。
 */
"use client";

import type { ClientItem } from "@/lib/client/types";
import { cn } from "@/lib/utils";

interface JobResultItemProps {
  readonly item: ClientItem;
}

export function JobResultItem({ item }: JobResultItemProps) {
  const content = item.content as {
    job_id?: string;
    job_type?: string;
    status?: string;
    result?: unknown;
    error?: string;
    progress?: number;
  };

  const isPending = item.item_state === "pending";
  const isCompleted = item.item_state === "completed";
  const isFailed = item.item_state === "failed";

  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "max-w-[80%] rounded-[var(--radius-lg)] border px-4 py-3",
          isFailed ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted",
        )}
      >
        <div className="flex items-center gap-2">
          {/* Job 图标 */}
          <div
            className={cn(
              "flex size-8 items-center justify-center rounded",
              isPending && "bg-[var(--primary)]/10 text-[var(--primary)]",
              isCompleted && "bg-success/10 text-success",
              isFailed && "bg-destructive/10 text-destructive",
            )}
          >
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
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          </div>

          <div className="flex-1">
            <div className="font-medium text-sm text-foreground">{content.job_type ?? "Job"}</div>
            <div className="mt-0.5 text-2xs text-muted-foreground">
              {isPending ? "执行中" : isCompleted ? "已完成" : "失败"}
            </div>
          </div>

          {/* 状态标签 */}
          <span
            className={cn(
              "rounded px-2 py-0.5 text-3xs",
              isPending && "bg-[var(--primary)]/10 text-[var(--primary)]",
              isCompleted && "bg-success/10 text-success",
              isFailed && "bg-destructive/10 text-destructive",
            )}
          >
            {isPending ? "进行中" : isCompleted ? "完成" : "失败"}
          </span>
        </div>

        {/* 进度条（role=progressbar + aria-valuenow/min/max 公告给辅助技术） */}
        {isPending && typeof content.progress === "number" && (
          <div className="mt-3">
            <div
              role="progressbar"
              aria-label="任务进度"
              aria-valuenow={Math.round(Math.min(1, Math.max(0, content.progress)) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              tabIndex={-1}
              className="h-1.5 overflow-hidden rounded-full bg-card"
            >
              <div
                className="h-full bg-[var(--primary)] transition-all"
                style={{ width: `${Math.min(100, Math.max(0, content.progress * 100))}%` }}
              />
            </div>
            <div className="mt-1 text-2xs text-muted-foreground" aria-hidden="true">
              {Math.round(content.progress * 100)}%
            </div>
          </div>
        )}

        {/* 结果摘要 */}
        {isCompleted && content.result ? (
          <div className="mt-2 border-border border-t pt-2">
            <pre className="overflow-x-auto rounded bg-background p-2 text-2xs text-muted-foreground">
              {JSON.stringify(content.result, null, 2)}
            </pre>
          </div>
        ) : null}

        {/* 错误信息 */}
        {isFailed && content.error && (
          <div
            role="alert"
            className="mt-2 rounded bg-destructive/10 p-2 text-2xs text-destructive"
          >
            {content.error}
          </div>
        )}
      </div>
    </div>
  );
}
