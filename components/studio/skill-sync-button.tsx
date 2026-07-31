"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * capability-market 同步按钮（02 文档 §7.1）。
 * 仅 admin 可见（列表页/详情页由 server 侧 hasPermission 控制渲染）。
 * 点击 → POST /studio/api/skills/sync → 展示分组结果（imported/updated/uptodate/conflict/blocked/failed/missing）。
 */
export function SkillSyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/studio/api/skills/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const d = body.data;
      setResult({
        新导入: d.imported?.length ?? 0,
        已更新: d.updated?.length ?? 0,
        已是最新: d.uptodate?.length ?? 0,
        名称冲突: d.conflict?.length ?? 0,
        被远端阻止: d.blocked?.length ?? 0,
        失败: d.failed?.length ?? 0,
        远端已下线: d.missing?.length ?? 0,
      });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络错误");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="rounded-[var(--radius)] bg-[var(--primary)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
      >
        {busy ? "同步中…" : "同步 capability-market"}
      </button>
      {error && <span className="text-[12px] text-[var(--danger)]">{error}</span>}
      {result && (
        <span className="text-[12px] text-[var(--fg-muted)]">
          {Object.entries(result)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${k} ${n}`)
            .join(" · ") || "无变化"}
          {(result["名称冲突"] ?? 0) > 0 && (
            <span className="ml-2 text-[var(--danger)]">（有名称冲突,请在详情页处理）</span>
          )}
        </span>
      )}
    </div>
  );
}
