/**
 * PendingInput 队列 UI（S10-W03 / W4-1 重构）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W03：「PendingInput 可编辑、删除和排序，尚未正式发送的内容不出现在消息历史」
 * - W4-1：从时间线上方移入输入框正上方，紧凑单行条，宽度与输入框对齐。
 *
 * 职责：
 * - 展示 Thread 的 PendingInput 队列（仅 pending 状态，admitted/removed 不显示）。
 * - 每条 PendingInput 单行紧凑条：左侧序号 + 文本（截断），右侧 ↳ 引导 / 🗑 / ⋯（更多）。
 * - 「更多」收纳编辑 / 上移 / 下移，避免主操作区拥挤。
 * - ↳ 引导：调用 onSteer(item) 把排队消息升级为对当前 Turn 的即时引导，
 *   成功后由父组件负责从队列移除（删除 PendingInput）。
 * - 编辑模式：textarea 替代文本展示，确认/取消按钮。
 * - 重排：上移/下移调用 reorder([全量 ordered ids])。
 * - 错误展示：visibleError → 行内提示。
 * - 空队列不渲染（避免占位）。
 *
 * 不变量：
 * - 显示的是队列快照（usePendingInputs 维护），不重复出现在时间线中。
 * - 编辑/删除/重排/引导时禁用其他操作（busy=true）。
 * - 编辑需要资源 ETag，重排需要队列 ETag。
 * - 不在组件内自宣「已引导」——引导结果由父组件的 useTurnControls.lastSteer 投射。
 *
 * 使用：
 * ```tsx
 * <PendingInputQueue
 *   threadId={threadId}
 *   onSteer={async (item) => steer(extractText(item.input))}
 * />
 * ```
 */
"use client";

