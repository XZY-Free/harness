"use client";

import { Icon } from "@/components/icons";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

/**
 * 思考卡片 — 极简 inline 风格，类似 TRAE Code 的「思考过程 〉」
 * - 流式输出中：展开显示内容 + 末尾光标动画
 * - 完成后：自动折叠，点击标题栏可展开/收起
 */
export function ReasoningCard({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(isStreaming);
  const prevStreamingRef = useRef(isStreaming);

  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;

    if (wasStreaming && !isStreaming) {
      const timer = setTimeout(() => setExpanded(false), 600);
      return () => clearTimeout(timer);
    }
    if (isStreaming && !expanded) {
      setExpanded(true);
    }
  }, [isStreaming, expanded]);

  const hasContent = text.trim().length > 0;
  if (!hasContent) return null;

  const summary =
    text
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim()
      .slice(0, 80) ?? "";

  return (
    <div className="py-1">
      {/* 标题栏 — 纯文字行 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 py-1 text-left text-[13px] text-[var(--fg-muted)] transition hover:text-[var(--fg)]"
      >
        {isStreaming ? (
          <span className="flex size-4 items-center justify-center">
            <span className="size-1.5 rounded-full bg-[var(--primary)] animate-pulse" />
          </span>
        ) : (
          <Icon.sparkles size={14} className="text-[var(--fg-subtle)]" />
        )}
        <span className="font-medium">思考</span>
        {summary && !expanded && (
          <span className="truncate text-[var(--fg-subtle)] max-w-[420px]">{summary}</span>
        )}
        {!isStreaming && (
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn("ml-auto transition-transform duration-200", expanded && "rotate-180")}
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        )}
      </button>

      {/* 展开的内容区 */}
      {expanded && (
        <div
          data-testid="reasoning-content"
          className="ml-6 border-l border-[var(--border)]/40 pl-4 py-2 prose-markdown"
        >
          <Markdown>{text}</Markdown>
          {isStreaming && (
            <span className="inline-block w-1.5 h-4 bg-[var(--primary)] animate-pulse ml-0.5 align-middle" />
          )}
        </div>
      )}
    </div>
  );
}
