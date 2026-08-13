/**
 * 员工端 Thread 详情 Hook。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W02：「Thread 顶部固定展示主 Agent、可选 Goal、当前任务状态和默认执行位置」
 *
 * 职责：
 * - 加载 Thread 详情（含 active Goal + 最新 Turn）。
 * - 加载 Turn 列表（用于推导当前任务状态）。
 * - 与 useThread 独立：Thread 详情不走 SSE 事件流，是按需查询。
 * - 当 SSE 事件到达时（turn.accepted / turn.state_changed / thread.updated），
 *   客户端可调用 refresh() 重新加载 Thread 详情。
 *
 * 使用：
 * ```tsx
 * function ThreadHeader({ threadId }: { threadId: string }) {
 *   const { thread, activeGoal, latestTurn, turns, loading, error, refresh } =
 *     useThreadDetail(threadId);
 *   if (loading) return <Spinner />;
 *   if (error) return <ErrorCard error={error} onRetry={refresh} />;
 *   return <Header thread={thread} goal={activeGoal} turn={latestTurn} />;
 * }
 * ```
 */
"use client";

import { apiFetch } from "@/lib/api-fetch";
import { toVisibleError } from "@/lib/client/error-messages";
import type {
  ClientErrorBody,
  ClientThreadResponse,
  ClientTurnsResponse,
  ClientVisibleError,
} from "@/lib/client/types";
import { useCallback, useEffect, useState } from "react";

/** Hook 返回值。 */
export interface UseThreadDetailResult {
  /** Thread 详情。 */
  readonly thread: ClientThreadResponse["thread"] | null;
  /** active Goal。 */
  readonly activeGoal: ClientThreadResponse["active_goal"] | null;
  /** 最新 Turn。 */
  readonly latestTurn: ClientThreadResponse["latest_turn"] | null;
  /** Turn 列表（按 turn_sequence 升序）。 */
  readonly turns: ClientTurnsResponse["turns"];
  /** 加载状态。 */
  readonly loading: boolean;
  /** 错误。 */
  readonly error: ClientVisibleError | null;
  /** 手动刷新。 */
  readonly refresh: () => Promise<void>;
}

/** Thread 详情 Hook。 */
export function useThreadDetail(threadId: string): UseThreadDetailResult {
  const [thread, setThread] = useState<ClientThreadResponse["thread"] | null>(null);
  const [activeGoal, setActiveGoal] = useState<ClientThreadResponse["active_goal"] | null>(null);
  const [latestTurn, setLatestTurn] = useState<ClientThreadResponse["latest_turn"] | null>(null);
  const [turns, setTurns] = useState<ClientTurnsResponse["turns"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClientVisibleError | null>(null);

  // W4-1：区分「初始加载」与「后台刷新」。SSE 事件触发的 refresh 不动 loading 状态，
  // 否则每个 turn.accepted / turn.state_changed 都会把已渲染的会话替换成全屏 spinner，
  // 视觉上像「每次请求/回复结束都刷新页面」。仅初始加载与显式重试才显示 loading。
  const load = useCallback(
    async (options?: { readonly silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setLoading(true);
        setError(null);
      }

      try {
        // 并行加载 Thread 详情 + Turn 列表
        const [threadResp, turnsResp] = await Promise.all([
          apiFetch(`/api/v1/threads/${threadId}`, {
            credentials: "include",
            cache: "no-store",
          }),
          apiFetch(`/api/v1/threads/${threadId}/turns?limit=200`, {
            credentials: "include",
            cache: "no-store",
          }),
        ]);

        // 处理 Thread 详情响应
        if (!threadResp.ok) {
          const bodyText = await threadResp.text().catch(() => "");
          let errorBody: ClientErrorBody | null = null;
          try {
            errorBody = JSON.parse(bodyText) as ClientErrorBody;
          } catch {
            // ignore
          }
          const visible = errorBody
            ? toVisibleError(errorBody)
            : {
                // 非 JSON 错误响应 = 请求未到应用层（Nginx 404 HTML / 网关拦截），
                // 不能映射成"会话不存在"误导员工。
                code: "UPSTREAM_INVALID_RESPONSE",
                title: "服务响应异常",
                description:
                  "服务器未返回有效数据，可能是网关或部署配置问题。请稍后重试，若持续出现请联系管理员。",
                retryable: true,
                recoveryAction: "reload_page" as const,
                requestId: null,
              };
          setError(visible);
          setLoading(false);
          return;
        }

        const threadData = (await threadResp.json()) as ClientThreadResponse;
        setThread(threadData.thread);
        setActiveGoal(threadData.active_goal);
        setLatestTurn(threadData.latest_turn);

        // 处理 Turn 列表响应（失败不阻断 Thread 详情）
        if (turnsResp.ok) {
          const turnsData = (await turnsResp.json()) as ClientTurnsResponse;
          setTurns(turnsData.turns);
        }
      } catch {
        setError({
          code: "NETWORK_ERROR",
          title: "网络异常",
          description: "无法连接服务器，请检查网络后再试。",
          retryable: true,
          recoveryAction: "reload_page",
          requestId: null,
        });
      } finally {
        setLoading(false);
      }
    },
    [threadId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // refresh 供 SSE 事件触发的后台刷新使用 → silent=true 不打断已显示的 UI。
  // 显式重试场景（错误页「重试」按钮）走 useThread 的 resnapshot()，不走 refresh。
  const refresh = useCallback(() => load({ silent: true }), [load]);

  return {
    thread,
    activeGoal,
    latestTurn,
    turns,
    loading,
    error,
    refresh,
  };
}
