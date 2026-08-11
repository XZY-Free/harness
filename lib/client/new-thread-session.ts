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

async function requireJson<T>(response: Response, message: string): Promise<T> {
  if (!response.ok) throw new Error(message);
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
    left.text === right.text && left.agentId === right.agentId && left.modelRef === right.modelRef
  );
}

export function createNewThreadSession(config: NewThreadSessionConfig = {}): NewThreadSession {
  const fetchImpl = config.fetchImpl ?? apiFetch;
  const idempotencyKeyFactory = config.idempotencyKeyFactory ?? createIdempotencyKey;
  let pending: PendingFirstTurn | null = null;

  return {
    async submit(submission) {
      if (pending && !submissionsEqual(pending.submission, submission)) {
        throw new Error("首条消息发送失败后不能更换助手、模型或消息内容，请先重试原消息。");
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
          body: JSON.stringify({ agent_id: submission.agentId, title }),
        });
        const created = await requireJson<{ readonly id: string; readonly title?: string | null }>(
          createResponse,
          "创建会话失败，请稍后重试。",
        );
        pending = {
          thread: {
            id: created.id,
            title: created.title ?? title,
            primary_agent_id: submission.agentId,
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
          ...(pending.submission.modelRef
            ? { selected_model: pending.submission.modelRef }
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
