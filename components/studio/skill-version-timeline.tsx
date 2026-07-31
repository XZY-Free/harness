"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Phase 4-4 Stage B：skill 版本时间线 + 发布 / 回滚操作。
 *
 * 写操作走 /studio/api/* （client fetch），受后端 skill.write 守卫。操作成功后 router.refresh()
 * 让 server component 重取最新 currentVersionId。无权限用户按钮点击会收到 403，前端提示。
 */

type VersionLite = {
  id: string;
  version: number;
  status: string;
  createdAt: Date | string;
  commitSha?: string | null;
};

async function postAction(
  skillId: string,
  versionId: string,
  kind: "publish" | "rollback",
): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`/studio/api/skills/${skillId}/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: body?.error?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "网络错误" };
  }
}

export function SkillVersionTimeline({
  skillId,
  versions,
  currentVersionId,
  canWrite = false,
}: {
  skillId: string;
  versions: VersionLite[];
  currentVersionId: string | null;
  canWrite?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handle(skillId: string, v: VersionLite, kind: "publish" | "rollback") {
    setBusy(`${kind}:${v.id}`);
    setError(null);
    const r = await postAction(skillId, v.id, kind);
    setBusy(null);
    if (!r.ok) {
      setError(`v${v.version} ${kind} 失败：${r.message ?? ""}`);
      return;
    }
    router.refresh();
  }

  if (versions.length === 0) {
    return <div className="text-[13px] text-[var(--fg-muted)]">该 skill 暂无版本。</div>;
  }

  return (
    <div>
      <ul className="flex flex-col gap-2">
        {versions.map((v) => {
          const isCurrent = v.id === currentVersionId;
          return (
            <li
              key={v.id}
              className="flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            >
              <div className="flex items-center gap-2.5 text-[13px]">
                <span className="font-medium text-[var(--fg)]">v{v.version}</span>
                {v.commitSha && (
                  <span className="font-mono text-[11px] text-[var(--fg-subtle)]">
                    {v.commitSha.slice(0, 7)}
                  </span>
                )}
                {isCurrent && (
                  <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] text-[var(--primary)]">
                    当前
                  </span>
                )}
                <span className="text-[var(--fg-subtle)]">
                  {new Date(v.createdAt).toLocaleString()}
                </span>
              </div>
              {canWrite && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isCurrent || busy !== null}
                    onClick={() => handle(skillId, v, "publish")}
                    className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--fg-muted)] transition hover:bg-[var(--surface-2)] disabled:opacity-40"
                  >
                    发布
                  </button>
                  <button
                    type="button"
                    disabled={isCurrent || busy !== null}
                    onClick={() => handle(skillId, v, "rollback")}
                    className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--fg-muted)] transition hover:bg-[var(--surface-2)] disabled:opacity-40"
                  >
                    回滚
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && <div className="mt-2 text-[12px] text-[var(--danger)]">{error}</div>}
    </div>
  );
}
