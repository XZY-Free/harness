/**
 * Thread 任务时间线（S10-W02 / S10-W08 / W3-3）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W02：「时间线覆盖用户与 Agent Item、公开进度、ToolCall、Artifact、UserAction、Child Thread 与 Job 结果投影」
 *   S10-W08：「长 Thread、密集 Tool/Event 和大 Artifact 列表保持可交互，按需加载不改变事件顺序」
 * - docs/solutions/desktop-ui-redesign/04-light-theme-and-conversation.md §4（W3-3 分层原则）
 *
 * W3-3 信息架构（视觉基准：03 原型）：
 * - 过程层：同一 Turn 内连续的 tool_call 聚合进 ProcessFold（"已处理"折叠条），
 *   运行中默认展开实时呈现、完成后自动收纳；
 * - 结论层：agent_message 全宽正文；
 * - 行动项层：user_action / artifact 重卡片，独立渲染不进折叠；
 * - 用户消息：右对齐浅灰气泡。
 *
 * 职责（保持）：
 * - 按 item_sequence 升序渲染；superseded 默认隐藏；
 * - 超过阈值启用虚拟化（W3-3 起以"段"为虚拟化单位）；
 * - 流式状态指示（aria-live）；新内容自动滚动到底部。
 */
"use client";

import type { ClientItem, ClientStreamStatus } from "@/lib/client/types";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Wifi } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { AgentMessageItem } from "./items/agent-message-item";
import { ArtifactItem } from "./items/artifact-item";
import { ChildThreadItem } from "./items/child-thread-item";
import { JobResultItem } from "./items/job-result-item";
import { ToolCallItem } from "./items/tool-call-item";
import { UserActionItem } from "./items/user-action-item";
import { UserMessageItem } from "./items/user-message-item";
import { MessageLocator } from "./message-locator";
import { ProcessFold } from "./process-fold";

/** 段数量阈值；超过后启用虚拟化。 */
const VIRTUALIZATION_THRESHOLD = 100;

interface ThreadTimelineProps {
  readonly items: readonly ClientItem[];
  readonly streamStatus: ClientStreamStatus;
  /** 当前重连尝试次数（0 = 未处于重连），用于展示"正在重新连接 2/5"。 */
  readonly reconnectAttempt?: number;
  /** 重连次数上限。 */
  readonly reconnectMax?: number;
  readonly threadId?: string;
  /** 是否显示 superseded Item（默认 false）。 */
  readonly showSuperseded?: boolean;
  /** W3-5：是否显示消息定位轴（Desktop 默认启用）。 */
  readonly showMessageLocator?: boolean;
  /** 右侧工作台请求定位的 Item；requestId 支持重复定位同一条记录。 */
  readonly locateItem?: { readonly itemId: string; readonly requestId: number } | null;
}

/**
 * 渲染段：过程段（同 Turn 连续 tool_call 聚合）或普通 Item 段。
 * 聚合规则（方案 §4.1）：仅 tool_call 进过程段；跨 Turn 不合并；
 * 被 agent_message / 行动项打断后开新段。
 */
type TimelineSegment =
  | { readonly kind: "item"; readonly item: ClientItem }
  | { readonly kind: "process"; readonly items: ClientItem[] };

