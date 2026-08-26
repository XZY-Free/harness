/**
 * Thread 输入框（W3-4 / W4-1 重构）。
 *
 * 结构：
 * - 大圆角（20px）容器，focus-within 边框加深 + 阴影浮起。
 * - 上方内嵌 PendingInputQueue（紧凑单行条，宽度与输入框对齐）。
 * - textarea 自增高，占位"随心输入，交给 Agent 处理…"。
 * - Enter 发送，Shift+Enter 换行，无常驻快捷键提示文字。
 * - 底部工具行：[＋] [助手选择器]（弹性空间）[模型选择器] [右下圆钮]
 *
 * W4-1 右下圆钮状态机（参考 codex 截图 3）：
 * - 运行中 + 输入框为空 → 黑色实心圆 + ■（点击 = interrupt，不弹确认）。
 * - 运行中 + 输入框有文字 → Send 箭头（消息送进 PendingInput 队列）。
 * - 空闲 → Send 箭头（创建正式 Turn）。
 * - 已请求停止（lastInterrupt !== null）→ 圆钮禁用 + title 显示"已请求停止，等待 Runtime 确认"。
 *
 * W4-1 引导：PendingInputQueue 的 ↳ 引导 按钮调用本组件的 useTurnControls.steer，
 * 把排队消息升级为对当前 Turn 的即时引导；成功后 PendingInputQueue 自行从队列移除。
 */
"use client";

import { useThreadDraft } from "@/components/hooks/use-thread-draft";
import { useThreadInput } from "@/components/hooks/use-thread-input";
import { useTurnControls } from "@/components/hooks/use-turn-controls";
import { Button } from "@/components/ui/button";
import type { ClientPendingInput, ClientThread, ClientTurn } from "@/lib/client/types";
import { cn } from "@/lib/utils";
import { Loader2, Send, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentOption,
  AgentSelectorPopover,
  ModelSelectorPopover,
  PlusMenuPopover,
} from "./input/input-popovers";
import { PendingInputQueue } from "./pending-input-queue";

interface ThreadInputProps {
  /** 真实 Thread id；null 表示新建页（首条消息经 onSubmitText 创建 Thread+Turn）。 */
  readonly threadId: string | null;
  readonly latestTurn: ClientTurn | null;
  readonly thread?: ClientThread | null;
  /** Desktop 已加载的真实助手列表。 */
  readonly availableAgents?: readonly AgentOption[];
  readonly onAgentChange?: (agentId: string) => void;
  readonly onModelChange?: (modelRef: string) => void;
  readonly settingsBusy?: boolean;
  /** 草稿隔离键；默认使用 threadId。 */
  readonly draftKey?: string;
  /** 新建页首条消息提交器；存在时不调用既有 Thread 的 turns 接口。 */
  readonly onSubmitText?: (text: string) => Promise<boolean>;
  readonly currentAgentId?: string | null;
  readonly currentModelRef?: string | null;
  /** 平台默认模型（shell.default_model_ref）；未显式选择时的即时展示。 */
  readonly defaultModelRef?: string;
}

/** 从 PendingInput.input 提取可读文本，作为引导请求体。 */
function extractPendingInputText(input: ClientPendingInput["input"]): string {
  if (typeof input.text === "string") return input.text;
  return JSON.stringify(input);
}

