/**
 * 员工端 PendingInput 队列 Hook（S10-W03）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W03：「PendingInput 可编辑、删除和排序，尚未正式发送的内容不出现在消息历史」
 *
 * 职责：
 * - 加载 Thread 的 PendingInput 队列（GET /api/v1/threads/{id}/pending-inputs）。
 * - 创建 PendingInput（POST，运行中发送消息走此路径）。
 * - 编辑 PendingInput 内容（PATCH /api/v1/pending-inputs/{id}，If-Match 资源 ETag）。
 * - 删除 PendingInput（DELETE，If-Match 资源 ETag）。
 * - 重排队列（POST /api/v1/threads/{id}/pending-inputs/reorder，If-Match 队列 ETag）。
 * - 维护队列 ETag 与资源 ETag，保证乐观锁正确。
 * - SSE 事件到达时（pending_input.created/updated/removed/reordered）调用 refresh()。
 *
 * 不变量：
 * - pendingInputs 按 queue_position 升序。
 * - queueEtag 与服务端 queue_etag 同步，reorder 时用作 If-Match。
 * - 操作进行中 busy=true，防止重复触发。
 * - 错误转化为 ClientVisibleError，不暴露内部堆栈。
 *
 * 使用：
 * ```tsx
 * function PendingInputQueue({ threadId }: { threadId: string }) {
 *   const { pendingInputs, queueEtag, create, edit, remove, reorder, refresh, loading, error } =
 *     usePendingInputs(threadId);
 *   // ...
 * }
 * ```
 */
"use client";

import { apiFetch } from "@/lib/api-fetch";
import { toVisibleError } from "@/lib/client/error-messages";
import type {
  ClientCreatePendingInputResponse,
  ClientDeletePendingInputResponse,
  ClientEditPendingInputResponse,
  ClientErrorBody,
  ClientPendingInput,
  ClientPendingInputListResponse,
  ClientVisibleError,
} from "@/lib/client/types";
import { useCallback, useEffect, useRef, useState } from "react";

