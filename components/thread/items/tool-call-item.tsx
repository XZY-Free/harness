/**
 * Tool 调用 Item（tool_call）——W3-3 轻量行内条目形态（方案 §4.2）。
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

import type { ClientItem } from "@/lib/client/types";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, CircleAlert, CircleSlash2, LoaderCircle } from "lucide-react";
import { useState } from "react";

interface ToolCallItemProps {
  readonly item: ClientItem;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fileNameFromInput(input: unknown): string | null {
  const record = asRecord(input);
  if (!record) return null;
  const candidate = [record.path, record.file_path, record.filename].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!candidate) return null;
  return candidate.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? null;
}

function readableToolName(toolName: string | undefined, input: unknown): string {
  const normalized = toolName?.trim().toLowerCase() ?? "";
  const fileName = fileNameFromInput(input);
  if (["read", "read_file", "read_text_file"].includes(normalized)) {
    return fileName ? `读取 ${fileName}` : "读取文件";
  }
  if (["write", "write_file", "edit", "edit_file", "apply_patch"].includes(normalized)) {
    return fileName ? `编辑 ${fileName}` : "编辑文件";
  }
  if (["list_directory", "list_files"].includes(normalized)) return "查看文件夹";
  if (["search", "search_files", "grep", "ripgrep"].includes(normalized)) return "搜索文件";
  if (["run", "run_command", "shell", "exec", "exec_command"].includes(normalized)) {
    return "运行命令";
  }
  if (["browser", "open_url", "navigate"].includes(normalized)) return "浏览网页";
  return "执行操作";
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
  const isCancelled = item.item_state === "cancelled" || item.item_state === "superseded";
  const name = content.tool_display_name ?? readableToolName(content.tool_name, content.input);
  const statusLabel = isPending ? "执行中" : isFailed ? "失败" : isCancelled ? "已取消" : "已完成";

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={`tool-call-content-${item.id}`}
        className="-ml-1.5 inline-flex max-w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span
          aria-label={`工具状态：${statusLabel}`}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-md",
            isPending && "bg-muted text-muted-foreground",
            isFailed && "bg-destructive/10 text-destructive",
            isCancelled && "bg-muted text-foreground-subtle",
            !isPending && !isFailed && !isCancelled && "bg-success/10 text-success",
          )}
        >
          {isPending ? (
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
          ) : isFailed ? (
            <CircleAlert aria-hidden="true" className="size-3.5" />
          ) : isCancelled ? (
            <CircleSlash2 aria-hidden="true" className="size-3.5" />
          ) : (
            <Check aria-hidden="true" className="size-3.5" />
          )}
        </span>
        <span className="truncate text-foreground">{name}</span>
        {isPending && <span className="text-2xs text-foreground-subtle">执行中</span>}
        {isFailed && <span className="text-2xs text-destructive">失败</span>}
        {isCancelled && <span className="text-2xs text-foreground-subtle">已取消</span>}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 text-foreground-subtle transition-transform duration-200",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && (
        <div
          id={`tool-call-content-${item.id}`}
          className="mt-1.5 overflow-hidden rounded-lg border border-border/70 bg-muted/55 px-3.5 py-3"
        >
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
