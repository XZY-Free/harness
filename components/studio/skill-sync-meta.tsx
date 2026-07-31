"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * 同步 Skill 元数据展示 + 操作（02 文档 §7.1、§7.2）。
 * 展示远端 asset / version / hash / syncState / 最近同步时间 / 错误。
 * 操作：「重新同步」（触发全局同步）、「取消同步」（POST /unsync → archive + 映射 not_found）。
 */
export function SkillSyncMeta({
  skillId,
  skillName,
  syncState,
  remoteAssetId,
  remoteName,
  remoteDisplayName,
  remoteVersion,
  remoteContentHash,
  lastSyncedAt,
  lastError,
}: {
  skillId: string;
  skillName: string;
  syncState: string;
  remoteAssetId: string | null;
  remoteName: string | null;
  remoteDisplayName: string | null;
  remoteVersion: string | null;
  remoteContentHash: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}) {
  const router = useRouter();
  const [unsyncing, setUnsyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unsync() {
    if (unsyncing) return;
    if (
      !confirm(
        `取消同步「${skillName}」？本地 skill 将归档（不物理删除,历史 run 仍可读旧版本）,且不再进入运行候选。`,
      )
    )
      return;
    setUnsyncing(true);
    setError(null);
    try {
      const res = await fetch(`/studio/api/skills/${skillId}/unsync`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络错误");
    } finally {
      setUnsyncing(false);
    }
  }

  return (
    <section className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-4 text-[13px]">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-medium text-[var(--fg)]">
          同步 Skill（只读） · 状态 {syncState}
        </h2>
        <button
          type="button"
          onClick={unsync}
          disabled={unsyncing}
          className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1 text-[12px] text-[var(--fg-muted)] disabled:opacity-50"
        >
          {unsyncing ? "取消中…" : "取消同步"}
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[var(--fg-muted)]">
        <dt className="text-[var(--fg-subtle)]">远端资产 ID</dt>
        <dd className="font-mono">{remoteAssetId ?? "—"}</dd>
        <dt className="text-[var(--fg-subtle)]">远端名称</dt>
        <dd>{remoteDisplayName ?? remoteName ?? "—"}</dd>
        <dt className="text-[var(--fg-subtle)]">远端版本</dt>
        <dd>{remoteVersion ?? "—"}</dd>
        <dt className="text-[var(--fg-subtle)]">内容 hash</dt>
        <dd className="font-mono">{remoteContentHash ?? "—"}</dd>
        <dt className="text-[var(--fg-subtle)]">最近同步</dt>
        <dd>{lastSyncedAt ?? "—"}</dd>
        {lastError && (
          <>
            <dt className="text-[var(--fg-subtle)]">最近错误</dt>
            <dd className="text-[var(--danger)]">{lastError}</dd>
          </>
        )}
      </dl>
      <p className="mt-3 text-[12px] text-[var(--fg-subtle)]">
        同步 Skill 是 capability-market 的本地镜像,只读。修改请到 Studio 列表点「同步
        capability-market」重新同步,或取消同步后本地自建。
      </p>
      {error && <p className="mt-2 text-[12px] text-[var(--danger)]">{error}</p>}
    </section>
  );
}