import { usePendingInputs } from "@/components/hooks/use-pending-inputs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ClientPendingInput } from "@/lib/client/types";
import { ArrowDown, ArrowUp, CornerDownRight, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

interface PendingInputQueueProps {
  readonly threadId: string;
  /**
   * 引导回调：把该条 PendingInput 文本升级为对当前 Turn 的即时引导。
   * 返回 true 表示引导请求已成功入队，父组件可继续删除该 PendingInput。
   * 不传时 ↳ 引导 按钮不渲染（如运行中 Turn 不存在的场景）。
   */
  readonly onSteer?: (item: ClientPendingInput) => Promise<boolean>;
  /** 父组件操作进行中（如引导/停止正在请求），用于禁用所有按钮。 */
  readonly parentBusy?: boolean;
}

/** 从 PendingInput.input 提取可读文本。 */
function extractText(input: ClientPendingInput["input"]): string {
  if (typeof input.text === "string") return input.text;
  return JSON.stringify(input);
}

export function PendingInputQueue({ threadId, onSteer, parentBusy }: PendingInputQueueProps) {
  const { pendingInputs, edit, remove, reorder, busy, error, refresh } =
    usePendingInputs(threadId);

  // 编辑状态：pendingInputId → 编辑文本
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  // 引导进行中的 PendingInput id（避免同一行重复点击）
  const [steeringId, setSteeringId] = useState<string | null>(null);

  // 只显示 pending 状态的 PendingInput（admitted/removed 不显示）
  const visibleQueue = pendingInputs;
  const actionBusy = busy || parentBusy;

  // 当队列长度为 0 且无错误时不渲染（避免空容器跳动；有错误时仍渲染以展示错误）
  if (visibleQueue.length === 0 && !error) return null;

  const startEdit = (item: ClientPendingInput) => {
    setEditingId(item.id);
    setEditingText(extractText(item.input));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingText("");
  };

  const confirmEdit = async (item: ClientPendingInput) => {
    if (!editingText.trim()) return;
    const ok = await edit(item.id, item.etag, { type: "message", text: editingText });
    if (ok) cancelEdit();
  };

  const handleRemove = async (item: ClientPendingInput) => {
    await remove(item.id, item.etag);
  };

  /** 上移：交换 index 与 index-1。 */
  const handleMoveUp = async (index: number) => {
    if (index === 0) return;
    const ids = visibleQueue.map((p) => p.id);
    const a = ids[index - 1];
    const b = ids[index];
    if (a === undefined || b === undefined) return;
    ids[index - 1] = b;
    ids[index] = a;
    await reorder(ids);
  };

  /** 下移：交换 index 与 index+1。 */
  const handleMoveDown = async (index: number) => {
    if (index === visibleQueue.length - 1) return;
    const ids = visibleQueue.map((p) => p.id);
    const a = ids[index];
    const b = ids[index + 1];
    if (a === undefined || b === undefined) return;
    ids[index] = b;
    ids[index + 1] = a;
    await reorder(ids);
  };

  /** 引导：调用父组件 steer，成功后删除该 PendingInput（已被升级为正式引导）。 */
  const handleSteer = async (item: ClientPendingInput) => {
    if (!onSteer || actionBusy) return;
    setSteeringId(item.id);
    try {
      const ok = await onSteer(item);
      if (ok) {
        await remove(item.id, item.etag);
      }
    } finally {
      setSteeringId(null);
    }
  };

  return (
    <section aria-label="待办消息队列" className="flex flex-col gap-1.5">
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-2xs text-destructive"
        >
          <span className="truncate">
            {error.title}：{error.description}
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="ml-2 shrink-0 rounded px-1.5 py-0.5 text-2xs hover:bg-destructive/10"
            aria-label="重试加载队列"
          >
            重试
          </button>
        </div>
      )}

      <ul className="flex flex-col gap-1">
        {visibleQueue.map((item, index) => {
          const isEditing = editingId === item.id;
          const isSteering = steeringId === item.id;
          return (
            <li
              key={item.id}
              className={cn(
                "flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 transition",
                actionBusy && "opacity-60",
              )}
            >
              {/* 位置序号 */}
              <span
                className="shrink-0 rounded-full bg-foreground-subtle/15 px-1.5 text-3xs font-mono text-foreground-subtle"
                aria-label={`队列位置 ${index + 1}`}
              >
                {index + 1}
              </span>

              {/* 内容或编辑框 */}
              <div className="min-w-0 flex-1">
                {isEditing ? (
                  <textarea
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    rows={2}
                    aria-label="编辑队列消息"
                    className="w-full resize-none rounded-[var(--radius-sm)] border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary/60"
                    // biome-ignore lint/a11y/noAutofocus: 编辑模式开启时即时聚焦是预期交互
                    autoFocus
                  />
                ) : (
                  <p className="truncate text-sm text-foreground" title={extractText(item.input)}>
                    {extractText(item.input)}
                  </p>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex shrink-0 items-center gap-0.5">
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void confirmEdit(item)}
                      disabled={actionBusy || !editingText.trim()}
                      aria-label="确认编辑"
                      className="rounded px-1.5 py-1 text-2xs text-success hover:bg-success/10 disabled:opacity-30"
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={actionBusy}
                      aria-label="取消编辑"
                      className="rounded px-1.5 py-1 text-2xs text-muted-foreground hover:bg-muted disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </>
                ) : (
                  <>
                    {onSteer && (
                      <button
                        type="button"
                        onClick={() => void handleSteer(item)}
                        disabled={actionBusy || isSteering}
                        aria-label="升级为即时引导"
                        title="升级为即时引导"
                        className="flex items-center gap-0.5 rounded px-1.5 py-1 text-2xs text-foreground-subtle transition hover:bg-muted hover:text-foreground disabled:opacity-30"
                      >
                        <CornerDownRight className="size-3" strokeWidth={1.5} />
                        引导
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleRemove(item)}
                      disabled={actionBusy}
                      aria-label="删除"
                      title="删除"
                      className="rounded px-1.5 py-1 text-foreground-subtle hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                    >
                      <Trash2 className="size-3" strokeWidth={1.5} />
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        type="button"
                        aria-label="更多操作"
                        title="更多操作"
                        disabled={actionBusy}
                        className="rounded px-1.5 py-1 text-foreground-subtle hover:bg-muted hover:text-foreground disabled:opacity-30"
                      >
                        <MoreHorizontal className="size-3" strokeWidth={1.5} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" sideOffset={4}>
                        <DropdownMenuItem
                          onClick={() => void handleMoveUp(index)}
                          disabled={actionBusy || index === 0}
                        >
                          <ArrowUp className="size-3.5" strokeWidth={1.5} />
                          上移
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => void handleMoveDown(index)}
                          disabled={actionBusy || index === visibleQueue.length - 1}
                        >
                          <ArrowDown className="size-3.5" strokeWidth={1.5} />
                          下移
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => startEdit(item)} disabled={actionBusy}>
                          <Pencil className="size-3.5" strokeWidth={1.5} />
                          编辑
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
