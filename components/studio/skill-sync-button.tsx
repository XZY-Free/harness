"use client";

import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * 从已配置的技能库同步内容。可见性由服务端权限判断。
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
        setError(body?.error?.message ?? "同步失败，请稍后重试");
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
    } catch {
      setError("网络连接失败，未能同步技能库");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button type="button" onClick={run} disabled={busy} variant="outline">
        <RefreshCw
          data-icon="inline-start"
          aria-hidden
          className={busy ? "animate-spin" : undefined}
        />
        {busy ? "同步中…" : "同步技能库"}
      </Button>
      {error && (
        <span role="alert" className="max-w-72 text-right text-xs text-destructive">
          {error}
        </span>
      )}
      {result && (
        <output className="max-w-96 text-right text-xs text-muted-foreground">
          {Object.entries(result)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${k} ${n}`)
            .join(" · ") || "无变化"}
          {(result.名称冲突 ?? 0) > 0 && (
            <span className="ml-2 text-destructive">有名称冲突，请检查技能列表。</span>
          )}
        </output>
      )}
    </div>
  );
}
