"use client";

import { Icon } from "@/components/icons";
import { Markdown } from "@/components/markdown";
import type { WorkspacePanelView } from "@/components/workspace-panel/types";
import { isAttachmentDataPart, isAttachmentTextPart } from "@/lib/chat/attachments";
import { isInternalToolPart } from "@/lib/chat/internal-tools";
import type { ChatMessage } from "@/lib/types";
import { cn, formatMessageTime } from "@/lib/utils";
import React from "react";
import { ActionCard } from "./action-card";
import { ReasoningCard } from "./reasoning-card";
import {
  type ToolPart,
  getAttachmentParts,
  getImageParts,
  getVisibleTextFromMessage,
} from "./utils";

/**
 * 12-P1-2 / 12-P2-1：单条消息渲染抽离。
 *
 * 从 chat-panel.tsx 的 messages.map 体内嵌渲染抽出，供虚拟滚动 MessageList 复用。
 * 同时承载 user / assistant 两种消息渲染分支（图片 + 附件 + 文本气泡 + reasoning + tool 调用）。
 */

export interface MessageRowProps {
  message: ChatMessage;
  /** 是否最后一条 assistant 消息（用于流式判断 + hover 操作栏） */
  isLastAssistant: boolean;
  /** 当前是否流式输出（最后一条 assistant 且 status streaming/submitted） */
  isStreamingThis: boolean;
  /** 编辑态：editingId === message.id */
  isEditing: boolean;
  /** 是否最后一条 user 消息（控制编辑入口「重新生成」vs「发送」） */
  isLastUser: boolean;
  /** 编辑中的文本 */
  editText: string;
  /** busy 状态（编辑提交按钮 disabled） */
  busy: boolean;
  /** 编辑文本变更 */
  onEditTextChange: (text: string) => void;
  /** 确认编辑 */
  onConfirmEdit: () => void;
  /** 取消编辑 */
  onCancelEdit: () => void;
  /** 进入编辑 */
  onStartEdit: (messageId: string, text: string) => void;
  /** 复制文本 */
  onCopy: (text: string) => void;
  /** 重新生成（最后一条 assistant 用） */
  onRegenerate: () => void;
  /**
   * V5-C1：点击工具卡片「查看产物」按钮时上抛对应视图。
   * 父级（ChatPanel）已绑定 threadId，这里只需传 view。
   */
  onOpenWorkspace?: (view: WorkspacePanelView) => void;
}