export function ThreadInput({
  threadId,
  latestTurn,
  thread,
  availableAgents,
  onAgentChange,
  onModelChange,
  draftKey,
  onSubmitText,
  currentAgentId,
  currentModelRef,
  defaultModelRef,
}: ThreadInputProps) {
  const {
    send,
    busy: threadBusy,
    error,
    route,
    clearError,
  } = useThreadInput({
    threadId,
    latestTurn,
  });
  // W4-1：停止/引导由 ThreadInput 内部承载，不再依赖顶部 TurnControls。
  // onSubmitText 用于新建会话首条消息（无 Turn），此时不需要 steer/interrupt。
  const turnId = latestTurn?.id ?? "";
  const {
    steer,
    interrupt,
    busy: turnBusy,
    error: turnError,
    lastInterrupt,
    clearError: clearTurnError,
  } = useTurnControls(turnId);

  // threadId 为 null 时仅新建页（必带 draftKey）会命中；调用方漏传时兜底到新建草稿键。
  const { text, setText, clear: clearDraft } = useThreadDraft(draftKey ?? threadId ?? "new-thread");
  const [customBusy, setCustomBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = threadBusy || customBusy || turnBusy;
  const isRunning = route === "pending_input";
  // 05 §10：Stop 可用 = isRunning AND latestTurn.controls.cancel_supported
  // （服务端 Binding 派生；cancel=false → 无可点击 Stop、不发送 interrupt API）。
  const cancelSupported = latestTurn?.controls?.cancel_supported ?? false;
  // 新建页（onSubmitText）不暴露停止按钮；停止按钮仅对既有 Thread + 运行中 Turn 生效。
  const stopAvailable = isRunning && !onSubmitText && turnId !== "" && cancelSupported;
  const stopRequested = lastInterrupt !== null;
  // 运行中且输入框为空 → 显示停止按钮；否则显示发送按钮。
  const showStopButton = stopAvailable && !text.trim();

  // textarea 自增高
  // biome-ignore lint/correctness/useExhaustiveDependencies: text 变化后必须重新测量 textarea 的 scrollHeight
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // 错误变化时聚焦回输入框，方便重试
  useEffect(() => {
    if (error && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [error]);

  const handleSend = async () => {
    if (!text.trim() || busy) return;
    setCustomBusy(Boolean(onSubmitText));
    let ok = false;
    try {
      ok = await (onSubmitText ?? send)(text);
    } finally {
      setCustomBusy(false);
    }
    if (ok) {
      clearDraft();
      // 重置高度
      const el = textareaRef.current;
      if (el) el.style.height = "auto";
      clearError();
    }
  };

  /** 直接停止当前 Turn（无确认对话框）。 */
  const handleStop = async () => {
    if (busy || stopRequested) return;
    await interrupt("user_requested_stop", true);
  };

  /** 引导：把排队消息升级为对当前 Turn 的即时引导。 */
  const handleSteer = useCallback(
    async (item: ClientPendingInput): Promise<boolean> => {
      if (!turnId) return false;
      return steer(extractPendingInputText(item.input));
    },
    [steer, turnId],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  };

  // 统一错误展示：发送错误 + 引导/停止错误
  const visibleError = error ?? turnError;
  const handleClearError = () => {
    clearError();
    clearTurnError();
  };

  return (
    <div className="sticky bottom-0 z-20 shrink-0 bg-background/95 pt-2 pb-[calc(16px+env(safe-area-inset-bottom))] backdrop-blur-sm">
      <div className="composer-track">
        {/* W4-1：待办队列移入输入框上方，宽度与输入框对齐；仅在真实 Thread 下渲染。 */}
        {threadId !== null && isRunning && !onSubmitText && (
          <PendingInputQueue threadId={threadId} onSteer={handleSteer} parentBusy={turnBusy} />
        )}

        {visibleError && (
          <div
            role="alert"
            className="mb-2 flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            <span>
              {visibleError.title}：{visibleError.description}
            </span>
            <button
              type="button"
              onClick={handleClearError}
              className="ml-2 shrink-0 rounded px-1.5 py-0.5 text-xs hover:bg-destructive/10"
              aria-label="关闭错误提示"
            >
              ✕
            </button>
          </div>
        )}

        {/* 大圆角容器 */}
        <div
          className={cn(
            "rounded-[20px] border border-border bg-background px-4 pb-2.5 pt-3.5 shadow-[0_2px_12px_rgba(0,0,0,0.03)] transition",
            "focus-within:border-foreground/20 focus-within:shadow-md",
          )}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="随心输入，交给 Agent 处理…"
            rows={1}
            aria-label={isRunning ? "队列消息输入框" : "消息输入框"}
            className={cn(
              "max-h-[120px] min-h-[24px] w-full resize-none bg-transparent text-[14.5px] leading-[1.6] text-foreground outline-none",
              "placeholder:text-muted-foreground",
            )}
            style={{ height: "auto", overflowY: "auto" }}
            disabled={busy}
          />

          {/* 底部工具行：窄屏标签收缩/截断，关键按钮不被挤出 */}
          <div className="mt-2 flex min-w-0 items-center gap-1">
            <PlusMenuPopover />

            {/* 专题01：Agent 选择器仅在建会话（new-thread 提供 onAgentChange）渲染；
                既有 Thread 不再绑主 Agent（primary_agent_id 已移除），选择无 handoff 动作，故不渲染。 */}
            {onAgentChange && (
              <AgentSelectorPopover
                currentAgentId={currentAgentId ?? null}
                onChange={onAgentChange}
                agentOptions={availableAgents}
              />
            )}

            <div className="flex-1" />

            <ModelSelectorPopover
              currentModelRef={currentModelRef ?? thread?.default_model_ref ?? null}
              platformDefaultModelRef={defaultModelRef}
              onChange={onModelChange}
            />

            {showStopButton ? (
              // W4-1：运行中且输入框为空 → 停止按钮（codex 形态）。
              // 直接 interrupt，不弹确认；已请求停止后禁用并显示加载态。
              <Button
                type="button"
                onClick={handleStop}
                disabled={busy || stopRequested}
                size="icon-sm"
                aria-label={stopRequested ? "已请求停止" : "停止任务"}
                title={stopRequested ? "已请求停止，等待 Runtime 确认" : "停止任务"}
                className="rounded-full bg-foreground text-background hover:bg-foreground/80"
              >
                {turnBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Square className="size-3.5 fill-current" />
                )}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleSend}
                disabled={busy || !text.trim()}
                size="icon-sm"
                className="rounded-full"
                aria-label={isRunning ? "加入队列" : "发送"}
              >
                <Send className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
