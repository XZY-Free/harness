/**
 * 员工端 Environment 接管 Hook（S10-W07）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W07：
 *   「页面显示当前 Environment owner、在线状态、租约和接管条件」
 *   「接管前核对未完成 ToolCall/Effect；重复连接不能并发执行同一需要写锁的本地操作」
 *
 * 职责：
 * - 调用 POST /api/v1/threads/{thread_id}/environment:takeover 请求接管。
 * - 必填 Idempotency-Key（Hook 内部生成 crypto.randomUUID()）。
 * - busyRef 同步拦截防竞态：busy 期间拒绝重复触发。
 * - 错误转化为 ClientVisibleError，含 blocking_reasons 详情（422 时）。
 * - 成功后返回 lastTakeover 供调用方触发环境状态刷新。
 *
 * 使用：
 * ```tsx
 * function TakeoverButton({ threadId, onTaken }: { threadId: string; onTaken: () => void }) {
 *   const { requestTakeover, busy, error, lastTakeover, clearError } = useEnvironmentTakeover();
 *   return (
 *     <button
 *       disabled={busy}
 *       onClick={async () => {
 *         const result = await requestTakeover(threadId);
 *         if (result) onTaken();
 *       }}
 *     >
 *       {busy ? "接管中…" : "请求接管"}
 *     </button>
 *   );
 * }
 * ```
 *
 * 稳定性约束（与项目 memory 一致）：
 * - requestTakeover 使用 useCallback 稳定引用，避免子组件无限重渲染。
 * - busyRef 同步标志，避免 setState 异步延迟导致重复触发。
 */
"use client";

import { apiFetch } from "@/lib/api-fetch";
import { toVisibleError } from "@/lib/client/error-messages";
import type {
  ClientErrorBody,
  ClientTakeoverResponse,
  ClientVisibleError,
} from "@/lib/client/types";
import { useCallback, useEffect, useRef, useState } from "react";

/** Hook 返回值。 */
export interface UseEnvironmentTakeoverResult {
  /** 是否正在请求接管。 */
  readonly busy: boolean;
  /** 错误（ClientVisibleError + 可选 blocking_reasons）。 */
  readonly error: (ClientVisibleError & { readonly blocking_reasons?: readonly string[] }) | null;
  /** 最近一次接管成功结果；null 表示尚未接管或上次失败。 */
  readonly lastTakeover: ClientTakeoverResponse | null;
  /** 请求接管。返回结果；失败返回 null 并设置 error。 */
  readonly requestTakeover: (
    threadId: string,
    reasonCode?: string,
  ) => Promise<ClientTakeoverResponse | null>;
  /** 清除错误。 */
  readonly clearError: () => void;
}

/** Environment 接管 Hook。 */
export function useEnvironmentTakeover(): UseEnvironmentTakeoverResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<
    (ClientVisibleError & { readonly blocking_reasons?: readonly string[] }) | null
  >(null);
  const [lastTakeover, setLastTakeover] = useState<ClientTakeoverResponse | null>(null);
  const busyRef = useRef(false);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const requestTakeover = useCallback(
    async (threadId: string, reasonCode?: string): Promise<ClientTakeoverResponse | null> => {
      // 同步防竞态：busyRef 同步检查，避免 setState 异步延迟期间重复触发
      if (busyRef.current) return null;
      busyRef.current = true;
      if (!unmountedRef.current) {
        setBusy(true);
        setError(null);
      }

      try {
        const idempotencyKey =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `takeover-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const resp = await apiFetch(`/api/v1/threads/${threadId}/environment:takeover`, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(reasonCode ? { reason_code: reasonCode } : {}),
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
                code: "BUSINESS_CONSTRAINT_VIOLATION" as const,
                title: "接管失败",
                description: "无法完成接管请求，请稍后重试。",
                retryable: true,
                recoveryAction: "reload_page" as const,
                requestId: null,
              };
          // 提取 blocking_reasons（422 BUSINESS_CONSTRAINT_VIOLATION 时服务端返回）
          const blockingReasons = errorBody?.error?.details?.blocking_reasons;
          if (!unmountedRef.current) {
            setError({
              ...visible,
              ...(Array.isArray(blockingReasons)
                ? { blocking_reasons: blockingReasons as readonly string[] }
                : {}),
            });
            setBusy(false);
          }
          busyRef.current = false;
          return null;
        }

        const data = (await resp.json()) as ClientTakeoverResponse;
        if (!unmountedRef.current) {
          setLastTakeover(data);
          setBusy(false);
        }
        busyRef.current = false;
        return data;
      } catch (err) {
        if (!unmountedRef.current) {
          setError({
            code: "NETWORK_ERROR",
            title: "网络异常",
            description: "无法连接服务器，请检查网络后再试。",
            retryable: true,
            recoveryAction: "reload_page",
            requestId: null,
          });
          setBusy(false);
        }
        busyRef.current = false;
        return null;
      }
    },
    [],
  );

  const clearError = useCallback(() => {
    if (!unmountedRef.current) {
      setError(null);
    }
  }, []);

  return {
    busy,
    error,
    lastTakeover,
    requestTakeover,
    clearError,
  };
}
