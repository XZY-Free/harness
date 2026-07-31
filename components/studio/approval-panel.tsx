"use client";

import { useThreadEvents } from "@/components/hooks/use-thread-events";
import { t } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";

/**
 * V3.1 Stage E：Studio 审批面板（client）。
 *
 * 列出当前 thread 的 pending ToolApprovalRequest，提供 approve/deny + scope 操作。
 * approved/denied 历史折叠展示。空状态提示「无待审批」。
 * 操作经 POST /studio/api/threads/[id]/approvals/[approvalId] 决议；
 * approved 后由前端重发 chat 恢复执行（chat route 恢复路径）。
 *
 * 12-P1-3：改为 SSE 事件驱动刷新——订阅 tool.approval_requested/resolved 事件，
 * 收到事件后调 refresh() 拉最新 pending/resolved。SSE 断线时自动降级轮询。
 */

type Approval = {
  id: string;
  toolName: string;
  permissionKey: string;
  argSummary: string;
  status: string;
  approvedScope: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
};

type Scope = "once" | "thread" | "project" | "always";

const SCOPES: Scope[] = ["once", "thread", "project", "always"];

export function ApprovalPanel({ threadId }: { threadId: string }) {
  const [pending, setPending] = useState<Approval[]>([]);
  const [resolved, setResolved] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("thread");
  const [showResolved, setShowResolved] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/studio/api/threads/${threadId}/approvals`, { cache: "no-store" });
      if (res.status === 404) {
        setPending([]);
        setResolved([]);
        return;
      }
      if (!res.ok) throw new Error(`${t("studio.approval.loading")} (${res.status})`);
      const body = (await res.json()) as { data?: { pending: Approval[]; resolved: Approval[] } };
      setPending(body.data?.pending ?? []);
      setResolved(body.data?.resolved ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 12-P1-3：SSE 事件驱动刷新——收到 approval 相关事件或降级轮询通知时 refresh
  useThreadEvents({
    threadId,
    onEvent: (ev) => {
      if (
        ev.type === "tool.approval_requested" ||
        ev.type === "tool.approval_resolved" ||
        ev.type === "__fallback__"
      ) {
        void refresh();
      }
    },
  });

  async function resolve(approvalId: string, decision: "approved" | "denied") {
    setBusyId(approvalId);
    setError(null);
    try {
      const res = await fetch(`/studio/api/threads/${threadId}/approvals/${approvalId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, scope }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `决议失败 (${res.status})`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return <div className="text-[13px] text-[var(--fg-muted)]">{t("studio.approval.loading")}</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {error !== null && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-[12px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {/* scope 选择（对 approve 生效；deny 不依赖 scope） */}
      <div className="flex items-center gap-2 text-[12px] text-[var(--fg-muted)]">
        <span>{t("studio.approval.scope_label")}</span>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as Scope)}
          className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12px]"
        >
          {SCOPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {pending.length === 0 ? (
        <div className="text-[13px] text-[var(--fg-muted)]">{t("studio.approval.empty")}</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {pending.map((a) => (
            <li
              key={a.id}
              className="flex items-start gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px]"
            >
              <div className="flex-1">
                <div className="font-medium text-[var(--fg)]">
                  {a.toolName}
                  <span className="ml-2 font-mono text-[12px] text-[var(--fg-subtle)]">
                    {a.permissionKey}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] text-[var(--fg-muted)]">{a.argSummary}</div>
                <div className="mt-0.5 text-[11px] text-[var(--fg-subtle)]">
                  {new Date(a.createdAt).toLocaleString()}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  disabled={busyId === a.id}
                  onClick={() => void resolve(a.id, "approved")}
                  className="rounded-[var(--radius-sm)] bg-[var(--ok-soft)] px-2.5 py-1 text-[12px] text-[var(--ok)] hover:opacity-80 disabled:opacity-50"
                >
                  {t("studio.approval.approve")}
                </button>
                <button
                  type="button"
                  disabled={busyId === a.id}
                  onClick={() => void resolve(a.id, "denied")}
                  className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-2.5 py-1 text-[12px] text-[var(--danger)] hover:opacity-80 disabled:opacity-50"
                >
                  {t("studio.approval.deny")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {resolved.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            {showResolved ? "▾" : "▸"} {t("studio.approval.history")}（{resolved.length}）
          </button>
          {showResolved && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {resolved.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12px] text-[var(--fg-muted)]"
                >
                  <span
                    className={
                      a.status === "approved" ? "text-[var(--ok)]" : "text-[var(--danger)]"
                    }
                  >
                    {a.status === "approved"
                      ? t("studio.approval.resolved_approved")
                      : t("studio.approval.resolved_denied")}
                  </span>
                  <span className="flex-1">
                    {a.toolName} · {a.argSummary}
                  </span>
                  {a.approvedScope && (
                    <span className="text-[var(--fg-subtle)]">scope={a.approvedScope}</span>
                  )}
                  {a.resolvedAt && (
                    <span className="text-[var(--fg-subtle)]">
                      {new Date(a.resolvedAt).toLocaleString()}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
