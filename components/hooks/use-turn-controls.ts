/**
 * 员工端 Turn 控制 Hook（S10-W03）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W03：「Steer 显示 requested/acknowledged/applied/rejected，不在 Runtime ack 前宣称已经引导」
 *   「Stop 暂停后续队列；页面明确区分『已请求停止』『Runtime 已确认』和『副作用仍需核对』」
 *
 * 职责：
 * - Steer 运行中 Turn（POST /api/v1/turns/{id}/steer，202 Accepted，异步命令）。
 * - Interrupt（Stop）运行中 Turn（POST /api/v1/turns/{id}/interrupt，202 Accepted，异步命令）。
 * - 不在 Runtime ack 前宣称已引导/已停止：UI 状态固定为 "queued" / "requested"。
 * - 错误转化为 ClientVisibleError。
 *
 * 关键不变量：
 * - Steer/Interrupt 是异步命令，调用后 Turn 状态未变（后端不立即改 turn_state）。
 * - Steer/Interrupt 的最终结果（acknowledged/applied/rejected）由 SSE 事件通知：
 *   - turn.steer_queued → 命令入队（本 hook 调用后立即出现）
 *   - turn.steered → Runtime ack（本阶段 Runtime 未接入，此事件不会被写入）
 *   - turn.interrupt_requested → 命令入队
 *   - turn.interrupted → Runtime ack 终态（本阶段不会被写入）
 * - 前端 UI 必须区分三种状态：
 *   1. 已请求停止（command_state=queued，等待 Runtime ack）
 *   2. Runtime 已确认（通过 turn.interrupted SSE 事件，turn_state 变为 interrupted）
 *   3. 副作用仍需核对（already_completed_effects_preserved=true 提示）
 *
 * 使用：
 * ```tsx
 * function TurnControls({ turnId }: { turnId: string }) {
 *   const { steer, interrupt, busy, error, lastSteer, lastInterrupt } = useTurnControls(turnId);
 *   // ...
 * }
 * ```
 */
"use client";

import { apiFetch } from "@/lib/api-fetch";
import { toVisibleError } from "@/lib/client/error-messages";
import type {
  ClientErrorBody,
  ClientInterruptResponse,
  ClientSteerResponse,
  ClientVisibleError,
} from "@/lib/client/types";
import { useCallback, useState } from "react";

/** Hook 返回值。 */
export interface UseTurnControlsResult {
  /** 是否有操作进行中。 */
  readonly busy: boolean;
  /** 错误。 */
  readonly error: ClientVisibleError | null;
  /** 最近一次 Steer 结果（用于 UI 显示 "已请求引导" 状态）。 */
  readonly lastSteer: ClientSteerResponse | null;
  /** 最近一次 Interrupt 结果（用于 UI 显示 "已请求停止" 状态）。 */
  readonly lastInterrupt: ClientInterruptResponse | null;
  /** 发送 Steer（运行中引导）。 */
  readonly steer: (guidanceText: string) => Promise<boolean>;
  /** 发送 Interrupt（停止）。 */
  readonly interrupt: (reasonCode?: string, preservePendingInputs?: boolean) => Promise<boolean>;
  /** 清除错误。 */
  readonly clearError: () => void;
}

/** 生成客户端幂等键。 */
function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

/** Turn 控制 Hook。 */
export function useTurnControls(turnId: string): UseTurnControlsResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientVisibleError | null>(null);
  const [lastSteer, setLastSteer] = useState<ClientSteerResponse | null>(null);
  const [lastInterrupt, setLastInterrupt] = useState<ClientInterruptResponse | null>(null);

  /** 发送 Steer。 */
  const steer = useCallback(
    async (guidanceText: string): Promise<boolean> => {
      if (!guidanceText.trim()) {
        setError({
          code: "REQUEST_SCHEMA_INVALID",
          title: "输入无效",
          description: "引导内容不能为空。",
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
        const resp = await apiFetch(`/api/v1/turns/${turnId}/steer`, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ guidance_text: guidanceText }),
        });
        if (!resp.ok) {
          const visible = await parseError(resp);
          setError(visible);
          return false;
        }
        const data = (await resp.json()) as ClientSteerResponse;
        setLastSteer(data);
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
    [turnId],
  );

  /** 发送 Interrupt（停止）。 */
  const interrupt = useCallback(
    async (reasonCode = "user_requested_stop", preservePendingInputs = true): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const idempotencyKey = generateIdempotencyKey();
        const resp = await apiFetch(`/api/v1/turns/${turnId}/interrupt`, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
            reason_code: reasonCode,
            preserve_pending_inputs: preservePendingInputs,
          }),
        });
        if (!resp.ok) {
          const visible = await parseError(resp);
          setError(visible);
          return false;
        }
        const data = (await resp.json()) as ClientInterruptResponse;
        setLastInterrupt(data);
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
    [turnId],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    busy,
    error,
    lastSteer,
    lastInterrupt,
    steer,
    interrupt,
    clearError,
  };
}
