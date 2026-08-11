/**
 * 员工端 Thread Hook。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md
 *   S10-W01：「以 Thread snapshot 为基线、ThreadEvent sequence 为增量，建立 Web/Desktop 共用的客户端状态投影」
 *
 * 职责：
 * - 把 createThreadClient 绑定到 React 生命周期。
 * - 用 useSyncExternalStore 订阅 store，保证 render 与状态一致。
 * - 组件卸载时自动 stop()，关闭 SSE 并停止重连。
 * - threadId 变化时重建客户端。
 *
 * 使用：
 * ```tsx
 * function ThreadView({ threadId }: { threadId: string }) {
 *   const { items, streamStatus, visibleError, snapshotStatus, resnapshot } =
 *     useThread(threadId);
 *   if (snapshotStatus === "loading") return <Spinner />;
 *   if (visibleError) return <ErrorCard error={visibleError} onRetry={resnapshot} />;
 *   return <Timeline items={items} streamStatus={streamStatus} />;
 * }
 * ```
 *
 * 不在 Desktop Shell 与 Web 之间区分实现 — 两端共用同一投影。
 */
"use client";

import {
  type ClientItem,
  type ClientStreamStatus,
  type ClientVisibleError,
  type ThreadClient,
  createThreadClient,
} from "@/lib/client";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

/** Hook 返回值。 */
export interface UseThreadResult {
  /** 当前 Thread id。 */
  readonly threadId: string;
  /** Item 投影（按 item_sequence 升序）。 */
  readonly items: readonly ClientItem[];
  /** SSE 连接状态。 */
  readonly streamStatus: ClientStreamStatus;
  /** 当前重连尝试次数（0 = 未处于重连）。 */
  readonly reconnectAttempt: number;
  /** 重连次数上限。 */
  readonly reconnectMax: number;
  /** snapshot 加载状态。 */
  readonly snapshotStatus: "idle" | "loading" | "ready" | "failed";
  /** 当前可见错误（已映射中文语义）。 */
  readonly visibleError: ClientVisibleError | null;
  /** 已应用的最大 event sequence（诊断用）。 */
  readonly lastAppliedEventSequence: number;
  /** 手动重新加载 snapshot（用于恢复）。 */
  readonly resnapshot: () => Promise<void>;
}

/** Thread Hook。 */
export function useThread(threadId: string): UseThreadResult {
  // threadId 变化时重建客户端
  const clientRef = useRef<ThreadClient | null>(null);
  const client = useMemo<ThreadClient>(() => {
    const next = createThreadClient({ threadId });
    clientRef.current = next;
    return next;
  }, [threadId]);

  // 启动 + 清理
  useEffect(() => {
    void client.start();
    return () => {
      client.stop();
    };
  }, [client]);

  // 订阅 store
  const state = useSyncExternalStore(
    (listener) => client.store.subscribe(listener),
    () => client.store.getState(),
    () => client.store.getState(),
  );

  return {
    threadId: state.threadId,
    items: state.items,
    streamStatus: state.streamStatus,
    reconnectAttempt: state.reconnectAttempt,
    reconnectMax: state.reconnectMax,
    snapshotStatus: state.snapshotStatus,
    visibleError: state.visibleError,
    lastAppliedEventSequence: state.lastAppliedEventSequence,
    resnapshot: client.resnapshot,
  };
}
