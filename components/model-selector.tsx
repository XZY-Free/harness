"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

/**
 * 自定义模型选择器：按钮 + 浮层（搜索 + 滚动列表 + 选中态）。
 * - direction: 浮层方向（输入框底部用 "up"，侧栏等用 "down"）
 * - compact: 紧凑模式（无边框、auto 宽、浮层固定宽），用于输入框工具栏
 */
export function ModelSelector({
  models,
  value,
  onChange,
  direction = "down",
  compact = false,
}: {
  models: { id: string; name?: string }[];
  value: string;
  onChange: (id: string) => void;
  direction?: "up" | "down";
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = models.filter(
    (m) =>
      m.id.toLowerCase().includes(q.toLowerCase()) ||
      m.name?.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={
          compact
            ? "flex max-w-[220px] items-center gap-2 rounded-[var(--radius)] px-3 py-1.5 text-left transition-all hover:bg-[var(--surface-2)] hover:scale-[1.02]"
            : "flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left transition-all hover:border-[var(--primary)]/40 hover:shadow-[var(--shadow-sm)]"
        }
      >
        <span className="truncate font-mono text-[13px] text-[var(--fg-muted)]">
          {value || "选择模型"}
        </span>
        <Icon.chevron
          size={14}
          className={`shrink-0 text-[var(--fg-subtle)] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          className={`animate-pop absolute z-50 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-pop)] ${
            direction === "up" ? "bottom-full mb-2" : "top-full mt-2"
          } ${compact ? "right-0 w-[280px]" : "w-full"}`}
        >
          <div className="flex items-center gap-2 border-[var(--border)] border-b px-3 py-2">
            <Icon.search size={14} className="shrink-0 text-[var(--fg-subtle)]" />
            <input
              // biome-ignore lint/a11y/noAutofocus: 浮层打开时聚焦搜索是预期交互
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索模型…"
              className="w-full bg-transparent font-mono text-[13px] outline-none placeholder:text-[var(--fg-subtle)]"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-[var(--fg-subtle)] text-sm">
                无匹配模型
              </div>
            ) : (
              filtered.map((m) => {
                const active = m.id === value;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onChange(m.id);
                      setOpen(false);
                      setQ("");
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left font-mono text-[13px] transition ${
                      active
                        ? "bg-[var(--accent-soft)] text-[var(--primary)]"
                        : "text-[var(--fg)] hover:bg-[var(--surface-2)]"
                    }`}
                  >
                    <span className="truncate">{m.name ?? m.id}</span>
                    {active && <Icon.check size={14} className="shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
