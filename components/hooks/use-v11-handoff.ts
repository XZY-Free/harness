/**
 * V11 员工端 Handoff Hook（S10-W04）。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform/11-api-and-event-boundaries.md §3.18（解析 UserActionRequest）、
 *   §7.2（handoff.completed Event）
 * - docs/solutions/v11-agentkit-platform/12-capability-and-collaboration-api.md §5（Handoff 统一规则）
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md
 *   S10-W04：「员工 :resolve 接口解析 handoff（approve/deny）」
 *
 * 职责：
 * - resolveHandoff：员工解析 handoff 请求（POST /api/v1/threads/{thread_id}/handoffs/{handoff_id}:resolve）。
 * - 不在事务 ack 前宣称已解析：UI 状态固定为 "busy"，等待 200 响应后再更新 lastResolve。
 * - 错误转化为 V11ClientVisibleError。
 *
 * 关键不变量：
 * - resolve 是同步命令（200，非 202）：后端事务内完成 Thread.primary_agent_id 变更 + Event 写入。
 * - busy=true 时禁止重复触发。
 * - 同一 handoffId 只能解析一次（后端 HandoffAlreadyResolvedError → 409 OPERATION_PAYLOAD_CONFLICT）。
 *
 * 使用：
 * ```tsx
 * function HandoffCard({ threadId, handoffId }: { threadId: string; handoffId: string }) {
 *   const { resolve, busy, error, lastResolve } = useV11Handoff({ threadId });
 *   // ...
 * }
 * ```
 */
"use client";

import { apiFetch } from "@/lib/api-fetch";
import { toVisibleError } from "@/lib/v11/client/error-messages";
import type {
  V11ClientErrorBody,
  V11ClientHandoffResolveResponse,
  V11ClientVisibleError,
} from "@/lib/v11/client/types";
import { useCallback, useState } from "react";

/** Hook 入参。 */
interface UseV11HandoffParams {
  readonly threadId: string;
}

/** Hook 返回值。 */
export interface UseV11HandoffResult {
  /** 是否有操作进行中。 */
  readonly busy: boolean;
  /** 错误。 */
  readonly error: V11ClientVisibleError | null;
  /** 最近一次解析结果（用于 UI 显示 "已同意/已拒绝" 状态）。 */
  readonly lastResolve: V11ClientHandoffResolveResponse | null;
  /** 解析 handoff 请求。返回 true 表示成功。 */
  readonly resolve: (handoffId: string, resolution: "approve" | "deny") => Promise<boolean>;
  /** 清除错误。 */
  readonly clearError: () => void;
}

/** 生成客户端幂等键。 */
function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `hdf_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

/** V11 Handoff Hook。 */
export function useV11Handoff({ threadId }: UseV11HandoffParams): UseV11HandoffResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<V11ClientVisibleError | null>(null);
  const [lastResolve, setLastResolve] = useState<V11ClientHandoffResolveResponse | null>(null);

  const resolve = useCallback(
    async (handoffId: string, resolution: "approve" | "deny"): Promise<boolean> => {
      if (!handoffId) {
        setError({
          code: "REQUEST_SCHEMA_INVALID",
          title: "参数无效",
          description: "handoffId 不能为空。",
          retryable: false,
          recoveryAction: "none",
          requestId: null,
        });
        return false;
      }
      setBusy(true);
      setError(null);
      try {
        const idempotencyKey = generateIdempotencyKey();
        // 路径含冒号 custom method（:resolve）；Next.js App Router 直接收录此段名。
        const resp = await apiFetch(`/api/v1/threads/${threadId}/handoffs/${handoffId}:resolve`, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ resolution }),
        });
        if (!resp.ok) {
          const visible = await parseError(resp);
          setError(visible);
          return false;
        }
        const data = (await resp.json()) as V11ClientHandoffResolveResponse;
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