export const MessageRow = React.memo(function MessageRow({
  message: m,
  isLastAssistant,
  isStreamingThis,
  isEditing,
  isLastUser,
  editText,
  busy,
  onEditTextChange,
  onConfirmEdit,
  onCancelEdit,
  onStartEdit,
  onCopy,
  onRegenerate,
  onOpenWorkspace,
}: MessageRowProps) {
  const isUser = m.role === "user";
  const time = formatMessageTime(m.createdAt);

  /* ========== user 消息：分组渲染（图片 + 附件 + 文本气泡）========== */
  if (isUser) {
    const text = getVisibleTextFromMessage(m);
    const imgParts = getImageParts(m);
    const attParts = getAttachmentParts(m);
    return (
      <div className={cn("group/user-msg flex animate-rise", "justify-end")}>
        <div
          data-testid="message-content"
          className="ml-auto flex w-fit max-w-[85%] min-w-0 flex-col gap-2 max-sm:max-w-full"
        >
          {time ? (
            <span className="px-1 text-right text-[11px] text-[var(--fg-subtle)]">{time}</span>
          ) : null}
          {imgParts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {imgParts.map((ip, idx) => (
                <img
                  key={`${m.id}-img-${idx}`}
                  src={ip.url}
                  alt={ip.filename ?? "附件"}
                  className="max-h-[240px] max-w-full rounded-[var(--radius-lg)] object-contain"
                />
              ))}
            </div>
          )}
          {attParts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attParts.map((ap, idx) => (
                <div
                  key={`${m.id}-att-${idx}`}
                  className="flex items-center gap-2 rounded-[var(--radius)] bg-white/15 px-3 py-2 text-[13px] text-white"
                >
                  <Icon.fileText size={14} className="text-white/80" />
                  <span className="max-w-[200px] truncate">{ap.filename}</span>
                  <span className="text-[11px] text-white/60">
                    {ap.charCount.toLocaleString()} 字符
                  </span>
                </div>
              ))}
            </div>
          )}
          {text && (
            <div className="relative">
              {isEditing ? (
                /* 编辑状态：内联 textarea */
                <div className="rounded-[var(--radius-lg)] border-2 border-[var(--primary)] bg-[var(--bg)] shadow-[var(--shadow-md)]">
                  <textarea
                    className="min-h-[60px] w-full resize-y rounded-[var(--radius-lg)] bg-transparent px-4 py-2.5 text-[14px] leading-7 outline-none placeholder:text-[var(--fg-subtle)]"
                    rows={2}
                    value={editText}
                    onChange={(e) => onEditTextChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        onConfirmEdit();
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        onCancelEdit();
                      }
                    }}
                  />
                  <div className="flex items-center justify-end gap-1.5 border-t border-[var(--border)] px-3 py-1.5">
                    <button
                      type="button"
                      onClick={onCancelEdit}
                      className="rounded-[var(--radius-sm)] px-2.5 py-1 text-[12px] text-[var(--fg-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={onConfirmEdit}
                      disabled={!editText.trim() || busy}
                      className="rounded-[var(--radius-sm)] bg-[var(--primary)] px-2.5 py-1 text-[12px] text-[var(--accent-fg)] transition hover:bg-[var(--accent-hover)] disabled:opacity-30"
                    >
                      {isLastUser ? "重新生成" : "发送"}
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  {/* 正常文本气泡 — 无边框，实色背景 */}
                  <div className="whitespace-pre-wrap break-words rounded-[var(--radius-lg)] bg-[var(--primary)] px-4 py-2.5 text-[14px] leading-7 text-white shadow-[var(--shadow-sm)]">
                    {text}
                  </div>
                  {/* hover 操作栏 */}
                  <div className="-mt-1 flex justify-end opacity-0 transition-opacity group-hover/user-msg:opacity-100">
                    <div className="flex items-center gap-0.5 rounded-full bg-[var(--surface)] px-1.5 py-1 shadow-[var(--shadow-sm)]">
                      <button
                        type="button"
                        title="复制消息"
                        onClick={() => onCopy(text)}
                        className="flex size-6 items-center justify-center rounded-full text-[var(--fg-subtle)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
                      >
                        <Icon.copy size={13} />
                      </button>
                      <button
                        type="button"
                        title="编辑消息"
                        onClick={() => onStartEdit(m.id, text)}
                        className={`flex size-6 items-center justify-center rounded-full text-[var(--fg-subtle)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)] ${!isLastUser ? "hidden" : ""}`}
                      >
                        <Icon.pencil size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ========== assistant 消息：按 parts 时间线顺序交错渲染 ========== */
  return (
    <div className={cn("group/assistant-msg flex animate-rise", "justify-start")}>
      <div
        data-testid="message-content"
        className="flex w-[85%] min-w-0 flex-col gap-1 max-sm:w-full"
      >
        {time ? <span className="px-1 text-[11px] text-[var(--fg-subtle)]">{time}</span> : null}
        {(m.parts ?? []).map((p, idx) => {
          // step-start: 流式步骤标记，UI 不渲染
          if (p.type === "step-start") return null;
          // reasoning 思考卡片
          if (p.type === "reasoning" && typeof (p as { text?: unknown }).text === "string") {
            return (
              <ReasoningCard
                key={`${m.id}-part-${idx}`}
                text={(p as { text: string }).text}
                isStreaming={isStreamingThis}
              />
            );
          }
          // file 图片
          if (p.type === "file" && p.mediaType.startsWith("image/")) {
            return (
              <img
                key={`${m.id}-part-${idx}`}
                src={p.url}
                alt={p.filename ?? "附件"}
                className="max-h-[240px] max-w-full rounded-[var(--radius-lg)] object-contain"
              />
            );
          }
          // data-attachment 文档附件
          if (isAttachmentDataPart(p)) {
            const ap = p.data;
            return (
              <div
                key={`${m.id}-part-${idx}`}
                className="flex items-center gap-2 rounded-[var(--radius)] bg-[var(--accent-soft)]/40 px-3 py-2 text-[13px]"
              >
                <Icon.fileText size={14} className="text-[var(--primary)]" />
                <span className="max-w-[200px] truncate">{ap.filename}</span>
                <span className="text-[11px] text-[var(--fg-muted)]">
                  {ap.charCount.toLocaleString()} 字符
                </span>
              </div>
            );
          }
          // text 文本（Markdown 渲染）— 无边框，纯文字流
          if (p.type === "text") {
            if (isAttachmentTextPart(p)) return null;
            const t = p.text;
            if (!t.trim()) return null;
            return (
              <div
                key={`${m.id}-part-${idx}`}
                className="px-1 py-0.5 text-[14px] leading-7 text-[var(--fg)] prose-markdown"
              >
                <Markdown>{t}</Markdown>
              </div>
            );
          }
          // tool-* 工具调用
          if (typeof p.type === "string" && p.type.startsWith("tool-")) {
            // V5-E：内部编排类工具（MCP / 子代理派生汇合）不渲染卡片，
            // 员工不应感知「MCP」协议或子代理存在；详细 tool run 仍可在 Studio 查看。
            if (isInternalToolPart(p)) return null;
            return (
              <ActionCard
                key={`${m.id}-part-${idx}`}
                part={p as ToolPart}
                type={p.type}
                onOpenWorkspace={onOpenWorkspace}
              />
            );
          }
          return null;
        })}
        {/* D-2: 最后一条 assistant 消息 hover 操作栏 */}
        {isLastAssistant && !isStreamingThis && (
          <div className="-mt-0.5 flex justify-start opacity-0 transition-opacity group-hover/assistant-msg:opacity-100">
            <div className="flex items-center gap-0.5 rounded-full bg-[var(--surface)] px-1.5 py-1 shadow-[var(--shadow-sm)]">
              <button
                type="button"
                title="重新生成"
                onClick={() => onRegenerate()}
                className="flex size-6 items-center justify-center rounded-full text-[var(--fg-subtle)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
              >
                <Icon.refresh size={13} />
              </button>
              <button
                type="button"
                title="复制回复"
                onClick={() => onCopy(getVisibleTextFromMessage(m))}
                className="flex size-6 items-center justify-center rounded-full text-[var(--fg-subtle)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
              >
                <Icon.copy size={13} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
