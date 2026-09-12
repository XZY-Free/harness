"use client";

import type { ClientItem } from "@/lib/client/types";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";

interface MessageLocatorProps {
  readonly items: readonly ClientItem[];
  readonly scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  readonly onNavigate?: (atBottom: boolean) => void;
}

interface TurnTick {
  /** 回合锚点（该回合首条用户消息）在 items 中的下标。 */
  readonly index: number;
  readonly itemId: string;
  readonly label: string;
}

/** v7 合同参数：固定步长 12px、整簇垂直居中；磁吸半径 5 回合（回合坐标空间）；
 * 静止宽 10px / opacity 0.35；聚焦宽 30px / opacity 1；左缘对齐仅向右生长；
 * 在轴零过渡直跟，离轴 140ms 收拢；左侧自由边距 < 32px 隐藏。 */
const FIXED_STEP = 12;
const FALLBACK_HEIGHT = 320;
const RADIUS_IDX = 5;
const BASE_W = 10;
const GROW = 20;
const REST_O = 0.35;
const FREE_LEFT_MIN = 32;
const SETTLE_MS = 180;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function itemKindLabel(item: ClientItem): string {
  switch (item.item_type) {
    case "user_message":
    case "user_guidance":
      return "用户消息";
    case "assistant_message":
      return "助手回复";
    case "tool_call":
      return "运行过程";
    case "artifact":
      return "会话产物";
    case "user_action":
      return "待确认操作";
    default:
      return "时间线节点";
  }
}

function locatorLabel(item: ClientItem): string {
  const text = extractItemText(item).replace(/\s+/g, " ").trim();
  return text ? `${itemKindLabel(item)}：${text.slice(0, 72)}` : itemKindLabel(item);
}

function isUserItem(item: ClientItem): boolean {
  return item.item_type === "user_message" || item.item_type === "user_guidance";
}

/** 刻度粒度 = 问答回合：回合 = 一条用户消息起、至下一条用户消息前（含助手回复与过程折叠）。
 * 刻度数与用户发送数严格 1:1；会话开头的非用户 Item（如恢复态）归入首回合锚点。 */
function buildTurnTicks(items: readonly ClientItem[]): TurnTick[] {
  const ticks: TurnTick[] = [];
  items.forEach((item, index) => {
    if (index === 0 || isUserItem(item)) {
      ticks.push({ index, itemId: item.id, label: locatorLabel(item) });
    }
  });
  return ticks;
}

