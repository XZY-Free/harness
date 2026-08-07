/**
 * 过程流折叠条（W3-3，方案 §4.1/§4.3）。
 *
 * 职责：
 * - 收纳一个 Turn 内的过程类内容（工具调用等），"已处理"默认收起、点击展开。
 * - 运行中（存在 pending 过程项）：默认展开，标签"正在处理 Ns"实时跳秒；
 *   全部完成后切换为"已处理 [Ns]"并自动收起。
 * - 展开/收起用 CSS grid rows 过渡（内容高度未知时仍平滑）。
 *
 * 视觉参数由当前 Desktop 对话样式维护。
 */
"use client";

import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

interface ProcessFoldProps {
  /** 过程是否仍在进行（存在 pending 工具调用）。 */
  readonly running: boolean;
  /** 过程起始时间（ISO），用于运行中计时与完成后时长展示。 */
  readonly startedAt?: string;
  /** 过程结束时间（ISO，完成后传入）。 */
  readonly endedAt?: string;
  readonly children: ReactNode;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export function ProcessFold({ running, startedAt, endedAt, children }: ProcessFoldProps) {
  // 运行中默认展开；完成后默认收起
  const [open, setOpen] = useState(running);
  const [elapsed, setElapsed] = useState(0);
  const wasRunning = useRef(running);

  // 运行中实时跳秒
  useEffect(() => {
    if (!running) return;
    const start = startedAt ? new Date(startedAt).getTime() : Date.now();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [running, startedAt]);

  // 运行 → 完成：自动收纳（原型的收纳动效）
  useEffect(() => {
    if (wasRunning.current && !running) {
      setOpen(false);
    }
    wasRunning.current = running;
  }, [running]);

  const doneSeconds =
    startedAt && endedAt
      ? Math.max(
          0,
          Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000),
        )
      : null;

  const label = running
    ? `正在处理 ${formatDuration(elapsed)}`
    : doneSeconds !== null && doneSeconds > 0
      ? `已处理 ${formatDuration(doneSeconds)}`
      : "已处理";

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-border border-b py-2 text-left text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-foreground-subtle transition-transform duration-200",
            open && "rotate-90",
          )}
        />
        <span className="tabular-nums">{label}</span>
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="pt-3 pb-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
