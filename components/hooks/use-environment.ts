/**
 * 员工端 Environment 状态 Hook（S10-W06）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W06：「Desktop 复用共同时间线，在右侧增加文件、页面和内部系统任务操作面板」
 *   「本地 Shell、Git、测试、构建、浏览器和应用操作显示实际执行设备、目录、权限和结果」
 *
 * 职责：
 * - 加载 Thread 当前 Environment 状态（EnvironmentDefinition + active Lease + ExecutionOwnership + availability）。
 * - 提供 refresh 手动刷新（SSE 事件到达时可触发）。
 * - AbortController 防竞态：多次快速刷新只保留最后一次结果。
 * - unmounted 守卫：组件卸载后不写入 state。
 * - 错误转化为 ClientVisibleError。
 *
 * 使用：
 * ```tsx
 * function EnvironmentStatus({ threadId }: { threadId: string }) {
 *   const { status, loading, error, refresh } = useEnvironment(threadId);
 *   if (loading) return <Spinner />;
 *   if (error) return <ErrorCard error={error} onRetry={refresh} />;
 *   return <Console status={status} />;
 * }
 * ```
 */
"use client";

import { apiFetch } from "@/lib/api-fetch";
import { toVisibleError } from "@/lib/client/error-messages";
import type {
  ClientEnvironmentStatusResponse,
  ClientErrorBody,
  ClientVisibleError,
} from "@/lib/client/types";
import { useCallback, useEffect, useRef, useState } from "react";

/** Hook 返回值。 */
export interface UseEnvironmentResult {
  /** Environment 状态；null 表示尚未加载或加载失败。 */
  readonly status: ClientEnvironmentStatusResponse | null;
  /** 加载状态。 */
  readonly loading: boolean;
  /** 错误。 */
  readonly error: ClientVisibleError | null;
  /** 手动刷新。 */
  readonly refresh: () => Promise<void>;
}

/** Environment 状态 Hook。 */
export function useEnvironment(threadId: string): UseEnvironmentResult {
  const [status, setStatus] = useState<ClientEnvironmentStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClientVisibleError | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const unmountedRef = useRef(false);

  const load = useCallback(async () => {
    // 取消上一个请求
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const resp = await apiFetch(`/api/v1/threads/${threadId}/environment`, {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
      });

      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => "");
        let errorBody: ClientErrorBody | null = null;
        try {
          errorBody = JSON.parse(bodyText) as ClientErrorBody;
        } catch {
          // ignore
        }
        const visible = errorBody
          ? toVisibleError(errorBody)
          : {
              code: "RESOURCE_NOT_FOUND",
              title: "环境状态不可用",
              description: "无法加载会话环境状态，请稍后重试。",
              retryable: true,
              recoveryAction: "reload_page" as const,
              requestId: null,
            };
        if (!unmountedRef.current) {
          setError(visible);
          setLoading(false);
        }
        return;
      }

      const data = (await resp.json()) as ClientEnvironmentStatusResponse;
      if (!unmountedRef.current) {
        setStatus(data);
        setLoading(false);
      }
    } catch (err) {
      // AbortError 是预期的（被新请求取消），不写入错误
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!unmountedRef.current) {
        setError({
          code: "NETWORK_ERROR",
          title: "网络异常",
          description: "无法连接服务器，请检查网络后再试。",
          retryable: true,
          recoveryAction: "reload_page",
          requestId: null,
        });
        setLoading(false);
      }
    }
  }, [threadId]);

  useEffect(() => {
    unmountedRef.current = false;
    void load();
    return () => {
      unmountedRef.current = true;
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [load]);

  return {
    status,
    loading,
    error,
    refresh: load,
  };
}
