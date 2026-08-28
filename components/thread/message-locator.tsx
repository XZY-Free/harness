"use client";

import type { ClientItem } from "@/lib/client/types";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";

interface MessageLocatorProps {
  readonly items: readonly ClientItem[];
  readonly scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

interface Tick {
  readonly index: number;
  readonly itemId: string;
  readonly isUserMessage: boolean;
  readonly ratio: number;
}

const RADIUS = 44;

export function MessageLocator({ items, scrollContainerRef }: MessageLocatorProps) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [mouseY, setMouseY] = useState<number>(-1000);
  const [hoveredTick, setHoveredTick] = useState<Tick | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 测量刻度位置：优先 DOM 精确测量，未挂载时回退到均匀分布。
  // W4-1：依赖 items.length 而非 items 引用，避免 resnapshot 导致 items 引用变化
  // → 重新创建 ResizeObserver + 立即 measure → setTicks → 额外重渲染 → 布局抖动。
  // items 引用存在 ref 中，measure 时读取最新值。
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅依赖 items.length 数值变化
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const measure = () => {
      const currentItems = itemsRef.current;
      const scrollHeight = scrollContainer.scrollHeight;
      const containerHeight = scrollContainer.clientHeight;
      if (scrollHeight <= containerHeight) {
        setTicks((prev) => (prev.length === 0 ? prev : []));
        return;
      }

      const newTicks: Tick[] = [];
      for (let i = 0; i < currentItems.length; i++) {
        const item = currentItems[i];
        if (!item) continue;
        const el = scrollContainer.querySelector(
          `[data-item-id="${item.id}"]`,
        ) as HTMLElement | null;
        let ratio: number;
        if (el) {
          const rect = el.getBoundingClientRect();
          const containerRect = scrollContainer.getBoundingClientRect();
          const relativeTop = rect.top - containerRect.top + scrollContainer.scrollTop;
          ratio = relativeTop / scrollHeight;
        } else {
          ratio = currentItems.length > 1 ? i / (currentItems.length - 1) : 0.5;
        }
        ratio = Math.max(0, Math.min(1, ratio));
        newTicks.push({
          index: i,
          itemId: item.id,
          isUserMessage: item.item_type === "user_message" || item.item_type === "user_guidance",
          ratio,
        });
      }
      setTicks(newTicks);
    };

    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(scrollContainer);
    scrollContainer.addEventListener("scroll", measure);

    return () => {
      ro.disconnect();
      scrollContainer.removeEventListener("scroll", measure);
    };
  }, [items.length, scrollContainerRef]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMouseY(e.clientY - rect.top);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setMouseY(-1000);
    setHoveredTick(null);
  }, []);

  const handleTickClick = useCallback(
    (tick: Tick) => {
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) return;
      const el = scrollContainer.querySelector(
        `[data-item-id="${tick.itemId}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        const scrollHeight = scrollContainer.scrollHeight;
        const containerHeight = scrollContainer.clientHeight;
        scrollContainer.scrollTo({
          top: tick.ratio * (scrollHeight - containerHeight),
          behavior: "smooth",
        });
      }
    },
    [scrollContainerRef],
  );

  const getTickStyle = (tick: Tick): React.CSSProperties => {
    const containerHeight = containerRef.current?.clientHeight ?? 300;
    const tickY = tick.ratio * containerHeight;
    const distance = Math.abs(tickY - mouseY);

    let width = tick.isUserMessage ? 14 : 9;
    let opacity = 0.3;

    if (distance < RADIUS) {
      const factor = 1 - distance / RADIUS;
      width = tick.isUserMessage ? 14 + factor * 11 : 9 + factor * 13;
      const colorFactor = factor ** 3;
      opacity = 0.3 + colorFactor * 0.7;
    }

    return {
      top: `${tick.ratio * 100}%`,
      width: `${width}px`,
      opacity,
      transition: "width 130ms ease-out, opacity 130ms ease-out",
    };
  };

  if (ticks.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="absolute left-2.5 top-1/2 z-10 h-[80%] w-6 -translate-y-1/2"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {ticks.map((tick) => (
        <button
          key={tick.itemId}
          type="button"
          onClick={() => handleTickClick(tick)}
          onMouseEnter={() => setHoveredTick(tick)}
          onMouseLeave={() => setHoveredTick(null)}
          className={cn(
            "absolute left-1/2 h-[2px] -translate-x-1/2 cursor-pointer rounded-full bg-foreground",
            tick.isUserMessage && "h-[3px]",
          )}
          style={getTickStyle(tick)}
          aria-label={tick.isUserMessage ? "用户消息" : "时间线节点"}
        />
      ))}

      {hoveredTick?.isUserMessage && <PreviewCard tick={hoveredTick} items={items} />}
    </div>
  );
}

function PreviewCard({
  tick,
  items,
}: { readonly tick: Tick; readonly items: readonly ClientItem[] }) {
  const userItem = items[tick.index];
  if (!userItem) return null;
  const userText = extractItemText(userItem);

  let agentText = "";
  for (let i = tick.index + 1; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (item.item_type === "assistant_message") {
      agentText = extractItemText(item);
      break;
    }
  }

  return (
    <div className="absolute left-8 top-0 z-20 w-[480px] rounded-xl border border-border bg-popover p-4 shadow-lg">
      <div className="truncate text-sm font-semibold text-foreground">{userText || "用户消息"}</div>
      {agentText && (
        <div className="mt-2 line-clamp-5 text-xs text-muted-foreground">{agentText}</div>
      )}
    </div>
  );
}

function extractItemText(item: ClientItem): string {
  if (!item.content) return "";
  if (typeof item.content === "string") return item.content;
  if (typeof item.content === "object" && item.content !== null) {
    const c = item.content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    if (typeof c.message === "string") return c.message;
    if (typeof c.content === "string") return c.content;
  }
  return "";
}