function buildSegments(items: readonly ClientItem[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  for (const item of items) {
    if (item.item_type === "tool_call") {
      const last = segments[segments.length - 1];
      if (last?.kind === "process" && last.items[0]?.turn_id === item.turn_id) {
        last.items.push(item);
      } else {
        segments.push({ kind: "process", items: [item] });
      }
    } else {
      segments.push({ kind: "item", item });
    }
  }
  return segments;
}

function hasTextContent(item: ClientItem): boolean {
  if (item.item_type !== "user_message" && item.item_type !== "user_guidance") {
    if (item.item_type !== "agent_message") return true;
  }
  if (!item.content || typeof item.content !== "object") return false;
  const content = item.content as Record<string, unknown>;
  if (item.item_type === "user_guidance" && content.kind === "progress.snapshot") return false;
  return typeof content.text === "string" && content.text.trim().length > 0;
}

/** 单个 Item 渲染分发；外层包裹 data-item-id 供定位轴测量。 */
function renderItem(item: ClientItem, threadId: string): React.ReactNode {
  const inner = (() => {
    switch (item.item_type) {
      case "user_message":
      case "user_guidance":
        return <UserMessageItem item={item} />;
      case "agent_message":
        return <AgentMessageItem item={item} />;
      case "tool_call":
        return <ToolCallItem item={item} />;
      case "artifact":
        return <ArtifactItem item={item} />;
      case "user_action":
        return <UserActionItem threadId={threadId} item={item} />;
      case "child_thread":
        return <ChildThreadItem item={item} />;
      case "job_result":
        return <JobResultItem item={item} />;
      default:
        return (
          <div className="rounded-lg border border-border bg-muted px-4 py-3 text-muted-foreground text-sm">
            暂不支持的消息类型：{item.item_type}
          </div>
        );
    }
  })();
  return (
    <div key={item.id} data-item-id={item.id}>
      {inner}
    </div>
  );
}

/** 段渲染：过程段包 ProcessFold，普通段直出。 */
function renderSegment(segment: TimelineSegment, threadId: string): React.ReactNode {
  if (segment.kind === "item") {
    return renderItem(segment.item, threadId);
  }
  const running = segment.items.some((i) => i.item_state === "pending");
  const first = segment.items[0];
  const last = segment.items[segment.items.length - 1];
  return (
    <ProcessFold
      running={running}
      startedAt={first?.created_at}
      endedAt={running ? undefined : last?.created_at}
    >
      {segment.items.map((i) => renderItem(i, threadId))}
    </ProcessFold>
  );
}

function segmentKey(segment: TimelineSegment): string {
  return segment.kind === "item" ? segment.item.id : `process-${segment.items[0]?.id}`;
}

export function ThreadTimeline({
  items,
  streamStatus,
  reconnectAttempt = 0,
  reconnectMax = 5,
  threadId = "",
  showSuperseded = false,
  showMessageLocator = false,
  locateItem = null,
}: ThreadTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 过滤 superseded、运行时进度误投影和空正文 → 聚合为渲染段
  const visibleItems = useMemo(() => {
    return items.filter(
      (item) => (showSuperseded || item.item_state !== "superseded") && hasTextContent(item),
    );
  }, [items, showSuperseded]);
  const segments = useMemo(() => buildSegments(visibleItems), [visibleItems]);

  const shouldVirtualize = segments.length > VIRTUALIZATION_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? segments.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 8,
  });

  // 新内容到达时自动滚动到底部。
  // W4-1：仅当段数量增加（新消息到达）时才滚动，避免 resnapshot 导致 items 引用变化
  // → segments 重建 → 误触发滚动 → 视觉上「从上翻到下重新加载一遍」。
  // 用户主动上滚查看历史时不强制拉回底部。
  // 用 requestAnimationFrame 确保 DOM 已更新后再滚动，避免布局抖动。
  // 用 scrollTo({ behavior: "auto" }) 覆盖 CSS scroll-behavior: smooth，
  // 让自动滚动瞬间完成，不产生「从上到下」的平滑滚动动画。
  const prevSegmentCountRef = useRef(segments.length);
  useEffect(() => {
    const prevCount = prevSegmentCountRef.current;
    prevSegmentCountRef.current = segments.length;
    // 段数未增加（resnapshot / item.updated）不触发滚动
    if (segments.length <= prevCount) return;
    const el = scrollRef.current;
    if (!el) return;
    // 仅在用户已接近底部（100px 内）时自动滚动，避免打断用户阅读历史
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > 100) return;
    // 用 rAF 确保浏览器完成布局后再滚动，避免在布局过程中设置 scrollTop 导致跳动
    const frame = window.requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "auto",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [segments.length]);

  // 工作台仅负责提供任务上下文；实际确认和产物详情仍回到共同时间线处理。
  useEffect(() => {
    if (!locateItem || !scrollRef.current) return;
    const segmentIndex = segments.findIndex((segment) =>
      segment.kind === "item"
        ? segment.item.id === locateItem.itemId
        : segment.items.some((item) => item.id === locateItem.itemId),
    );
    if (segmentIndex < 0) return;

    if (shouldVirtualize) {
      virtualizer.scrollToIndex(segmentIndex, { align: "center" });
    }
    const scrollToItem = () => {
      const item = Array.from(
        scrollRef.current?.querySelectorAll<HTMLElement>("[data-item-id]") ?? [],
      ).find((element) => element.dataset.itemId === locateItem.itemId);
      item?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    scrollToItem();
    const frame = window.requestAnimationFrame(scrollToItem);
    return () => window.cancelAnimationFrame(frame);
  }, [locateItem, segments, shouldVirtualize, virtualizer]);

  return (
    <div
      ref={scrollRef}
      className="relative flex-1 overflow-y-auto py-[18px]"
      role="log"
      aria-label="对话时间线"
      aria-live="polite"
      aria-atomic="false"
    >
      {showMessageLocator && <MessageLocator items={visibleItems} scrollContainerRef={scrollRef} />}
      <div className="conversation-column flex flex-col gap-1">
        {shouldVirtualize ? (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const segment = segments[virtualItem.index];
              if (!segment) return null;
              return (
                <div
                  key={segmentKey(segment)}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                  className="pb-2"
                >
                  {renderSegment(segment, threadId)}
                </div>
              );
            })}
          </div>
        ) : (
          segments.map((segment) => (
            <div key={segmentKey(segment)} className="flex flex-col">
              {renderSegment(segment, threadId)}
            </div>
          ))
        )}

        {/* 连接异常提示（W4-1）。
            正常连接（open）不提示——健康状态无需占用视线；
            仅在重连/重新同步时以最低视觉权重呈现一行淡灰小字，附带重连进度。 */}
        {(streamStatus === "reconnecting" || streamStatus === "resnapshot") && (
          <output className="flex items-center gap-1.5 py-1 text-foreground-subtle text-xs">
            <Wifi
              aria-hidden="true"
              strokeWidth={1.5}
              className="size-3.5 animate-gentle-pulse opacity-70"
            />
            <span>
              {streamStatus === "reconnecting"
                ? reconnectAttempt > 0
                  ? `正在重新连接 ${reconnectAttempt}/${reconnectMax}`
                  : "正在重新连接"
                : "正在同步会话"}
            </span>
          </output>
        )}

        {/* 空状态 */}
        {segments.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <p className="text-muted-foreground text-sm">还没有消息</p>
            <p className="text-foreground-subtle text-xs">发送第一条消息开始对话</p>
          </div>
        )}
      </div>
    </div>
  );
}
