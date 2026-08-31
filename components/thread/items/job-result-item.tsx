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
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";

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
    <div className="flex justify-start py-1">
      <div
        className={cn(
          "w-full max-w-xl rounded-xl border bg-card px-3.5 py-3 shadow-sm",
          isFailed ? "border-destructive/40" : "border-border",
        )}
      >
        <div className="flex items-center gap-2">
          {/* Job 图标 */}
          <div
            className={cn(
              "flex size-9 items-center justify-center rounded-lg",
              isPending && "bg-muted text-muted-foreground",
              isCompleted && "bg-success/10 text-success",
              isFailed && "bg-destructive/10 text-destructive",
            )}
          >
            {isPending ? (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            ) : isFailed ? (
              <CircleAlert aria-hidden="true" className="size-4" />
            ) : (
              <CircleCheck aria-hidden="true" className="size-4" />
            )}
          </div>

          <div className="flex-1">
            <div className="font-medium text-foreground text-sm">后台任务</div>
            <div className="mt-0.5 text-2xs text-muted-foreground">
              {isPending ? "执行中" : isCompleted ? "已完成" : "失败"}
            </div>
          </div>

          {/* 状态标签 */}
          <span
            className={cn(
              "rounded px-2 py-0.5 text-3xs",
              isPending && "bg-muted text-muted-foreground",
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
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-foreground/70 transition-all"
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
