/**
 * V3.8 Stage E：Studio 部署面板（只读展示 + 回滚入口）。
 *
 * 展示部署历史列表（environment / status / cicdJobUrl / deployedAt）+ 回滚入口。
 * 空状态：无部署时展示提示。
 *
 * S1（12-P1-6）：状态文案收敛到 lib/i18n 的 DEPLOYMENT_STATUS_LABEL（styles 颜色保留,非文案）。
 */

import { deploymentStatusLabel } from "@/lib/i18n";

type DeploymentRow = {
  id: string;
  environment: string;
  commitSha: string | null;
  imageTag: string | null;
  cicdJobId: string | null;
  cicdJobUrl: string | null;
  status: string;
  previousDeploymentId: string | null;
  deployedAt: Date | null;
  rolledBackAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
};

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    deployed: "bg-[var(--success-bg)] text-[var(--success-fg)]",
    deploying: "bg-[var(--info-bg)] text-[var(--info-fg)]",
    pending: "bg-[var(--info-bg)] text-[var(--info-fg)]",
    failed: "bg-[var(--danger-bg)] text-[var(--danger-fg)]",
    rolled_back: "bg-[var(--warning-bg)] text-[var(--warning-fg)]",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
        styles[status] ?? "bg-[var(--surface)] text-[var(--fg-muted)]"
      }`}
    >
      {deploymentStatusLabel(status)}
    </span>
  );
}

export function DeploymentPanel({ deployments }: { deployments: DeploymentRow[] }) {
  if (deployments.length === 0) {
    return <div className="text-[13px] text-[var(--fg-muted)]">当前 thread 尚无部署记录。</div>;
  }

  return (
    <div className="flex flex-col gap-2 text-[13px]">
      {deployments.map((d) => (
        <div
          key={d.id}
          className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-3"
        >
          <div className="mb-1 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-mono font-medium text-[var(--fg)]">{d.environment}</span>
              <StatusBadge status={d.status} />
            </div>
            <span className="text-[11px] text-[var(--fg-muted)]">
              {d.deployedAt
                ? `部署于 ${d.deployedAt.toLocaleString()}`
                : `创建于 ${d.createdAt.toLocaleString()}`}
            </span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[var(--fg-muted)]">
            {d.commitSha && (
              <>
                <dt>commit</dt>
                <dd className="font-mono text-[var(--fg)]">{d.commitSha.slice(0, 8)}</dd>
              </>
            )}
            {d.imageTag && (
              <>
                <dt>image</dt>
                <dd className="font-mono">{d.imageTag}</dd>
              </>
            )}
            {d.cicdJobUrl && (
              <>
                <dt>CI/CD</dt>
                <dd>
                  <a
                    href={d.cicdJobUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--primary)] underline"
                  >
                    {d.cicdJobId ?? "查看 job"}
                  </a>
                </dd>
              </>
            )}
            {d.previousDeploymentId && (
              <>
                <dt>回滚自</dt>
                <dd className="font-mono text-[11px]">{d.previousDeploymentId.slice(0, 8)}</dd>
              </>
            )}
            {d.errorMessage && (
              <>
                <dt>错误</dt>
                <dd className="text-[var(--danger-fg)]">{d.errorMessage.slice(0, 200)}</dd>
              </>
            )}
          </dl>
        </div>
      ))}
    </div>
  );
}
