/**
 * 员工端发消息 Hook（S10-W03）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W03：「空闲时发送创建正式 UserMessage/Turn；运行中默认创建 PendingInput」
 *
 * 职责：
 * - 根据 latestTurn.turn_state 决定走 POST /turns（空闲）还是 POST /pending-inputs（运行中）。
 * - 空闲状态（无 Turn / completed / interrupted / failed / cancelled）→ 创建正式 Turn。
 * - 运行中状态（accepted / queued / running / waiting_user / regenerating）→ 创建 PendingInput。
 * - 维护发送状态（idle / sending / sent / error），供 UI 显示加载与错误。
 * - 错误转化为 ClientVisibleError。
 *
 * 不变量：
 * - busy=true 时禁止重复触发。
 * - 发送成功后清空输入文本（由调用方负责，本 hook 只返回成功标志）。
 *
 * 使用：
 * ```tsx
 * function ThreadInput({ threadId, latestTurn }: { threadId: string; latestTurn: ClientTurn | null }) {
 *   const { send, busy, error, lastRoute } = useThreadInput({ threadId, latestTurn });
 *   // ...
 * }
 * ```
 */
"use client";

import { apiFetch } from "@/lib/api-fetch";
import { toVisibleError } from "@/lib/client/error-messages";
import type { ClientErrorBody, ClientTurn, ClientVisibleError } from "@/lib/client/types";
import { useCallback, useState } from "react";

/** 运行中状态集合（这些状态下发送消息走 PendingInput）。 */
const RUNNING_STATES = new Set(["accepted", "queued", "running", "waiting_user", "regenerating"]);

/** 发送路由：turn（正式消息）/ pending_input（队列）/ none（不应发送）。 */
export type SendRoute = "turn" | "pending_input" | "none";

/** Hook 返回值。 */
export interface UseThreadInputResult {
  /** 是否正在发送。 */
  readonly busy: boolean;
  /** 错误。 */
  readonly error: ClientVisibleError | null;
  /** 最近一次发送走哪条路由。 */
  readonly lastRoute: SendRoute;
  /** 根据当前 Turn 状态推断发送路由。 */
  readonly route: SendRoute;
  /** 发送消息。返回 true 表示成功，false 表示失败（错误已写入 error）。 */
  readonly send: (text: string) => Promise<boolean>;
  /** 清除错误。 */
  readonly clearError: () => void;
}

/** 生成客户端幂等键。 */
function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 解析错误响应为可见错误。 */
async function parseError(response: Response): Promise<ClientVisibleError> {
  const bodyText = await response.text().catch(() => "");
  let errorBody: ClientErrorBody | null = null;
  try {
    errorBody = JSON.parse(bodyText) as ClientErrorBody;
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

/** 推断发送路由。 */
export function deriveSendRoute(latestTurn: ClientTurn | null): SendRoute {
  if (!latestTurn) return "turn"; // 无 Turn → 空闲
  if (RUNNING_STATES.has(latestTurn.turn_state)) return "pending_input";
  return "turn"; // completed / interrupted / failed / cancelled → 空闲
}

interface UseThreadInputParams {
  /** 真实 Thread id；null 表示尚未创建正式 Thread（新建页首条消息走 onSubmitText）。 */
  readonly threadId: string | null;
  readonly latestTurn: ClientTurn | null;
}

/** 发消息 Hook。 */
export function useThreadInput({
  threadId,
  latestTurn,
}: UseThreadInputParams): UseThreadInputResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientVisibleError | null>(null);
  const [lastRoute, setLastRoute] = useState<SendRoute>("none");

  // 无真实 Thread id（新建页）时不得走任何 turns/pending-inputs 路由。
  const route = threadId === null ? "none" : deriveSendRoute(latestTurn);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (!text.trim()) {
        setError({
          code: "REQUEST_SCHEMA_INVALID",
          title: "输入无效",
          description: "消息内容不能为空。",
          retryable: false,
          recoveryAction: "none",
          requestId: null,
        });
        return false;
      }
      // fail-closed：threadId 为空时绝不拼接 API URL，直接返回失败并设置明确错误。
      if (threadId === null) {
        setError({
          code: "REQUEST_SCHEMA_INVALID",
          title: "无法发送",
          description: "尚未创建正式 Thread，无法直接发送消息。",
          retryable: false,
          recoveryAction: "none",
          requestId: null,
        });
        setLastRoute("none");
        return false;
      }
      setBusy(true);
      setError(null);
      const idempotencyKey = generateIdempotencyKey();
      // 决定路由：运行中 → pending_input，否则 → turn
      const targetRoute = deriveSendRoute(latestTurn);
      setLastRoute(targetRoute);
      try {
        if (targetRoute === "pending_input") {
          // 运行中：创建 PendingInput
          const resp = await apiFetch(`/api/v1/threads/${threadId}/pending-inputs`, {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify({
              input: { type: "message", text },
              client_message_id: idempotencyKey,
            }),
          });
          if (!resp.ok) {
            const visible = await parseError(resp);
            setError(visible);
            return false;
          }
          return true;
        }
        // 空闲：创建正式 Turn
        const resp = await apiFetch(`/api/v1/threads/${threadId}/turns`, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
            input: { type: "message", text },
          }),
        });
        if (!resp.ok) {
          const visible = await parseError(resp);
          setError(visible);
          return false;
        }
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
    [threadId, latestTurn],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    busy,
    error,
    lastRoute,
    route,
    send,
    clearError,
  };
}