export function MessageLocator({ items, scrollContainerRef, onNavigate }: MessageLocatorProps) {
  const navigationRef = useRef<HTMLElement>(null);
  const settleTimerRef = useRef<number | null>(null);
  const [navHeight, setNavHeight] = useState(FALLBACK_HEIGHT);
  const [pointerY, setPointerY] = useState(-1);
  const [focusIndex, setFocusIndex] = useState(-1);
  const [settling, setSettling] = useState(false);
  const [hidden, setHidden] = useState(false);

  const ticks = buildTurnTicks(items);
  const count = ticks.length;
  const step = count > 1 ? Math.min(FIXED_STEP, navHeight / (count - 1)) : FIXED_STEP;
  const clusterTop = count > 1 ? (navHeight - (count - 1) * step) / 2 : navHeight / 2;

  // 轴盒高度：固定步长与整簇居中只依赖它，不量内容。
  useEffect(() => {
    const nav = navigationRef.current;
    if (!nav) return;
    const update = () => setNavHeight(nav.clientHeight || FALLBACK_HEIGHT);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(nav);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  // 窄 pane 自动隐藏：左侧自由边距（居中留白 + track 起始 padding）< 32px 时让位正文。
  // 布局不可测量（宽度 0，测试/首帧）时保持显示，避免误判。
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    const evaluate = () => {
      const containerWidth = scrollContainer.clientWidth;
      if (containerWidth <= 0) {
        setHidden(false);
        return;
      }
      const track = scrollContainer.querySelector<HTMLElement>(".message-track");
      const trackWidth = track?.offsetWidth ?? containerWidth;
      const gutter = Math.max(0, (containerWidth - trackWidth) / 2);
      const padding = track
        ? Number.parseFloat(getComputedStyle(track).paddingLeft || "0") || 0
        : 0;
      setHidden(gutter + padding < FREE_LEFT_MIN);
    };
    evaluate();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(evaluate);
    observer?.observe(scrollContainer);
    scrollContainer.addEventListener("scroll", evaluate, { passive: true });
    window.addEventListener("resize", evaluate);
    return () => {
      observer?.disconnect();
      scrollContainer.removeEventListener("scroll", evaluate);
      window.removeEventListener("resize", evaluate);
    };
  }, [scrollContainerRef]);

  useEffect(() => {
    return () => {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    };
  }, []);

  // 在轴上：零延迟直跟（同步写状态，不经 rAF/transition 低通）。
  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const rect = navigationRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    setSettling(false);
    setPointerY(event.clientY - rect.top);
  }, []);

  const handlePointerLeave = useCallback(() => {
    setPointerY(-1);
    setSettling(true);
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      setSettling(false);
    }, SETTLE_MS);
  }, []);

  const handleTickClick = useCallback(
    (tick: TurnTick) => {
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) return;
      const element = Array.from(
        scrollContainer.querySelectorAll<HTMLElement>("[data-item-id]"),
      ).find((candidate) => candidate.dataset.itemId === tick.itemId);
      if (!element) return;
      const maximumScroll = Math.max(
        0,
        scrollContainer.scrollHeight - scrollContainer.clientHeight,
      );
      const scrollRect = scrollContainer.getBoundingClientRect();
      const elementTop =
        scrollContainer.scrollTop + element.getBoundingClientRect().top - scrollRect.top;
      const targetTop = Math.max(
        0,
        Math.min(maximumScroll, elementTop - scrollContainer.clientHeight * 0.42),
      );
      onNavigate?.(maximumScroll - targetTop <= 100);
      scrollContainer.scrollTo({
        top: targetTop,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    },
    [onNavigate, scrollContainerRef],
  );

  const pointerOn = pointerY >= 0;
  const center = pointerOn && step > 0 ? (pointerY - clusterTop) / step : null;
  const pointerFocused =
    center !== null && count > 0 ? Math.max(0, Math.min(count - 1, Math.round(center))) : -1;
  const focused = pointerOn ? pointerFocused : focusIndex;

  return (
    <nav
      ref={navigationRef}
      aria-label="会话位置导航"
      data-empty={count === 0 ? "true" : "false"}
      className={cn(
        "message-locator pointer-events-none absolute inset-y-[clamp(1rem,8%,4rem)] left-[clamp(0.25rem,1vw,0.75rem)] z-20 w-10 select-none",
        settling && "settling",
        hidden && "message-locator-hidden",
      )}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      {ticks.map((tick, i) => {
        const influence = center !== null ? Math.max(0, 1 - Math.abs(i - center) / RADIUS_IDX) : 0;
        const isFocused = i === focused;
        const factor = Math.max(influence, isFocused ? 1 : 0);
        return (
          <button
            key={tick.itemId}
            type="button"
            aria-label={tick.label}
            onClick={() => handleTickClick(tick)}
            onFocus={() => setFocusIndex(i)}
            onBlur={() => setFocusIndex(-1)}
            className="pointer-events-auto absolute left-0 flex h-6 w-8 -translate-y-1/2 cursor-pointer items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            style={{ top: `${clusterTop + i * step}px` }}
          >
            <span
              aria-hidden="true"
              className={cn(
                "message-locator-tick ml-1 block h-0.5 origin-left rounded-full bg-foreground",
                settling && "transition-[width,opacity] duration-[140ms] ease-out",
              )}
              style={{
                width: `${BASE_W + factor * GROW}px`,
                opacity: isFocused ? 1 : REST_O,
              }}
            />
          </button>
        );
      })}

      {focused >= 0 && ticks[focused] ? (
        <PreviewCard
          tick={ticks[focused]}
          ticks={ticks}
          items={items}
          top={clusterTop + focused * step}
          navHeight={navHeight}
        />
      ) : null}
    </nav>
  );
}

function PreviewCard({
  tick,
  ticks,
  items,
  top,
  navHeight,
}: {
  readonly tick: TurnTick;
  readonly ticks: readonly TurnTick[];
  readonly items: readonly ClientItem[];
  readonly top: number;
  readonly navHeight: number;
}) {
  const userItem = items[tick.index];
  if (!userItem) return null;
  const userText = extractItemText(userItem);

  const tickPosition = ticks.indexOf(tick);
  const turnEnd =
    tickPosition >= 0 ? (ticks[tickPosition + 1]?.index ?? items.length) : items.length;
  let agentText = "";
  for (let index = tick.index + 1; index < turnEnd; index++) {
    const item = items[index];
    if (item?.item_type === "assistant_message") {
      agentText = extractItemText(item);
      break;
    }
  }

  const verticalAlignment =
    top < navHeight * 0.15
      ? "translateY(0)"
      : top > navHeight * 0.85
        ? "translateY(-100%)"
        : "translateY(-50%)";

  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute left-8 z-30 w-[30rem] max-w-[calc(100cqw-4.25rem)] rounded-xl border border-border/80 bg-popover/95 p-4 text-left shadow-[0_10px_30px_rgba(15,23,42,0.10)] backdrop-blur-md"
      style={{ top: `${top}px`, transform: verticalAlignment }}
    >
      <p className="truncate text-[13px] font-semibold leading-5 text-foreground">
        {userText || "用户消息"}
      </p>
      {agentText ? (
        <p className="mt-2 line-clamp-5 text-xs leading-[1.55] text-muted-foreground">
          {agentText}
        </p>
      ) : (
        <p className="mt-2 text-xs text-foreground-subtle">尚无回复</p>
      )}
    </div>
  );
}

function extractItemText(item: ClientItem): string {
  if (!item.content) return "";
  if (typeof item.content === "string") return item.content;
  if (typeof item.content === "object" && item.content !== null) {
    const content = item.content as Record<string, unknown>;
    for (const key of ["text", "message", "content", "title", "summary", "short_purpose"]) {
      const value = content[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return "";
}
