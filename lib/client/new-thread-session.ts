import { apiFetch } from "@/lib/api-fetch";
import { fallbackTitleFromUserText } from "@/lib/thread-title";
import type {
  ClientNewThreadSubmission,
  ClientThreadShellResponse,
  ClientThreadSummary,
} from "./types";

export type ThreadApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

interface NewThreadSessionConfig {
  readonly fetchImpl?: ThreadApiFetch;
  readonly idempotencyKeyFactory?: () => string;
}

interface PendingFirstTurn {
  readonly thread: ClientThreadSummary;
  readonly submission: ClientNewThreadSubmission;
  readonly turnIdempotencyKey: string;
}

export interface NewThreadSession {
  submit(submission: ClientNewThreadSubmission): Promise<ClientThreadSummary>;
}

function createIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * 解析失败响应并抛出可见错误（09 §11：区分 no eligible route / required context 等）。
 * 服务端错误 Envelope 为 { error: { code, message } }；无可用 body 时退回默认提示。
 */
async function requireJson<T>(response: Response, message: string): Promise<T> {
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    let serverMessage: string | null = null;
    try {
      const body = JSON.parse(bodyText) as { error?: { message?: string } };
      serverMessage = body.error?.message ?? null;
    } catch {
      // 非 JSON body：保持默认提示
    }
    throw new Error(serverMessage ?? message);
  }
  return (await response.json()) as T;
}

export async function loadThreadShell(
  fetchImpl: ThreadApiFetch = apiFetch,
): Promise<ClientThreadShellResponse> {
  const response = await fetchImpl("/api/v1/threads", {
    credentials: "include",
    cache: "no-store",
  });
  return requireJson<ClientThreadShellResponse>(response, "无法读取会话列表");
}

function submissionsEqual(
  left: ClientNewThreadSubmission,
  right: ClientNewThreadSubmission,
): boolean {
  return (
    left.text === right.text &&
    left.modelRef === right.modelRef &&
    (left.agentId ?? null) === (right.agentId ?? null)
  );
}

export function createNewThreadSession(config: NewThreadSessionConfig = {}): NewThreadSession {
  const fetchImpl = config.fetchImpl ?? apiFetch;
  const idempotencyKeyFactory = config.idempotencyKeyFactory ?? createIdempotencyKey;
  let pending: PendingFirstTurn | null = null;

  return {
    async submit(submission) {
      if (pending && !submissionsEqual(pending.submission, submission)) {
        throw new Error("首条消息发送失败后不能更换模型或消息内容，请先重试原消息。");
      }

      if (!pending) {
        const title = fallbackTitleFromUserText(submission.text) || "新会话";
        const createResponse = await fetchImpl("/api/v1/threads", {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKeyFactory(),
          },
          body: JSON.stringify({ title }),
        });
        const created = await requireJson<{ readonly id: string; readonly title?: string | null }>(
          createResponse,
          "创建会话失败，请稍后重试。",
        );
        pending = {
          thread: {
            id: created.id,
            title: created.title ?? title,
          },
          submission,
          turnIdempotencyKey: idempotencyKeyFactory(),
        };
      }

      const turnResponse = await fetchImpl(`/api/v1/threads/${pending.thread.id}/turns`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "idempotency-key": pending.turnIdempotencyKey,
        },
        body: JSON.stringify({
          input: { type: "message", text: pending.submission.text },
          ...(pending.submission.modelRef ? { selected_model: pending.submission.modelRef } : {}),
          // 09 §9/§10：员工选择只影响本条 Turn（agent_selection.mode=required）。
          ...(pending.submission.agentId
            ? { agent_selection: { mode: "required", agent_id: pending.submission.agentId } }
            : {}),
        }),
      });
      await requireJson(turnResponse, "消息发送失败，请稍后重试。");

      const createdThread = pending.thread;
      pending = null;
      return createdThread;
    },
  };
}
