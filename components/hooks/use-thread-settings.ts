/**
 * 员工端 Thread 默认设置 Hook。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md
 *   S10-W04：「员工在发送消息前选择 Agent / Model / Skill / Environment」
 *
 * 职责：
 * - 封装 PATCH /api/v1/threads/{id}/settings 调用。
 * - 维护 busy / error 状态，供 CatalogSettingsBar 禁用控件与展示错误。
 * - 错误转化为 ClientVisibleError。
 * - 乐观锁：调用方传入 expectedVersionNo（来自 thread.version_no），hook 内构造 If-Match。
 *
 * 不变量：
 * - busy=true 时禁止重复触发（patchSettings 直接返回 false）。
 * - 至少一个字段非 undefined 时才发请求；否则返回 false 并设置参数错误。
 * - PATCH 成功后调用方应自行 refresh Thread 详情以拿到新的 version_no。
 *
 * 使用：
 * ```tsx
 * function SettingsBar({ thread, onPatched }: { thread: ClientThread; onPatched: () => void }) {
 *   const { patchSettings, busy, error, clearError } = useThreadSettings({ threadId: thread.id });
 *   const handleModelChange = (modelRef: string) => {
 *     void patchSettings({
 *       expectedVersionNo: thread.version_no,
 *       updates: { default_model_ref: modelRef },
 *     }).then((ok) => { if (ok) onPatched(); });
 *   };
 *   // ...
 * }
 * ```
 */
"use client";

import { apiFetch } from "@/lib/api-fetch";
import { toVisibleError } from "@/lib/client/error-messages";
import type { ClientErrorBody, ClientVisibleError } from "@/lib/client/types";
import { useCallback, useState } from "react";

/** PATCH settings 更新字段（与服务端 UpdateSettingsBody 对齐）。 */
export interface ThreadSettingsUpdate {
  readonly default_model_ref?: string | null;
  readonly default_workspace_id?: string | null;
  readonly default_environment_definition_id?: string | null;
}

/** Hook 返回值。 */
export interface UseThreadSettingsResult {
  /** 是否正在 PATCH。 */
  readonly busy: boolean;
  /** 错误。 */
  readonly error: ClientVisibleError | null;
  /** PATCH settings。返回 true 表示成功，false 表示失败（错误已写入 error）。 */
  readonly patchSettings: (params: {
    readonly expectedVersionNo: number;
    readonly updates: ThreadSettingsUpdate;
  }) => Promise<boolean>;
  /** 清除错误。 */
  readonly clearError: () => void;
}

/** Thread 设置 ETag 前缀（与服务端 THREAD_SETTINGS_ETAG_PREFIX 一致）。 */
const THREAD_SETTINGS_ETAG_PREFIX = "thread-settings-";

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

interface UseThreadSettingsParams {
  readonly threadId: string;
}

/** Thread 设置 Hook。 */
export function useThreadSettings({
  threadId,
}: UseThreadSettingsParams): UseThreadSettingsResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientVisibleError | null>(null);

  const patchSettings = useCallback(
    async ({
      expectedVersionNo,
      updates,
    }: {
      readonly expectedVersionNo: number;
      readonly updates: ThreadSettingsUpdate;
    }): Promise<boolean> => {
      const hasUpdate =
        updates.default_model_ref !== undefined ||
        updates.default_workspace_id !== undefined ||
        updates.default_environment_definition_id !== undefined;
      if (!hasUpdate) {
        setError({
          code: "REQUEST_SCHEMA_INVALID",
          title: "参数无效",
          description: "至少需要指定一个待更新字段。",
          retryable: false,
          recoveryAction: "none",
          requestId: null,
        });
        return false;
      }
      if (busy) return false;
      setBusy(true);
      setError(null);
      try {
        const resp = await apiFetch(`/api/v1/threads/${threadId}/settings`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "if-match": `"${THREAD_SETTINGS_ETAG_PREFIX}${expectedVersionNo}"`,
          },
          body: JSON.stringify(updates),
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
    [threadId, busy],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    busy,
    error,
    patchSettings,
    clearError,
  };
}
