import type { DeliverySummary } from "@/lib/delivery/summary";

/**
 * V3.7 Stage E：Studio 交付面板（只读展示）。
 * 展示最近 deliverySummary（文件变更 / 测试结果 / 预览 / commit / PR 链接 / blindCommit 标记）
 * + checkpoint 历史（tag / commitSha / reason / restoredAt）。
 * 无交付时展示空状态。
 */

type CheckpointRow = {
  id: string;
  tag: string;
  commitSha: string;
  reason: string;
  restoredAt: Date | null;
  createdAt: Date;
};

export function DeliveryPanel({
  summary,
  checkpoints,
}: {
  summary: DeliverySummary | null;
  checkpoints: CheckpointRow[];
}) {
  if (!summary) {
    return <div className="text-[13px] text-[var(--fg-muted)]">当前 thread 尚未交付。</div>;
  }

  return (
    <div className="flex flex-col gap-4 text-[13px]">
      <section className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-3">
        <h3 className="mb-2 text-[14px] font-medium text-[var(--fg)]">交付摘要</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[var(--fg-muted)]">
          <dt>commit</dt>
          <dd className="font-mono text-[var(--fg)]">{summary.commitSha ?? "—"}</dd>
          <dt>分支</dt>
          <dd className="font-mono">{summary.branch ?? "—"}</dd>
          <dt>推送</dt>
          <dd>{summary.pushed ? "已推送" : "未推送"}</dd>
          <dt>远程</dt>
          <dd className="break-all font-mono text-[12px]">{summary.remoteUrl ?? "—"}</dd>
          <dt>PR / 链接</dt>
          <dd className="break-all">
            {summary.prUrl ? (
              <a
                href={summary.prUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--primary)] underline"
              >
                {summary.prUrl}
              </a>
            ) : summary.deliveryLink ? (
              <a
                href={summary.deliveryLink}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--primary)] underline"
              >
                {summary.deliveryLink}
              </a>
            ) : (
              "—"
            )}
          </dd>
          <dt>预览</dt>
          <dd className="break-all">{summary.previewUrl ?? "—"}</dd>
          <dt>测试</dt>
          <dd>
            {summary.testResults.passed} passed / {summary.testResults.failed} failed
          </dd>
          {summary.tested && (
            <>
              <dt>已验证</dt>
              <dd>{summary.tested}</dd>
            </>
          )}
          {summary.notTested && (
            <>
              <dt>未验证</dt>
              <dd>{summary.notTested}</dd>
            </>
          )}
        </dl>
        {summary.blindCommit && (
          <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--danger)] bg-[var(--danger-soft)] px-2 py-1 text-[12px] text-[var(--danger)]">
            ⚠ blindCommit：提交前未读 gitStatus/gitDiff
          </div>
        )}
      </section>

      <section className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-3">
        <h3 className="mb-2 text-[14px] font-medium text-[var(--fg)]">
          文件变更（{summary.filesChanged.length}）
        </h3>
        {summary.filesChanged.length === 0 ? (
          <div className="text-[var(--fg-muted)]">无变更。</div>
        ) : (
          <ul className="flex flex-col gap-0.5 font-mono text-[12px]">
            {summary.filesChanged.map((f) => (
              <li key={`${f.path}:${f.status}`} className="flex gap-2">
                <span className="w-16 shrink-0 text-[var(--fg-subtle)]">{f.status}</span>
                <span className="break-all text-[var(--fg)]">{f.path}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-3">
        <h3 className="mb-2 text-[14px] font-medium text-[var(--fg)]">
          Checkpoint 历史（{checkpoints.length}）
        </h3>
        {checkpoints.length === 0 ? (
          <div className="text-[var(--fg-muted)]">无 checkpoint。</div>
        ) : (
          <ol className="flex flex-col gap-1">
            {checkpoints.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px]">
                <span className="font-mono text-[var(--primary)]">{c.tag}</span>
                <span className="font-mono text-[var(--fg-subtle)]">{c.commitSha.slice(0, 7)}</span>
                <span className="text-[var(--fg-muted)]">{c.reason}</span>
                {c.restoredAt && (
                  <span className="text-[var(--danger)]">
                    已回滚 {new Date(c.restoredAt).toLocaleString()}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
