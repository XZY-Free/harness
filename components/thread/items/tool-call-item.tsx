/**
 * V11 Tool 调用 Item（tool_call）——W3-3 轻量行内条目形态（方案 §4.2）。
 *
 * content 结构：{ tool_name, tool_display_name?, status, input?, output?, error? }
 *
 * 形态（视觉基准：03 原型 .tool-line/.tool-out）：
 * - 行内条目：17px 小方图标容器 + 名称 + 状态 + chevron，无边框卡片。
 * - 运行中图标容器内 spinner；完成 ✓（success）；失败 !（destructive）。
 * - 点击展开浅灰输出块（bg-muted 圆角 pre：输入 / 输出 / 错误）。
 * - 重卡片只留给行动项（审批/diff），工具调用禁止使用边框卡片。
 */
"use client";

import { cn } from "@/lib/utils";
import type { ClientItem } from "@/lib/client/types";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

interface ToolCallItemProps {
  readonly item: ClientItem;
}

export function ToolCallItem({ item }: ToolCallItemProps) {
  const [expanded, setExpanded] = useState(false);
  const content = item.content as {
    tool_name?: string;
    tool_display_name?: string;
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
  };
  const isPending = item.item_state === "pending";
  const isFailed = item.item_state === "failed";
  const name = content.tool_display_name ?? content.tool_name ?? "Tool";

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={`tool-call-content-${item.id}`}
        className="-ml-2 inline-flex items-center gap-2 rounded-lg px-2 py-1 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-[17px] shrink-0 items-center justify-center rounded-[5px] text-2xs",
            isPending && "bg-secondary",
            isFailed && "bg-destructive/10 text-destructive",
            !isPending && !isFailed && "bg-success/10 text-success",
          )}
        >
          {isPending ? (
            <span className="size-[9px] animate-spin rounded-full border-[1.5px] border-border-strong border-t-ring" />
          ) : isFailed ? (
            "!"
          ) : (
            "✓"
          )}
        </span>
        <span className="text-foreground">{name}</span>
        {isPending && <span className="text-2xs text-foreground-subtle">执行中</span>}
        {isFailed && <span className="text-2xs text-destructive">失败</span>}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 text-foreground-subtle transition-transform duration-200",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && (
        <div id={`tool-call-content-${item.id}`} className="mt-2 rounded-[10px] bg-muted px-4 py-3">
          {content.input ? (
            <div className="mb-2">
              <div className="text-2xs text-foreground-subtle">输入</div>
              <pre className="mt-1 overflow-x-auto font-mono text-muted-foreground text-xs leading-relaxed">
                {JSON.stringify(content.input, null, 2)}
              </pre>
            </div>
          ) : null}
          {content.output ? (
            <div className="mb-1">
              <div className="text-2xs text-foreground-subtle">输出</div>
              <pre className="mt-1 overflow-x-auto font-mono text-muted-foreground text-xs leading-relaxed">
                {JSON.stringify(content.output, null, 2)}
              </pre>
            </div>
          ) : null}
          {content.error ? (
            <div role="alert">
              <div className="text-2xs text-destructive">错误</div>
              <pre className="mt-1 overflow-x-auto font-mono text-destructive text-xs leading-relaxed">
                {content.error}
              </pre>
            </div>
          ) : null}
          {!content.input && !content.output && !content.error && (
            <div className="text-foreground-subtle text-xs">暂无输出</div>
          )}
        </div>
      )}
    </div>
  );
}