/** 单条 PendingInput 输入内容。 */
export interface PendingInputContentInput {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

/** Hook 返回值。 */
export interface UsePendingInputsResult {
  /** 队列快照（按 queue_position 升序）。 */
  readonly pendingInputs: readonly ClientPendingInput[];
  /** 队列 ETag（reorder 时用作 If-Match）。 */
  readonly queueEtag: string | null;
  /** 加载状态。 */
  readonly loading: boolean;
  /** 错误。 */
  readonly error: ClientVisibleError | null;
  /** 是否有操作进行中（create/edit/remove/reorder）。 */
  readonly busy: boolean;
  /** 创建 PendingInput。 */
  readonly create: (input: PendingInputContentInput, clientMessageId?: string) => Promise<boolean>;
  /** 编辑 PendingInput 内容。 */
  readonly edit: (
    pendingInputId: string,
    etag: string,
    input: PendingInputContentInput,
  ) => Promise<boolean>;
  /** 删除 PendingInput。 */
  readonly remove: (pendingInputId: string, etag: string) => Promise<boolean>;
  /** 重排队列（orderedIds 必须与当前 pending 集合完全一致）。 */
  readonly reorder: (orderedIds: readonly string[]) => Promise<boolean>;
  /** 手动刷新队列。 */
  readonly refresh: () => Promise<void>;
}

/** 生成客户端幂等键（crypto.randomUUID 在浏览器与 Node 20+ 均可用）。 */
function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `pi_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

/** PendingInput 队列 Hook。 */
export function usePendingInputs(threadId: string): UsePendingInputsResult {
  const [pendingInputs, setPendingInputs] = useState<readonly ClientPendingInput[]>([]);
  const [queueEtag, setQueueEtag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClientVisibleError | null>(null);
  const [busy, setBusy] = useState(false);

  // 防止 threadId 切换后旧请求回填新状态。
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const load = useCallback(async () => {
    if (threadIdRef.current !== threadId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await apiFetch(`/api/v1/threads/${threadId}/pending-inputs`, {
        credentials: "include",
        cache: "no-store",
      });
      if (threadIdRef.current !== threadId) return;
      if (!resp.ok) {
        const visible = await parseError(resp);
        setError(visible);
        setLoading(false);
        return;
      }
      const data = (await resp.json()) as ClientPendingInputListResponse;
      // 按 queue_position 升序
      const sorted = [...data.pending_inputs].sort((a, b) => a.queue_position - b.queue_position);
      setPendingInputs(sorted);
      setQueueEtag(data.queue_etag);
    } catch {
      if (threadIdRef.current !== threadId) return;
      setError({
        code: "NETWORK_ERROR",
        title: "网络异常",
        description: "无法连接服务器，请检查网络后再试。",
        retryable: true,
        recoveryAction: "reload_page",
        requestId: null,
      });
    } finally {
      if (threadIdRef.current === threadId) setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 创建 PendingInput。 */
  const create = useCallback(
    async (input: PendingInputContentInput, clientMessageId?: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const idempotencyKey = generateIdempotencyKey();
        const resp = await apiFetch(`/api/v1/threads/${threadId}/pending-inputs`, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
            input,
            client_message_id: clientMessageId,
          }),
        });
        if (!resp.ok) {
          const visible = await parseError(resp);
          setError(visible);
          return false;
        }
        const data = (await resp.json()) as ClientCreatePendingInputResponse;
        // 乐观更新：把新建的 PendingInput 加入队列并按 queue_position 排序
        setPendingInputs((prev) => {
          const next: ClientPendingInput = {
            id: data.pending_input.id,
            queue_position: data.pending_input.queue_position,
            input: data.pending_input.input,
            etag: data.pending_input.etag,
          };
          return [...prev, next].sort((a, b) => a.queue_position - b.queue_position);
        });
        setQueueEtag(data.queue_etag);
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

  /** 编辑 PendingInput 内容。 */
  const edit = useCallback(
    async (
      pendingInputId: string,
      etag: string,
      input: PendingInputContentInput,
    ): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const resp = await apiFetch(`/api/v1/pending-inputs/${pendingInputId}`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "if-match": `"${etag}"`,
          },
          body: JSON.stringify({ input }),
        });
        if (!resp.ok) {
          const visible = await parseError(resp);
          setError(visible);
          return false;
        }
        const data = (await resp.json()) as ClientEditPendingInputResponse;
        setPendingInputs((prev) =>
          prev
            .map((p) =>
              p.id === pendingInputId
                ? {
                    id: data.pending_input.id,
                    queue_position: data.pending_input.queue_position,
                    input: data.pending_input.input,
                    etag: data.pending_input.etag,
                  }
                : p,
            )
            .sort((a, b) => a.queue_position - b.queue_position),
        );
        setQueueEtag(data.queue_etag);
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
    [],
  );

  /** 删除 PendingInput。 */
  const remove = useCallback(async (pendingInputId: string, etag: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const resp = await apiFetch(`/api/v1/pending-inputs/${pendingInputId}`, {
        method: "DELETE",
        credentials: "include",
        headers: {
          "if-match": `"${etag}"`,
        },
      });
      if (!resp.ok) {
        const visible = await parseError(resp);
        setError(visible);
        return false;
      }
      const data = (await resp.json()) as ClientDeletePendingInputResponse;
      setPendingInputs((prev) => prev.filter((p) => p.id !== pendingInputId));
      setQueueEtag(data.queue_etag);
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
  }, []);

  /** 重排队列。 */
  const reorder = useCallback(
    async (orderedIds: readonly string[]): Promise<boolean> => {
      if (!queueEtag) {
        setError({
          code: "ETAG_MISMATCH",
          title: "队列已变更",
          description: "队列刚刚发生变化，正在为你刷新。",
          retryable: true,
          recoveryAction: "resnapshot",
          requestId: null,
        });
        return false;
      }
      setBusy(true);
      setError(null);
      try {
        const resp = await apiFetch(`/api/v1/threads/${threadId}/pending-inputs/reorder`, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "if-match": `"${queueEtag}"`,
          },
          body: JSON.stringify({ ordered_ids: orderedIds }),
        });
        if (!resp.ok) {
          const visible = await parseError(resp);
          setError(visible);
          return false;
        }
        const data = (await resp.json()) as ClientPendingInputListResponse;
        setPendingInputs(
          [...data.pending_inputs].sort((a, b) => a.queue_position - b.queue_position),
        );
        setQueueEtag(data.queue_etag);
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
    [threadId, queueEtag],
  );

  return {
    pendingInputs,
    queueEtag,
    loading,
    error,
    busy,
    create,
    edit,
    remove,
    reorder,
    refresh: load,
  };
}
