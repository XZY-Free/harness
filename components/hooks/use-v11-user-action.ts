/**
 * V11 员工端通用 UserAction Hook（S10-W05）。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform/11-api-and-event-boundaries.md §3.18（解析 UserActionRequest）
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md
 *   S10-W05：「UserAction 查询、确认、拒绝、授权完成与超时」
 *
 * 职责：
 * - resolveUserAction：员工解析通用 UserAction 请求
 *   （POST /api/v1/threads/{thread_id}/user-actions/{request_id}:resolve）。
 * - 支持 4 种 resolution：approve / deny / submit / cancel。
 * - input 类型 submit 时通过 responseRedactedJson 传入脱敏响应。
 * - 不处理 handoff（handoff 由 useV11Handoff 处理）；后端会拒绝 purpose=handoff 的请求。
 * - 错误转化为 V11ClientVisibleError。
 *
 * 关键不变量：
 * - resolve 是同步命令（200，非 202）：后端事务内完成 UserActionRequest 状态变更 + Event 写入 +
 *   Invocation 恢复 + resume 入队。
 * - busy=true 时禁止重复触发。
 * - 同一 requestId 只能解析一次（后端 UserActionAlreadyResolvedError → 409 OPERATION_PAYLOAD_CONFLICT）。
 *
 * 使用：
 * ```tsx
 * function InputCard({ threadId, requestId }: { threadId: string; requestId: string }) {
 *   const { resolve, busy, error, lastResolve } = useV11UserAction({ threadId });
 *   // ...
 * }
 * ```
 */
"use client";

import { apiFetch } from "@/lib/api-fetch";
import { toVisibleError } from "@/lib/v11/client/error-messages";
import type {
  V11ClientErrorBody,
  V11ClientUserActionResolveResponse,
  V11ClientVisibleError,
} from "@/lib/v11/client/types";
import type { UserActionResolution } from "@/lib/v11/schema/user-action-request";
import { useCallback, useRef, useState } from "react";

/** Hook 入参。 */
interface UseV11UserActionParams {
  readonly threadId: string;
}

/** resolve 选项。 */
export interface ResolveUserActionOptions {
  /** input 类型 submit 时必填：已脱敏的响应 JSON（对象或数组）。 */
  readonly responseRedactedJson?: unknown;
}

/** Hook 返回值。 */
export interface UseV11UserActionResult {
  /** 是否有操作进行中。 */
  readonly busy: boolean;
  /** 错误。 */
  readonly error: V11ClientVisibleError | null;
  /** 最近一次解析结果（用于 UI 显示 "已同意/已拒绝/已提交/已取消" 状态）。 */
  readonly lastResolve: V11ClientUserActionResolveResponse | null;
  /** 解析 UserAction 请求。返回 true 表示成功。 */
  readonly resolve: (
    requestId: string,
    resolution: UserActionResolution,
    options?: ResolveUserActionOptions,
  ) => Promise<boolean>;
  /** 清除错误。 */
  readonly clearError: () => void;
}

/** 生成客户端幂等键。 */
function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ua_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 解析错误响应为可见错误。 */
async function parseError(response: Response): Promise<V11ClientVisibleError> {
  const bodyText = await response.text().catch(() => "");
  let errorBody: V11ClientErrorBody | null = null;
  try {
    errorBody = JSON.parse(bodyText) as V11ClientErrorBody;
  } catch {
    // ignore
  }
  if (errorBody) return toVisibleError(errorBody);
  return {
    code: "NETWORK_ERROR",
    title: "网络异常",
    description: "无法连接服务器，请检查网络后再试。",
    retryable: true,
    recoveryAction: "reload_page",
    requestId: null,
  };
}

/** V11 通用 UserAction Hook。 */
export function useV11UserAction({ threadId }: UseV11UserActionParams): UseV11UserActionResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<V11ClientVisibleError | null>(null);
  const [lastResolve, setLastResolve] = useState<V11ClientUserActionResolveResponse | null>(null);
  // 同步标志：用于 busy 期间拒绝重复触发，避免 setBusy 异步延迟导致的竞态。
  const busyRef = useRef(false);

  const resolve = useCallback(
    async (
      requestId: string,
      resolution: UserActionResolution,
      options?: ResolveUserActionOptions,
    ): Promise<boolean> => {
      if (!requestId) {
        setError({
          code: "REQUEST_SCHEMA_INVALID",
          title: "参数无效",
          description: "requestId 不能为空。",
          retryable: false,
          recoveryAction: "none",
          requestId: null,
        });
        return false;
      }
      if (busyRef.current) {
        setError({
          code: "REQUEST_SCHEMA_INVALID",
          title: "操作进行中",
          description: "上一次操作尚未完成，请稍后再试。",
          retryable: false,
          recoveryAction: "none",
          requestId: null,
        });
        return false;
      }
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const idempotencyKey = generateIdempotencyKey();
        const body: Record<string, unknown> = { resolution };
        if (options?.responseRedactedJson !== undefined) {
          body.response_redacted = options.responseRedactedJson;
        }
        // 路径含冒号 custom method（:resolve）；Next.js App Router 直接收录此段名。
        const resp = await apiFetch(
          `/api/v1/threads/${threadId}/user-actions/${requestId}:resolve`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify(body),
          },
        );
        if (!resp.ok) {
          const visible = await parseError(resp);
          setError(visible);
          return false;
        }
        const data = (await resp.json()) as V11ClientUserActionResolveResponse;
        setLastResolve(data);
        return true;
      } catch {
        setError({
          code: "NETWORK_ERROR",
          title: "网络异常",
          description: "无法连接服务器，请检查网络后再试。",
          retryable: true,
          recoveryAction: "reload_page",
          requestId: null,
        });
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [threadId],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    busy,
    error,
    lastResolve,
    resolve,
    clearError,
  };
}
