"use client";

import { apiPath } from "@/lib/api-fetch";
import { useEffect, useRef } from "react";

/**
 * 12-P1-3：Studio 详情页各面板统一订阅 SSE 事件流。
 *
 * 订阅 /api/threads/stream?threadId=xxx，收到 event 事件时调用 onEvent 回调。
 * 各面板（subagent/approval/task/qa）在 onEvent 中按 type 过滤自己关心的事件，
 * 收到后调自己的 refresh() 拉最新数据（SSE 只负责通知「有变更」，数据走 REST 拉取保证一致性）。
 *
 * 降级：SSE 断线（onerror）时回退轮询——onEvent 每 5s 被调一次（模拟事件到达），
 * 直到 SSE 重连成功。复用 EventSource 内置重连（自动重连），降级轮询兜底跨实例 + 断线场景。
 *
 * thread-auto-refresh 用本 hook 订阅 status 事件（收到 status 变更再 router.refresh）。
 */

export type ThreadSseEvent = {
  type: string;
  payload: unknown;
  sequence: number;
};

export type ThreadSseStatus = {
  status: string;
};

/**
 * 订阅 thread 的 SSE 事件流。
 *
 * @param threadId thread ID
 * @param onEvent 收到 event 事件回调（subagent/approval/task/qa 等）
 * @param onStatus 收到 status 事件回调（thread-auto-refresh 用）
 * @param fallbackPollMs SSE 断线时的降级轮询间隔（默认 5000ms）
 */
export function useThreadEvents({
  threadId,
  onEvent,
  onStatus,
  fallbackPollMs = 5000,
}: {
  threadId: string;
  onEvent?: (ev: ThreadSseEvent) => void;
  onStatus?: (s: ThreadSseStatus) => void;
  fallbackPollMs?: number;
}): void {
  // 用 ref 持有最新回调，避免回调变化重新订阅 SSE
  const onEventRef = useRef(onEvent);
  const onStatusRef = useRef(onStatus);
  onEventRef.current = onEvent;
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (!threadId) return;

    let es: EventSource | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let disconnected = false;

    const stopFallback = () => {
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const startFallback = () => {
      if (fallbackTimer) return;
      // 降级轮询：模拟一次「泛事件」通知，让面板 refresh 拉数据
      fallbackTimer = setInterval(() => {
        onEventRef.current?.({ type: "__fallback__", payload: null, sequence: 0 });
      }, fallbackPollMs);
    };

    const connect = () => {
      es = new EventSource(apiPath(`/api/threads/stream?threadId=${encodeURIComponent(threadId)}`));
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as {
            kind: "status" | "event";
            threadId: string;
            status?: string;
            type?: string;
            payload?: unknown;
            sequence?: number;
          };
          if (data.kind === "status" && data.status) {
            onStatusRef.current?.({ status: data.status });
          } else if (data.kind === "event" && data.type) {
            onEventRef.current?.({
              type: data.type,
              payload: data.payload,
              sequence: data.sequence ?? 0,
            });
          }
        } catch {
          /* 忽略非 JSON / 心跳 */
        }
      };
      es.onopen = () => {
        // 重连成功：停降级轮询
        disconnected = false;
        stopFallback();
      };
      es.onerror = () => {
        // SSE 断线：启动降级轮询，EventSource 会自动重连
        if (!disconnected) {
          disconnected = true;
          startFallback();
        }
      };
    };

    connect();

    return () => {
      stopFallback();
      es?.close();
    };
  }, [threadId, fallbackPollMs]);
}
